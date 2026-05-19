# Pi-Langfuse 代码重构与拆分计划

## 摘要 (Summary)
将当前长达 1105 行的单文件 `index.ts` 重构并按功能职责拆分至 `src/` 目录下的多个模块中。保留根目录的 `index.ts` 作为 Pi 扩展的纯入口文件。此举将极大提升代码的可读性和可维护性。

## 当前状态分析 (Current State Analysis)
目前 `index.ts` 是一个单文件巨石（Monolith），包含了以下所有逻辑：
1. 本地与环境变量配置读取
2. TypeScript 接口声明（`Config`, `AgentState`, `LangfuseObservation` 等）
3. 全局可变状态（如 `agentState`, `currentSessionId`, 各类计数器）
4. Langfuse SDK 的懒加载与生命周期管理
5. 数据格式化、截断与负载提取工具函数
6. Agent、Generation 和 Tool 各自的观测事件处理器
7. Pi 扩展命令注册与生命周期事件监听

所有逻辑混合在一起，导致状态变更难以追踪，且由于闭包共享了大量模块级状态，修改代码容易引入隐藏的副作用。

## 提议更改 (Proposed Changes)

### 1. 更新项目配置
- 修改 `tsconfig.json`：在 `include` 中增加 `"src/**/*.ts"`，以包含新的源码目录。
- **依赖引用规范**：由于 `tsconfig.json` 配置了 `"moduleResolution": "NodeNext"`，所有内部文件导入必须显式带有 `.js` 后缀（例如 `import { state } from "./state.js"`）。

### 2. 建立 `src/` 目录结构并拆分职责
计划新建如下文件与目录：

- **`src/types.ts`**
  - **内容**：提取所有的 Interface 和 Type 定义。
  - **包含**：`Config`, `LangfuseObservation`, `ObservationUpdate`, `LangfuseScoreClient`, `LangfuseRuntime`, `GenerationState`, `ToolState`, `AgentState`。

- **`src/constants.ts`**
  - **内容**：提取所有魔法数字和常量配置。
  - **包含**：`EXT_DIR`, `CONFIG_PATH`, `DEFAULT_LANGFUSE_HOST`, `MAX_STRING_LENGTH` 等。

- **`src/state.ts`**
  - **内容**：统一管理所有全局可变状态。
  - **实现方式**：将原来的 `let agentState`, `let currentSessionId` 等包裹在一个 `export const state = { ... }` 对象中，确保跨模块引用时状态一致。
  - **包含函数**：`resetRunState`, `computeEvaluationScores`。

- **`src/utils.ts`**
  - **内容**：集中存放与状态无关的纯工具函数。
  - **包含**：`truncate`, `tryParseJson`, `shapePayload`, `safeSerialize`，以及一系列解析函数（`extractTextContent`, `extractToolCalls`, `getToolCallId` 等）。

- **`src/config.ts`**
  - **内容**：负责配置读取与持久化，以及与 Pi UI 的交互提示。
  - **包含**：`loadConfigFromFile`, `loadConfigFromEnv`, `saveConfig`, `ensureConfig`, `promptForConfig`。

- **`src/langfuse.ts`**
  - **内容**：Langfuse SDK 客户端封装。
  - **包含**：`getRuntime` (单例模式加载 SDK)、`shutdownRuntime`、`sendScore`。

- **`src/handlers/agent.ts`**
  - **内容**：Agent 生命周期的事件逻辑。
  - **包含**：`startAgentRun`, `finishAgentRun`, `updateTraceIO`。

- **`src/handlers/generation.ts`**
  - **内容**：模型生成 (Generation) 相关的生命周期逻辑。
  - **包含**：`getOpenGeneration`, `startGeneration`, `updateGenerationMetadata`, `finishGenerationFromMessage`, `createFallbackGenerationFromTurn`。

- **`src/handlers/tool.ts`**
  - **内容**：工具调用 (Tool) 相关的逻辑。
  - **包含**：`startToolObservation`, `finishToolObservation`, `closeDanglingObservations`。

### 3. 精简根目录 `index.ts`
- **内容**：将其转换为纯粹的事件路由中心。
- **改动**：删除原有的业务实现，改为从 `src/` 各个模块导入必要的 handler。保留默认导出的扩展注册函数 `export default async function (pi: ExtensionAPI)`，并在其中通过 `pi.on` 和 `pi.registerCommand` 将事件委派给对应的处理函数。

## 假设与决策 (Assumptions & Decisions)
- **零行为变更**：本次重构仅做结构上的梳理，不修改任何核心逻辑、状态变更时机或事件 payload 的生成规则，从而保证与当前 Langfuse 的数据对接一致。
- **状态管理**：采用共享的 `state` 单例对象替代原本的顶层变量，以最少的改动适配多文件架构。
- **兼容性**：保留根目录的 `index.ts` 以兼容现有的 `package.json` 中的 `pi.extensions` 配置，无需修改发布行为。

## 验证步骤 (Verification steps)
1. 运行 `npm run typecheck` 确认代码拆分后无 TypeScript 编译及引入报错。
2. 开启 Pi CLI (`pi "test prompt"`) 并挂载该本地扩展，验证：
   - 配置初始化弹窗或环境变量读取是否正常工作。
   - 工具调用、LLM 生成以及会话结束时的逻辑是否无异常抛出。
3. 登录 Langfuse 控制面板，核对新产生的 trace 数据结构（agent、generation、tool observations 及打分数据）是否完整，未出现状态泄漏或丢失。
