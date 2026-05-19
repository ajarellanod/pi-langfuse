import { state } from "../state.js";
import { getRuntime } from "../langfuse.js";
import { shapePayload } from "../utils.js";

export async function startTurnObservation(event: Record<string, unknown>) {
  if (!state.agentState?.root) {
    return;
  }

  // If a turn is already active, close it (fallback safety)
  if (state.agentState.activeTurn) {
    state.agentState.activeTurn.end();
    state.agentState.activeTurn = undefined;
  }

  try {
    const turnIndex = event.turnIndex ?? state.turnCount;
    const observation = state.agentState.root.startObservation
      ? state.agentState.root.startObservation(
          "turn",
          {
            input: shapePayload(event.context ?? event),
            metadata: { turnIndex },
          },
          { asType: "span" },
        )
      : (await getRuntime()).startObservation(
          "turn",
          {
            input: shapePayload(event.context ?? event),
            metadata: { turnIndex },
          },
          { asType: "span" },
        );

    state.agentState.activeTurn = observation;
  } catch (e) {
    console.warn("📊 Langfuse: Failed to start turn observation", e);
  }
}

export function finishTurnObservation(event?: Record<string, unknown>) {
  if (!state.agentState?.activeTurn) {
    return;
  }

  try {
    state.agentState.activeTurn.end();
    state.agentState.activeTurn = undefined;
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish turn observation", e);
  }
}
