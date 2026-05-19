# Pi Langfuse Extension - Agents & Architecture

## Project Overview

This repository contains a Pi Coding Agent extension that integrates with Langfuse to provide deep observability into agent sessions. By hooking into Pi's Extension API, it forwards telemetry data (traces, spans, and LLM generations) to Langfuse, enabling developers to monitor token usage, cost, tool execution success rates, and conversational context.

## Architecture & Event Mapping

The extension leverages the `@earendil-works/pi-coding-agent` Extension API to intercept lifecycle events and maps them to Langfuse's hierarchical observability model: **Trace** -> **Span** / **Generation**.

### 1. Trace Level (Agent Run)
The root of the observability tree is a **Trace**, representing a single user prompt and the agent's complete execution to fulfill it.

- `before_agent_start` / `agent_start`: Initializes the `pi-agent` **Trace**. Captures the initial prompt, working directory (`cwd`), and session ID.
- `agent_end`: Finalizes the trace, captures the final assistant output, and submits evaluation scores (e.g., tool call count, success rate).

### 2. Generation Level (LLM Calls)
Every time the agent communicates with an LLM provider, a **Generation** is recorded to track token usage, costs, and latency.

- `before_provider_request`: Starts the `llm-generation` observation.
- `after_provider_response`: Updates the generation with HTTP status and provider metadata.
- `message_update`: Tracks streaming text (can be used to track Time-To-First-Token).
- `message_end`: Ends the generation, extracting `usageDetails` (input/output tokens, cache metrics) and `costDetails`.
- `turn_end`: Handles fallback generation logging if standard message events miss the completion.

### 3. Span Level (Tool Executions)
When the LLM decides to use a registered tool (e.g., bash, file read), a **Span** is created under the root trace.

- `tool_execution_start` / `tool_call`: Starts a `tool` span, logging the tool name and its input parameters (truncated for safety).
- `tool_result` / `tool_execution_end`: Finalizes the tool span. If the tool fails, the span's level is marked as `ERROR` and the error message is recorded.

### 4. Session & Lifecycle Management
- `session_start`: Captures the stable session ID from Pi (`ctx.sessionManager.getSessionFile()`).
- `session_shutdown`: Cleans up and flushes dangling observations (e.g., if the user abruptly exits via `Ctrl+C`).

## Development & Testing

1. **Prerequisites**: Node.js `>=22` and a local `config.json` with Langfuse credentials (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`).
2. **Run**: 
   ```bash
   npm install
   pi -e ./index.ts "your test prompt"
   ```
3. **Validation**: Open your Langfuse dashboard to verify that Traces, Generations, and Tool Spans are accurately grouped, and that token usage/costs are populated.

## Design Constraints
- **Statefulness**: The extension maintains module-level state (`state.ts`) because multiple Pi hooks share the same context across an agent run.
- **Data Safety**: Large tool payloads and circular references are aggressively truncated/shaped to prevent serialization crashes and excessive network overhead.
