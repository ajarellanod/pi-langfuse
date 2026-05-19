# Langfuse 追踪逻辑优化方案

## 1. 背景与目标
根据之前的建议，我们需要进一步优化 Pi-Langfuse 扩展的上报逻辑，使得在 Langfuse 控制台中观察 Agent 执行过程时更加细致、层级分明且数据完备。
本次优化包含 5 个核心点：引入 Turn 级别的 Span、精准追踪 TTFT（首字响应时间）、处理 Provider 请求异常、上报 System Prompt，以及完善 Session 的边缘生命周期和上下文压缩（Compact）处理。

## 2. 现状分析
- **层级结构**：目前 `llm-generation` 和 `tool` 是平级挂载在根 Trace 下，多轮对话时瀑布图非常扁平。
- **TTFT**：尚未记录 `completionStartTime`，无法在 Langfuse 中直观看到首字耗时。
- **异常闭环**：LLM Provider 发生 4xx/5xx HTTP 错误时，`message_end` 可能不触发，导致 Generation 无法正常闭合。
- **上下文完备性**：`before_agent_start` 仅提取了 user prompt，缺少 System Prompt，不利于后期 Debug。
- **Session 生命周期**：仅处理了 `session_start` 和 `session_shutdown`，忽略了 `/new`, `/resume`, `/fork`, `/compact` 等高级会话操作引发的状态混乱问题。

## 3. 具体修改方案

### 3.1 引入 Turn-Level Span (层级结构优化)
将一轮对话（Turn）包装为一个 Span，使其成为 Generation 和 Tool 的父节点。
- **`src/types.ts`**:
  - 在 `AgentState` 接口中增加 `activeTurn?: LangfuseObservation` 字段。
- **`src/handlers/turn.ts` (新建)**:
  - 实现 `startTurnObservation(event)`：调用 `state.agentState.root.startObservation("turn", {...}, { asType: "span" })` 并赋值给 `activeTurn`。
  - 实现 `finishTurnObservation(event)`：结束 `activeTurn` 并将其置空。
- **`src/handlers/generation.ts` & `src/handlers/tool.ts`**:
  - 在创建 `llm-generation` 和 `tool` 观察节点时，优先判断 `state.agentState.activeTurn` 是否存在，若存在则调用 `activeTurn.startObservation`，否则降级使用 `root.startObservation`。
- **`index.ts`**:
  - 注册 `turn_start` 事件，调用 `startTurnObservation`。
  - 在现有的 `turn_end` 监听器中，除了处理 Fallback Generation，还需要调用 `finishTurnObservation`。

### 3.2 精准追踪 TTFT (首字生成时间)
记录模型流式输出第一块 Chunk 的时间，用于计算 TTFT。
- **`src/types.ts`**:
  - 在 `GenerationState` 中增加 `ttftRecorded?: boolean` 标志位。
- **`src/handlers/generation.ts`**:
  - 新增 `recordTTFT(event)` 函数：获取当前 `activeGeneration`，若 `ttftRecorded` 为 false/undefined，则调用 `generation.observation.update({ completionStartTime: new Date() })`，并标记 `ttftRecorded = true`。
- **`index.ts`**:
  - 在 `message_update` 事件监听器中，除了原有的提取逻辑外，新增调用 `recordTTFT(event)`。

### 3.3 异常流闭环：Provider 请求级错误处理
防止因 Provider HTTP 请求失败导致 Generation 永远处于开启状态。
- **`src/handlers/generation.ts`**:
  - 修改 `updateGenerationMetadata(event)` 函数。在提取完 metadata 后，检查 `metadata.status`。
  - 如果 `status >= 400` 或者存在明确的 error 信息，立刻将该 Generation 的状态设为 `level: "ERROR"`，附加 `statusMessage`，并调用 `.end()` 提前闭合它，同时设置 `ended = true`。

### 3.4 完善上下文信息：上报 System Prompt
将 System Prompt 纳入 Trace 的元数据或输入中，方便回溯。
- **`src/handlers/agent.ts`**:
  - 修改 `startAgentRun(event, ctx)`。
  - 增加 `const systemPrompt = await ctx.getSystemPrompt();`。
  - 在 `root` Trace 的 `metadata` 中增加 `systemPrompt: truncate(systemPrompt, MAX_TOOL_PAYLOAD_LENGTH)`。

### 3.5 Session 边缘生命周期与 Compact 处理
完善 Pi 扩展 API 提供的各类会话切换与上下文管理事件。
- **`index.ts`**:
  - 增加 `session_before_switch` 和 `session_before_fork` 的事件监听。当触发这些事件时，表明当前会话即将被替换，调用 `closeDanglingObservations("Session switched or forked")` 提前闭合所有挂起的节点，并调用 `resetRunState()`。
  - 增加 `session_compact` 事件监听。如果当前 `state.agentState.root` 存在，调用 `root.startObservation("session_compact", { level: "DEFAULT", statusMessage: "Context was compacted" }, { asType: "span" }).end()`，在 Trace 中记录下压缩动作发生的时机。

## 4. 假设与决策
- **决策**: Turn Span 的命名直接使用 `"turn"`，类型使用 `span`，这样在 Langfuse 的甘特图中能清晰地包裹住内部的 Generation 和 Tool。
- **决策**: TTFT 使用系统当前时间 `new Date()`。尽管存在微小的事件传递延迟，但在 Node.js 环境下已足够精确。
- **假设**: `ctx.getSystemPrompt()` 是异步方法，在 `before_agent_start` 和 `agent_start` 中可以通过 `await` 正常获取。
- **决策**: 对于 Session Lifecycle 的处理，统一视作强行终止当前 Agent Run 的执行，因此复用 `closeDanglingObservations` 逻辑以保证不会出现悬空（Dangling）的 Trace/Span。

## 5. 验收标准
1. 在代码中实现上述 5 项修改，且不破坏现有 TypeScript 编译。
2. 运行 Pi Agent 进行一次多轮对话（调用工具），能够在 Langfuse 观察到 `Trace -> Turn -> Generation/Tool` 的层级结构。
3. Langfuse 的 Generation 详情中能够看到 `Time to First Token (TTFT)`。
4. Trace 的 Metadata 中包含 `systemPrompt` 字段。
5. 通过 `/new` 或 `/compact` 时，控制台不报挂起节点相关的警告。