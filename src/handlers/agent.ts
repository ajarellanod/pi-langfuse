import { state, resetRunState, computeEvaluationScores } from "../state.js";
import { getRuntime, sendScore } from "../langfuse.js";
import { ensureConfig } from "../config.js";
import { shapePayload, truncate, extractFinalAssistant, extractAssistantOutput } from "../utils.js";
import { closeDanglingObservations } from "./tool.js";

export function updateTraceIO(input?: unknown, output?: unknown) {
  const root = state.agentState?.root;
  if (!root?.setTraceIO) {
    return;
  }

  try {
    root.setTraceIO({ input, output });
  } catch {
    // Older SDKs may omit setTraceIO; root IO still mirrors trace IO in current Langfuse.
  }
}

export async function startAgentRun(event: Record<string, unknown>, ctx: any) {
  if (!(await ensureConfig(ctx))) {
    return;
  }

  try {
    const rt = await getRuntime();
    const cwd = String(
      (event.systemPromptOptions && typeof event.systemPromptOptions === "object"
        ? (event.systemPromptOptions as Record<string, unknown>).cwd
        : undefined) ?? process.cwd(),
    );

    if (!state.currentModel && ctx.model) {
      state.currentModel = ctx.model.id || "";
      state.currentProvider = ctx.model.provider || "";
    }

    let systemPrompt = undefined;
    try {
      if (ctx.getSystemPrompt) {
        systemPrompt = await ctx.getSystemPrompt();
      }
    } catch {
      // Ignore if getSystemPrompt is not available or fails
    }

    const promptInput = shapePayload({
      prompt: event.prompt,
      images: event.images,
      context: event.context ?? event.attachments,
    });

    state.agentState = {
      cwd,
      promptInput,
      generationSeq: 0,
      activeGenerations: new Map(),
      generationOrder: [],
      activeTools: new Map(),
      providerMetadataByRequest: new Map(),
    };

    const root = rt.propagateAttributes(
      {
        sessionId: state.currentSessionId ? truncate(state.currentSessionId, 200) : undefined,
        traceName: "pi-agent",
        metadata: {
          cwd: truncate(cwd, 200),
          ...(state.currentModel ? { model: truncate(state.currentModel, 200) } : {}),
          ...(state.currentProvider ? { provider: truncate(state.currentProvider, 200) } : {}),
        },
      },
      () =>
        rt.startObservation(
          "pi-agent",
          {
            input: promptInput,
            metadata: {
              cwd,
              model: state.currentModel || undefined,
              provider: state.currentProvider || undefined,
              sessionId: state.currentSessionId || undefined,
              ...(systemPrompt ? { systemPrompt: truncate(String(systemPrompt), 20000) } : {}),
            },
          },
          { asType: "agent" },
        ),
    );

    state.agentState.root = root;
    state.agentState.traceId = root.traceId;
    updateTraceIO(promptInput, undefined);
  } catch (e) {
    console.warn("📊 Langfuse: Failed to create agent observation", e);
  }
}

export async function finishAgentRun(event: Record<string, unknown> = {}) {
  if (!state.agentState?.root) {
    resetRunState();
    return;
  }

  const lastAssistant = extractFinalAssistant(event.messages);
  const output = lastAssistant ? extractAssistantOutput(lastAssistant) : state.agentState.latestAssistantOutput;
  const scores = computeEvaluationScores();

  closeDanglingObservations("Agent run ended before observation finalized");

  try {
    state.agentState.root
      .update({
        output,
        metadata: {
          cwd: state.agentState.cwd,
          completed: true,
          model: state.currentModel || undefined,
          provider: state.currentProvider || undefined,
          totalTools: state.toolCallCount,
          ...scores,
        },
      })
      .end();
    updateTraceIO(state.agentState.promptInput, output);

    await sendScore("tool_call_count", scores.tool_call_count, { traceId: state.agentState.traceId });
    await sendScore("turn_count", scores.turn_count, { traceId: state.agentState.traceId });
    await sendScore("total_tool_errors", scores.total_tool_errors, { traceId: state.agentState.traceId });
    await sendScore("tool_success_rate", scores.tool_success_rate, { traceId: state.agentState.traceId });
    await sendScore("session_had_errors", scores.session_had_errors, { traceId: state.agentState.traceId });
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish agent observation", e);
  } finally {
    resetRunState();
  }
}
