import test from "node:test";
import assert from "node:assert/strict";

import { __setRuntimeForTest, forceShutdownRuntime } from "../src/langfuse.ts";
import type { LangfuseRuntime } from "../src/types.js";

function never(): Promise<void> {
  return new Promise(() => {});
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function makeLargePayload() {
  return {
    chunks: Array.from({ length: 60 }, (_, index) => `${index}:` + "x".repeat(10_000)),
  };
}

test("force shutdown does not hang when Langfuse SDK shutdown stalls", async () => {
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {
      flush: never,
      shutdown: never,
    },
    tracerProvider: {
      forceFlush: never,
      shutdown: never,
    },
    clearTracerProvider: () => {},
  } satisfies LangfuseRuntime;

  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};

  try {
    __setRuntimeForTest(runtime, 50);

    const result = await Promise.race([
      forceShutdownRuntime().then(() => "resolved"),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
    ]);

    assert.equal(result, "resolved");
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("REST fallback chunks large traces below Langfuse Cloud ingestion limits", async () => {
  const requests: unknown[] = [];
  const cloudLimitBytes = 4_500_000;
  const ingestion = {
    async batch(request: unknown) {
      const size = jsonBytes(request);
      assert.ok(size < cloudLimitBytes, `fallback request exceeded cloud limit: ${size}`);
      requests.push(request);
      return {};
    },
  };
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {
      api: {
        trace: {
          get: async () => undefined,
        },
        ingestion,
      },
    },
    restFallback: {
      trace: {
        id: "trace-large-fallback",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
        input: makeLargePayload(),
        output: makeLargePayload(),
      },
      observations: Array.from({ length: 40 }, (_, index) => ({
        id: `obs-${index}`,
        traceId: "trace-large-fallback",
        type: "SPAN" as const,
        name: `tool-${index}`,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        input: makeLargePayload(),
        output: makeLargePayload(),
        metadata: { index, payload: makeLargePayload() },
      })),
      observationById: new Map(),
      attempted: false,
    },
  } satisfies LangfuseRuntime;

  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};

  try {
    __setRuntimeForTest(runtime, 50);

    await forceShutdownRuntime();

    assert.ok(requests.length > 1, "expected large fallback trace to be split into multiple requests");
    assert.equal((requests[0] as { batch: Array<{ type: string }> }).batch[0]?.type, "trace-create");
    for (const request of requests) {
      assert.ok(jsonBytes(request) < cloudLimitBytes);
      assert.ok((request as { batch: unknown[] }).batch.length > 0);
    }
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("REST fallback logs payload-too-large ingestion failures concisely", async () => {
  const ingestion = {
    async batch(_request: unknown) {
      throw {
        statusCode: 413,
        body: {
          ok: false,
          error: {
            reason: "non-json",
            statusCode: 413,
            rawBody: "Body exceeded 4.5mb limit",
          },
        },
        rawResponse: {
          status: 413,
          statusText: "Body exceeded 4.5mb limit",
        },
      };
    },
  };
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {
      api: {
        trace: {
          get: async () => undefined,
        },
        ingestion,
      },
    },
    restFallback: {
      trace: {
        id: "trace-413-fallback",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
        input: makeLargePayload(),
      },
      observations: [],
      observationById: new Map(),
      attempted: false,
    },
  } satisfies LangfuseRuntime;

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  console.log = () => {};

  try {
    __setRuntimeForTest(runtime, 50);

    await forceShutdownRuntime();

    assert.ok(warnings.length > 0);
    assert.ok(warnings.every((args) => args.every((arg) => typeof arg === "string")));
    const joined = warnings.flat().join("\n");
    assert.match(joined, /statusCode=413/);
    assert.match(joined, /Body exceeded 4\.5mb limit/);
    assert.doesNotMatch(joined, /rawResponse|Headers|rawBody/);
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("REST fallback calls Langfuse ingestion with its SDK receiver", async () => {
  const ingestion = {
    called: false,
    async batch(this: { called: boolean }, _request: unknown) {
      this.called = true;
      return {};
    },
  };
  const runtime = {
    startObservation: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["startObservation"],
    propagateAttributes: (() => {
      throw new Error("not used");
    }) as LangfuseRuntime["propagateAttributes"],
    scoreClient: {
      api: {
        trace: {
          get: async () => undefined,
        },
        ingestion,
      },
    },
    restFallback: {
      trace: {
        id: "trace-uses-bound-batch",
        timestamp: new Date().toISOString(),
        name: "pi-agent",
      },
      observations: [],
      observationById: new Map(),
      attempted: false,
    },
  } satisfies LangfuseRuntime;

  const logs: unknown[][] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };

  try {
    __setRuntimeForTest(runtime, 50);

    await forceShutdownRuntime();

    assert.equal(ingestion.called, true);
    assert.deepEqual(logs, []);
  } finally {
    __setRuntimeForTest(null);
    console.warn = originalWarn;
    console.log = originalLog;
  }
});
