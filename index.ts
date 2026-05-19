/**
 * Langfuse Observability Extension for Pi Coding Agent
 *
 * Sends one complete Langfuse trace per Pi agent run:
 * - root agent observation for the user prompt and final assistant response
 * - one generation observation per provider request
 * - one tool observation per tool call, keyed by toolCallId
 */

import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { state, resetRunState } from "./src/state.js";
import { ensureConfig, promptForConfig } from "./src/config.js";
import { shutdownRuntime } from "./src/langfuse.js";
import { getMessageFromEvent, extractAssistantOutput } from "./src/utils.js";
import { startAgentRun, finishAgentRun } from "./src/handlers/agent.js";
import { startTurnObservation, finishTurnObservation } from "./src/handlers/turn.js";
import {
  startGeneration,
  updateGenerationMetadata,
  finishGenerationFromMessage,
  createFallbackGenerationFromTurn,
  recordTTFT,
} from "./src/handlers/generation.js";
import {
  startToolObservation,
  finishToolObservation,
  closeDanglingObservations,
} from "./src/handlers/tool.js";

// ============================================
// Extension
// ============================================

export default async function (pi: ExtensionAPI) {
  if (state.config) {
    console.log("📊 Langfuse: Tracing enabled →", state.config.host);
  } else {
    console.log("📊 Langfuse: Waiting for first-run setup");
  }

  pi.registerCommand("langfuse-setup", {
    description: "Configure Langfuse API keys for this extension",
    handler: async (_args, ctx) => {
      await promptForConfig(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state.setupAttemptedThisSession = false;
    await ensureConfig(ctx);
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      state.currentSessionId = basename(sessionFile, ".jsonl");
    }
    resetRunState();
  });

  pi.on("model_select", async (event) => {
    state.currentModel = event.model?.id || "";
    state.currentProvider = event.model?.provider || "";
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await startAgentRun(event, ctx);
  });

  pi.on("agent_start", async (event, ctx) => {
    if (!state.agentState?.root) {
      await startAgentRun(event, ctx);
    }
  });

  pi.on("turn_start", async (event) => {
    await startTurnObservation(event);
  });

  pi.on("before_provider_request", async (event) => {
    await startGeneration(event);
  });

  pi.on("after_provider_response", async (event) => {
    updateGenerationMetadata(event);
  });

  pi.on("message_update", async (event) => {
    recordTTFT(event);
    const message = getMessageFromEvent(event);
    if (message?.role === "assistant" && state.agentState) {
      state.agentState.latestAssistantOutput = extractAssistantOutput(message);
    }
  });

  pi.on("message_end", async (event) => {
    await finishGenerationFromMessage(event);
  });

  pi.on("tool_execution_start", async (event) => {
    await startToolObservation(event);
  });

  pi.on("tool_call", async (event) => {
    await startToolObservation(event);
  });

  pi.on("tool_result", async (event) => {
    await finishToolObservation(event);
  });

  pi.on("tool_execution_end", async (event) => {
    await finishToolObservation(event);
  });

  pi.on("turn_end", async (event) => {
    state.turnCount++;
    const message = getMessageFromEvent(event);
    if (message?.role === "assistant") {
      await createFallbackGenerationFromTurn(event, message);
      await finishGenerationFromMessage(event);
    }
    finishTurnObservation(event);
  });

  pi.on("agent_end", async (event) => {
    await finishAgentRun(event);
    await shutdownRuntime();
  });

  const handleSessionInterruption = (reason: string) => {
    if (state.agentState?.root) {
      closeDanglingObservations(reason);
      state.agentState.root.update({ metadata: { completed: false, cancelled: true } }).end();
    }
    resetRunState();
  };

  pi.on("session_before_switch", async () => {
    handleSessionInterruption("Session switched");
  });

  pi.on("session_before_fork", async () => {
    handleSessionInterruption("Session forked");
  });

  pi.on("session_compact", async (event) => {
    if (state.agentState?.root) {
      const parent = state.agentState.activeTurn ?? state.agentState.root;
      try {
        const observation = parent.startObservation ? parent.startObservation(
          "session_compact", 
          {
            level: "DEFAULT",
            statusMessage: "Context was compacted",
            metadata: { ...event }
          }, 
          { asType: "span" }
        ) : undefined;
        observation?.end();
      } catch (e) {
        // ignore
      }
    }
  });

  pi.on("session_shutdown", async () => {
    handleSessionInterruption("Session shutdown before agent completed");
    await shutdownRuntime();
  });
}
