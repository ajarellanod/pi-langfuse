import test from "node:test";
import assert from "node:assert/strict";

import { extractUsage } from "../src/utils.ts";
import {
  finishGenerationFromMessage,
  startGeneration,
} from "../src/handlers/generation.ts";
import {
  clearAllSessionStates,
  setCurrentSession,
  state,
} from "../src/state.ts";
import type { AgentState, LangfuseObservation, ObservationUpdate } from "../src/types.js";

class FakeObservation implements LangfuseObservation {
  id = "fake-observation";
  traceId = "fake-trace";
  updates: Array<ObservationUpdate | undefined> = [];
  children: FakeObservation[] = [];
  ended = false;

  constructor(public body?: ObservationUpdate) {}

  update(body?: ObservationUpdate): LangfuseObservation {
    this.updates.push(body);
    return this;
  }

  end(body?: ObservationUpdate): void {
    if (body) {
      this.updates.push(body);
    }
    this.ended = true;
  }

  startObservation(_name: string, body?: ObservationUpdate): LangfuseObservation {
    const child = new FakeObservation(body);
    this.children.push(child);
    return child;
  }
}

function makeAgentState(root: LangfuseObservation): AgentState {
  return {
    root,
    generationSeq: 0,
    activeGenerations: new Map(),
    generationOrder: [],
    activeTools: new Map(),
    providerMetadataByRequest: new Map(),
  };
}

test("extractUsage maps cache tokens to Langfuse-recognized usage keys", () => {
  const usage = extractUsage({
    usage: {
      input: 100,
      output: 50,
      cacheRead: 20,
      cacheWrite: 10,
    },
  });

  assert.deepEqual(usage, {
    input: 100,
    output: 50,
    total: 150,
    cache_read_input_tokens: 20,
    cache_creation_input_tokens: 10,
  });
});

test("extractUsage accepts Anthropic-style cache token aliases", () => {
  const usage = extractUsage({
    usage: {
      prompt_tokens: 200,
      completion_tokens: 40,
      cache_read_input_tokens: 75,
      cache_creation_input_tokens: 15,
    },
  });

  assert.deepEqual(usage, {
    input: 200,
    output: 40,
    total: 240,
    cache_read_input_tokens: 75,
    cache_creation_input_tokens: 15,
  });
});

test("extractUsage omits cache keys when cache tokens are zero", () => {
  const usage = extractUsage({
    usage: {
      input: 10,
      output: 5,
    },
  });

  assert.deepEqual(usage, {
    input: 10,
    output: 5,
    total: 15,
  });
});

test("finishGenerationFromMessage attributes output to the keyed generation under concurrency", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-correctness");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  await startGeneration({ requestId: "request-1", payload: {} });
  await startGeneration({ requestId: "request-2", payload: {} });

  const first = state.agentState.activeGenerations.get("request-1")
    ?.observation as FakeObservation;
  const second = state.agentState.activeGenerations.get("request-2")
    ?.observation as FakeObservation;

  // Finish the FIRST (older) request even though a newer one is still open.
  await finishGenerationFromMessage({
    requestId: "request-1",
    message: {
      role: "assistant",
      content: "answer for request-1",
    },
  });

  assert.equal(first.ended, true);
  assert.equal(second.ended, false);
  assert.equal(first.updates.at(-1)?.output, "answer for request-1");
});

test("finishGenerationFromMessage falls back to the last open generation without a key", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-correctness-fallback");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  await startGeneration({ requestId: "request-1", payload: {} });
  const generation = state.agentState.activeGenerations.get("request-1")
    ?.observation as FakeObservation;

  await finishGenerationFromMessage({
    message: {
      role: "assistant",
      content: "fallback answer",
    },
  });

  assert.equal(generation.ended, true);
  assert.equal(generation.updates.at(-1)?.output, "fallback answer");
  assert.equal(state.agentState.latestAssistantOutput, "fallback answer");
});

test("finishGenerationFromMessage still records latestAssistantOutput with no matching generation", async () => {
  clearAllSessionStates();
  setCurrentSession("generation-correctness-no-match");

  const root = new FakeObservation();
  state.agentState = makeAgentState(root);

  await finishGenerationFromMessage({
    requestId: "missing-request",
    message: {
      role: "assistant",
      content: "orphan output",
    },
  });

  assert.equal(state.agentState.latestAssistantOutput, "orphan output");
});
