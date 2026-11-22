export type ToolSideEffect = 'read' | 'write' | 'payment'
export type Idempotency = 'none' | 'required'
export type PolicyDecisionValue = 'allow' | 'deny' | 'require_approval'

export type UserRole = 'reader' | 'librarian' | 'auditor' | 'admin'

export interface AuthUser {
  id: string
  username: string
  displayName: string
  role: UserRole
  readerId?: string
}

export interface ToolContract {
  name: string
  version: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  permissions: string[]
  sideEffect: ToolSideEffect
  idempotency: Idempotency
  approvalPolicy?: string
  timeoutMs?: number
  retry?: { maxAttempts: number }
}

export interface PolicyDecision {
  decision: PolicyDecisionValue
  policyId: string
  reason: string
  approvalRole?: string
}

export interface ApprovalRequest {
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

export interface AuditEvent {
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

export type LayerName =
  | 'intent'
  | 'knowledge'
  | 'orchestration'
  | 'capability'
  | 'infrastructure'

export interface TraceEvent {
  id: string
  runId: string
  layer: LayerName
  type: 'tool' | 'policy' | 'approval' | 'model' | 'audit'
  name: string
  status: 'ok' | 'error' | 'pending' | 'denied'
  startedAt: string
  endedAt?: string
  input?: Record<string, unknown>
  output?: unknown
  policy?: PolicyDecision
}

export interface KnowledgePassage {
  id: string
  text: string
  source: string
  version: string
  score?: number
}

export interface KnowledgeResult {
  passages: KnowledgePassage[]
  citations: string[]
  entities?: string[]
}

export interface AgentRunInput {
  /** Stable client-owned conversation ID; the Agent maps it to a durable Pi conversation. */
  chatId: string
  message: string
  user: AuthUser
}

export interface AgentRunResult {
  runId: string
  answer: string
  citations: string[]
  trace: TraceEvent[]
  pendingApproval?: ApprovalRequest
}

export const FIVE_LAYERS: { id: LayerName; name: string; en: string }[] = [
  { id: 'intent', name: '意图层', en: 'Intent' },
  { id: 'knowledge', name: '知识层', en: 'Knowledge' },
  { id: 'orchestration', name: '编排层', en: 'Orchestration' },
  { id: 'capability', name: '能力层', en: 'Capability' },
  { id: 'infrastructure', name: '基础设施层', en: 'Infrastructure' },
]

export const LIBRARY_TOOLS: ToolContract[] = [
  {
    name: 'catalog_search',
    version: '1.0.0',
    description: '按书名、作者、ISBN 或分类搜索馆藏图书',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    permissions: ['library:catalog:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 2 },
  },
  {
    name: 'catalog_list',
    version: '1.0.0',
    description: '列出馆藏图书，支持按分类和可借状态筛选；用于“列出全部/有哪些书/馆藏清单”',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        availableOnly: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: [],
    },
    permissions: ['library:catalog:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 2 },
  },
  {
    name: 'book_availability',
    version: '1.0.0',
    description: '查询一本书的可借副本与馆藏地',
    inputSchema: { type: 'object', properties: { bookId: { type: 'string' } }, required: ['bookId'] },
    permissions: ['library:catalog:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 2 },
  },
  {
    name: 'reader_get',
    version: '1.0.0',
    description: '查询读者状态、借阅上限与脱敏联系方式',
    inputSchema: { type: 'object', properties: { readerId: { type: 'string' } }, required: ['readerId'] },
    permissions: ['library:reader:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 2 },
  },
  {
    name: 'reader_search',
    version: '1.0.0',
    description: '工作人员按姓名或读者 ID 检索读者',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    permissions: ['library:reader:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 2 },
  },
  {
    name: 'loan_list',
    version: '1.0.0',
    description: '查询读者当前借阅、逾期与预计罚款',
    inputSchema: { type: 'object', properties: { readerId: { type: 'string' } }, required: ['readerId'] },
    permissions: ['library:loan:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 2 },
  },
  {
    name: 'knowledge_search',
    version: '1.0.0',
    description: '检索制度知识；问全部制度/规则总览时 query 可留空',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: [],
    },
    permissions: ['library:knowledge:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 2 },
  },
  {
    name: 'reservation_create',
    version: '1.0.0',
    description: '为读者创建图书预约；有逾期或超限时需要馆员审批',
    inputSchema: {
      type: 'object',
      properties: {
        bookId: { type: 'string' },
        bookTitle: { type: 'string' },
        readerId: { type: 'string' },
      },
      required: ['readerId'],
    },
    permissions: ['library:reservation:write'],
    sideEffect: 'write',
    idempotency: 'required',
    approvalPolicy: 'library.reservation.approval',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'branch_list',
    version: '1.0.0',
    description: '分馆、地址、电话、开放时间',
    inputSchema: { type: 'object', properties: {}, required: [] },
    permissions: ['library:branch:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 1 },
  },
  {
    name: 'reader_type_list',
    version: '1.0.0',
    description: '读者类型、借阅上限、预约上限、借期、续借规则',
    inputSchema: { type: 'object', properties: {}, required: [] },
    permissions: ['library:reader-type:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 1 },
  },
  {
    name: 'reader_admin',
    version: '1.0.0',
    description: '读者创建/修改/状态维护（action=create/update/update_status）',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:reader:write'],
    sideEffect: 'write',
    idempotency: 'none',
    approvalPolicy: 'library.reader.status',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'catalog_admin',
    version: '1.0.0',
    description: '图书/副本创建、修改、下架、调拨、状态维护',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:catalog:write'],
    sideEffect: 'write',
    idempotency: 'none',
    approvalPolicy: 'library.catalog.archive',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'circulation_admin',
    version: '1.0.0',
    description: '借书、还书、续借、逾期清单',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:circulation:write'],
    sideEffect: 'write',
    idempotency: 'required',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'reservation_admin',
    version: '1.0.0',
    description: '预约列表、取消、到馆取书',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:reservation:write'],
    sideEffect: 'write',
    idempotency: 'required',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'fine_admin',
    version: '1.0.0',
    description: '罚款列表、支付、减免（超 50 元馆员减免需审批）',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:fine:write'],
    sideEffect: 'write',
    idempotency: 'required',
    approvalPolicy: 'library.fine.waiver',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'notification_admin',
    version: '1.0.0',
    description: '通知列表、创建、标记发送',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:notification:write'],
    sideEffect: 'write',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'acquisition_admin',
    version: '1.0.0',
    description: '供应商、采购申请、订单、验收',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:acquisition:write'],
    sideEffect: 'write',
    idempotency: 'required',
    approvalPolicy: 'library.acquisition.approval',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'serial_admin',
    version: '1.0.0',
    description: '连续出版物订购、到刊登记',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:serial:write'],
    sideEffect: 'write',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'resource_admin',
    version: '1.0.0',
    description: '电子资源与许可状态',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:resource:write'],
    sideEffect: 'write',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'ill_admin',
    version: '1.0.0',
    description: '馆际互借申请与状态流转',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:ill:write'],
    sideEffect: 'write',
    idempotency: 'required',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'stocktake_admin',
    version: '1.0.0',
    description: '馆藏盘点任务、扫描、完成',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:stocktake:write'],
    sideEffect: 'write',
    idempotency: 'required',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'event_admin',
    version: '1.0.0',
    description: '阅读推广活动列表与创建',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:event:write'],
    sideEffect: 'write',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 0 },
  },
  {
    name: 'report',
    version: '1.0.0',
    description: '流通、逾期、馆藏统计报表',
    inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] },
    permissions: ['library:report:read'],
    sideEffect: 'read',
    idempotency: 'none',
    timeoutMs: 5000,
    retry: { maxAttempts: 1 },
  },
]
