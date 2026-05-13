# pi-langfuse

[![npm version](https://img.shields.io/npm/v/pi-langfuse)](https://www.npmjs.com/package/pi-langfuse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**English**](./README.md) | [**简体中文**](./README_CN.md)

Langfuse observability extension for [Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent). Sends traces to [Langfuse](https://langfuse.com) for monitoring tokens, costs, latency, and tool calls.

## Why Langfuse?

Langfuse provides open-source observability for LLM applications. This extension allows you to **trace**, **monitor**, and **debug** your Pi sessions with production-grade detail, helping you understand exactly how your agent is performing, what it's costing you, and where it might be failing.

## Features

- **Hierarchical Tracing**: Maps user prompts to per-turn spans and nested tool executions for deep visibility.
- **LLM Metadata**: Automatically records model name, provider, token usage, and API costs per turn.
- **Tool Observability**: Detailed logs for every tool call, including arguments, results, and error states.
- **Session Correlation**: Groups all prompts from the same Pi session into a single Langfuse session.
- **Cost Tracking**: Records input/output/total costs in USD per generation.
- **Token Usage**: Tracks input and output tokens per turn.
- **Evaluation Scores**: Automatically computes and sends tool success rates, error counts, and session health metrics.

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
export LANGFUSE_HOST="https://cloud.langfuse.com"  # optional
```

Environment variables take precedence over `config.json`.

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

Run Pi as usual — the extension auto-loads and traces every session:

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

Each Pi session gets its own Langfuse session. Close Pi and start a new one to begin a new trace.

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
4. Confirm traces, spans, generations, and evaluation scores appear in your Langfuse project

## Trace Model

```
Trace (name: "pi-agent")
├── Session ID: <pi-session-id>
├── Metadata: model, provider, cwd, evaluation scores
└── Span (name: "tool:<name>")
    ├── input:  tool parameters (JSON)
    └── output: tool result

Generation (name: "llm-response")
├── Model: MiniMax-M2.7
├── Usage: input/output/total tokens
├── Cost:  input/output/total USD
└── Metadata: provider, cached tokens
```

## What Gets Tracked

### Trace Level
| Field | Description |
|-------|-------------|
| `input` | User prompt |
| `output` | Assistant response |
| `sessionId` | Pi session identifier |
| `metadata.model` | Model identifier (e.g., "MiniMax-M2.7") |
| `metadata.provider` | LLM provider name |
| `metadata.cwd` | Working directory |

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
| `model` | Model identifier (e.g., "MiniMax-M2.7") |
| `usage.input` | Input token count |
| `usage.output` | Output token count |
| `usage.total` | Total token count |
| `costDetails.total` | Total cost in USD |
| `costDetails.input` | Input cost in USD |
| `costDetails.output` | Output cost in USD |

### Span Observations (Tool Calls)
| Field | Description |
|-------|-------------|
| `name` | Tool name (e.g., "tool:bash", "tool:read") |
| `input` | Tool parameters (JSON) |
| `output` | Tool result (truncated to 2000 chars) |
| `metadata.isError` | Whether the tool failed |

### Observation-Level Scores
| Score Name | Description |
|------------|-------------|
| `tool_is_error` | Value 1 assigned to individual tool spans that errored |

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
- The `model` field in generations comes from `model_select` or `ctx.model`

### API key errors?
- Langfuse public keys start with `pk-lf-`, secret keys with `sk-lf-`
- If self-hosting, verify your host URL is correct

## Dependencies

- [langfuse](https://www.npmjs.com/package/langfuse) — Langfuse SDK (^3.0.0)
- [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — Pi extension API (peer dependency)

## About Langfuse Skill

This package includes a Langfuse CLI skill (at `.agents/skills/langfuse/`) that lets you query Langfuse data directly from Pi. Use it to look up traces, prompts, datasets, and scores without leaving the terminal. The skill is auto-registered when the extension is installed globally.

## License

MIT
