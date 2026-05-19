/**
 * Langfuse Observability Extension for Pi Coding Agent
 *
 * Sends one complete Langfuse trace per Pi agent run:
 * - root agent observation for the user prompt and final assistant response
 * - one generation observation per provider request
 * - one tool observation per tool call, keyed by toolCallId
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================
// Configuration
// ============================================

interface Config {
  publicKey: string;
  secretKey: string;
  host: string;
}

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = resolve(EXT_DIR, "config.json");
const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

function loadConfigFromFile(): Config | null {
  if (existsSync(CONFIG_PATH)) {
    try {
      const content = readFileSync(CONFIG_PATH, "utf-8");
      const config = JSON.parse(content) as Config;
      if (config.publicKey && config.secretKey) {
        return {
          publicKey: config.publicKey,
          secretKey: config.secretKey,
          host: config.host || DEFAULT_LANGFUSE_HOST,
        };
      }
    } catch (e) {
      console.warn("📊 Langfuse: Failed to load config.json", e);
    }
  }

  return null;
}

function loadConfigFromEnv(): Config | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY || "";
  const secretKey = process.env.LANGFUSE_SECRET_KEY || "";
  if (!publicKey || !secretKey) {
    return null;
  }

  return {
    publicKey,
    secretKey,
    host: process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || DEFAULT_LANGFUSE_HOST,
  };
}

function saveConfig(config: Config) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

// ============================================
// Langfuse SDK facade (lazy-loaded)
// ============================================

interface LangfuseObservation {
  id?: string;
  traceId?: string;
  update(body?: ObservationUpdate): LangfuseObservation;
  end(body?: ObservationUpdate): void;
  startObservation?(
    name: string,
    body?: ObservationUpdate,
    options?: { asType?: "agent" | "generation" | "tool" | "span" },
  ): LangfuseObservation;
  setTraceIO?(body?: { input?: unknown; output?: unknown }): void;
}

interface ObservationUpdate {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  model?: string;
  usageDetails?: Record<string, number>;
  usage?: Record<string, number>;
  costDetails?: Record<string, number>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
}

interface LangfuseScoreClient {
  score?: {
    create(body: {
      traceId?: string;
      sessionId?: string;
      observationId?: string;
      name: string;
      value: number;
      dataType?: "NUMERIC" | "BOOLEAN";
    }): unknown;
  };
  flush?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}

interface LangfuseRuntime {
  startObservation: (
    name: string,
    body?: ObservationUpdate,
    options?: { asType?: "agent" | "generation" | "tool" | "span" },
  ) => LangfuseObservation;
  propagateAttributes: (
    params: {
      sessionId?: string;
      traceName?: string;
      metadata?: Record<string, string>;
      tags?: string[];
    },
    fn: () => LangfuseObservation,
  ) => LangfuseObservation;
  scoreClient: LangfuseScoreClient;
  spanProcessor?: { forceFlush?: () => Promise<void>; shutdown?: () => Promise<void> };
  sdk?: { start?: () => void; shutdown?: () => Promise<void> };
}

let runtime: LangfuseRuntime | null = null;
let config: Config | null = loadConfigFromFile() ?? loadConfigFromEnv();
let setupAttemptedThisSession = false;

async function getRuntime(): Promise<LangfuseRuntime> {
  if (!config) {
    throw new Error("Langfuse config is not set");
  }

  if (!runtime) {
    const [{ NodeSDK }, { LangfuseSpanProcessor }, tracing, { LangfuseClient }] = await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@langfuse/otel"),
      import("@langfuse/tracing"),
      import("@langfuse/client"),
    ]);

    const spanProcessor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.host,
    });
    const sdk = new NodeSDK({ spanProcessors: [spanProcessor] });
    sdk.start();

    runtime = {
      startObservation: tracing.startObservation as unknown as LangfuseRuntime["startObservation"],
      propagateAttributes: tracing.propagateAttributes as unknown as LangfuseRuntime["propagateAttributes"],
      scoreClient: new LangfuseClient({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.host,
      }) as LangfuseScoreClient,
      spanProcessor,
      sdk,
    };
  }

  return runtime as LangfuseRuntime;
}

async function shutdownRuntime(): Promise<void> {
  if (!runtime) {
    return;
  }

  try {
    await runtime.scoreClient.flush?.();
    await runtime.scoreClient.shutdown?.();
    await runtime.spanProcessor?.forceFlush?.();
    await runtime.spanProcessor?.shutdown?.();
    await runtime.sdk?.shutdown?.();
  } catch (e) {
    console.warn("📊 Langfuse: Failed to flush/shutdown cleanly", e);
  } finally {
    runtime = null;
  }
}

// ============================================
// State
// ============================================

interface GenerationState {
  observation: LangfuseObservation;
  requestKey: string;
  ended: boolean;
  metadata: Record<string, unknown>;
}

interface ToolState {
  observation: LangfuseObservation;
  toolName: string;
  ended: boolean;
}

interface AgentState {
  root?: LangfuseObservation;
  traceId?: string;
  promptInput?: unknown;
  cwd?: string;
  generationSeq: number;
  activeGenerations: Map<string, GenerationState>;
  generationOrder: string[];
  activeTools: Map<string, ToolState>;
  latestAssistantOutput?: unknown;
  providerMetadataByRequest: Map<string, Record<string, unknown>>;
}

let currentSessionId = "";
let currentModel = "";
let currentProvider = "";
let agentState: AgentState | null = null;

// Evaluation tracking state
let toolCallCount = 0;
let errorCount = 0;
let turnCount = 0;

const MAX_STRING_LENGTH = 12_000;
const MAX_TOOL_PAYLOAD_LENGTH = 24_000;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 80;

function truncate(value: string, maxLength = MAX_STRING_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value;
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function shapePayload(value: unknown, options: { maxString?: number; depth?: number } = {}): unknown {
  const maxString = options.maxString ?? MAX_STRING_LENGTH;
  const depth = options.depth ?? MAX_DEPTH;

  function visit(item: unknown, remainingDepth: number, seen: WeakSet<object>): unknown {
    if (typeof item === "string") {
      const truncated = truncate(item, maxString);
      const parsed = tryParseJson(truncated);
      if (parsed === truncated) {
        return truncated;
      }
      return visit(parsed, remainingDepth - 1, seen);
    }

    if (
      item === null ||
      typeof item === "undefined" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      return item;
    }

    if (typeof item === "bigint") {
      return item.toString();
    }

    if (typeof item === "function" || typeof item === "symbol") {
      return `[${typeof item}]`;
    }

    if (remainingDepth <= 0) {
      return `[max depth ${depth} reached]`;
    }

    if (Array.isArray(item)) {
      return item.slice(0, MAX_ARRAY_ITEMS).map((entry) => visit(entry, remainingDepth - 1, seen));
    }

    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack ? truncate(item.stack, maxString) : undefined,
      };
    }

    if (typeof item === "object") {
      if (seen.has(item)) {
        return "[circular]";
      }
      seen.add(item);

      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
        output[key] = visit(entry, remainingDepth - 1, seen);
      }
      return output;
    }

    return String(item);
  }

  return visit(value, depth, new WeakSet<object>());
}

function safeSerialize(value: unknown, maxLength = MAX_TOOL_PAYLOAD_LENGTH): string {
  try {
    return truncate(JSON.stringify(shapePayload(value, { maxString: maxLength }), null, 2), maxLength);
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}

function extractTextContent(content: unknown, maxLength?: number): string | undefined {
  if (typeof content === "string") {
    return maxLength ? truncate(content, maxLength) : content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const block = item as { type?: string; text?: string; thinking?: string };
      return block.type === "text" && block.text ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");

  if (!text) {
    return undefined;
  }

  return maxLength ? truncate(text, maxLength) : text;
}

function extractToolCalls(message: Record<string, unknown>): unknown | undefined {
  return (
    message.toolCalls ??
    message.tool_calls ??
    message.function_calls ??
    (message.content && Array.isArray(message.content)
      ? message.content.filter((block) => {
          return block && typeof block === "object" && ["tool_use", "tool_call"].includes(String((block as { type?: string }).type));
        })
      : undefined)
  );
}

function extractAssistantOutput(message: unknown): unknown | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  const msg = message as Record<string, unknown>;
  const text = extractTextContent(msg.content);
  if (text) {
    return text;
  }

  const toolCalls = extractToolCalls(msg);
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return { toolCalls: shapePayload(toolCalls) };
  }

  if (toolCalls) {
    return { toolCalls: shapePayload(toolCalls) };
  }

  return shapePayload(msg);
}

function extractFinalAssistant(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  return messages.filter((message) => message?.role === "assistant").pop() as Record<string, unknown> | undefined;
}

function getRequestKey(event: Record<string, unknown>, fallback: string): string {
  return String(
    event.requestId ??
      event.providerRequestId ??
      event.messageId ??
      event.turnId ??
      event.turnIndex ??
      event.id ??
      fallback,
  );
}

function getToolCallId(event: Record<string, unknown>): string | undefined {
  const id = event.toolCallId ?? event.id ?? event.callId ?? event.tool_use_id ?? event.toolUseId;
  return id === undefined || id === null ? undefined : String(id);
}

function getToolName(event: Record<string, unknown>): string {
  return String(
    event.toolName ??
      event.name ??
      event.tool ??
      event.functionName ??
      (event.call && typeof event.call === "object" ? (event.call as Record<string, unknown>).name : undefined) ??
      "tool",
  );
}

function getToolInput(event: Record<string, unknown>): unknown {
  return (
    event.input ??
    event.args ??
    event.arguments ??
    event.params ??
    (event.call && typeof event.call === "object" ? (event.call as Record<string, unknown>).input : undefined) ??
    event
  );
}

function getProviderPayload(event: Record<string, unknown>): unknown {
  return event.request ?? event.payload ?? event.body ?? event.providerPayload ?? event.messages ?? event;
}

function getMessageFromEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.message && typeof event.message === "object") {
    return event.message as Record<string, unknown>;
  }
  if (event.role || event.content) {
    return event;
  }
  return undefined;
}

function extractUsage(messageOrEvent: Record<string, unknown>): Record<string, number> | undefined {
  const usage = (messageOrEvent.usage ??
    (messageOrEvent.message && typeof messageOrEvent.message === "object"
      ? (messageOrEvent.message as Record<string, unknown>).usage
      : undefined)) as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const input = Number(usage.input ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const output = Number(usage.output ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0);
  const total = Number(usage.total ?? usage.totalTokens ?? usage.total_tokens ?? input + output);
  const cacheRead = Number(usage.cacheRead ?? usage.cache_read ?? usage.cachedTokens ?? 0);
  const cacheWrite = Number(usage.cacheWrite ?? usage.cache_write ?? 0);

  return {
    input,
    output,
    total,
    ...(cacheRead ? { cacheRead } : {}),
    ...(cacheWrite ? { cacheWrite } : {}),
  };
}

function extractCostDetails(messageOrEvent: Record<string, unknown>): Record<string, number> | undefined {
  const usage = (messageOrEvent.usage ??
    (messageOrEvent.message && typeof messageOrEvent.message === "object"
      ? (messageOrEvent.message as Record<string, unknown>).usage
      : undefined)) as Record<string, unknown> | undefined;
  const cost = (messageOrEvent.cost ?? usage?.cost ?? messageOrEvent.costDetails) as Record<string, unknown> | undefined;
  if (!cost || typeof cost !== "object") {
    return undefined;
  }

  const input = Number(cost.input ?? cost.inputCost ?? 0);
  const output = Number(cost.output ?? cost.outputCost ?? 0);
  const total = Number(cost.total ?? cost.totalCost ?? input + output);

  return { input, output, total };
}

function extractResponseMetadata(event: Record<string, unknown>): Record<string, unknown> {
  return shapePayload(
    {
      status: event.status ?? event.statusCode ?? event.httpStatus,
      headers: event.headers,
      responseHeaders: event.responseHeaders,
      providerMetadata: event.providerMetadata ?? event.metadata,
      requestId: event.requestId ?? event.providerRequestId,
    },
    { depth: 4, maxString: 4_000 },
  ) as Record<string, unknown>;
}

function updateTraceIO(input?: unknown, output?: unknown) {
  const root = agentState?.root;
  if (!root?.setTraceIO) {
    return;
  }

  try {
    root.setTraceIO({ input, output });
  } catch {
    // Older SDKs may omit setTraceIO; root IO still mirrors trace IO in current Langfuse.
  }
}

function resetRunState() {
  agentState = null;
  toolCallCount = 0;
  errorCount = 0;
  turnCount = 0;
}

function computeEvaluationScores() {
  const toolSuccessRate = toolCallCount > 0 ? (toolCallCount - errorCount) / toolCallCount : 1;
  const sessionHadErrors = errorCount > 0;

  return {
    tool_call_count: toolCallCount,
    turn_count: turnCount,
    total_tool_errors: errorCount,
    tool_success_rate: toolSuccessRate,
    session_had_errors: sessionHadErrors ? 1 : 0,
  };
}

async function sendScore(name: string, value: number, options: { traceId?: string; observationId?: string } = {}) {
  try {
    const rt = await getRuntime();
    rt.scoreClient.score?.create({
      name,
      value,
      dataType: name === "session_had_errors" || name === "tool_is_error" ? "BOOLEAN" : "NUMERIC",
      traceId: options.traceId,
      observationId: options.observationId,
      sessionId: options.traceId ? undefined : currentSessionId || undefined,
    });
  } catch (e) {
    console.warn(`📊 Langfuse: Failed to send score ${name}`, e);
  }
}

async function ensureConfig(ctx: any): Promise<boolean> {
  if (config) {
    return true;
  }

  if (setupAttemptedThisSession) {
    return false;
  }
  setupAttemptedThisSession = true;

  if (!ctx.hasUI) {
    console.log("📊 Langfuse: Missing config. Run this extension in Pi UI to complete setup, or set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL.");
    return false;
  }

  ctx.ui.notify("Langfuse setup required. Enter your API keys to enable tracing.", "info");

  const publicKey = (await ctx.ui.input("Langfuse public key:", "pk-lf-..."))?.trim();
  if (!publicKey) {
    ctx.ui.notify("Langfuse setup cancelled.", "warning");
    return false;
  }

  const secretKey = (await ctx.ui.input("Langfuse secret key:", "sk-lf-..."))?.trim();
  if (!secretKey) {
    ctx.ui.notify("Langfuse setup cancelled.", "warning");
    return false;
  }

  const hostInput = (await ctx.ui.input("Langfuse host:", DEFAULT_LANGFUSE_HOST))?.trim();
  config = {
    publicKey,
    secretKey,
    host: hostInput || DEFAULT_LANGFUSE_HOST,
  };

  try {
    saveConfig(config);
    ctx.ui.notify(`Langfuse config saved to ${CONFIG_PATH}`, "info");
    return true;
  } catch (error) {
    console.warn("📊 Langfuse: Failed to save config.json", error);
    ctx.ui.notify("Failed to save Langfuse config.json. Check extension directory permissions.", "error");
    config = null;
    return false;
  }
}

async function promptForConfig(ctx: any): Promise<boolean> {
  setupAttemptedThisSession = false;
  config = null;
  await shutdownRuntime();
  return ensureConfig(ctx);
}

async function startAgentRun(event: Record<string, unknown>, ctx: any) {
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

    if (!currentModel && ctx.model) {
      currentModel = ctx.model.id || "";
      currentProvider = ctx.model.provider || "";
    }

    const promptInput = shapePayload({
      prompt: event.prompt,
      images: event.images,
      context: event.context ?? event.attachments,
    });

    agentState = {
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
        sessionId: currentSessionId ? truncate(currentSessionId, 200) : undefined,
        traceName: "pi-agent",
        metadata: {
          cwd: truncate(cwd, 200),
          ...(currentModel ? { model: truncate(currentModel, 200) } : {}),
          ...(currentProvider ? { provider: truncate(currentProvider, 200) } : {}),
        },
      },
      () =>
        rt.startObservation(
          "pi-agent",
          {
            input: promptInput,
            metadata: {
              cwd,
              model: currentModel || undefined,
              provider: currentProvider || undefined,
              sessionId: currentSessionId || undefined,
            },
          },
          { asType: "agent" },
        ),
    );

    agentState.root = root;
    agentState.traceId = root.traceId;
    updateTraceIO(promptInput, undefined);
  } catch (e) {
    console.warn("📊 Langfuse: Failed to create agent observation", e);
  }
}

function getOpenGeneration(): GenerationState | undefined {
  if (!agentState) {
    return undefined;
  }

  for (let i = agentState.generationOrder.length - 1; i >= 0; i--) {
    const key = agentState.generationOrder[i];
    const state = agentState.activeGenerations.get(key);
    if (state && !state.ended) {
      return state;
    }
  }

  return undefined;
}

async function startGeneration(event: Record<string, unknown>) {
  if (!agentState?.root) {
    return;
  }

  try {
    const key = getRequestKey(event, `generation-${++agentState.generationSeq}`);
    const payload = getProviderPayload(event);
    const model = String(event.model ?? event.modelId ?? currentModel ?? "");
    const provider = String(event.provider ?? currentProvider ?? "");
    const metadata = shapePayload({
      provider,
      requestId: key,
      url: event.url,
      method: event.method,
    }) as Record<string, unknown>;

    const generation = agentState.root.startObservation
      ? agentState.root.startObservation(
          "llm-generation",
          {
            input: shapePayload(payload),
            model: model || undefined,
            metadata,
          },
          { asType: "generation" },
        )
      : (await getRuntime()).startObservation(
          "llm-generation",
          {
            input: shapePayload(payload),
            model: model || undefined,
            metadata,
          },
          { asType: "generation" },
        );

    agentState.activeGenerations.set(key, {
      observation: generation,
      requestKey: key,
      ended: false,
      metadata,
    });
    agentState.generationOrder.push(key);
  } catch (e) {
    console.warn("📊 Langfuse: Failed to start generation", e);
  }
}

function updateGenerationMetadata(event: Record<string, unknown>) {
  if (!agentState) {
    return;
  }

  const key = getRequestKey(event, "");
  const metadata = extractResponseMetadata(event);
  if (!key) {
    const generation = getOpenGeneration();
    if (generation) {
      generation.metadata = { ...generation.metadata, ...metadata };
      generation.observation.update({ metadata: generation.metadata });
    }
    return;
  }

  const generation = agentState.activeGenerations.get(key) ?? getOpenGeneration();
  if (generation) {
    generation.metadata = { ...generation.metadata, ...metadata };
    generation.observation.update({ metadata: generation.metadata });
  }
}

async function finishGenerationFromMessage(event: Record<string, unknown>) {
  if (!agentState) {
    return;
  }

  const message = getMessageFromEvent(event);
  if (!message || message.role !== "assistant") {
    return;
  }

  const generation = getOpenGeneration();
  const output = extractAssistantOutput(message);
  agentState.latestAssistantOutput = output;

  if (!generation) {
    return;
  }

  const usageDetails = extractUsage({ ...event, message });
  const costDetails = extractCostDetails({ ...event, message });
  const model = String(message.model ?? event.model ?? currentModel ?? "");
  const update: ObservationUpdate = {
    output,
    model: model || undefined,
    usageDetails,
    costDetails,
    metadata: {
      ...generation.metadata,
      finishReason: message.finishReason ?? message.stopReason ?? event.finishReason,
    },
  };

  try {
    generation.observation.update(update).end();
    generation.ended = true;
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish generation", e);
  }
}

async function createFallbackGenerationFromTurn(event: Record<string, unknown>, message: Record<string, unknown>) {
  if (!agentState?.root || agentState.generationOrder.length > 0) {
    return;
  }

  try {
    const usageDetails = extractUsage({ ...event, message });
    const costDetails = extractCostDetails({ ...event, message });
    const model = String(message.model ?? event.model ?? currentModel ?? "");
    const generation = agentState.root.startObservation
      ? agentState.root.startObservation(
          "llm-generation",
          {
            input: agentState.promptInput,
            output: extractAssistantOutput(message),
            model: model || undefined,
            usageDetails,
            costDetails,
            metadata: {
              provider: currentProvider || undefined,
              sourceEvent: "turn_end",
            },
          },
          { asType: "generation" },
        )
      : (await getRuntime()).startObservation(
          "llm-generation",
          {
            input: agentState.promptInput,
            output: extractAssistantOutput(message),
            model: model || undefined,
            usageDetails,
            costDetails,
            metadata: {
              provider: currentProvider || undefined,
              sourceEvent: "turn_end",
            },
          },
          { asType: "generation" },
        );

    generation.end();
    agentState.generationOrder.push("turn-end-fallback");
  } catch (e) {
    console.warn("📊 Langfuse: Failed to create fallback generation", e);
  }
}

async function startToolObservation(event: Record<string, unknown>) {
  if (!agentState?.root) {
    return;
  }

  const toolCallId = getToolCallId(event);
  if (!toolCallId || agentState.activeTools.has(toolCallId)) {
    return;
  }

  try {
    const toolName = getToolName(event);
    const tool = agentState.root.startObservation
      ? agentState.root.startObservation(
          toolName,
          {
            input: shapePayload(getToolInput(event), { maxString: MAX_TOOL_PAYLOAD_LENGTH }),
            metadata: { toolName, toolCallId },
          },
          { asType: "tool" },
        )
      : (await getRuntime()).startObservation(
          toolName,
          {
            input: shapePayload(getToolInput(event), { maxString: MAX_TOOL_PAYLOAD_LENGTH }),
            metadata: { toolName, toolCallId },
          },
          { asType: "tool" },
        );

    toolCallCount++;
    agentState.activeTools.set(toolCallId, { observation: tool, toolName, ended: false });
  } catch (e) {
    console.warn("📊 Langfuse: Failed to start tool observation", e);
  }
}

async function finishToolObservation(event: Record<string, unknown>) {
  if (!agentState) {
    return;
  }

  const toolCallId = getToolCallId(event);
  if (!toolCallId) {
    return;
  }

  const state = agentState.activeTools.get(toolCallId);
  if (!state || state.ended) {
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
    state.observation
      .update({
        output: shapePayload(output, { maxString: MAX_TOOL_PAYLOAD_LENGTH }),
        level: isError ? "ERROR" : "DEFAULT",
        statusMessage: isError ? truncate(String(event.error ?? output), 1_000) : undefined,
        metadata: {
          toolName: state.toolName,
          toolCallId,
          isError,
        },
      })
      .end();
    state.ended = true;

    if (isError) {
      errorCount++;
      await sendScore("tool_is_error", 1, {
        traceId: agentState.traceId,
        observationId: state.observation.id,
      });
    }
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish tool observation", e);
  } finally {
    agentState.activeTools.delete(toolCallId);
  }
}

function closeDanglingObservations(statusMessage: string) {
  if (!agentState) {
    return;
  }

  for (const state of agentState.activeTools.values()) {
    if (!state.ended) {
      state.observation
        .update({ level: "WARNING", statusMessage, metadata: { toolName: state.toolName, cancelled: true } })
        .end();
      state.ended = true;
    }
  }

  for (const state of agentState.activeGenerations.values()) {
    if (!state.ended) {
      state.observation.update({ level: "WARNING", statusMessage, metadata: { ...state.metadata, cancelled: true } }).end();
      state.ended = true;
    }
  }

  agentState.activeTools.clear();
}

async function finishAgentRun(event: Record<string, unknown> = {}) {
  if (!agentState?.root) {
    resetRunState();
    return;
  }

  const lastAssistant = extractFinalAssistant(event.messages);
  const output = lastAssistant ? extractAssistantOutput(lastAssistant) : agentState.latestAssistantOutput;
  const scores = computeEvaluationScores();

  closeDanglingObservations("Agent run ended before observation finalized");

  try {
    agentState.root
      .update({
        output,
        metadata: {
          cwd: agentState.cwd,
          completed: true,
          model: currentModel || undefined,
          provider: currentProvider || undefined,
          totalTools: toolCallCount,
          ...scores,
        },
      })
      .end();
    updateTraceIO(agentState.promptInput, output);

    await sendScore("tool_call_count", scores.tool_call_count, { traceId: agentState.traceId });
    await sendScore("turn_count", scores.turn_count, { traceId: agentState.traceId });
    await sendScore("total_tool_errors", scores.total_tool_errors, { traceId: agentState.traceId });
    await sendScore("tool_success_rate", scores.tool_success_rate, { traceId: agentState.traceId });
    await sendScore("session_had_errors", scores.session_had_errors, { traceId: agentState.traceId });
  } catch (e) {
    console.warn("📊 Langfuse: Failed to finish agent observation", e);
  } finally {
    resetRunState();
  }
}

// ============================================
// Extension
// ============================================

export default async function (pi: ExtensionAPI) {
  if (config) {
    console.log("📊 Langfuse: Tracing enabled →", config.host);
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
    setupAttemptedThisSession = false;
    await ensureConfig(ctx);
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      currentSessionId = basename(sessionFile, ".jsonl");
    }
    resetRunState();
  });

  pi.on("model_select", async (event) => {
    currentModel = event.model?.id || "";
    currentProvider = event.model?.provider || "";
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await startAgentRun(event, ctx);
  });

  pi.on("agent_start", async (event, ctx) => {
    if (!agentState?.root) {
      await startAgentRun(event, ctx);
    }
  });

  pi.on("before_provider_request", async (event) => {
    await startGeneration(event);
  });

  pi.on("after_provider_response", async (event) => {
    updateGenerationMetadata(event);
  });

  pi.on("message_update", async (event) => {
    const message = getMessageFromEvent(event);
    if (message?.role === "assistant" && agentState) {
      agentState.latestAssistantOutput = extractAssistantOutput(message);
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
    turnCount++;
    const message = getMessageFromEvent(event);
    if (message?.role === "assistant") {
      await createFallbackGenerationFromTurn(event, message);
      await finishGenerationFromMessage(event);
    }
  });

  pi.on("agent_end", async (event) => {
    await finishAgentRun(event);
    await shutdownRuntime();
  });

  pi.on("session_shutdown", async () => {
    if (agentState?.root) {
      closeDanglingObservations("Session shutdown before agent completed");
      agentState.root.update({ metadata: { completed: false, cancelled: true } }).end();
    }
    resetRunState();
    await shutdownRuntime();
  });
}
