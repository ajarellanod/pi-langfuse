import type { Config, AgentState } from "./types.js";

export const state = {
  config: null as Config | null,
  setupAttemptedThisSession: false,
  
  currentSessionId: "",
  currentModel: "",
  currentProvider: "",
  agentState: null as AgentState | null,
  
  // Evaluation tracking state
  toolCallCount: 0,
  errorCount: 0,
  turnCount: 0,
};

export function resetRunState() {
  state.agentState = null;
  state.toolCallCount = 0;
  state.errorCount = 0;
  state.turnCount = 0;
  state.currentModel = "";
  state.currentProvider = "";
}

export function computeEvaluationScores() {
  const toolSuccessRate = state.toolCallCount > 0 ? (state.toolCallCount - state.errorCount) / state.toolCallCount : 1;
  const sessionHadErrors = state.errorCount > 0;

  return {
    tool_call_count: state.toolCallCount,
    turn_count: state.turnCount,
    total_tool_errors: state.errorCount,
    tool_success_rate: toolSuccessRate,
    session_had_errors: sessionHadErrors ? 1 : 0,
  };
}
