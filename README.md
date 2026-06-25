# pi-langfuse

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**English**](./README.md) | [**简体中文**](./README_CN.md)

## Credit & Attribution

This is a **fork** of [pi-langfuse](https://github.com/gooyoung/pi-langfuse), originally created by **gooyoung**. All credit for the original design and implementation belongs to the original author.

This fork adds further improvements while preserving the original MIT license and author credit. It is distributed from [github.com/ajarellanod/pi-langfuse](https://github.com/ajarellanod/pi-langfuse) and is **not published to npm**, so it is installed directly from the Git repository (see [Quick Start](#quick-start)).

Langfuse observability extension for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). It sends complete Pi runs to [Langfuse](https://langfuse.com) so the prompt, agent workflow, LLM generations, tool calls, final response, usage, cost, and health scores appear in one trace.

## What This Adds to Pi

- One Langfuse trace per user prompt, grouped by Pi session.
- Root `agent`, per-request `generation`, and per-tool `tool` observations.
- Final assistant output capture, tool error visibility, and trace-level scores.
- Privacy controls for inputs, outputs, tool I/O, system prompt, and cwd.
- Secret redaction and local path hashing before upload.
- REST fallback for self-hosted Langfuse setups where OTel spans arrive but traces do not materialize.

## Prerequisites

- **Node.js** >= 22
- **Pi Coding Agent** installed and configured
- A **Langfuse** account ([cloud](https://cloud.langfuse.com) or self-hosted)

## Quick Start

1. Install the extension from the Git repository:

   ```bash
   pi install git:github.com/ajarellanod/pi-langfuse
   ```

   > You can also install from a local clone with `pi install ./pi-langfuse` (or any path to the checked-out repo).

2. Run Pi once. If no credentials are configured yet, Pi prompts for:
   - Langfuse public key, starting with `pk-lf-...`
   - Langfuse secret key, starting with `sk-lf-...`
   - Langfuse host, defaulting to `https://cloud.langfuse.com`

3. Run Pi normally:

   ```bash
   pi "Explain the architecture of Redis"
   ```

4. Open Langfuse and inspect the new trace.

## Configuration

Langfuse API keys are available in **Langfuse Cloud** -> **Settings** -> **API Keys**.

### Method 1: Interactive setup

Run any `pi` command with the extension loaded. On first run without configuration, Pi prompts in the CLI or TUI and saves the result to `~/.pi/agent/pi-langfuse/config.json`.

To run setup again:

```text
/langfuse-setup
```

### Method 2: Environment variables

Set these before starting Pi:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-xxxx"
export LANGFUSE_SECRET_KEY="sk-lf-xxxx"
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"  # optional; LANGFUSE_HOST is also supported
```

Saved config takes precedence. Environment variables are only used when `~/.pi/agent/pi-langfuse/config.json` is missing or incomplete.

Privacy controls can also be set through environment variables:

```bash
export LANGFUSE_PRIVACY_PRESET="full-debug"
```

Available presets:

| Preset | Captures |
|--------|----------|
| `metadata-only` | Metadata only; omits inputs, outputs, tool I/O, system prompt, and cwd |
| `prompts-only` | Prompt/provider inputs plus metadata |
| `conversations` | Inputs and assistant outputs, but omits tool I/O, system prompt, and cwd |
| `full-debug` | Full trace detail; this is the default |

Fine-grained flags override presets:

```bash
export LANGFUSE_CAPTURE_INPUTS=true
export LANGFUSE_CAPTURE_OUTPUTS=true
export LANGFUSE_CAPTURE_TOOL_IO=false
export LANGFUSE_CAPTURE_SYSTEM_PROMPT=false
export LANGFUSE_CAPTURE_CWD=false
```

All captured payloads are redacted before upload. The extension masks common API keys, bearer tokens, passwords, cookies, private keys, Langfuse keys, GitHub/npm/AWS-style tokens, and local absolute paths.

### Method 3: Persistent `config.json`

Create or update `~/.pi/agent/pi-langfuse/config.json`:

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com",
  "privacyPreset": "conversations"
}
```

Fine-grained capture flags can also be persisted:

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com",
  "capture": {
    "LANGFUSE_PRIVACY_PRESET": "metadata-only",
    "LANGFUSE_CAPTURE_INPUTS": "true"
  }
}
```

> **Security**: Keep `~/.pi/agent/pi-langfuse/config.json` private. Never commit API keys to version control.

## Verify the Extension

Check that Pi has loaded the package:

```bash
pi list
```

`pi-langfuse` should appear in the installed package list (the package name stays `pi-langfuse` even when installed from Git).

## What Appears in Langfuse

- Each Pi session gets its own Langfuse session ID.
- Each user prompt within that session becomes a separate trace.
- The trace contains the final assistant output shown in Pi.
- Tool runs appear as tool observations with arguments, results, and error state.
- LLM requests appear as generation observations, including usage and cost when the provider exposes them.
- Trace-level scores include tool counts, tool success rate, and whether the run had errors.

The package also includes a Langfuse CLI skill, so Langfuse data can be queried directly from Pi:

```text
/pi-langfuse-langfuse <your-query>
```

## Source Metadata

Local prototype note: source metadata support in this installed package is a local prototype patch. A durable solution should be shipped through an upstream PR, a fork, or a maintained package version so reinstalling the extension does not lose the behavior.

For Git-backed runs, the extension attaches safe source metadata to traces:

```json
{
  "source_type": "git-repo",
  "repo_identity": "owner/repo",
  "repo_owner": "owner",
  "repo_name": "repo",
  "repo_root_name": "repo",
  "git_branch": "main",
  "git_commit": "abc123",
  "git_remote_host": "github.com",
  "git_remote_path": "owner/repo",
  "metadata_source": "git-detection"
}
```

`repo_identity` is `owner/repo`. `repo_name` is the repo name only and must not contain a slash.

A Git repo may optionally provide `.pi-langfuse.metadata.json`. Overrides are whitelist-only; unknown keys are ignored. Allowed keys are:

```text
repo_identity
repo_owner
repo_name
source_type
service_name
project_slug
environment
observability_owner
```

Repo-local overrides are used only after the working directory is confirmed to be inside a usable Git repo. If Git detection fails for any reason, including a missing Git command, corrupted repo, or non-Git folder, the extension ignores repo-local identity files and emits only:

```json
{
  "source_type": "non-git",
  "metadata_source": "non-git"
}
```

The extension must not upload raw absolute local paths, credentialed remotes, tokens, unknown override keys, or folder names for non-Git folders.

## Troubleshooting

### No traces appearing?

- Verify the API keys and run `/langfuse-setup` again if needed.
- Confirm the Langfuse project is active and accepts writes.
- Confirm the keys have write permission.
- Look for `📊 Langfuse:` log messages in Pi output.

### Extension not loading?

```bash
pi list
pi install git:github.com/ajarellanod/pi-langfuse
```

### "Missing config" on startup?

- Run `/langfuse-setup`.
- Or set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` before starting Pi.

### Model or cost not showing?

- Some providers do not expose cost information.
- Inspect the raw observation data in Langfuse traces.
- The `model` field can come from provider events, finalized assistant messages, `model_select`, or `ctx.model`.

### API key errors?

- Public keys start with `pk-lf-`.
- Secret keys start with `sk-lf-`.
- For self-hosted deployments, verify the host URL.

## Development Docs

Development setup, source installation, runtime architecture, trace model, tracked fields, and validation steps are documented in [DEVELOPMENT.md](./DEVELOPMENT.md) and [DEVELOPMENT_CN.md](./DEVELOPMENT_CN.md).

## License

MIT.

This fork preserves the original MIT license and author credit. pi-langfuse was originally created by **gooyoung** ([github.com/gooyoung/pi-langfuse](https://github.com/gooyoung/pi-langfuse)); this fork at [github.com/ajarellanod/pi-langfuse](https://github.com/ajarellanod/pi-langfuse) adds improvements while keeping that attribution intact.
