# pi-langfuse

[![npm version](https://img.shields.io/npm/v/pi-langfuse)](https://www.npmjs.com/package/pi-langfuse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**English**](./README.md) | [**简体中文**](./README_CN.md)

[Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 的 Langfuse 可观测性扩展。将完整的 Pi 代理运行发送到 [Langfuse](https://langfuse.com)，以便您可以在一个追踪（trace）中检查用户提示词、根代理工作流、每次 LLM 生成、每次工具调用、最终助手响应、使用情况、成本和健康分数。

## 为什么选择 Langfuse？

Langfuse 为 LLM 应用程序提供开源的可观测性。此扩展允许您以生产级细节**追踪**、**监控**和**调试**您的 Pi 会话，帮助您准确了解代理的执行情况、成本消耗以及可能出现故障的环节。

## 功能

- **完整的代理追踪**：为每个用户提示词创建一个追踪，包含一个根 `agent`（代理）观察节点，其中记录了提示词输入和最终助手输出。
- **每次请求生成记录**：为每次提供商请求记录单独的 `generation`（生成）观察节点，包含实际的提供商请求负载，而不仅仅是原始提示词。
- **捕获最终消息**：在生成和根输出中使用已定型的助手消息，因此 Langfuse 会显示用户在 Pi 中实际看到的内容。
- **工具可观测性**：为每次工具调用创建 Langfuse `tool`（工具）观察节点，包括参数、结果和错误状态。
- **并行工具安全性**：通过 `toolCallId` 关联工具观察节点，避免在 Pi 并发运行工具时出现结果混淆。
- **会话关联**：将同一 Pi 会话中的所有追踪分组到一个共享的 Langfuse 会话 ID 下。
- **成本和 Token 追踪**：当 Pi/提供商负载公开时，记录每次生成的使用情况和成本详细信息。
- **评估分数**：自动计算并发送工具成功率、错误计数和会话健康指标。
- **防御性负载整形**：尽可能解析类似 JSON 的字符串，限制对象深度，并在上传前截断超大负载。

## 亮点

`pi-langfuse` 旨在使 Pi 运行作为代理工作流具有可读性，而不仅仅是一堆日志：

- 追踪（trace）的输入/输出与根 `agent` 观察节点镜像同步，使得从 Langfuse 追踪列表和详情视图中即可理解运行情况。
- 使用工具的运行中的首次生成可以显示助手的工具调用消息，工具观察节点显示执行的输入/输出，而后续的生成显示最终的自然语言答案。
- 工具故障会在工具观察节点上标记，并反映在追踪级别的分数中，而后续的生成仍会在其输入历史中保留工具错误结果。
- 关机和中断的运行会刷新待处理的遥测数据，并将未完成的观察节点标记为已取消/警告，而不是默默丢失追踪记录。

## 前提条件

- **Node.js** >= 22
- **Pi Coding Agent** 已安装并配置
- **Langfuse** 账户（[云服务](https://cloud.langfuse.com)或自托管）

## 安装

### 方式 1：通过 npm 安装（推荐给用户）

```bash
pi install npm:pi-langfuse
```

Pi 会自动下载包并将其注册为扩展。

### 方式 2：从本地源码安装（推荐给开发者）

```bash
git clone <你的仓库地址>
cd pi-langfuse
npm install
```

然后告诉 Pi 使用它：

```bash
pi link /path/to/pi-langfuse
```

或者直接在项目目录中运行 Pi——Pi 会自动发现当前目录中 `package.json` 的扩展。

## 配置

你需要 Langfuse API 密钥。从 **Langfuse Cloud** → **设置** → **API 密钥** 获取。

有三种配置方式：

### 方式 1：交互式设置（最简单）

加载扩展后运行任意 `pi` 命令。首次运行且未配置时，Pi 会在 CLI 或 TUI 中提示输入：

1. **Langfuse 公钥** — 以 `pk-lf-...` 开头
2. **Langfuse 密钥** — 以 `sk-lf-...` 开头
3. **Langfuse 主机地址** — 默认为 `https://cloud.langfuse.com`

扩展会将这些保存到本地的 `config.json`（被 git 忽略）。

随时重新运行设置：

```
/langfuse-setup
```

### 方式 2：环境变量

在启动 Pi 前设置：

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-xxxx"
export LANGFUSE_SECRET_KEY="sk-lf-xxxx"
export LANGFUSE_BASE_URL="https://cloud.langfuse.com"  # 可选；也支持 LANGFUSE_HOST
```

扩展会先检查本地的 `config.json`，然后回退到环境变量。

### 方式 3：本地 config.json（仅限开发）

对于本地开发，在项目根目录创建 `config.json`：

```json
{
  "publicKey": "pk-lf-xxxx",
  "secretKey": "sk-lf-xxxx",
  "host": "https://cloud.langfuse.com"
}
```

> **⚠️ 安全提醒**：`config.json` 不会被 git 跟踪。切勿将 API 密钥提交到版本控制。

## 使用

### 基本使用

像往常一样运行 Pi——扩展会自动加载并追踪每次代理运行：

```bash
pi "解释 Redis 的架构"
```

会话结束后，在 [Langfuse 仪表板](https://cloud.langfuse.com) 中查看追踪信息。

### 验证扩展已加载

```bash
pi list
```

你应该能看到 `pi-langfuse` 在已安装包列表中。

### 多个会话

每个 Pi 会话对应一个独立的 Langfuse 会话 ID。在该 Pi 会话中的每个用户提示词都会成为归入同一会话下的独立 Langfuse 追踪。

## 开发设置

如果你为此扩展贡献代码：

```bash
# 克隆并安装依赖
git clone <你的仓库地址>
cd pi-langfuse
npm install

# 检查 TypeScript 类型
npm run typecheck

# 用 Pi 测试
pi "test prompt"
```

### 项目结构

```
pi-langfuse/
├── index.ts            # 扩展入口和核心逻辑
├── package.json        # 包元数据
├── tsconfig.json       # TypeScript 配置
├── config.json         # 本地凭据（git 忽略）
├── types/
│   ├── pi-coding-agent.d.ts   # Pi 扩展 API 类型
│   └── node-shims.d.ts        # Node.js 模块 shims
├── .agents/
│   └── skills/
│       └── langfuse/
│           └── SKILL.md       # 用于数据查询的 Langfuse CLI 技能
├── AGENTS.md           # 开发者指南（扩展版）
├── README.md           # 英文 README
├── README_CN.md        # 本文件（中文）
└── AGENTS_CN.md        # 开发者指南（中文）
```

### 验证

目前没有专门的测试套件。验证更改的方法：

1. 运行 `npm run typecheck` 检查 TypeScript 错误
2. 启用扩展启动 Pi
3. 运行几个提示词
4. 确认追踪、根代理观察节点、工具观察节点、生成和评估分数出现在您的 Langfuse 项目中

## 追踪模型

```
Trace (name: "pi-agent")
├── Session ID: <pi-session-id>
├── input:  用户提示词，存在时包含图片/上下文摘要
├── output: 最终助手响应
└── Agent observation (name: "pi-agent", type: agent)
    ├── input:  当前用户提示词
    ├── output: 最终助手响应
    ├── Generation observation (name: "llm-generation", type: generation)
    │   ├── input: 提供商请求负载 / 消息历史记录
    │   ├── output: 已定型的助手消息或工具调用消息
    │   ├── model, usageDetails, costDetails
    │   └── metadata: 提供商/请求详细信息
    └── Tool observation (name: "<tool-name>", type: tool)
        ├── input: 工具参数
        ├── output: 工具结果
        └── metadata: toolCallId, isError
```

## 追踪内容

### 追踪级别 (Trace Level)
| 字段 | 说明 |
|------|------|
| `input` | 用户提示词，可用时包含图片/上下文摘要 |
| `output` | Pi 中显示的最终助手响应 |
| `sessionId` | Pi 会话标识符 |
| `metadata.model` | 模型标识符（例如 "MiniMax-M2.7"） |
| `metadata.provider` | LLM 提供商名称 |
| `metadata.cwd` | 工作目录 |

### 代理观察节点 (Agent Observation / 根工作流)
| 字段 | 说明 |
|------|------|
| `type` | `agent` |
| `name` | `pi-agent` |
| `input` | 当前用户提示词负载 |
| `output` | 最终助手响应 |
| `metadata.sessionId` | Pi 会话标识符 |
| `metadata.cwd` | 工作目录 |
| `metadata.model` | 可用时的所选模型 |
| `metadata.provider` | 可用时的提供商 |

### 评估分数 (追踪级别)

| 分数名称 | 类型 | 说明 |
|----------|------|------|
| `tool_call_count` | number | 会话中的工具调用总数 |
| `turn_count` | number | 助手交互轮数 |
| `total_tool_errors` | number | 返回错误的工具数 |
| `tool_success_rate` | float (0-1) | 工具调用成功率 |
| `session_had_errors` | 0 或 1 | 是否有任何工具出错 |

### 生成观察节点 (Generation Observations / LLM 调用)
| 字段 | 说明 |
|------|------|
| `type` | `generation` |
| `name` | `llm-generation` |
| `input` | 实际提供商请求负载 / 消息历史记录 |
| `output` | 已定型的助手消息，包含工具调用轮次的工具调用负载 |
| `model` | 模型标识符（例如 "MiniMax-M2.7"） |
| `usageDetails.input` | 输入 Token 数 |
| `usageDetails.output` | 输出 Token 数 |
| `usageDetails.total` | 总 Token 数 |
| `costDetails.total` | 总成本（美元） |
| `costDetails.input` | 输入成本（美元） |
| `costDetails.output` | 输出成本（美元） |
| `metadata.provider` | 提供商名称 |
| `metadata.requestId` | 可用时的提供商/Pi 请求标识符 |
| `metadata.status` | 可用时的 HTTP/提供商状态 |

### 工具观察节点 (Tool Observations)
| 字段 | 说明 |
|------|------|
| `type` | `tool` |
| `name` | 工具名称（例如 "bash", "read"） |
| `input` | 工具参数 |
| `output` | 工具结果，为了可读性进行整形和截断 |
| `metadata.toolCallId` | 稳定的 Pi 工具调用标识符 |
| `metadata.isError` | 工具是否失败 |
| `level` | 失败的工具调用为 `ERROR`，否则为 `DEFAULT` |

### 观察节点级别分数
| 分数名称 | 说明 |
|----------|------|
| `tool_is_error` | 分配给出错个体工具观察节点的值 1 |

## Langfuse 仪表板

运行后，在您的 Langfuse 项目中检查：

1. **Traces（追踪）** — 所有带输入/输出的 pi 代理运行
2. **Sessions（会话）** — 按会话 ID 分组的追踪
3. **Observations（观察）** — 工具调用和 LLM 生成
4. **Scores（分数）** — 评估指标（工具错误、成功率等）
5. **Model Usage（模型使用）** — 按模型划分的使用情况细分

您也可以通过内置的 Langfuse 技能直接在终端中监控 Langfuse 数据：

```
/pi-langfuse-langfuse <您的查询>
```

## 故障排除

### 没有追踪出现？
- 验证 API 密钥是否正确 — 运行 `/langfuse-setup` 重新配置
- 检查您的 Langfuse 项目是否活跃且有写入容量
- 确保 API 密钥有写入权限（非只读）
- 在 Pi 输出中查找 `📊 Langfuse:` 日志信息

### 扩展未加载？
```bash
pi list                      # 确认 pi-langfuse 已安装
pi install npm:pi-langfuse   # 如果缺失则重新安装
```

### 启动时显示 "Missing config"？
- 扩展需要凭据。使用交互式 `/langfuse-setup` 命令
- 或设置 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 环境变量

### 模型/成本未显示？
- 并非所有提供商都公开成本信息
- 检查 Langfuse traces API 获取原始观察数据
- 生成中的 `model` 字段来自提供商事件、已定型的助手消息、`model_select` 或 `ctx.model`

### API 密钥错误？
- Langfuse 公钥以 `pk-lf-` 开头，密钥以 `sk-lf-` 开头
- 如果使用自托管，请验证您的主机 URL 是否正确

## 依赖项

- [@langfuse/tracing](https://www.npmjs.com/package/@langfuse/tracing) — 用于 `agent`、`generation` 和 `tool` 追踪的 Langfuse 观察 API
- [@langfuse/otel](https://www.npmjs.com/package/@langfuse/otel) — 用于将追踪导出到 Langfuse 的 OpenTelemetry 跨度处理器
- [@langfuse/client](https://www.npmjs.com/package/@langfuse/client) — 用于分数的 Langfuse API 客户端
- [@opentelemetry/sdk-node](https://www.npmjs.com/package/@opentelemetry/sdk-node) — Node OpenTelemetry SDK
- [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — Pi 扩展 API（对等依赖）

## 关于 Langfuse 技能

此包包含一个 Langfuse CLI 技能（位于 `.agents/skills/langfuse/`），使您可以直接从 Pi 查询 Langfuse 数据。无需离开终端即可查看追踪、提示词、数据集和分数。全局安装扩展时该技能会自动注册。

## 许可证

MIT
