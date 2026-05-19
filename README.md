# pi-langfuse

[![npm version](https://img.shields.io/npm/v/pi-langfuse)](https://www.npmjs.com/package/pi-langfuse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**English**](./README.md) | [**简体中文**](./README_CN.md)

Langfuse observability extension for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Sends complete Pi agent runs to [Langfuse](https://langfuse.com) so you can inspect the user prompt, root agent workflow, every LLM generation, every tool call, final assistant response, usage, cost, and health scores in one trace.

## Why Langfuse?

Langfuse provides open-source observability for LLM applications. This extension allows you to **trace**, **monitor**, and **debug** your Pi sessions with production-grade detail, helping you understand exactly how your agent is performing, what it's costing you, and where it might be failing.

## Features

- **Complete Agent Traces**: Creates one trace per user prompt with a root `agent` observation containing the prompt input and final assistant output.
- **Per-Request Generations**: Records a separate `generation` observation for every provider request, including the actual provider payload instead of only the original prompt.
- **Final Message Capture**: Uses finalized assistant messages for generation and root outputs, so Langfuse shows what the user actually saw in Pi.
- **Tool Observability**: Creates Langfuse `tool` observations for every tool call, including arguments, results, and error states.
- **Parallel Tool Safety**: Correlates tool observations by `toolCallId`, avoiding result mix-ups when Pi runs tools concurrently.
- **Session Correlation**: Groups traces from the same Pi session under a shared Langfuse session ID.
- **Cost and Token Tracking**: Records usage and cost details on each generation when Pi/provider payloads expose them.
- **Evaluation Scores**: Automatically computes and sends tool success rates, error counts, and session health metrics.
- **Defensive Payload Shaping**: Parses JSON-like strings when possible, limits object depth, and truncates large payloads before upload.

## Highlights

`pi-langfuse` is designed to make a Pi run readable as an agent workflow, not just a bag of logs:

- The trace input/output mirrors the root `agent` observation, making the run understandable from the Langfuse trace list and detail view.
- The first generation in a tool-using run can show the assistant's tool-call message, the tool observation shows execution I/O, and the follow-up generation shows the final natural-language answer.
- Tool failures are marked on the tool observation and reflected in trace-level scores, while later generations still preserve the tool error result in their input history.
- Shutdown and interrupted runs flush pending telemetry and mark unfinished observations as cancelled/warning instead of silently losing the trace.

## Prerequisites

- **Node.js** >= 22
- **Pi Coding Agent** installed and configured
- A **Langfuse** account ([cloud](https://cloud.langfuse.com) or self-hosted)

## Installation

### Option 1: Install via npm (recommended for users)

```bash
pi install npm:pi-langfuse
```

Pi will download the package and register it as an extension.

### Option 2: Install from local source (recommended for development)

```bash
git clone <your-repo-url>
cd pi-langfuse
npm install
```

Then tell Pi to use it:

```bash
pi link /path/to/pi-langfuse
```

Or run Pi from the project directory — Pi auto-discovers extensions in the current directory's `package.json`.

## Configuration

You need Langfuse API keys. Get them from **Langfuse Cloud** → **Settings** → **API Keys**.

There are three ways to configure the extension:

### Method 1: Interactive setup (easiest)

Run any `pi` command with the extension loaded. On first run without configuration, Pi will prompt you in the CLI or TUI for:

1. **Langfuse public key** — starts with `pk-lf-...`
2. **Langfuse secret key** — starts with `sk-lf-...`
3. **Langfuse host** — defaults to `https://cloud.langfuse.com`

The extension saves these to a local `config.json` (ignored by git).

To re-run setup at any time:

```
/langfuse-setup
```

### Method 2: Environment variables

Set these before starting Pi:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-xxxx"
export LANGFUSE_SECRET_KEY="sk-lf-xxxx"
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"  # optional; LANGFUSE_HOST is also supported
```

The extension checks the local `config.json` first, then falls back to environment variables.

### Method 3: Local config.json (development only)

For local development, create a `config.json` in the project root:

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com"
}
```

> **⚠️ Security**: `config.json` is not tracked by git. Never commit API keys to version control.

## Usage

### Basic usage

Run Pi as usual — the extension auto-loads and traces every agent run:

```bash
pi "Explain the architecture of Redis"
```

After the session ends, check your [Langfuse dashboard](https://cloud.langfuse.com) for the trace.

### Verify the extension is loaded

```bash
pi list
```

You should see `pi-langfuse` in the list of installed packages.

### Multiple sessions

Each Pi session gets its own Langfuse session ID. Each user prompt within that Pi session becomes a separate Langfuse trace grouped under the same session.

## Development Setup

If you're contributing to this extension:

```bash
# Clone and install dependencies
git clone <your-repo-url>
cd pi-langfuse
npm install

# Type-check your changes
npm run typecheck

# Test with Pi
pi "test prompt"
```

### Project structure

```
pi-langfuse/
├── index.ts            # Extension entrypoint and core logic
├── package.json        # Package metadata
├── tsconfig.json       # TypeScript configuration
├── config.json         # Local credentials (git-ignored)
├── types/
│   ├── pi-coding-agent.d.ts   # Pi extension API types
│   └── node-shims.d.ts        # Node.js module shims
├── .agents/
│   └── skills/
│       └── langfuse/
│           └── SKILL.md       # Langfuse CLI skill for data queries
├── AGENTS.md           # Developer guide (extended)
├── README.md           # This file
├── README_CN.md        # Chinese translation
└── AGENTS_CN.md        # Developer guide (Chinese)
```

### Validation

There is no dedicated test suite yet. To validate changes:

1. Run `npm run typecheck` for TypeScript errors
2. Start Pi with the extension enabled
3. Run a few prompts
4. Confirm traces, the root agent observation, tool observations, generations, and evaluation scores appear in your Langfuse project

## Trace Model

```
Trace (name: "pi-agent")
├── Session ID: <pi-session-id>
├── input:  user prompt, images/context summary when present
├── output: final assistant response
└── Agent observation (name: "pi-agent", type: agent)
    ├── input:  current user prompt
    ├── output: final assistant response
    ├── Generation observation (name: "llm-generation", type: generation)
    │   ├── input: provider request payload / message history
    │   ├── output: finalized assistant message or tool-call message
    │   ├── model, usageDetails, costDetails
    │   └── metadata: provider/request details
    └── Tool observation (name: "<tool-name>", type: tool)
        ├── input: tool parameters
        ├── output: tool result
        └── metadata: toolCallId, isError
```

## What Gets Tracked

### Trace Level
| Field | Description |
|-------|-------------|
| `input` | User prompt, with images/context summary when available |
| `output` | Final assistant response shown in Pi |
| `sessionId` | Pi session identifier |
| `metadata.model` | Model identifier (e.g., "MiniMax-M2.7") |
| `metadata.provider` | LLM provider name |
| `metadata.cwd` | Working directory |

### Agent Observation (Root Workflow)
| Field | Description |
|-------|-------------|
| `type` | `agent` |
| `name` | `pi-agent` |
| `input` | Current user prompt payload |
| `output` | Final assistant response |
| `metadata.sessionId` | Pi session identifier |
| `metadata.cwd` | Working directory |
| `metadata.model` | Selected model when available |
| `metadata.provider` | Provider when available |

### Evaluation Scores (Trace Level)

| Score Name | Type | Description |
|------------|------|-------------|
| `tool_call_count` | number | Total tool calls in session |
| `turn_count` | number | Number of assistant turns |
| `total_tool_errors` | number | Tools that returned errors |
| `tool_success_rate` | float (0-1) | Ratio of successful tool calls |
| `session_had_errors` | 0 or 1 | Whether any tool errored |

### Generation Observations (LLM Calls)
| Field | Description |
|-------|-------------|
| `type` | `generation` |
| `name` | `llm-generation` |
| `input` | Actual provider request payload / message history |
| `output` | Finalized assistant message, including tool-call payloads for tool-calling turns |
| `model` | Model identifier (e.g., "MiniMax-M2.7") |
| `usageDetails.input` | Input token count |
| `usageDetails.output` | Output token count |
| `usageDetails.total` | Total token count |
| `costDetails.total` | Total cost in USD |
| `costDetails.input` | Input cost in USD |
| `costDetails.output` | Output cost in USD |
| `metadata.provider` | Provider name |
| `metadata.requestId` | Provider/Pi request identifier when available |
| `metadata.status` | HTTP/provider status when available |

### Tool Observations
| Field | Description |
|-------|-------------|
| `type` | `tool` |
| `name` | Tool name (e.g., "bash", "read") |
| `input` | Tool parameters |
| `output` | Tool result, shaped and truncated for readability |
| `metadata.toolCallId` | Stable Pi tool call identifier |
| `metadata.isError` | Whether the tool failed |
| `level` | `ERROR` for failed tool calls, otherwise `DEFAULT` |

### Observation-Level Scores
| Score Name | Description |
|------------|-------------|
| `tool_is_error` | Value 1 assigned to individual tool observations that errored |

## Langfuse Dashboard

After running, check your Langfuse project for:

1. **Traces** — All pi agent runs with I/O
2. **Sessions** — Traces grouped by session ID
3. **Observations** — Tool calls and LLM generations
4. **Scores** — Evaluation metrics (tool errors, success rate, etc.)
5. **Model Usage** — Usage breakdown by model

You can also monitor your Langfuse data directly from the terminal using the built-in Langfuse skill:

```
/pi-langfuse-langfuse <your-query>
```

## Troubleshooting

### No traces appearing?
- Verify API keys are correct — run `/langfuse-setup` to re-configure
- Check your Langfuse project is active and has write capacity
- Ensure API keys have write permissions (not read-only)
- Look for `📊 Langfuse:` log messages in the Pi output

### Extension not loading?
```bash
pi list                      # Verify pi-langfuse is installed
pi install npm:pi-langfuse   # Reinstall if missing
```

### "Missing config" message on startup?
- The extension needs credentials. Use the interactive `/langfuse-setup` command
- Or set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` environment variables

### Model/cost not showing?
- Not all providers expose cost information
- Check the Langfuse traces API for raw observation data
- The `model` field in generations comes from provider events, finalized assistant messages, `model_select`, or `ctx.model`

### API key errors?
- Langfuse public keys start with `pk-lf-`, secret keys with `sk-lf-`
- If self-hosting, verify your host URL is correct

## Dependencies

- [@langfuse/tracing](https://www.npmjs.com/package/@langfuse/tracing) — Langfuse observation API for `agent`, `generation`, and `tool` traces
- [@langfuse/otel](https://www.npmjs.com/package/@langfuse/otel) — OpenTelemetry span processor for exporting traces to Langfuse
- [@langfuse/client](https://www.npmjs.com/package/@langfuse/client) — Langfuse API client used for scores
- [@opentelemetry/sdk-node](https://www.npmjs.com/package/@opentelemetry/sdk-node) — Node OpenTelemetry SDK
- [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — Pi extension API (peer dependency)

## About Langfuse Skill

This package includes a Langfuse CLI skill (at `.agents/skills/langfuse/`) that lets you query Langfuse data directly from Pi. Use it to look up traces, prompts, datasets, and scores without leaving the terminal. The skill is auto-registered when the extension is installed globally.

## License

MIT
