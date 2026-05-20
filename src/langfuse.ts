import type { LangfuseRuntime, LangfuseScoreClient } from "./types.js";
import { state } from "./state.js";

let runtime: LangfuseRuntime | null = null;

export async function getRuntime(): Promise<LangfuseRuntime> {
  if (!state.config) {
    throw new Error("Langfuse config is not set");
  }

  if (!runtime) {
    const [{ BasicTracerProvider }, { LangfuseSpanProcessor }, tracing, { LangfuseClient }] = await Promise.all([
      import("@opentelemetry/sdk-trace-base"),
      import("@langfuse/otel"),
      import("@langfuse/tracing"),
      import("@langfuse/client"),
    ]);

    const spanProcessor = new LangfuseSpanProcessor({
      publicKey: state.config.publicKey,
      secretKey: state.config.secretKey,
      baseUrl: state.config.host,
    });
    const tracerProvider = new BasicTracerProvider({ spanProcessors: [spanProcessor] });
    tracing.setLangfuseTracerProvider(tracerProvider);

    runtime = {
      startObservation: tracing.startObservation as unknown as LangfuseRuntime["startObservation"],
      propagateAttributes: tracing.propagateAttributes as unknown as LangfuseRuntime["propagateAttributes"],
      scoreClient: new LangfuseClient({
        publicKey: state.config.publicKey,
        secretKey: state.config.secretKey,
        baseUrl: state.config.host,
      }) as LangfuseScoreClient,
      spanProcessor,
      tracerProvider,
      clearTracerProvider: () => tracing.setLangfuseTracerProvider(null),
    };
  }

  return runtime as LangfuseRuntime;
}

export async function shutdownRuntime(): Promise<void> {
  if (!runtime) {
    return;
  }

  try {
    await runtime.scoreClient.flush?.();
    await runtime.scoreClient.shutdown?.();
    await runtime.tracerProvider?.forceFlush?.();
    await runtime.tracerProvider?.shutdown?.();
  } catch (e) {
    console.warn("📊 Langfuse: Failed to flush/shutdown cleanly", e);
  } finally {
    runtime.clearTracerProvider?.();
    runtime = null;
  }
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
