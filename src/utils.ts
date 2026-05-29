import {
  MAX_ARRAY_ITEMS,
  MAX_DEPTH,
  MAX_OBJECT_KEYS,
  MAX_PAYLOAD_NODES,
  MAX_STRING_LENGTH,
  MAX_TOOL_PAYLOAD_LENGTH,
} from "./constants.js";

export function truncate(value: string, maxLength = MAX_STRING_LENGTH): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value;
}

export function tryParseJson(value: string): unknown {
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

const PAYLOAD_TOO_LARGE = "[payload too large]";

export function shapePayload(value: unknown, options: { maxString?: number; depth?: number; maxNodes?: number } = {}): unknown {
  const maxString = options.maxString ?? MAX_STRING_LENGTH;
  const depth = options.depth ?? MAX_DEPTH;
  const maxNodes = options.maxNodes ?? MAX_PAYLOAD_NODES;
  const budget = { exhausted: false, nodeCount: 0 };

  function visit(item: unknown, remainingDepth: number, seen: WeakSet<object>): unknown {
    if (budget.exhausted) {
      return PAYLOAD_TOO_LARGE;
    }

    budget.nodeCount++;
    if (budget.nodeCount > maxNodes) {
      budget.exhausted = true;
      return PAYLOAD_TOO_LARGE;
    }

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
      const output: unknown[] = [];
      const limit = Math.min(item.length, MAX_ARRAY_ITEMS);
      for (let index = 0; index < limit; index++) {
        output.push(visit(item[index], remainingDepth - 1, seen));
        if (budget.exhausted) {
          break;
        }
      }
      return output;
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
      let keyCount = 0;
      for (const key in item as Record<string, unknown>) {
        if (!Object.hasOwn(item, key)) {
          continue;
        }
        output[key] = visit((item as Record<string, unknown>)[key], remainingDepth - 1, seen);
        keyCount++;
        if (budget.exhausted || keyCount >= MAX_OBJECT_KEYS) {
          break;
        }
      }
      return output;
    }

    return String(item);
  }

  return visit(value, depth, new WeakSet<object>());
}

export function safeSerialize(value: unknown, maxLength = MAX_TOOL_PAYLOAD_LENGTH): string {
  try {
    return truncate(JSON.stringify(shapePayload(value, { maxString: maxLength }), null, 2), maxLength);
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}

export function estimatePayloadBytes(value: unknown, maxLength = MAX_TOOL_PAYLOAD_LENGTH): number {
  return new TextEncoder().encode(safeSerialize(value, maxLength)).length;
}

export function extractTextContent(content: unknown, maxLength?: number): string | undefined {
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

export function extractToolCalls(message: Record<string, unknown>): unknown | undefined {
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

export function extractAssistantOutput(message: unknown): unknown | undefined {
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

export function extractFinalAssistant(messages: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  return messages.filter((message) => message?.role === "assistant").pop() as Record<string, unknown> | undefined;
}

export function getRequestKey(event: Record<string, unknown>, fallback: string): string {
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

export function getToolCallId(event: Record<string, unknown>): string | undefined {
  const id = event.toolCallId ?? event.id ?? event.callId ?? event.tool_use_id ?? event.toolUseId;
  return id === undefined || id === null ? undefined : String(id);
}

export function getToolName(event: Record<string, unknown>): string {
  return String(
    event.toolName ??
      event.name ??
      event.tool ??
      event.functionName ??
      (event.call && typeof event.call === "object" ? (event.call as Record<string, unknown>).name : undefined) ??
      "tool",
  );
}

export function getToolInput(event: Record<string, unknown>): unknown {
  return (
    event.input ??
    event.args ??
    event.arguments ??
    event.params ??
    (event.call && typeof event.call === "object" ? (event.call as Record<string, unknown>).input : undefined) ??
    event
  );
}

export function getProviderPayload(event: Record<string, unknown>): unknown {
  return event.request ?? event.payload ?? event.body ?? event.providerPayload ?? event.messages ?? event;
}

export function getMessageFromEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.message && typeof event.message === "object") {
    return event.message as Record<string, unknown>;
  }
  if (event.role || event.content) {
    return event;
  }
  return undefined;
}

export function extractUsage(messageOrEvent: Record<string, unknown>): Record<string, number> | undefined {
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

export function extractCostDetails(messageOrEvent: Record<string, unknown>): Record<string, number> | undefined {
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

export function extractResponseMetadata(event: Record<string, unknown>): Record<string, unknown> {
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
