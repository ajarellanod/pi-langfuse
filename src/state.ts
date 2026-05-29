import { AsyncLocalStorage } from "node:async_hooks";
import type { Config, AgentState } from "./types.js";

export interface SessionRunState {
  currentModel: string;
  currentProvider: string;
  agentState: AgentState | null;
  toolCallCount: number;
  errorCount: number;
  turnCount: number;
}

const DEFAULT_SESSION_ID = "__pi_langfuse_default_session__";

let activeSessionId = DEFAULT_SESSION_ID;
const sessionScope = new AsyncLocalStorage<string>();

function createSessionRunState(): SessionRunState {
  return {
    currentModel: "",
    currentProvider: "",
    agentState: null,
    toolCallCount: 0,
    errorCount: 0,
    turnCount: 0,
  };
}

function normalizeSessionId(sessionId?: string) {
  return sessionId || DEFAULT_SESSION_ID;
}

function getActiveSessionId() {
  return sessionScope.getStore() ?? activeSessionId;
}

export function getSessionRunState(sessionId = getActiveSessionId()): SessionRunState {
  const normalizedSessionId = normalizeSessionId(sessionId);
  let sessionState = state.sessionStates.get(normalizedSessionId);
  if (!sessionState) {
    sessionState = createSessionRunState();
    state.sessionStates.set(normalizedSessionId, sessionState);
  }
  return sessionState;
}

export function setCurrentSession(sessionId?: string) {
  activeSessionId = normalizeSessionId(sessionId);
  getSessionRunState(activeSessionId);
}

export function runWithSession<T>(sessionId: string | undefined, fn: () => T): T {
  const normalizedSessionId = normalizeSessionId(sessionId);
  setCurrentSession(normalizedSessionId);
  return sessionScope.run(normalizedSessionId, fn);
}

export const state = {
  config: null as Config | null,
  setupAttemptedThisSession: false,
  sessionStates: new Map<string, SessionRunState>(),

  get currentSessionId() {
    const sessionId = getActiveSessionId();
    return sessionId === DEFAULT_SESSION_ID ? "" : sessionId;
  },
  set currentSessionId(sessionId: string) {
    setCurrentSession(sessionId);
  },

  get currentModel() {
    return getSessionRunState().currentModel;
  },
  set currentModel(model: string) {
    getSessionRunState().currentModel = model;
  },

  get currentProvider() {
    return getSessionRunState().currentProvider;
  },
  set currentProvider(provider: string) {
    getSessionRunState().currentProvider = provider;
  },

  get agentState() {
    return getSessionRunState().agentState;
  },
  set agentState(agentState: AgentState | null) {
    getSessionRunState().agentState = agentState;
  },

  get toolCallCount() {
    return getSessionRunState().toolCallCount;
  },
  set toolCallCount(toolCallCount: number) {
    getSessionRunState().toolCallCount = toolCallCount;
  },

  get errorCount() {
    return getSessionRunState().errorCount;
  },
  set errorCount(errorCount: number) {
    getSessionRunState().errorCount = errorCount;
  },

  get turnCount() {
    return getSessionRunState().turnCount;
  },
  set turnCount(turnCount: number) {
    getSessionRunState().turnCount = turnCount;
  },
};

export function resetRunState(sessionId = getActiveSessionId()) {
  state.sessionStates.set(normalizeSessionId(sessionId), createSessionRunState());
}

export function clearAllSessionStates() {
  state.sessionStates.clear();
  activeSessionId = DEFAULT_SESSION_ID;
  getSessionRunState();
}

export function computeEvaluationScores(sessionId = getActiveSessionId()) {
  const sessionState = getSessionRunState(sessionId);
  const toolSuccessRate =
    sessionState.toolCallCount > 0
      ? (sessionState.toolCallCount - sessionState.errorCount) / sessionState.toolCallCount
      : 1;
  const sessionHadErrors = sessionState.errorCount > 0;

  return {
    tool_call_count: sessionState.toolCallCount,
    turn_count: sessionState.turnCount,
    total_tool_errors: sessionState.errorCount,
    tool_success_rate: toolSuccessRate,
    session_had_errors: sessionHadErrors ? 1 : 0,
  };
}

getSessionRunState();
