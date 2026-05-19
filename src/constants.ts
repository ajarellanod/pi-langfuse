import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Since we are in src/constants.ts, EXT_DIR should point to the parent of src/ (the root of the extension)
// We use `import.meta.url` which points to `src/constants.ts`.
// `dirname` gives us `src/`, and `resolve(..., '..')` gives us the root.
export const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = resolve(EXT_DIR, "config.json");
export const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

export const MAX_STRING_LENGTH = 12_000;
export const MAX_TOOL_PAYLOAD_LENGTH = 24_000;
export const MAX_DEPTH = 6;
export const MAX_ARRAY_ITEMS = 50;
export const MAX_OBJECT_KEYS = 80;
