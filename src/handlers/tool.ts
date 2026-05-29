import { state } from "../state.js";
import { getRuntime, sendScore } from "../langfuse.js";
import {
  getToolCallId,
  getToolName,
  getToolInput,
  shapePayload,
  extractTextContent,
  truncate,
  estimatePayloadBytes,
} from "../utils.js";
import { MAX_TOOL_PAYLOAD_LENGTH } from "../constants.js";

export async function startToolObservation(event: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState?.root) {
    return;
  }

  const toolCallId = getToolCallId(event);
  if (!toolCallId || state.agentState.activeTools.has(toolCallId)) {
    return;
  }

  try {
    const toolName = getToolName(event);
    const toolInput = getToolInput(event);
    const shapedInput = shapePayload(toolInput, { maxString: MAX_TOOL_PAYLOAD_LENGTH });
    const inputBytes = estimatePayloadBytes(shapedInput, MAX_TOOL_PAYLOAD_LENGTH);
    const parent = state.agentState.activeTurn ?? state.agentState.root;
    const tool = parent.startObservation
      ? parent.startObservation(
          toolName,
          {
            input: shapedInput,
            metadata: { toolName, toolCallId, inputBytes },
          },
          { asType: "tool" },
        )
      : (await getRuntime()).startObservation(
          toolName,
          {
            input: shapedInput,
            metadata: { toolName, toolCallId, inputBytes },
          },
          { asType: "tool" },
        );

    state.toolCallCount++;
    state.agentState.activeTools.set(toolCallId, {
      observation: tool,
      toolName,
      ended: false,
      startedAt: Date.now(),
      inputBytes,
    });
  } catch (e) {
    console.warn("📊 Langfuse: Failed to start tool observation", e);
  }
}

export async function finishToolObservation(event: Record<string, unknown>) {
  if (state.isTracingDisabled || !state.agentState) {
    return;
  }

  const toolCallId = getToolCallId(event);
  if (!toolCallId) {
    return;
  }

  const activeTool = state.agentState.activeTools.get(toolCallId);
  if (!activeTool || activeTool.ended) {
    return;
  }

  const isError = Boolean(event.isError ?? event.error ?? event.status === "error");
  const output =
    extractTextContent(event.content, MAX_TOOL_PAYLOAD_LENGTH) ??
    event.output ??
    event.result ??
    event.error ??
    event.content ??
    event;

  try {
    const shapedOutput = shapePayload(output, { maxString: MAX_TOOL_PAYLOAD_LENGTH });
    const outputBytes = estimatePayloadBytes(shapedOutput, MAX_TOOL_PAYLOAD_LENGTH);
    const durationMs = Math.max(0, Date.now() - activeTool.startedAt);

    activeTool.observation
      .update({
        output: shapedOutput,
        level: isError ? "ERROR" : "DEFAULT",
        statusMessage: isError ? truncate(String(event.error ?? output), 1_000) : undefined,
        metadata: {
          toolName: activeTool.toolName,
          toolCallId,
          isError,
          durationMs,
          inputBytes: activeTool.inputBytes,
          outputBytes,
        },
      })
      .end();
    activeTool.ended = true;

    if (isError) {
      state.errorCount++;
      await sendScore("tool_is_error", 1, {
        traceId: state.agentState.traceId,
        observationId: activeTool.observation.id,
      });
    }
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish tool observation", e);
  } finally {
    state.agentState.activeTools.delete(toolCallId);
  }
}

export function closeDanglingObservations(statusMessage: string) {
  if (state.isTracingDisabled || !state.agentState) {
    return;
  }

  for (const activeTool of state.agentState.activeTools.values()) {
    if (!activeTool.ended) {
      activeTool.observation
        .update({ level: "WARNING", statusMessage, metadata: { toolName: activeTool.toolName, cancelled: true } })
        .end();
      activeTool.ended = true;
    }
  }

  for (const generation of state.agentState.activeGenerations.values()) {
    if (!generation.ended) {
      generation.observation.update({ level: "WARNING", statusMessage, metadata: { ...generation.metadata, cancelled: true } }).end();
      generation.ended = true;
    }
  }

  state.agentState.activeTools.clear();
}
