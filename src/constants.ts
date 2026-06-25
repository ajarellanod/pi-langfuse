import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_DIR = resolve(homedir(), ".pi", "agent", "pi-langfuse");
export const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
export const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

export const MAX_STRING_LENGTH = 12_000;
export const MAX_TOOL_PAYLOAD_LENGTH = 24_000;
export const MAX_DEPTH = 6;
export const MAX_ARRAY_ITEMS = 50;
export const MAX_OBJECT_KEYS = 80;
export const MAX_PAYLOAD_NODES = 2_000;

let cachedExtensionVersion: string | undefined | null = null;

/**
 * Reads this extension's version from its package.json (resolved relative to the
 * compiled module). Used as the Langfuse trace `version` for deployment/regression
 * tracking. Cached after the first read; returns undefined if it cannot be resolved.
 */
export function getExtensionVersion(): string | undefined {
  if (cachedExtensionVersion !== null) {
    return cachedExtensionVersion;
  }
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    cachedExtensionVersion = typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    cachedExtensionVersion = undefined;
  }
  return cachedExtensionVersion;
}
