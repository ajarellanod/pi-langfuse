import { readFileSync, existsSync, writeFileSync } from "node:fs";
import type { Config } from "./types.js";
import { CONFIG_PATH, DEFAULT_LANGFUSE_HOST } from "./constants.js";
import { state } from "./state.js";
import { shutdownRuntime } from "./langfuse.js";

export function loadConfigFromFile(): Config | null {
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

export function loadConfigFromEnv(): Config | null {
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

export function saveConfig(config: Config) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

async function collectConfigFromUI(ctx: any, reason: string): Promise<Config | null> {
  if (!ctx.hasUI) {
    console.log(`📊 Langfuse: ${reason}. Run this extension in Pi UI to complete setup, or set LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL.`);
    return null;
  }

  ctx.ui.notify("Langfuse setup required. Enter your API keys to enable tracing.", "info");

  const publicKey = (await ctx.ui.input("Langfuse public key:", "pk-lf-..."))?.trim();
  if (!publicKey) {
    ctx.ui.notify("Langfuse setup cancelled.", "warning");
    return null;
  }

  const secretKey = (await ctx.ui.input("Langfuse secret key:", "sk-lf-..."))?.trim();
  if (!secretKey) {
    ctx.ui.notify("Langfuse setup cancelled.", "warning");
    return null;
  }

  const hostInput = (await ctx.ui.input("Langfuse host:", DEFAULT_LANGFUSE_HOST))?.trim();
  return {
    publicKey,
    secretKey,
    host: hostInput || DEFAULT_LANGFUSE_HOST,
  };
}

async function saveConfigFromUI(ctx: any, config: Config): Promise<boolean> {
  state.config = config;

  try {
    saveConfig(state.config);
    ctx.ui.notify(`Langfuse config saved to ${CONFIG_PATH}`, "info");
    return true;
  } catch (error) {
    console.warn("📊 Langfuse: Failed to save config.json", error);
    ctx.ui.notify("Failed to save Langfuse config.json. Check extension directory permissions.", "error");
    state.config = null;
    return false;
  }
}

export async function ensureConfig(ctx: any): Promise<boolean> {
  if (!state.config) {
    state.config = loadConfigFromEnv() || loadConfigFromFile();
  }

  if (state.config) {
    return true;
  }

  if (state.setupAttemptedThisSession) {
    return false;
  }
  state.setupAttemptedThisSession = true;

  const config = await collectConfigFromUI(ctx, "Missing config");
  if (!config) {
    return false;
  }

  return saveConfigFromUI(ctx, config);
}

export async function promptForConfig(ctx: any): Promise<boolean> {
  state.setupAttemptedThisSession = false;
  state.config = null;
  await shutdownRuntime();

  const config = await collectConfigFromUI(ctx, "Manual setup requested");
  if (!config) {
    state.config = loadConfigFromEnv() || loadConfigFromFile();
    return false;
  }

  const saved = await saveConfigFromUI(ctx, config);
  if (saved) {
    ctx.ui.notify("Langfuse tracing enabled for future agent runs.", "info");
  }
  return saved;
}
