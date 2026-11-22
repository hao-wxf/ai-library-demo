# 架构说明

> 仓库：<https://github.com/hao-wxf/ai-library-demo>（MIT）  
> 完整技术文档：[five-layers-pi-sdk.md](five-layers-pi-sdk.md)

## 1. 目标

用图书管理系统作为第一个业务载体，验证 AI 原生企业框架的最小闭环：

```text
读者意图
  → 知识检索
  → 能力调用
  → Pi 编排/持久化
  → 策略/审批
  → 审计/知识回流
```

## 2. 五层与代码

### 2.1 意图层 Intent

职责：定义“要什么、约束是什么、谁能批准”。

- 读者身份与角色（`R001` 普通读者、`R002` 有逾期、`R004` 停用）
- 借阅/预约规则
- 审批角色（馆员）
- Agent 提示词与工具选择

代码：

- `packages/policy-sdk/src/index.ts`
- `packages/agent-sdk/src/index.ts` 的 `section('library-agent', ...)`

### 2.2 知识层 Knowledge

职责：让 Agent 理解图书馆领域和制度。

- 本体：Book、Copy、Reader、Loan、Reservation、Fine、Branch、Policy、Regulation
- 制度文档：借阅规则、预约规则、隐私规范、开放时间、逾期处理
- 检索：关键词/二元组评分 + 引用
- 知识闭环：本演示保留接口方向，生产版把执行结果沉淀为候选知识

代码：

- `packages/knowledge-sdk/src/index.ts`

### 2.3 编排层 Orchestration

职责：把意图、知识和能力组织成可执行、可恢复的任务。

- Pi Durable `Harness` + `createConversation`
- DeepSeek 模型生成任务（`deepseekProvider`）
- 工具调用任务
- 按会话动态渲染系统提示（读者/馆员/审计员不同权限）
- 运行 Trace
- 未来：检查点/重放/子代理/审批等待

代码：

- `packages/agent-sdk/src/index.ts`

### 2.4 能力层 Capability

职责：把业务能力变成有契约的工具。

工具：

| 工具 | 类型 | 作用 |
|---|---|---|
| `catalog_search` | read | 搜索馆藏 |
| `catalog_list` | read | 列出馆藏（支持分类/可借筛选） |
| `book_availability` | read | 查询副本/馆藏地 |
| `reader_get` | read | 读者状态（脱敏，读者只能查本人） |
| `reader_search` | read | 工作人员按姓名/ID 检索读者 |
| `loan_list` | read | 借阅/逾期/罚款 |
| `knowledge_search` | read | 制度检索 |
| `reservation_create` | write | 预约（可能触发审批） |

代码：

- `packages/capability-sdk/src/index.ts`
- `packages/contracts/src/index.ts`

### 2.5 基础设施层 Infrastructure

- SQLite 业务库：`data/library.sqlite`
- Pi Agent 持久化：`data/agent.sqlite`
- HTTP/JSON API：`apps/server/src/main.ts`
- 认证会话与 RBAC：`packages/auth-sdk/src/index.ts`
- 对话映射：`chat_conversations`（UI 对话 ID → Pi conversation ID）
- 审计：`audit_events`
- 审批：`approvals`

生产替换方向：PostgreSQL、统一身份 / SSO、RBAC/ABAC、模型网关、审计平台、密钥管理、信创适配。

## 3. 一次运行的时序

```text
Web UI
  → POST /api/chat（Cookie 会话）
    → 服务端解析 AuthUser(role, readerId)
    → Agent.run({chatId, message, user})
      → 校验 chat_conversations 所有权
      → 取回/创建独立 Pi conversation
      → conversation.submit()
        → DeepSeek 依据输入自行决定意图与工具
        → Pi 执行工具（catalog/reader/loan/knowledge/reservation）
          → canUseTool 角色授权
          → canReserve 业务策略
          → 写 Trace/Audit
        → DeepSeek 生成最终回答
      → 读取 answer entry
    → 返回 answer + citations + pendingApproval
      + trace（仅工作人员）
  → UI 渲染消息/引用；工作人员可在开发者视图看 Trace/审批/审计
```

## 4. 审批闭环

`reservation_create` 遇到“有逾期”等情况时：

1. 策略返回 `require_approval`
2. 工具创建 `approvals` 记录，返回 `pending_approval`
3. UI 展示审批卡片
4. 馆员批准 → 业务 API 创建预约 → 更新审批 → 写审计
5. 馆员拒绝 → 更新审批 → 写审计

演示版在业务层完成审批后的执行；生产版应把审批做成 Pi 持久化任务，在批准后恢复 Agent 运行。

## 5. 为什么用真实 DeepSeek

- 验证真实模型的意图识别与工具选择，而不是脚本化场景；
- DeepSeek 通过 Pi 内置 `deepseekProvider()` 接入，只需 `DEEPSEEK_API_KEY`；
- 工具名必须匹配 `^[a-zA-Z0-9_-]+$`，因此使用下划线命名；
- 模型行为有不确定性，所以业务事实必须来自工具，策略必须由代码裁决。

## 6. RBAC 与开发者视图

- 角色：`reader / librarian / auditor / admin`；
- 登录：服务端会话 + `HttpOnly` Cookie；角色在服务端校验；
- `/api/approvals`、`/api/audit` 仅工作人员；
- `/api/chat` 只对工作人员返回 `trace`；
- 审批 `decidedBy` 从会话取；馆员不能审批自己发起的申请；
- 读者不能查询其他读者，不能复用他人的 `conversationId`。

详细矩阵见 [five-layers-pi-sdk.md](five-layers-pi-sdk.md)。

## 7. 与文章五层的对应

| 文章五层 | 本演示 |
|---|---|
| 意图层 | 身份、角色、工具授权、规则、审批角色、Agent 提示 |
| 知识层 | 本体、制度库、检索、引用 |
| 编排层 | Pi Durable Harness、DeepSeek、工具任务、会话隔离、Trace |
| 能力层 | 图书/读者/借阅/预约 API 与工具契约 |
| 基础设施层 | SQLite、HTTP、认证会话、审计、Agent 持久化 |

Pi 只出现在编排层，以及能力/基础设施的适配处；它不替代业务策略、知识、能力与治理。
