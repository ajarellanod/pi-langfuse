# pi-langfuse

[![npm version](https://img.shields.io/npm/v/pi-langfuse)](https://www.npmjs.com/package/pi-langfuse)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[**English**](./README.md) | [**简体中文**](./README_CN.md)

[Pi Coding Agent](https://github.com/earendil-works/pi-coding-agent) 的 Langfuse 可观测性扩展。将跟踪发送到 [Langfuse](https://langfuse.com) 以监控令牌、成本、延迟和工具调用。

## 为什么选择 Langfuse？

Langfuse 为 LLM 应用程序提供开源的可观测性。此扩展允许您以生产级细节**跟踪**、**监控**和**调试**您的 Pi 会话，帮助您准确了解代理的性能、成本以及可能失败的地方。

## 功能

- **分层跟踪**：将用户提示映射到每轮跨度和嵌套工具执行，实现深度可见性。
- **LLM 元数据**：自动记录每轮的模型名称、提供商、令牌使用情况和 API 成本。
- **工具可观测性**：每个工具调用的详细日志，包括参数、结果和错误状态。
- **会话关联**：将同一 Pi 会话中的所有提示分组到单个 Langfuse 会话中。
- **成本跟踪**：记录每代输入/输出/总成本（美元）。
- **令牌使用**：跟踪每轮的输入和输出令牌。
- **评估分数**：自动计算和发送工具成功率、错误次数和会话健康指标。

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

然后在 Pi 中使用：

```bash
pi link /path/to/pi-langfuse
```

或者直接在项目目录中运行 Pi——Pi 会自动发现当前目录中的扩展。

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
export LANGFUSE_HOST="https://cloud.langfuse.com"  # 可选
```

环境变量优先级高于 `config.json`。

### 方式 3：本地 config.json（仅限开发）

在项目根目录创建 `config.json`：

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

像往常一样运行 Pi——扩展会自动加载并跟踪每个会话：

```bash
pi "解释 Redis 的架构"
```

会话结束后，在 [Langfuse 仪表板](https://cloud.langfuse.com) 中查看跟踪信息。

### 验证扩展已加载

```bash
pi list
```

你应该能看到 `pi-langfuse` 在已安装包列表中。

### 多个会话

每个 Pi 会话对应一个独立的 Langfuse 会话。关闭 Pi 并重新启动即可开始新的跟踪。

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
│           └── SKILL.md       # Langfuse CLI 技能
├── AGENTS.md           # 开发者指南（英文）
├── README.md           # 本文件（英文）
├── README_CN.md        # 中文 README
└── AGENTS_CN.md        # 开发者指南（中文）
```

### 验证

目前没有专门的测试套件。验证更改的方法：

1. 运行 `npm run typecheck` 检查 TypeScript 错误
2. 启用扩展启动 Pi
3. 运行几个提示
4. 确认跟踪、跨度、生成和评估分数出现在 Langfuse 项目中

## 跟踪模型

```
跟踪（名称："pi-agent"）
├── 会话 ID：<pi-session-id>
├── 元数据：模型、提供商、cwd、评估分数
└── 跨度（名称："tool:<name>"）
    ├── input:  工具参数（JSON）
    └── output: 工具结果

生成（名称："llm-response"）
├── 模型：MiniMax-M2.7
├── 使用量：输入/输出/总令牌
├── 成本：输入/输出/总美元
└── 元数据：提供商、缓存令牌
```

## 跟踪内容

### 跟踪级别
| 字段 | 说明 |
|------|------|
| `input` | 用户提示 |
| `output` | 助手响应 |
| `sessionId` | Pi 会话标识符 |
| `metadata.model` | 模型标识符（例如 "MiniMax-M2.7"） |
| `metadata.provider` | LLM 提供商名称 |
| `metadata.cwd` | 工作目录 |

### 评估分数（跟踪级别）

| 分数名称 | 类型 | 说明 |
|----------|------|------|
| `tool_call_count` | number | 会话中的工具调用总数 |
| `turn_count` | number | 助手交互轮数 |
| `total_tool_errors` | number | 返回错误的工具数 |
| `tool_success_rate` | float (0-1) | 工具调用成功率 |
| `session_had_errors` | 0 或 1 | 是否有任何工具出错 |

### 生成观察（LLM 调用）
| 字段 | 说明 |
|------|------|
| `model` | 模型标识符（例如 "MiniMax-M2.7"） |
| `usage.input` | 输入令牌数 |
| `usage.output` | 输出令牌数 |
| `usage.total` | 总令牌数 |
| `costDetails.total` | 总成本（美元） |
| `costDetails.input` | 输入成本（美元） |
| `costDetails.output` | 输出成本（美元） |

### 跨度观察（工具调用）
| 字段 | 说明 |
|------|------|
| `name` | 工具名称（例如 "tool:bash"、"tool:read"） |
| `input` | 工具参数（JSON） |
| `output` | 工具结果（截断至 2000 字符） |
| `metadata.isError` | 工具是否失败 |

### 观察级别分数
| 分数名称 | 说明 |
|----------|------|
| `tool_is_error` | 分配给出错工具跨度的值 1 |

## Langfuse 仪表板

运行后，在你的 Langfuse 项目中检查：

1. **跟踪** — 所有 pi 代理运行及其 I/O
2. **会话** — 按会话 ID 分组的跟踪
3. **观察** — 工具调用和 LLM 生成
4. **分数** — 评估指标（工具错误、成功率等）
5. **模型使用** — 按模型划分的使用情况细分

你也可以通过内置的 Langfuse 技能直接在终端中查询 Langfuse 数据：

```
/pi-langfuse-langfuse <你的查询>
```

## 故障排除

### 没有跟踪出现？
- 验证 API 密钥是否正确 — 运行 `/langfuse-setup` 重新配置
- 检查 Langfuse 项目是否活跃且有写入容量
- 确保 API 密钥有写入权限（非只读）
- 在 Pi 输出中查找 `📊 Langfuse:` 日志

### 扩展未加载？
```bash
pi list                      # 确认 pi-langfuse 已安装
pi install npm:pi-langfuse   # 如果缺失则重新安装
```

### 启动时显示"缺少配置"？
- 扩展需要凭据。使用交互式 `/langfuse-setup` 命令
- 或设置 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 环境变量

### 模型/成本未显示？
- 并非所有提供商都公开成本信息
- 检查 Langfuse 跟踪 API 获取原始观察数据
- 生成中的 `model` 字段来自 `model_select` 事件或 `ctx.model`

### API 密钥错误？
- Langfuse 公钥以 `pk-lf-` 开头，密钥以 `sk-lf-` 开头
- 如果使用自托管，请验证主机 URL 是否正确

## 依赖项

- [langfuse](https://www.npmjs.com/package/langfuse) — Langfuse SDK (^3.0.0)
- [@earendil-works/pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) — Pi 扩展 API（对等依赖）

## 关于 Langfuse 技能

此包包含一个 Langfuse CLI 技能（位于 `.agents/skills/langfuse/`），使您可以直接从 Pi 查询 Langfuse 数据。无需离开终端即可查看跟踪、提示、数据集和分数。全局安装扩展时该技能会自动注册。

## 许可证

MIT
