import type { LangfuseRuntime, LangfuseScoreClient } from "./types.js";
import { state } from "./state.js";
import { shapePayload } from "./utils.js";
import { randomUUID } from "node:crypto";

let runtime: LangfuseRuntime | null = null;
let contextManagerRegistered = false;
const activeSessions = new Set<string>();

type FallbackObservationType = "SPAN" | "GENERATION";
type RestFallbackEventType = "trace-create" | "span-create" | "generation-create";

interface RestFallbackTrace {
  id: string;
  timestamp: string;
  name: string;
  input?: unknown;
  output?: unknown;
  sessionId?: string;
  environment?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface RestFallbackObservation {
  id: string;
  traceId: string;
  type: FallbackObservationType;
  name: string;
  startTime: string;
  endTime?: string;
  parentObservationId?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  completionStartTime?: string;
}

interface RestFallbackStore {
  trace?: RestFallbackTrace;
  observations: RestFallbackObservation[];
  observationById: Map<string, RestFallbackObservation>;
  attempted: boolean;
}

interface RestFallbackEvent {
  type: RestFallbackEventType;
  id: string;
  timestamp: string;
  body: Record<string, unknown>;
}

const OTEL_VISIBILITY_TIMEOUT_MS = 1_500;
const OTEL_VISIBILITY_POLL_INTERVAL_MS = 200;
const DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS = 2_000;

// Langfuse Cloud currently rejects ingestion bodies above ~4.5 MiB. Keep
// fallback requests comfortably below that so JSON encoding differences,
// headers, and future metadata additions do not push us over the server limit.
const REST_FALLBACK_MAX_REQUEST_BYTES = 3_500_000;
const REST_FALLBACK_MAX_STRING_LENGTH = 2_000;
const REST_FALLBACK_MAX_NODES = 200;
const REST_FALLBACK_MAX_DEPTH = 4;
const REST_FALLBACK_MAX_TAGS = 20;
const REST_FALLBACK_TRUNCATED_MARKER =
  "[truncated by pi-langfuse REST fallback to stay below Langfuse ingestion limits]";

let shutdownStepTimeoutMs = DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS;

function nowIso() {
  return new Date().toISOString();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(message: string) {
  if (process.env.PI_LANGFUSE_DEBUG === "1" || process.env.PI_LANGFUSE_DEBUG === "true") {
    console.log(message);
  }
}

async function withTimeout<T>(label: string, operation: Promise<T> | undefined): Promise<T | undefined> {
  if (!operation) {
    return undefined;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          debugLog(`📊 Langfuse: ${label} timed out after ${shutdownStepTimeoutMs}ms`);
          resolve(undefined);
        }, shutdownStepTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function toIso(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function mergeMetadata(current: Record<string, unknown> | undefined, next: Record<string, unknown> | undefined) {
  return next ? { ...(current ?? {}), ...next } : current;
}

function applyObservationUpdate(record: RestFallbackObservation, body: Record<string, unknown> | undefined) {
  if (!body) {
    return;
  }

  if ("input" in body) record.input = body.input;
  if ("output" in body) record.output = body.output;
  if ("metadata" in body && body.metadata && typeof body.metadata === "object") {
    record.metadata = mergeMetadata(record.metadata, body.metadata as Record<string, unknown>);
  }
  if (typeof body.model === "string") record.model = body.model;
  if (body.modelParameters && typeof body.modelParameters === "object") {
    record.modelParameters = body.modelParameters as Record<string, string | number>;
  }
  if (body.usageDetails && typeof body.usageDetails === "object") {
    record.usageDetails = body.usageDetails as Record<string, number>;
  }
  if (body.costDetails && typeof body.costDetails === "object") {
    record.costDetails = body.costDetails as Record<string, number>;
  }
  if (typeof body.level === "string") record.level = body.level as RestFallbackObservation["level"];
  if (typeof body.statusMessage === "string") record.statusMessage = body.statusMessage;
  const completionStartTime = toIso(body.completionStartTime);
  if (completionStartTime) record.completionStartTime = completionStartTime;
}

function applyTraceUpdate(store: RestFallbackStore, body: Record<string, unknown> | undefined) {
  if (!store.trace || !body) {
    return;
  }

  if ("input" in body) store.trace.input = body.input;
  if ("output" in body) store.trace.output = body.output;
  if ("metadata" in body && body.metadata && typeof body.metadata === "object") {
    store.trace.metadata = mergeMetadata(store.trace.metadata, body.metadata as Record<string, unknown>);
  }
}

function observationType(asType?: string): FallbackObservationType {
  return asType === "generation" ? "GENERATION" : "SPAN";
}

function wrapObservation(
  observation: any,
  store: RestFallbackStore,
  name: string,
  body: Record<string, unknown> | undefined,
  asType?: string,
  parentObservationId?: string,
): any {
  const id = observation.id || randomUUID();
  const traceId = observation.traceId || store.trace?.id || randomUUID();
  const metadata = body?.metadata && typeof body.metadata === "object" ? body.metadata as Record<string, unknown> : undefined;
  const record: RestFallbackObservation = {
    id,
    traceId,
    name,
    type: observationType(asType),
    startTime: nowIso(),
    parentObservationId,
    metadata: mergeMetadata(metadata, asType && asType !== "generation" && asType !== "span" ? { langfuseObservationType: asType } : undefined),
  };
  applyObservationUpdate(record, body);

  store.observations.push(record);
  store.observationById.set(id, record);

  if (!parentObservationId && !store.trace) {
    store.trace = {
      id: traceId,
      timestamp: record.startTime,
      name,
      input: body?.input,
      sessionId: typeof metadata?.sessionId === "string" ? metadata.sessionId : state.currentSessionId || undefined,
      metadata,
    };
  }

  return {
    ...observation,
    id,
    traceId,
    update(updateBody?: Record<string, unknown>) {
      applyObservationUpdate(record, updateBody);
      if (!parentObservationId) {
        applyTraceUpdate(store, updateBody);
      }
      const updated = observation.update(updateBody);
      return updated === observation ? this : updated;
    },
    end(endBody?: Record<string, unknown>) {
      if (endBody && typeof endBody === "object") {
        applyObservationUpdate(record, endBody);
        if (!parentObservationId) {
          applyTraceUpdate(store, endBody);
        }
      }
      record.endTime = nowIso();
      return observation.end();
    },
    startObservation(childName: string, childBody?: Record<string, unknown>, options?: { asType?: string }) {
      const child = observation.startObservation(childName, childBody, options);
      return wrapObservation(child, store, childName, childBody, options?.asType, id);
    },
    setTraceIO(traceBody?: { input?: unknown; output?: unknown }) {
      applyTraceUpdate(store, traceBody);
      return observation.setTraceIO?.(traceBody);
    },
  };
}

async function traceExists(rt: LangfuseRuntime, traceId: string): Promise<boolean> {
  try {
    const traceApi = rt.scoreClient.api?.trace;
    if (!traceApi?.get) {
      return false;
    }
    const trace = await withTimeout("Trace visibility check", traceApi.get(traceId));
    if (!trace) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForTraceVisibility(rt: LangfuseRuntime, traceId: string): Promise<boolean> {
  const deadline = Date.now() + OTEL_VISIBILITY_TIMEOUT_MS;

  while (true) {
    if (await traceExists(rt, traceId)) {
      return true;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }

    await delay(Math.min(OTEL_VISIBILITY_POLL_INTERVAL_MS, remainingMs));
  }
}

function eventTimestamp(record: { endTime?: string; startTime?: string; timestamp?: string }) {
  return record.endTime ?? record.startTime ?? record.timestamp ?? nowIso();
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value;
}

function jsonByteSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function stripUndefined<T extends Record<string, unknown>>(record: T): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function shapeFallbackValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  return shapePayload(value, {
    maxString: REST_FALLBACK_MAX_STRING_LENGTH,
    depth: REST_FALLBACK_MAX_DEPTH,
    maxNodes: REST_FALLBACK_MAX_NODES,
    parseJson: false,
  });
}

function shapeFallbackRecord(value: unknown): Record<string, unknown> | undefined {
  const shaped = shapeFallbackValue(value);
  return shaped && typeof shaped === "object" && !Array.isArray(shaped)
    ? (shaped as Record<string, unknown>)
    : undefined;
}

function shapeFallbackTags(tags: string[] | undefined): string[] | undefined {
  if (!tags || tags.length === 0) {
    return undefined;
  }
  return tags.slice(0, REST_FALLBACK_MAX_TAGS).map((tag) => truncateText(String(tag), 200));
}

function createTraceFallbackEvent(trace: RestFallbackTrace): RestFallbackEvent {
  return {
    type: "trace-create",
    id: randomUUID(),
    timestamp: eventTimestamp(trace),
    body: stripUndefined({
      id: trace.id,
      timestamp: trace.timestamp,
      name: trace.name,
      input: shapeFallbackValue(trace.input),
      output: shapeFallbackValue(trace.output),
      sessionId: trace.sessionId,
      environment: trace.environment,
      tags: shapeFallbackTags(trace.tags),
      metadata: shapeFallbackRecord(trace.metadata),
    }),
  };
}

function createObservationFallbackEvent(observation: RestFallbackObservation): RestFallbackEvent {
  return {
    type: observation.type === "GENERATION" ? "generation-create" : "span-create",
    id: randomUUID(),
    timestamp: eventTimestamp(observation),
    body: stripUndefined({
      id: observation.id,
      traceId: observation.traceId,
      name: observation.name,
      startTime: observation.startTime,
      endTime: observation.endTime,
      input: shapeFallbackValue(observation.input),
      output: shapeFallbackValue(observation.output),
      metadata: shapeFallbackRecord(observation.metadata),
      level: observation.level,
      statusMessage: observation.statusMessage ? truncateText(observation.statusMessage, 1_000) : undefined,
      parentObservationId: observation.parentObservationId,
      ...(observation.type === "GENERATION"
        ? {
            completionStartTime: observation.completionStartTime,
            model: observation.model ? truncateText(observation.model, 500) : undefined,
            modelParameters: shapeFallbackRecord(observation.modelParameters),
            usageDetails: shapeFallbackRecord(observation.usageDetails),
            costDetails: shapeFallbackRecord(observation.costDetails),
          }
        : {}),
    }),
  };
}

function createRestFallbackRequest(batch: RestFallbackEvent[], batchIndex: number, totalBatches: number) {
  return {
    batch,
    metadata: {
      source: "pi-langfuse",
      fallback: "rest-ingestion",
      reason: "otel-trace-not-visible-after-flush",
      batchIndex,
      totalBatches,
      eventCount: batch.length,
      maxRequestBytes: REST_FALLBACK_MAX_REQUEST_BYTES,
    },
  };
}

function compactMetadata(metadata: unknown): Record<string, unknown> {
  const output: Record<string, unknown> = {
    piLangfuseRestFallbackTruncated: true,
    truncationReason: REST_FALLBACK_TRUNCATED_MARKER,
  };
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return output;
  }

  let copied = 0;
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (copied >= 20) {
      break;
    }
    if (value === undefined || value === null || typeof value === "object" || typeof value === "function" || typeof value === "symbol") {
      continue;
    }
    output[key] = typeof value === "string" ? truncateText(value, 300) : value;
    copied++;
  }
  return output;
}

function compactFallbackEvent(event: RestFallbackEvent): RestFallbackEvent {
  const body = { ...event.body };
  if ("input" in body) {
    body.input = REST_FALLBACK_TRUNCATED_MARKER;
  }
  if ("output" in body) {
    body.output = REST_FALLBACK_TRUNCATED_MARKER;
  }
  body.metadata = compactMetadata(body.metadata);
  if (typeof body.statusMessage === "string") {
    body.statusMessage = truncateText(body.statusMessage, 300);
  }
  return { ...event, body };
}

function minimalFallbackEvent(event: RestFallbackEvent): RestFallbackEvent {
  const body = event.body;
  const common = stripUndefined({
    id: body.id,
    traceId: body.traceId,
    name: body.name,
    timestamp: body.timestamp,
    startTime: body.startTime,
    endTime: body.endTime,
    parentObservationId: body.parentObservationId,
    sessionId: body.sessionId,
    environment: body.environment,
    tags: Array.isArray(body.tags) ? body.tags.slice(0, REST_FALLBACK_MAX_TAGS) : undefined,
    level: body.level,
    statusMessage: typeof body.statusMessage === "string" ? truncateText(body.statusMessage, 300) : undefined,
    model: typeof body.model === "string" ? truncateText(body.model, 300) : undefined,
    usageDetails: body.usageDetails,
    costDetails: body.costDetails,
    metadata: {
      piLangfuseRestFallbackTruncated: true,
      truncationReason: REST_FALLBACK_TRUNCATED_MARKER,
    },
  });
  return { ...event, body: common };
}

function fitFallbackEvent(event: RestFallbackEvent): RestFallbackEvent {
  if (jsonByteSize(createRestFallbackRequest([event], 1, 1)) <= REST_FALLBACK_MAX_REQUEST_BYTES) {
    return event;
  }

  const compacted = compactFallbackEvent(event);
  if (jsonByteSize(createRestFallbackRequest([compacted], 1, 1)) <= REST_FALLBACK_MAX_REQUEST_BYTES) {
    return compacted;
  }

  return minimalFallbackEvent(event);
}

function createRestFallbackBatches(events: RestFallbackEvent[]): RestFallbackEvent[][] {
  const batches: RestFallbackEvent[][] = [];
  let currentBatch: RestFallbackEvent[] = [];

  for (const rawEvent of events) {
    const event = fitFallbackEvent(rawEvent);
    const candidate = [...currentBatch, event];
    if (
      currentBatch.length > 0 &&
      jsonByteSize(createRestFallbackRequest(candidate, 1, 1)) > REST_FALLBACK_MAX_REQUEST_BYTES
    ) {
      batches.push(currentBatch);
      currentBatch = [event];
    } else {
      currentBatch = candidate;
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function summarizeIngestionError(error: unknown): string {
  const record = error && typeof error === "object" ? (error as Record<string, any>) : undefined;
  const bodyError = record?.body?.error;
  const statusCode = record?.statusCode ?? bodyError?.statusCode ?? record?.rawResponse?.status;
  const message =
    bodyError?.rawBody ??
    bodyError?.reason ??
    record?.rawResponse?.statusText ??
    record?.message ??
    (typeof error === "string" ? error : "unknown error");
  return `${statusCode ? `statusCode=${statusCode} ` : ""}${truncateText(String(message), 500)}`.trim();
}

function isPayloadTooLargeError(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, any>) : undefined;
  const statusCode = record?.statusCode ?? record?.body?.error?.statusCode ?? record?.rawResponse?.status;
  const message = String(record?.body?.error?.rawBody ?? record?.rawResponse?.statusText ?? record?.message ?? error ?? "");
  return statusCode === 413 || /body exceeded|payload too large|request entity too large/i.test(message);
}

async function sendRestFallbackBatch(
  ingestionApi: { batch?: (request: unknown) => Promise<unknown> },
  batch: RestFallbackEvent[],
  batchLabel: string,
  totalBatches: number,
  allowPayloadRetry = true,
): Promise<boolean> {
  const request = createRestFallbackRequest(batch, Number.parseInt(batchLabel, 10) || 1, totalBatches);
  try {
    const response = await withTimeout(`REST fallback ingestion batch ${batchLabel}/${totalBatches}`, ingestionApi.batch?.(request));
    if (!response) {
      return false;
    }

    const responseBody = response as { errors?: unknown[] } | undefined;
    const responseErrors = responseBody?.errors;
    const errors = Array.isArray(responseErrors) ? responseErrors : [];
    if (errors.length > 0) {
      console.warn(
        `📊 Langfuse: REST fallback ingestion reported ${errors.length} error(s) for batch ${batchLabel}/${totalBatches}`,
      );
      return false;
    }
    return true;
  } catch (error) {
    if (allowPayloadRetry && isPayloadTooLargeError(error)) {
      if (batch.length > 1) {
        const midpoint = Math.ceil(batch.length / 2);
        const left = await sendRestFallbackBatch(ingestionApi, batch.slice(0, midpoint), `${batchLabel}.1`, totalBatches, true);
        const right = await sendRestFallbackBatch(ingestionApi, batch.slice(midpoint), `${batchLabel}.2`, totalBatches, true);
        return left && right;
      }

      const compacted = minimalFallbackEvent(batch[0]);
      if (jsonByteSize(createRestFallbackRequest([compacted], 1, 1)) < jsonByteSize(request)) {
        return sendRestFallbackBatch(ingestionApi, [compacted], `${batchLabel}.compact`, totalBatches, false);
      }
    }

    console.warn(
      `📊 Langfuse: REST fallback ingestion failed for batch ${batchLabel}/${totalBatches} ` +
        `(${batch.length} event(s), ${jsonByteSize(request)} bytes): ${summarizeIngestionError(error)}`,
    );
    return false;
  }
}

async function fallbackToRestIngestion(rt: LangfuseRuntime) {
  const store = rt.restFallback as RestFallbackStore | undefined;
  if (!store?.trace || store.attempted) {
    return;
  }
  store.attempted = true;

  if (await waitForTraceVisibility(rt, store.trace.id)) {
    return;
  }

  const trace = store.trace;
  const events = [createTraceFallbackEvent(trace), ...store.observations.map(createObservationFallbackEvent)];

  const ingestionApi = rt.scoreClient.api?.ingestion;
  if (!ingestionApi?.batch) {
    debugLog("📊 Langfuse: REST fallback ingestion is unavailable");
    return;
  }

  const batches = createRestFallbackBatches(events);
  let sentBatches = 0;
  for (let index = 0; index < batches.length; index++) {
    const ok = await sendRestFallbackBatch(ingestionApi, batches[index], String(index + 1), batches.length);
    if (ok) {
      sentBatches++;
    }
  }

  if (sentBatches === batches.length) {
    debugLog(
      `📊 Langfuse: OTel trace ${trace.id} was not visible; wrote fallback trace via REST ingestion ` +
        `in ${batches.length} batch(es)`,
    );
  } else if (sentBatches > 0) {
    console.warn(
      `📊 Langfuse: REST fallback ingestion partially succeeded for trace ${trace.id}: ` +
        `${sentBatches}/${batches.length} batch(es) accepted`,
    );
  }
}

export async function getRuntime(): Promise<LangfuseRuntime> {
  if (!state.config) {
    throw new Error("Langfuse config is not set");
  }

  // Track the current session as a runtime consumer.
  // Multiple sessions can share the same runtime; shutdown is deferred
  // until the last session releases it.
  const sessionId = state.currentSessionId;
  if (sessionId) {
    activeSessions.add(sessionId);
  }

  if (!runtime) {
    const [{ BasicTracerProvider }, { LangfuseSpanProcessor }, tracing, { LangfuseClient }, otelApi, contextAsyncHooks] = await Promise.all([
      import("@opentelemetry/sdk-trace-base"),
      import("@langfuse/otel"),
      import("@langfuse/tracing"),
      import("@langfuse/client"),
      import("@opentelemetry/api"),
      import("@opentelemetry/context-async-hooks"),
    ]);

    // Register a global OTel context manager exactly once. Without it, OpenTelemetry's
    // context propagation is a no-op, which silently drops every trace attribute set via
    // `propagateAttributes` (sessionId, tags, version). It must be enabled before any
    // observation is created.
    if (!contextManagerRegistered) {
      contextManagerRegistered = otelApi.context.setGlobalContextManager(
        new contextAsyncHooks.AsyncLocalStorageContextManager().enable(),
      );
    }

    const restFallback: RestFallbackStore = {
      observations: [],
      observationById: new Map(),
      attempted: false,
    };

    // The span processor is a process-level singleton, so environment/release are
    // scoped to the process and config — not per-trace. All traces emitted by this
    // runtime inherit the same environment and release.
    const spanProcessor = new LangfuseSpanProcessor({
      publicKey: state.config.publicKey,
      secretKey: state.config.secretKey,
      baseUrl: state.config.host,
      ...(state.config.environment ? { environment: state.config.environment } : {}),
      ...(state.config.release ? { release: state.config.release } : {}),
    });
    const tracerProvider = new BasicTracerProvider({ spanProcessors: [spanProcessor] });
    tracing.setLangfuseTracerProvider(tracerProvider);

    runtime = {
      startObservation: ((name: string, body?: Record<string, unknown>, options?: { asType?: string }) => {
        const observation = (tracing as any).startObservation(name, body, options);
        return wrapObservation(observation, restFallback, name, body, options?.asType);
      }) as unknown as LangfuseRuntime["startObservation"],
      propagateAttributes: tracing.propagateAttributes as unknown as LangfuseRuntime["propagateAttributes"],
      scoreClient: new LangfuseClient({
        publicKey: state.config.publicKey,
        secretKey: state.config.secretKey,
        baseUrl: state.config.host,
      }) as LangfuseScoreClient,
      spanProcessor,
      tracerProvider,
      clearTracerProvider: () => tracing.setLangfuseTracerProvider(null),
      restFallback,
    };
  }

  return runtime as LangfuseRuntime;
}

/**
 * Attach trace-level attributes to the REST fallback store so short-lived runs
 * (where the OTel trace is not visible before shutdown) don't lose `environment`
 * and `tags`. These are set on the OTel span via the processor / propagateAttributes,
 * but the REST fallback trace-create event must carry them explicitly.
 */
export function annotateFallbackTrace(attributes: { environment?: string; tags?: string[] }): void {
  const store = runtime?.restFallback as RestFallbackStore | undefined;
  if (!store?.trace) {
    return;
  }
  if (attributes.environment && !store.trace.environment) {
    store.trace.environment = attributes.environment;
  }
  if (attributes.tags && attributes.tags.length > 0) {
    store.trace.tags = attributes.tags;
  }
}

function doShutdownRuntime(): Promise<void> {
  return (async () => {
    if (!runtime) {
      return;
    }

    const rt = runtime;
    runtime = null;

    try {
      await withTimeout("OTel force flush", rt.tracerProvider?.forceFlush?.());
      await fallbackToRestIngestion(rt);
      await withTimeout("Langfuse score flush", rt.scoreClient.flush?.());
      await withTimeout("Langfuse client shutdown", rt.scoreClient.shutdown?.());
      await withTimeout("OTel tracer shutdown", rt.tracerProvider?.shutdown?.());
    } catch (e) {
      console.warn("📊 Langfuse: Failed to flush/shutdown cleanly", e);
    } finally {
      if (!runtime) {
        rt.clearTracerProvider?.();
      }
    }
  })();
}

/**
 * Release the current session's reference to the Langfuse runtime.
 * Only actually shuts down the runtime when the last session releases it.
 * Accepts an optional sessionId for use outside of withSession (e.g. deferred callbacks).
 */
export async function shutdownRuntime(sessionId?: string): Promise<void> {
  const sid = sessionId ?? state.currentSessionId;
  if (sid) {
    activeSessions.delete(sid);
  }

  // Still have active sessions — keep the runtime alive.
  if (activeSessions.size > 0) {
    return;
  }

  await doShutdownRuntime();
}

/**
 * Force-shutdown the Langfuse runtime regardless of active session references.
 * Used when the user manually reconfigures (e.g. /langfuse-setup) and needs
 * a fresh runtime with new credentials.
 */
export async function forceShutdownRuntime(): Promise<void> {
  activeSessions.clear();
  await doShutdownRuntime();
}

export function __setRuntimeForTest(rt: LangfuseRuntime | null, timeoutMs = DEFAULT_SHUTDOWN_STEP_TIMEOUT_MS): void {
  runtime = rt;
  shutdownStepTimeoutMs = timeoutMs;
  activeSessions.clear();
}

export async function sendScore(name: string, value: number, options: { traceId?: string; observationId?: string } = {}) {
  try {
    const rt = await getRuntime();
    rt.scoreClient.score?.create({
      name,
      value,
      dataType: name === "session_had_errors" || name === "tool_is_error" ? "BOOLEAN" : "NUMERIC",
      traceId: options.traceId,
      observationId: options.observationId,
      sessionId: options.traceId ? undefined : state.currentSessionId || undefined,
    });
  } catch (e) {
    console.warn(`📊 Langfuse: Failed to send score ${name}`, e);
  }
}
