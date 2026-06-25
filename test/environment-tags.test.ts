import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfigFromFile, loadConfigFromEnv } from "../src/config.ts";

function writeConfig(contents: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-langfuse-env-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(contents));
  return configPath;
}

test("reads environment and release from config.json", () => {
  const configPath = writeConfig({
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    host: "https://cloud.langfuse.com",
    environment: "staging",
    release: "1.2.3",
  });

  const config = loadConfigFromFile(configPath, {});

  assert.equal(config?.environment, "staging");
  assert.equal(config?.release, "1.2.3");
});

test("config.json environment wins, env release fills in when file omits it", () => {
  const configPath = writeConfig({
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    environment: "staging",
  });

  const config = loadConfigFromFile(configPath, {
    LANGFUSE_TRACING_ENVIRONMENT: "production",
    LANGFUSE_RELEASE: "9.9.9",
  });
  assert.equal(config?.environment, "staging");
  assert.equal(config?.release, "9.9.9");
});

test("env environment fills in when config.json omits it", () => {
  const configPath = writeConfig({
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
  });

  const config = loadConfigFromFile(configPath, {
    LANGFUSE_TRACING_ENVIRONMENT: "production",
  });
  assert.equal(config?.environment, "production");
});

test("loadConfigFromEnv resolves environment from either alias and release", () => {
  const fromAlias = loadConfigFromEnv({
    LANGFUSE_PUBLIC_KEY: "pk-lf-test",
    LANGFUSE_SECRET_KEY: "sk-lf-test",
    LANGFUSE_ENVIRONMENT: "qa",
    LANGFUSE_RELEASE: "2.0.0",
  });
  assert.equal(fromAlias?.environment, "qa");
  assert.equal(fromAlias?.release, "2.0.0");

  const fromTracingVar = loadConfigFromEnv({
    LANGFUSE_PUBLIC_KEY: "pk-lf-test",
    LANGFUSE_SECRET_KEY: "sk-lf-test",
    LANGFUSE_TRACING_ENVIRONMENT: "prod",
  });
  assert.equal(fromTracingVar?.environment, "prod");
  assert.equal(fromTracingVar?.release, undefined);
});

test("environment and release stay undefined when unset", () => {
  const config = loadConfigFromEnv({
    LANGFUSE_PUBLIC_KEY: "pk-lf-test",
    LANGFUSE_SECRET_KEY: "sk-lf-test",
  });
  assert.equal(config?.environment, undefined);
  assert.equal(config?.release, undefined);
});
