import { existsSync, readFileSync } from "node:fs";

import { CONFIG_PATH } from "./constants.js";
import { loadConfig, saveConfig, ensureConfig } from "./config.js";
import { createCapturePolicy, type PrivacyPreset, type CapturePolicy } from "./capture-policy.js";
import { getRuntime, forceShutdownRuntime as shutdownLangfuseRuntime } from "./langfuse.js";
import { state } from "./state.js";
import type { LangfuseRuntime } from "./types.js";

const PRIVACY_PRESETS = ["metadata-only", "prompts-only", "conversations", "full-debug"] as const;

export interface CommandContextLike {
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level?: "info" | "warning" | "error") => void;
  };
}

interface CommandDeps {
  configPath?: string;
  getRuntime?: () => Promise<LangfuseRuntime>;
  forceShutdownRuntime?: () => Promise<void>;
}

function notify(ctx: CommandContextLike, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(message, level);
    return;
  }
  const prefix = level === "error" ? "❌" : level === "warning" ? "⚠️" : "📊";
  console.log(`${prefix} Langfuse: ${message}`);
}

function parseCommandArgs(args: string): { values: Record<string, string>; positional: string[]; malformed: string[] } {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const malformed: string[] = [];

  for (const part of args.trim().split(/\s+/)) {
    if (!part) {
      continue;
    }
    const eq = part.indexOf("=");
    if (eq === -1) {
      positional.push(part);
      continue;
    }
    if (eq === 0) {
      malformed.push(part);
      continue;
    }
    values[part.slice(0, eq)] = part.slice(eq + 1);
  }

  return { values, positional, malformed };
}

function isPrivacyPreset(value: string | undefined): value is PrivacyPreset {
  return PRIVACY_PRESETS.includes(value as PrivacyPreset);
}

function inferPreset(policy: CapturePolicy): PrivacyPreset | "custom" {
  const entries: Array<[PrivacyPreset, CapturePolicy]> = [
    [
      "metadata-only",
      {
        captureInputs: false,
        captureOutputs: false,
        captureToolIo: false,
        captureSystemPrompt: false,
        captureCwd: false,
      },
    ],
    [
      "prompts-only",
      {
        captureInputs: true,
        captureOutputs: false,
        captureToolIo: false,
        captureSystemPrompt: false,
        captureCwd: false,
      },
    ],
    [
      "conversations",
      {
        captureInputs: true,
        captureOutputs: true,
        captureToolIo: false,
        captureSystemPrompt: false,
        captureCwd: false,
      },
    ],
    [
      "full-debug",
      {
        captureInputs: true,
        captureOutputs: true,
        captureToolIo: true,
        captureSystemPrompt: true,
        captureCwd: true,
      },
    ],
  ];

  for (const [preset, presetPolicy] of entries) {
    if (
      policy.captureInputs === presetPolicy.captureInputs &&
      policy.captureOutputs === presetPolicy.captureOutputs &&
      policy.captureToolIo === presetPolicy.captureToolIo &&
      policy.captureSystemPrompt === presetPolicy.captureSystemPrompt &&
      policy.captureCwd === presetPolicy.captureCwd
    ) {
      return preset;
    }
  }
  return "custom";
}

function describePolicy(policy: CapturePolicy) {
  return [
    `captureInputs: ${policy.captureInputs}`,
    `captureOutputs: ${policy.captureOutputs}`,
    `captureToolIo: ${policy.captureToolIo}`,
    `captureSystemPrompt: ${policy.captureSystemPrompt}`,
    `captureCwd: ${policy.captureCwd}`,
  ].join("\n");
}

function readPersistedConfig(path: string) {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hasActiveAgentObservation() {
  for (const sessionState of state.sessionStates.values()) {
    if (sessionState.agentState?.root) {
      return true;
    }
  }
  return false;
}

export async function handleLangfusePrivacyCommand(
  args: string,
  ctx: CommandContextLike,
  deps: CommandDeps = {},
): Promise<boolean> {
  const configPath = deps.configPath ?? CONFIG_PATH;
  const parsed = parseCommandArgs(args);
  if (parsed.malformed.length > 0) {
    notify(ctx, `Couldn't understand '${parsed.malformed[0]}'. Use /langfuse-privacy preset=metadata-only.`, "warning");
    return false;
  }

  const requestedPreset = parsed.values.preset ?? parsed.positional[0];
  if (!requestedPreset) {
    state.config = state.config ?? loadConfig(process.env, configPath);
    const policy = state.config?.capturePolicy ?? createCapturePolicy();
    notify(ctx, `Current Langfuse privacy preset: ${inferPreset(policy)}\n${describePolicy(policy)}`);
    return true;
  }

  if (!isPrivacyPreset(requestedPreset)) {
    notify(
      ctx,
      `Unknown privacy preset '${requestedPreset}'. Use one of: ${PRIVACY_PRESETS.join(", ")}.`,
      "warning",
    );
    return false;
  }

  const existing = readPersistedConfig(configPath);
  const loaded = state.config ?? loadConfig(process.env, configPath);
  
  const publicKey = existing.publicKey ?? loaded?.publicKey;
  const secretKey = existing.secretKey ?? loaded?.secretKey;
  const host = existing.host ?? loaded?.host;

  if (!publicKey || !secretKey || !host) {
    notify(ctx, "Langfuse is not configured yet. Run /langfuse-setup before changing privacy settings.", "warning");
    return false;
  }

  const nextConfig = {
    publicKey: String(publicKey),
    secretKey: String(secretKey),
    host: String(host),
    privacyPreset: requestedPreset,
  };
  saveConfig(nextConfig, configPath);
  state.config = loadConfig(process.env, configPath);

  notify(ctx, `Langfuse privacy preset saved: ${requestedPreset}\n${describePolicy(state.config?.capturePolicy ?? createCapturePolicy())}`);
  return true;
}

export async function handleLangfuseTestCommand(
  _args: string,
  ctx: CommandContextLike,
  deps: CommandDeps = {},
): Promise<boolean> {
  if (!state.config && !(await ensureConfig(ctx))) {
    notify(ctx, "Langfuse is not configured yet. Run /langfuse-setup first.", "warning");
    return false;
  }

  if (hasActiveAgentObservation()) {
    notify(ctx, "Langfuse test skipped because an agent run is active. Try again after the run finishes.", "warning");
    return false;
  }

  let runtimeInitialized = false;
  try {
    const rt = await (deps.getRuntime ?? getRuntime)();
    runtimeInitialized = true;
    rt.propagateAttributes(
      {
        traceName: "pi-langfuse-test",
        metadata: {
          source: "pi-langfuse",
          command: "langfuse-test",
        },
      },
      () => {
        const observation = rt.startObservation(
          "pi-langfuse-test",
          {
            input: { command: "/langfuse-test" },
            output: "ok",
            metadata: {
              source: "pi-langfuse",
              command: "langfuse-test",
            },
          },
          { asType: "span" },
        );
        observation.end();
        return observation;
      },
    );
    await rt.tracerProvider?.forceFlush?.();
    await rt.scoreClient.flush?.();
    notify(ctx, `Langfuse test succeeded. Test trace sent to ${state.config?.host}.`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notify(ctx, `Langfuse test failed: ${message}`, "error");
    return false;
  } finally {
    if (runtimeInitialized) {
      await (deps.forceShutdownRuntime ?? shutdownLangfuseRuntime)();
    }
  }
}
