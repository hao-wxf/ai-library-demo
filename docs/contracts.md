# 契约说明

> 仓库：<https://github.com/hao-wxf/ai-library-demo>（MIT）  
> 完整技术文档：[five-layers-pi-sdk.md](five-layers-pi-sdk.md)

框架的可复用性来自契约，而不是某个实现。本演示包含以下契约。

## ToolContract

```ts
interface ToolContract {
  name: string
  version: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  permissions: string[]
  sideEffect: 'read' | 'write' | 'payment'
  idempotency: 'none' | 'required'
  approvalPolicy?: string
  timeoutMs?: number
  retry?: { maxAttempts: number }
}
```

本演示的工具清单在 `packages/contracts/src/index.ts` 的 `LIBRARY_TOOLS`。

## AuthUser / AgentRunInput

```ts
type UserRole = 'reader' | 'librarian' | 'auditor' | 'admin'

interface AuthUser {
  id: string
  username: string
  displayName: string
  role: UserRole
  readerId?: string
}

interface AgentRunInput {
  chatId: string        // UI 对话 ID，服务端映射到独立 Pi conversation
  message: string
  user: AuthUser        // 来自服务端会话，不来自请求体
}
```

身份由服务端 Cookie 会话解析；前端不能通过传 `role` 或 `readerId` 提权。

## PolicyDecision

```ts
type PolicyDecision =
  | { decision: 'allow'; policyId: string; reason: string }
  | { decision: 'deny'; policyId: string; reason: string }
  | { decision: 'require_approval'; policyId: string; reason: string; approvalRole: string }
```

策略必须由代码执行，而不是只写进 Prompt。角色级工具授权在 `canUseTool`，业务规则在 `canReserve`，两者分开。

## ApprovalRequest

```ts
interface ApprovalRequest {
  id: string
  runId: string
  toolCallId?: string
  policyId: string
  tool: string
  payload: Record<string, unknown>
  requestedBy: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'failed'
  createdAt: string
  decidedAt?: string
  decidedBy?: string
  reason?: string
}
```

生产版应把审批做成持久化任务，批准后恢复 Agent 运行。

## AuditEvent

```ts
interface AuditEvent {
  id: string
  runId: string
  traceId: string
  actor: string
  agentId: string
  tool: string
  inputHash: string
  policyDecision: string
  approvalId?: string
  result: string
  createdAt: string
  details?: Record<string, unknown>
}
```

每次工具调用、策略判断、审批决定都应可追溯。

## TraceEvent

```ts
interface TraceEvent {
  id: string
  runId: string
  layer: 'intent' | 'knowledge' | 'orchestration' | 'capability' | 'infrastructure'
  type: 'tool' | 'policy' | 'approval' | 'model' | 'audit'
  name: string
  status: 'ok' | 'error' | 'pending' | 'denied'
  startedAt: string
  endedAt?: string
  input?: Record<string, unknown>
  output?: unknown
  policy?: PolicyDecision
}
```

Trace 是 UI 和评测的共同数据源。`/api/chat` 只对工作人员返回 Trace；读者响应中不包含 Trace。开发者视图和审批/审计接口都做服务端 RBAC 校验，前端隐藏按钮只是体验层。

## KnowledgeQuery / KnowledgeResult

```ts
interface KnowledgeResult {
  passages: { id: string; text: string; source: string; version: string; score?: number }[]
  citations: string[]
  entities?: string[]
}
```

知识工具必须返回引用和版本；生产版增加租户/数据权限、置信度和图谱关系。

## Agent Runtime API

```http
POST /runs            { intent, actor, tenant, context }
GET  /runs/{id}
POST /runs/{id}/approve
POST /runs/{id}/cancel
GET  /runs/{id}/events
```

本演示为了简化，把一次运行的 API 收敛为 `POST /api/chat`；生产版应拆成独立的 Agent Runtime 服务，并提供 SSE/审批/取消接口。
