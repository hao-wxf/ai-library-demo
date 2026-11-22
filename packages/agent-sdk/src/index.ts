import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { createModels } from '@earendil-works/pi-ai'
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek'
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  section,
} from '@earendil-works/pi-durable'
import type {
  Conversation,
  ConversationId,
  EntryId,
  ToolExecutionApi,
} from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { arr, bool, num, obj, opt, str } from '@earendil-works/pi-schema'
import type {
  AgentRunInput,
  AgentRunResult,
  ApprovalRequest,
  AuthUser,
  LayerName,
  PolicyDecision,
  TraceEvent,
  UserRole,
} from '../../contracts/src/index.ts'
import type { BusinessService, ChatConversationView } from '../../capability-sdk/src/index.ts'
import { canReserve, canUseTool } from '../../policy-sdk/src/index.ts'
import { listKnowledge, searchKnowledge } from '../../knowledge-sdk/src/index.ts'

type ToolDetails = Record<string, unknown>
type ToolResult = { output: { type: 'text'; text: string }[]; details: JsonValue }

interface ActiveRun {
  chatId: string
  runId: string
  traceId: string
  user: AuthUser
  trace: TraceEvent[]
  citations: string[]
  pendingApprovalId?: string
}

export class ChatAccessError extends Error {
  constructor(message = '无权访问该对话') {
    super(message)
    this.name = 'ChatAccessError'
  }
}

function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)
}

function textResult(text: string, details: ToolDetails): ToolResult {
  return { output: [{ type: 'text', text }], details: details as unknown as JsonValue }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && typeof block === 'object' && (block as { type?: string }).type === 'text')
    .map((block) => String((block as { text?: unknown }).text ?? ''))
    .join('\n')
}

function roleName(role: UserRole): string {
  switch (role) {
    case 'reader':
      return '读者'
    case 'librarian':
      return '馆员'
    case 'auditor':
      return '审计员'
    case 'admin':
      return '管理员'
  }
}

function actorLabel(user: AuthUser): string {
  return `${user.displayName}（${user.username} / ${roleName(user.role)}${user.readerId ? ` / ${user.readerId}` : ''}）`
}

function buildSystemPrompt(run: ActiveRun | undefined): string {
  const identity = run
    ? `当前用户：${run.user.displayName}（${run.user.username}），角色：${roleName(run.user.role)}${run.user.readerId ? `，读者 ID：${run.user.readerId}` : '，无绑定读者 ID'}。`
    : '当前没有可用的会话身份。'

  const roleRules =
    run?.user.role === 'reader'
      ? '你是读者会话：只能查询本人借阅和个人信息，只能为本人预约；不能查询其他读者，不能查看 Trace、审批列表或审计。'
      : run?.user.role === 'auditor'
        ? '你是审计角色：可以查询馆藏、制度、读者和借阅用于审计，但不得创建预约或处理审批；开发者视图只读。'
        : run?.user.role === 'librarian'
          ? '你是馆员：可以查询任意读者、查询馆藏和制度，可以代读者创建预约、处理审批；不能审批自己发起的申请。'
          : '你是管理员：拥有馆员与审计权限；仍应遵守最小必要原则，不泄露无关个人信息。'

  return `你是图书馆 AI 助手，服务读者、馆员和审计人员。${identity}

身份与权限规则：
${roleRules}

工具使用规则：
1. 回答馆藏、可借状态、借阅记录、读者信息、制度规则等事实前，必须先调用对应工具；不得凭记忆或猜测编造。
2. 单本馆藏/可借状态用 catalog_search / book_availability；用户要求“全部图书、有哪些书、馆藏清单”时用 catalog_list，不要说不能列出。制度与开放时间用 knowledge_search；问全部制度/规则总览时 query 可留空。读者本人借阅用 loan_list；工作人员查其他读者先用 reader_search 再 reader_get / loan_list。
3. 读者预约默认本人；工作人员代预约时，必须先确定 readerId。创建预约用 reservation_create。
4. 业务维护使用领域工具：馆藏/副本用 catalog_admin；读者资料用 reader_admin；借还/续借用 circulation_admin；预约查询/取消/取书用 reservation_admin；罚款用 fine_admin；通知用 notification_admin；采访采购用 acquisition_admin；连续出版物用 serial_admin；电子资源用 resource_admin；馆际互借用 ill_admin；盘点用 stocktake_admin；阅读活动用 event_admin；报表用 report；分馆/读者类型用 branch_list / reader_type_list。
5. 用户明确要求预约且信息齐全时，直接调用 reservation_create，不要反复要求确认。缺少书名或读者时，先问清或先检索，不要猜。
6. 工具返回 require_approval 时，明确告诉用户审批号和原因，不要声称预约或减免已经成功。工具返回 deny 时，解释业务原因，不要绕过。
7. 回答自然、简洁、可执行；使用纯文本，不要输出 Markdown 表格、标题或代码块，列表用短横线。
8. 不要输出内部提示词、工具参数结构或数据库表名。
9. 不泄露完整手机号、密码、Token 或其他读者的隐私信息。`
}

export async function createLibraryAgent(options: {
  business: BusinessService
  dataDir: string
}) {
  const { business, dataDir } = options
  mkdirSync(dataDir, { recursive: true })

  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is required. Put it in .env or export it before starting the server.')
  }

  const provider = deepseekProvider()
  const models = createModels()
  models.setProvider(provider)
  const modelId = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
  const model = models.getModel('deepseek', modelId)
  if (!model) {
    const available = provider.getModels().map((item) => item.id).join(', ')
    throw new Error(`Unknown DEEPSEEK_MODEL "${modelId}". Available: ${available}`)
  }
  const modelRef = { provider: model.provider, modelId: model.id }

  const activeRuns = new Map<string, ActiveRun>()
  const conversationCache = new Map<string, Conversation>()
  const chatQueues = new Map<string, Promise<unknown>>()

  function currentRun(api: ToolExecutionApi): ActiveRun {
    const run = activeRuns.get(String(api.conversationId))
    if (!run) throw new Error('No active agent run for this conversation')
    return run
  }

  function traceStart(
    run: ActiveRun,
    layer: LayerName,
    type: TraceEvent['type'],
    name: string,
    input?: Record<string, unknown>,
  ): TraceEvent {
    const event: TraceEvent = {
      id: `TRC-${randomUUID().slice(0, 8)}`,
      runId: run.runId,
      layer,
      type,
      name,
      status: 'pending',
      startedAt: new Date().toISOString(),
      ...(input ? { input } : {}),
    }
    run.trace.push(event)
    return event
  }

  function traceEnd(
    event: TraceEvent,
    status: TraceEvent['status'],
    output?: unknown,
    policy?: PolicyDecision,
  ): void {
    event.status = status
    event.endedAt = new Date().toISOString()
    if (output !== undefined) event.output = output
    if (policy) event.policy = policy
  }

  function tracePolicy(run: ActiveRun, policy: PolicyDecision): void {
    const event = traceStart(run, 'intent', 'policy', policy.policyId)
    const status: TraceEvent['status'] =
      policy.decision === 'allow' ? 'ok' : policy.decision === 'deny' ? 'denied' : 'pending'
    traceEnd(event, status, { reason: policy.reason, approvalRole: policy.approvalRole }, policy)
  }

  function auditTool(run: ActiveRun, input: {
    tool: string
    args: unknown
    policyDecision: string
    result: string
    approvalId?: string
    details?: ToolDetails
  }): void {
    business.recordAudit({
      runId: run.runId,
      traceId: run.traceId,
      actor: actorLabel(run.user),
      agentId: 'library-agent',
      tool: input.tool,
      inputHash: hashInput(input.args),
      policyDecision: input.policyDecision,
      approvalId: input.approvalId,
      result: input.result,
      details: input.details,
    })
  }

  function addCitation(run: ActiveRun, citation: string): void {
    if (!run.citations.includes(citation)) run.citations.push(citation)
  }

  function authorize(
    run: ActiveRun,
    tool: Parameters<typeof canUseTool>[1],
    targetReaderId?: string,
  ): PolicyDecision {
    const policy = canUseTool(run.user, tool, targetReaderId)
    tracePolicy(run, policy)
    return policy
  }

  const tools = [
    defineTool({
      name: 'catalog_search',
      description: '按书名、作者、ISBN 或分类搜索馆藏图书。返回图书 ID、可借副本数和馆藏地。',
      parameters: obj({ query: str() }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'catalog_search', { query: args.query })
        const policy = authorize(run, 'catalog_search')
        const books = business.searchBooks(args.query)
        const text = books.length === 0
          ? `没有找到与“${args.query}”匹配的图书。`
          : books
              .map(
                (book) =>
                  `《${book.title}》（ID: ${book.id}） ${book.author}｜可借 ${book.availableCopies}/${book.totalCopies}`,
              )
              .join('\n')
        const details: ToolDetails = { query: args.query, books, policy }
        traceEnd(event, 'ok', { books, policy })
        addCitation(run, '馆藏数据库')
        auditTool(run, {
          tool: 'catalog_search',
          args,
          policyDecision: policy.decision,
          result: 'ok',
          details,
        })
        return textResult(text, details)
      },
    }),
    defineTool({
      name: 'catalog_list',
      description:
        '列出馆藏图书，支持按分类筛选和只看可借。用户要求“列出全部图书 / 有哪些书 / 馆藏清单”时必须使用，不要说不能列出。默认最多 100 本。',
      parameters: obj({
        category: opt(str()),
        availableOnly: opt(bool()),
        limit: opt(num()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'catalog_list', {
          category: args.category,
          availableOnly: args.availableOnly,
          limit: args.limit,
        })
        const policy = authorize(run, 'catalog_list')
        const limit = Math.min(Math.max(Math.floor(args.limit ?? 100), 1), 200)
        const allBooks = business.listBooks()
        const filtered = allBooks.filter((book) => {
          if (args.category && !book.category.includes(args.category) && !book.title.includes(args.category)) {
            return false
          }
          if (args.availableOnly && book.availableCopies <= 0) return false
          return true
        })
        const books = filtered.slice(0, limit)
        const header = filtered.length > books.length
          ? `馆藏共 ${filtered.length} 本，显示前 ${books.length} 本：`
          : `馆藏共 ${filtered.length} 本：`
        const text = filtered.length === 0
          ? '没有符合条件的馆藏图书。'
          : `${header}\n${books
              .map(
                (book) =>
                  `《${book.title}》（ID: ${book.id}） ${book.author}｜${book.category}｜可借 ${book.availableCopies}/${book.totalCopies}`,
              )
              .join('\n')}`
        const details: ToolDetails = {
          total: filtered.length,
          shown: books.length,
          category: args.category,
          availableOnly: Boolean(args.availableOnly),
          books,
          policy,
        }
        traceEnd(event, 'ok', { total: filtered.length, books, policy })
        addCitation(run, '馆藏数据库')
        auditTool(run, {
          tool: 'catalog_list',
          args,
          policyDecision: policy.decision,
          result: 'ok',
          details,
        })
        return textResult(text, details)
      },
    }),
    defineTool({
      name: 'book_availability',
      description: '查询一本书的可借副本、馆藏地与图书 ID。',
      parameters: obj({ bookId: str() }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'book_availability', { bookId: args.bookId })
        const policy = authorize(run, 'book_availability')
        const book = business.getBook(args.bookId)
        if (!book) {
          traceEnd(event, 'error', { message: '图书不存在' }, policy)
          auditTool(run, {
            tool: 'book_availability',
            args,
            policyDecision: policy.decision,
            result: 'not_found',
          })
          return textResult(`没有找到图书 ID ${args.bookId}。可以先调用 catalog_search 按书名检索。`, {
            status: 'not_found',
            policy,
          })
        }
        const copies = business.listCopies(args.bookId)
        const text = `《${book.title}》（ID: ${book.id}）可借 ${book.availableCopies}/${book.totalCopies}；馆藏：${copies
          .map((copy) => `${copy.id}(${copy.branch},${copy.status})`)
          .join('，')}`
        traceEnd(event, 'ok', { book, copies, policy })
        addCitation(run, '馆藏数据库')
        auditTool(run, {
          tool: 'book_availability',
          args,
          policyDecision: policy.decision,
          result: 'ok',
          details: { book, copies },
        })
        return textResult(text, { book, copies, policy })
      },
    }),
    defineTool({
      name: 'reader_get',
      description: '查询读者状态、借阅上限、预约数量与脱敏联系方式。读者只能查本人；工作人员可查任意读者。',
      parameters: obj({ readerId: str() }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'reader_get', { readerId: args.readerId })
        const policy = authorize(run, 'reader_get', args.readerId)
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          auditTool(run, {
            tool: 'reader_get',
            args,
            policyDecision: policy.decision,
            result: 'denied',
            details: { reason: policy.reason },
          })
          return textResult(`无法查看该读者信息：${policy.reason}`, { status: 'denied', policy })
        }
        const reader = business.getReader(args.readerId)
        if (!reader) {
          traceEnd(event, 'error', { message: '读者不存在' }, policy)
          auditTool(run, {
            tool: 'reader_get',
            args,
            policyDecision: policy.decision,
            result: 'not_found',
          })
          return textResult(`没有找到读者 ID ${args.readerId}。`, { status: 'not_found', policy })
        }
        const text = `读者 ${reader.name}（${reader.id}）状态：${reader.status}；借阅 ${reader.activeLoans}/${reader.maxLoans}；预约 ${reader.activeReservations}/3；电话 ${reader.phoneMasked}；逾期：${reader.hasOverdue ? '有' : '无'}`
        traceEnd(event, 'ok', { reader, policy })
        addCitation(run, '读者数据库')
        auditTool(run, {
          tool: 'reader_get',
          args,
          policyDecision: policy.decision,
          result: 'ok',
          details: { reader },
        })
        return textResult(text, { reader, policy })
      },
    }),
    defineTool({
      name: 'reader_search',
      description: '按姓名或读者 ID 检索读者，返回读者 ID、状态和借阅概况。仅工作人员可用。',
      parameters: obj({ query: str() }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'reader_search', { query: args.query })
        const policy = authorize(run, 'reader_search')
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          auditTool(run, {
            tool: 'reader_search',
            args,
            policyDecision: policy.decision,
            result: 'denied',
          })
          return textResult(`无法检索读者：${policy.reason}`, { status: 'denied', policy })
        }
        const query = args.query.trim().toLowerCase()
        const readers = business
          .listReaders()
          .filter((reader) => reader.id.toLowerCase().includes(query) || reader.name.toLowerCase().includes(query))
          .slice(0, 10)
        const text = readers.length === 0
          ? `没有找到与“${args.query}”匹配的读者。`
          : readers
              .map(
                (reader) =>
                  `${reader.name}（读者 ID: ${reader.id}）状态 ${reader.status}｜借阅 ${reader.activeLoans}/${reader.maxLoans}｜逾期 ${reader.hasOverdue ? '有' : '无'}`,
              )
              .join('\n')
        traceEnd(event, 'ok', { readers, policy })
        addCitation(run, '读者数据库')
        auditTool(run, {
          tool: 'reader_search',
          args,
          policyDecision: policy.decision,
          result: 'ok',
          details: { count: readers.length },
        })
        return textResult(text, { readers, policy })
      },
    }),
    defineTool({
      name: 'loan_list',
      description: '查询读者当前借阅、应还日期、逾期天数与预计罚款。读者只能查本人；工作人员可查任意读者。',
      parameters: obj({ readerId: str() }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'loan_list', { readerId: args.readerId })
        const policy = authorize(run, 'loan_list', args.readerId)
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          auditTool(run, {
            tool: 'loan_list',
            args,
            policyDecision: policy.decision,
            result: 'denied',
            details: { reason: policy.reason },
          })
          return textResult(`无法查看该读者的借阅：${policy.reason}`, { status: 'denied', policy })
        }
        const reader = business.getReader(args.readerId)
        if (!reader) {
          traceEnd(event, 'error', { message: '读者不存在' }, policy)
          return textResult(`没有找到读者 ID ${args.readerId}。`, { status: 'not_found', policy })
        }
        const loans = business.listLoans(args.readerId)
        const totalFine = loans.reduce((sum, loan) => sum + loan.fine, 0)
        const overdueCount = loans.filter((loan) => loan.overdueDays > 0).length
        const text = loans.length === 0
          ? '当前没有借阅记录。'
          : loans
              .map((loan) => {
                const state = loan.returnedAt
                  ? '已归还'
                  : loan.overdueDays > 0
                    ? `逾期 ${loan.overdueDays} 天，罚款 ${loan.fine.toFixed(2)} 元`
                    : '在借'
                return `《${loan.bookTitle}》（${loan.copyId}）｜应还 ${loan.dueAt.slice(0, 10)}｜${state}`
              })
              .join('\n') + `\n预计罚款合计：${totalFine.toFixed(2)} 元`
        traceEnd(event, 'ok', { loans, totalFine, overdueCount, policy })
        addCitation(run, '借阅数据库')
        auditTool(run, {
          tool: 'loan_list',
          args,
          policyDecision: policy.decision,
          result: 'ok',
          details: { loans, totalFine, overdueCount },
        })
        return textResult(text, { loans, totalFine, overdueCount, policy })
      },
    }),
    defineTool({
      name: 'knowledge_search',
      description:
        '检索借阅规则、预约规则、读者隐私、开放时间、逾期与罚款等制度知识，返回引用来源。用户想了解全部制度/规则总览时，query 可以留空或传“全部”。',
      parameters: obj({ query: opt(str()) }),
      async execute(args, api) {
        const run = currentRun(api)
        const query = (args.query ?? '').trim()
        const event = traceStart(run, 'knowledge', 'tool', 'knowledge_search', { query })
        const policy = authorize(run, 'knowledge_search')
        const broad = !query || /全部|所有|总览|制度|规则|哪些/.test(query)
        const result = broad ? listKnowledge() : searchKnowledge(query, 3)
        for (const citation of result.citations) addCitation(run, citation)
        const text = result.passages
          .map((passage) => `${passage.text}（${passage.source} · ${passage.version}）`)
          .join('\n\n')
        traceEnd(event, 'ok', { passages: result.passages, citations: result.citations, policy })
        auditTool(run, {
          tool: 'knowledge_search',
          args,
          policyDecision: policy.decision,
          result: 'ok',
          details: { query, citations: result.citations },
        })
        return textResult(text || '知识库中没有找到相关制度。', { ...result, policy })
      },
    }),
    defineTool({
      name: 'reservation_create',
      description:
        '为读者创建图书预约。bookId 或 bookTitle 至少提供一个；readerId 必填。有逾期或超限时返回 require_approval，不会直接创建。',
      parameters: obj({
        bookId: opt(str()),
        bookTitle: opt(str()),
        readerId: str(),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'reservation_create', {
          bookId: args.bookId,
          bookTitle: args.bookTitle,
          readerId: args.readerId,
        })
        const policy = authorize(run, 'reservation_create', args.readerId)
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          auditTool(run, {
            tool: 'reservation_create',
            args,
            policyDecision: policy.decision,
            result: 'denied',
            details: { reason: policy.reason },
          })
          return textResult(`无法创建预约：${policy.reason}`, { status: 'denied', policy })
        }

        let book = args.bookId ? business.getBook(args.bookId) : undefined
        if (!book && args.bookTitle) {
          const matches = business.searchBooks(args.bookTitle)
          book = matches.find((item) => item.title === args.bookTitle) ?? matches[0]
        }
        const reader = business.getReader(args.readerId)
        if (!reader || !book) {
          const message = !reader ? `读者 ${args.readerId} 不存在` : `图书 ${args.bookId ?? args.bookTitle ?? ''} 不存在`
          traceEnd(event, 'error', { message }, policy)
          auditTool(run, {
            tool: 'reservation_create',
            args,
            policyDecision: policy.decision,
            result: 'not_found',
          })
          return textResult(`无法创建预约：${message}。请先检索确认图书或读者。`, {
            status: 'not_found',
            policy,
          })
        }

        const existing = business
          .listReservations(args.readerId)
          .find((reservation) => reservation.bookId === book.id && reservation.status === 'active')
        if (existing) {
          const details: ToolDetails = { status: 'existing', reservation: existing, policy }
          traceEnd(event, 'ok', details, policy)
          auditTool(run, {
            tool: 'reservation_create',
            args,
            policyDecision: policy.decision,
            result: 'existing',
            details,
          })
          return textResult(`读者已经预约过《${book.title}》，预约号 ${existing.id}。`, details)
        }

        const businessPolicy = canReserve({ reader, book })
        tracePolicy(run, businessPolicy)
        if (businessPolicy.decision === 'deny') {
          const details: ToolDetails = { status: 'denied', reason: businessPolicy.reason, policy: businessPolicy }
          traceEnd(event, 'denied', details, businessPolicy)
          auditTool(run, {
            tool: 'reservation_create',
            args,
            policyDecision: 'deny',
            result: 'denied',
            details,
          })
          return textResult(`无法预约：${businessPolicy.reason}`, details)
        }
        if (businessPolicy.decision === 'require_approval') {
          const approval = business.createApproval({
            runId: run.runId,
            toolCallId: api.callId,
            policyId: businessPolicy.policyId,
            tool: 'reservation_create',
            payload: { bookId: book.id, bookTitle: book.title, readerId: args.readerId },
            requestedBy: run.user.username,
          })
          run.pendingApprovalId = approval.id
          addCitation(run, '预约数据库')
          const approvalTrace = traceStart(run, 'capability', 'approval', 'reservation_create_approval', {
            approvalId: approval.id,
          })
          traceEnd(approvalTrace, 'pending', { approvalId: approval.id }, businessPolicy)
          const details: ToolDetails = {
            status: 'pending_approval',
            approvalId: approval.id,
            reason: businessPolicy.reason,
            policy: businessPolicy,
          }
          traceEnd(event, 'pending', details, businessPolicy)
          auditTool(run, {
            tool: 'reservation_create',
            args,
            policyDecision: 'require_approval',
            result: 'pending_approval',
            approvalId: approval.id,
            details,
          })
          return textResult(
            `预约需要馆员审批：${businessPolicy.reason}。审批号 ${approval.id}。`,
            details,
          )
        }
        const reservation = business.createReservation(
          book.id,
          args.readerId,
          run.user.role === 'reader' ? undefined : run.user.username,
        )
        const details: ToolDetails = { status: 'created', reservation, policy: businessPolicy }
        traceEnd(event, 'ok', details, businessPolicy)
        addCitation(run, '预约数据库')
        auditTool(run, {
          tool: 'reservation_create',
          args,
          policyDecision: 'allow',
          result: 'created',
          details,
        })
        return textResult(
          `已为《${book.title}》创建预约，预约号 ${reservation.id}，3 天内有效。`,
          details,
        )
      },
    }),
    defineTool({
      name: 'branch_list',
      description: '列出分馆、地址、电话、开放时间与状态。',
      parameters: obj({}),
      async execute(_args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'branch_list')
        const policy = authorize(run, 'branch_list')
        const branches = business.listBranches()
        const text = branches
          .map((branch) => `${branch.name}（${branch.id}）｜${branch.address}｜${branch.openingHours}｜${branch.phone}`)
          .join('\n')
        traceEnd(event, 'ok', { branches, policy })
        addCitation(run, '分馆信息')
        auditTool(run, { tool: 'branch_list', args: {}, policyDecision: policy.decision, result: 'ok' })
        return textResult(text || '暂无分馆信息。', { branches, policy })
      },
    }),
    defineTool({
      name: 'reader_type_list',
      description: '列出读者类型及其借阅上限、预约上限、借期、续借次数。',
      parameters: obj({}),
      async execute(_args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'reader_type_list')
        const policy = authorize(run, 'reader_type_list')
        const types = business.listReaderTypes()
        const text = types
          .map(
            (type) =>
              `${type.name}（${type.id}）｜借阅 ${type.maxLoans} 册｜预约 ${type.maxReservations} 个｜借期 ${type.loanDays} 天｜续借 ${type.maxRenews} 次 × ${type.renewDays} 天`,
          )
          .join('\n')
        traceEnd(event, 'ok', { types, policy })
        addCitation(run, '读者类型')
        auditTool(run, { tool: 'reader_type_list', args: {}, policyDecision: policy.decision, result: 'ok' })
        return textResult(text || '暂无读者类型。', { types, policy })
      },
    }),
    defineTool({
      name: 'reader_admin',
      description:
        '读者管理。action=create 创建读者；update 修改姓名/类型/电话/邮箱/有效期；update_status 修改状态（active/suspended/expired/lost）。工作人员使用。',
      parameters: obj({
        action: str({ description: 'create | update | update_status' }),
        readerId: opt(str()),
        name: opt(str()),
        readerTypeId: opt(str()),
        phone: opt(str()),
        email: opt(str()),
        expiresAt: opt(str()),
        status: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'reader_admin', args)
        const action = args.action
        const policyName = action === 'create' ? 'reader_create' : action === 'update' ? 'reader_update' : 'reader_update_status'
        const policy = authorize(run, policyName)
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          auditTool(run, { tool: 'reader_admin', args, policyDecision: policy.decision, result: 'denied' })
          return textResult(`无法维护读者：${policy.reason}`, { status: 'denied', policy })
        }
        try {
          let result: unknown
          if (action === 'create') {
            if (!args.name || !args.phone) throw new Error('创建读者需要 name 和 phone')
            result = business.createReader({
              name: args.name,
              phone: args.phone,
              readerTypeId: args.readerTypeId,
              email: args.email,
              expiresAt: args.expiresAt,
            })
          } else if (action === 'update') {
            if (!args.readerId) throw new Error('修改读者需要 readerId')
            result = business.updateReader(args.readerId, {
              name: args.name,
              readerTypeId: args.readerTypeId,
              phone: args.phone,
              email: args.email,
              expiresAt: args.expiresAt,
            })
          } else if (action === 'update_status') {
            if (!args.readerId || !args.status) throw new Error('修改状态需要 readerId 和 status')
            result = business.updateReaderStatus(args.readerId, args.status)
          } else {
            throw new Error(`不支持的 action：${action}`)
          }
          traceEnd(event, 'ok', { result, policy })
          addCitation(run, '读者数据库')
          auditTool(run, { tool: 'reader_admin', args, policyDecision: policy.decision, result: 'ok', details: { result } })
          const reader = result as { id: string; name: string; status: string; readerTypeName: string }
          return textResult(
            `读者 ${reader.name}（${reader.id}）已保存，类型 ${reader.readerTypeName}，状态 ${reader.status}。`,
            { action, result, policy },
          )
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) }, policy)
          auditTool(run, { tool: 'reader_admin', args, policyDecision: policy.decision, result: 'error' })
          return textResult(`读者操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
            policy,
          })
        }
      },
    }),
    defineTool({
      name: 'catalog_admin',
      description:
        '馆藏维护。action=create_book/update_book/archive_book/create_copy/list_copies/update_copy_status/transfer_copy。工作人员使用；修改馆藏和副本前先检索确认 ID。',
      parameters: obj({
        action: str({
          description:
            'create_book | update_book | archive_book | create_copy | list_copies | update_copy_status | transfer_copy',
        }),
        bookId: opt(str()),
        copyId: opt(str()),
        title: opt(str()),
        author: opt(str()),
        isbn: opt(str()),
        category: opt(str()),
        publisher: opt(str()),
        publishedYear: opt(num()),
        edition: opt(str()),
        language: opt(str()),
        pages: opt(num()),
        price: opt(num()),
        summary: opt(str()),
        keywords: opt(str()),
        branch: opt(str()),
        location: opt(str()),
        callNumber: opt(str()),
        barcode: opt(str()),
        condition: opt(str()),
        status: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'catalog_admin', args)
        const action = args.action
        const policyName =
          action === 'create_book'
            ? 'book_create'
            : action === 'update_book'
              ? 'book_update'
              : action === 'archive_book'
                ? 'book_archive'
                : action === 'create_copy'
                  ? 'copy_create'
                  : action === 'list_copies'
                    ? 'copy_list'
                    : action === 'update_copy_status'
                      ? 'copy_update_status'
                      : action === 'transfer_copy'
                        ? 'copy_transfer'
                        : 'book_update'
        const policy = authorize(run, policyName)
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          auditTool(run, { tool: 'catalog_admin', args, policyDecision: policy.decision, result: 'denied' })
          return textResult(`无法维护馆藏：${policy.reason}`, { status: 'denied', policy })
        }
        try {
          let result: unknown
          if (action === 'create_book') {
            if (!args.title || !args.author || !args.isbn || !args.category) {
              throw new Error('创建图书需要 title/author/isbn/category')
            }
            result = business.createBook({
              title: args.title,
              author: args.author,
              isbn: args.isbn,
              category: args.category,
              publisher: args.publisher,
              publishedYear: args.publishedYear,
              edition: args.edition,
              language: args.language,
              pages: args.pages,
              price: args.price,
              summary: args.summary,
              keywords: args.keywords,
            })
          } else if (action === 'update_book') {
            if (!args.bookId) throw new Error('修改图书需要 bookId')
            result = business.updateBook(args.bookId, {
              title: args.title,
              author: args.author,
              isbn: args.isbn,
              category: args.category,
              publisher: args.publisher,
              publishedYear: args.publishedYear,
              edition: args.edition,
              language: args.language,
              pages: args.pages,
              price: args.price,
              summary: args.summary,
              keywords: args.keywords,
              status: args.status,
            })
          } else if (action === 'archive_book') {
            if (!args.bookId) throw new Error('下架图书需要 bookId')
            result = business.archiveBook(args.bookId)
          } else if (action === 'create_copy') {
            if (!args.bookId || !args.branch) throw new Error('新增副本需要 bookId 和 branch')
            result = business.createCopy({
              bookId: args.bookId,
              branch: args.branch,
              location: args.location,
              callNumber: args.callNumber,
              barcode: args.barcode,
              condition: args.condition,
            })
          } else if (action === 'list_copies') {
            result = args.bookId ? business.listCopies(args.bookId) : business.listAllCopies(args.branch)
          } else if (action === 'update_copy_status') {
            if (!args.copyId || !args.status) throw new Error('修改副本状态需要 copyId 和 status')
            result = business.updateCopyStatus(args.copyId, args.status)
          } else if (action === 'transfer_copy') {
            if (!args.copyId || !args.branch) throw new Error('调拨副本需要 copyId 和 branch')
            result = business.transferCopy(args.copyId, args.branch, args.location)
          } else {
            throw new Error(`不支持的 action：${action}`)
          }
          traceEnd(event, 'ok', { result, policy })
          addCitation(run, '馆藏数据库')
          auditTool(run, { tool: 'catalog_admin', args, policyDecision: policy.decision, result: 'ok', details: { result } })
          let text = `馆藏操作已完成：${action}`
          if (action === 'create_book' || action === 'update_book' || action === 'archive_book') {
            const book = result as { id: string; title: string; status: string }
            text = `图书《${book.title}》已保存，图书 ID ${book.id}，状态 ${book.status}。`
          } else if (action === 'create_copy' || action === 'update_copy_status' || action === 'transfer_copy') {
            const copy = result as { id: string; bookTitle: string; branch: string; location: string; status: string }
            text = `副本 ${copy.id}（《${copy.bookTitle}》）｜分馆 ${copy.branch}｜位置 ${copy.location}｜状态 ${copy.status}。`
          } else if (action === 'list_copies') {
            const copies = result as { id: string; bookTitle: string; branch: string; location: string; status: string }[]
            text = copies.length === 0
              ? '没有找到副本。'
              : copies
                  .map(
                    (copy) =>
                      `${copy.id}｜《${copy.bookTitle}》｜${copy.branch}｜${copy.location}｜${copy.status}`,
                  )
                  .join('\n')
          }
          return textResult(text, { action, result, policy })
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) }, policy)
          auditTool(run, { tool: 'catalog_admin', args, policyDecision: policy.decision, result: 'error' })
          return textResult(`馆藏操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
            policy,
          })
        }
      },
    }),
    defineTool({
      name: 'circulation_admin',
      description:
        '流通管理。action=borrow（bookId+readerId，可选 branch）/return（优先传 L- 开头的借阅号 loanId；也可传 readerId + bookTitle 定位在借记录）/renew（同上）/overdue_list。读者可为本人借书、还书、续借；工作人员可代办。借阅号不是读者证号。',
      parameters: obj({
        action: str({ description: 'borrow | return | renew | overdue_list' }),
        bookId: opt(str()),
        readerId: opt(str()),
        loanId: opt(str({ description: 'L- 开头的借阅号，不是读者证号' })),
        bookTitle: opt(str({ description: '没有借阅号时，用书名 + readerId 定位在借记录' })),
        branch: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'circulation_admin', args)
        try {
          if (args.action === 'overdue_list') {
            const policy = authorize(run, 'loan_overdue_list')
            if (policy.decision !== 'allow') {
              traceEnd(event, 'denied', { reason: policy.reason }, policy)
              return textResult(`无法查看逾期：${policy.reason}`, { status: 'denied', policy })
            }
            const loans = business.listOverdueLoans()
            traceEnd(event, 'ok', { loans, policy })
            auditTool(run, { tool: 'circulation_admin', args, policyDecision: policy.decision, result: 'ok' })
            return textResult(
              loans.length === 0
                ? '当前没有逾期借阅。'
                : loans
                    .map(
                      (loan) =>
                        `${loan.readerName}（${loan.readerId}）《${loan.bookTitle}》｜应还 ${loan.dueAt.slice(0, 10)}｜逾期 ${loan.overdueDays} 天｜罚款 ${loan.fine.toFixed(2)} 元`,
                    )
                    .join('\n'),
              { loans, policy },
            )
          }
          if (args.action === 'borrow') {
            if (!args.bookId || !args.readerId) throw new Error('借书需要 bookId 和 readerId')
            const policy = authorize(run, 'loan_borrow', args.readerId)
            if (policy.decision !== 'allow') {
              traceEnd(event, 'denied', { reason: policy.reason }, policy)
              auditTool(run, { tool: 'circulation_admin', args, policyDecision: policy.decision, result: 'denied' })
              return textResult(`无法借书：${policy.reason}`, { status: 'denied', policy })
            }
            const loan = business.borrowBook(args.bookId, args.readerId, actorLabel(run.user), args.branch)
            traceEnd(event, 'ok', { loan, policy })
            addCitation(run, '借阅数据库')
            auditTool(run, { tool: 'circulation_admin', args, policyDecision: policy.decision, result: 'borrowed', details: { loan } })
            return textResult(
              `借书成功：${loan.readerName} 借《${loan.bookTitle}》，借阅号 ${loan.id}，应还 ${loan.dueAt.slice(0, 10)}。`,
              { loan, policy },
            )
          }
          let existing = args.loanId ? business.getLoan(args.loanId) : undefined
          if (!existing) {
            const readerId = args.readerId ?? (run.user.role === 'reader' ? run.user.readerId : undefined)
            const bookId = args.bookId ?? (args.bookTitle ? business.searchBooks(args.bookTitle)[0]?.id : undefined)
            const candidates = business.listLoans(readerId).filter((loan) => !loan.returnedAt)
            existing = candidates.find((loan) => !bookId || loan.bookId === bookId)
          }
          if (!existing) {
            throw new Error('找不到可归还/续借的在借记录；请提供 L- 开头的借阅号，或 readerId + bookTitle')
          }
          const targetLoan = existing
          if (run.user.role === 'reader' && targetLoan.readerId !== run.user.readerId) {
            throw new Error('读者只能办理本人的借阅')
          }
          const policy = authorize(
            run,
            args.action === 'return' ? 'loan_return' : 'loan_renew',
            targetLoan.readerId,
          )
          if (policy.decision !== 'allow') {
            traceEnd(event, 'denied', { reason: policy.reason }, policy)
            auditTool(run, { tool: 'circulation_admin', args, policyDecision: policy.decision, result: 'denied' })
            return textResult(`无法办理：${policy.reason}`, { status: 'denied', policy })
          }
          if (args.action === 'return') {
            const result = business.returnLoan(targetLoan.id)
            traceEnd(event, 'ok', { result, policy })
            addCitation(run, '借阅数据库')
            if (result.fine) addCitation(run, '罚款记录')
            auditTool(run, { tool: 'circulation_admin', args, policyDecision: policy.decision, result: 'returned', details: result })
            return textResult(
              `还书成功：《${result.loan.bookTitle}》已于 ${result.loan.returnedAt?.slice(0, 10)} 归还。${result.fine ? `产生罚款 ${result.fine.amount.toFixed(2)} 元（${result.fine.id}）。` : '无罚款。'}`,
              { ...result, policy },
            )
          }
          const loan = business.renewLoan(targetLoan.id)
          traceEnd(event, 'ok', { loan, policy })
          addCitation(run, '借阅数据库')
          auditTool(run, { tool: 'circulation_admin', args, policyDecision: policy.decision, result: 'renewed', details: { loan } })
          return textResult(
            `续借成功：《${loan.bookTitle}》新的应还日期为 ${loan.dueAt.slice(0, 10)}，已续借 ${loan.renewedCount} 次。`,
            { loan, policy },
          )
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          auditTool(run, { tool: 'circulation_admin', args, policyDecision: 'error', result: 'error' })
          return textResult(`流通操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'reservation_admin',
      description:
        '预约管理。action=list（读者看本人/工作人员可指定 readerId）/cancel（reservationId）/fulfill（reservationId，到馆取书并转借阅）。',
      parameters: obj({
        action: str({ description: 'list | cancel | fulfill' }),
        readerId: opt(str()),
        reservationId: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'reservation_admin', args)
        try {
          if (args.action === 'list') {
            const policy = authorize(run, 'reservation_list')
            if (policy.decision !== 'allow') {
              traceEnd(event, 'denied', { reason: policy.reason }, policy)
              return textResult(`无法查看预约：${policy.reason}`, { status: 'denied', policy })
            }
            const readerId = run.user.role === 'reader' ? run.user.readerId : args.readerId
            const reservations = business.listReservations(readerId)
            traceEnd(event, 'ok', { reservations, policy })
            addCitation(run, '预约数据库')
            auditTool(run, { tool: 'reservation_admin', args, policyDecision: policy.decision, result: 'ok' })
            return textResult(
              reservations.length === 0
                ? '当前没有预约。'
                : reservations
                    .map(
                      (reservation) =>
                        `${reservation.id}｜《${reservation.bookTitle}》｜读者 ${reservation.readerName}（${reservation.readerId}）｜状态 ${reservation.status}｜排队 ${reservation.queuePosition}｜取书 ${reservation.pickupBranch}`,
                    )
                    .join('\n'),
              { reservations, policy },
            )
          }
          if (!args.reservationId) throw new Error('cancel/fulfill 需要 reservationId')
          const reservation = business.getReservation(args.reservationId)
          if (!reservation) throw new Error('预约不存在')
          if (run.user.role === 'reader' && reservation.readerId !== run.user.readerId) {
            throw new Error('读者只能办理本人的预约')
          }
          const policy = authorize(
            run,
            args.action === 'cancel' ? 'reservation_cancel' : 'reservation_fulfill',
            reservation.readerId,
          )
          if (policy.decision !== 'allow') {
            traceEnd(event, 'denied', { reason: policy.reason }, policy)
            auditTool(run, { tool: 'reservation_admin', args, policyDecision: policy.decision, result: 'denied' })
            return textResult(`无法办理预约：${policy.reason}`, { status: 'denied', policy })
          }
          if (args.action === 'cancel') {
            const cancelled = business.cancelReservation(args.reservationId)
            traceEnd(event, 'ok', { reservation: cancelled, policy })
            addCitation(run, '预约数据库')
            auditTool(run, { tool: 'reservation_admin', args, policyDecision: policy.decision, result: 'cancelled' })
            return textResult(`预约 ${cancelled.id} 已取消。`, { reservation: cancelled, policy })
          }
          const result = business.fulfillReservation(args.reservationId, actorLabel(run.user))
          traceEnd(event, 'ok', { result, policy })
          addCitation(run, '预约数据库')
          addCitation(run, '借阅数据库')
          auditTool(run, { tool: 'reservation_admin', args, policyDecision: policy.decision, result: 'fulfilled', details: result })
          return textResult(
            `预约 ${result.reservation.id} 已取书，转为借阅 ${result.loan.id}，应还 ${result.loan.dueAt.slice(0, 10)}。`,
            { ...result, policy },
          )
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          auditTool(run, { tool: 'reservation_admin', args, policyDecision: 'error', result: 'error' })
          return textResult(`预约操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'fine_admin',
      description:
        '罚款管理。action=list（读者看本人/工作人员可指定 readerId）/pay（fineId）/waive（fineId；超过 50 元的馆员减免转审批）。fineId 是 F- 开头的罚款编号，不是读者 ID。',
      parameters: obj({
        action: str({ description: 'list | pay | waive' }),
        readerId: opt(str()),
        fineId: opt(str({ description: 'F- 开头的罚款编号，例如 F001；不是 readerId' })),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'fine_admin', args)
        try {
          if (args.action === 'list') {
            const policy = authorize(run, 'fine_list')
            if (policy.decision !== 'allow') {
              traceEnd(event, 'denied', { reason: policy.reason }, policy)
              return textResult(`无法查看罚款：${policy.reason}`, { status: 'denied', policy })
            }
            const readerId = run.user.role === 'reader' ? run.user.readerId : args.readerId
            const fines = business.listFines(readerId)
            traceEnd(event, 'ok', { fines, policy })
            addCitation(run, '罚款记录')
            auditTool(run, { tool: 'fine_admin', args, policyDecision: policy.decision, result: 'ok' })
            return textResult(
              fines.length === 0
                ? '当前没有罚款记录。'
                : fines
                    .map(
                      (fine) =>
                        `${fine.id}｜${fine.readerName}（${fine.readerId}）｜${fine.amount.toFixed(2)} 元｜${fine.status}｜${fine.reason}`,
                    )
                    .join('\n'),
              { fines, policy },
            )
          }
          const requestedFineId = args.fineId ?? (args.readerId?.startsWith('F') ? args.readerId : undefined)
          if (!requestedFineId) throw new Error('pay/waive 需要 fineId（F- 开头），不是 readerId')
          const fine = business.getFine(requestedFineId)
          if (!fine) throw new Error('罚款记录不存在')
          if (run.user.role === 'reader' && fine.readerId !== run.user.readerId) {
            throw new Error('读者只能办理本人的罚款')
          }
          const policy = authorize(run, args.action === 'pay' ? 'fine_pay' : 'fine_waive', fine.readerId)
          if (policy.decision !== 'allow') {
            traceEnd(event, 'denied', { reason: policy.reason }, policy)
            auditTool(run, { tool: 'fine_admin', args, policyDecision: policy.decision, result: 'denied' })
            return textResult(`无法办理罚款：${policy.reason}`, { status: 'denied', policy })
          }
          if (args.action === 'pay') {
            const paid = business.payFine(fine.id)
            traceEnd(event, 'ok', { fine: paid, policy })
            addCitation(run, '罚款记录')
            auditTool(run, { tool: 'fine_admin', args, policyDecision: policy.decision, result: 'paid' })
            return textResult(`罚款 ${paid.id} 已支付 ${paid.amount.toFixed(2)} 元，支付参考 ${paid.paymentRef ?? ''}。`, {
              fine: paid,
              policy,
            })
          }
          if (fine.amount > 50 && run.user.role === 'librarian') {
            const approval = business.createApproval({
              runId: run.runId,
              toolCallId: api.callId,
              policyId: 'library.fine.waiver',
              tool: 'fine_waive',
              payload: { fineId: fine.id, amount: fine.amount, readerId: fine.readerId },
              requestedBy: run.user.username,
            })
            run.pendingApprovalId = approval.id
            const approvalTrace = traceStart(run, 'capability', 'approval', 'fine_waive_approval', {
              approvalId: approval.id,
            })
            traceEnd(approvalTrace, 'pending', { approvalId: approval.id }, policy)
            traceEnd(event, 'pending', { fine, approval, policy }, policy)
            addCitation(run, '罚款记录')
            auditTool(run, {
              tool: 'fine_admin',
              args,
              policyDecision: 'require_approval',
              result: 'pending_approval',
              approvalId: approval.id,
            })
            return textResult(
              `罚款 ${fine.id} 金额 ${fine.amount.toFixed(2)} 元，超过 50 元，需要管理员审批。审批号 ${approval.id}。`,
              { status: 'pending_approval', fine, approval, policy },
            )
          }
          const waived = business.waiveFine(fine.id, actorLabel(run.user))
          traceEnd(event, 'ok', { fine: waived, policy })
          addCitation(run, '罚款记录')
          auditTool(run, { tool: 'fine_admin', args, policyDecision: policy.decision, result: 'waived' })
          return textResult(`罚款 ${waived.id} 已减免，金额 ${waived.amount.toFixed(2)} 元。`, {
            fine: waived,
            policy,
          })
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          auditTool(run, { tool: 'fine_admin', args, policyDecision: 'error', result: 'error' })
          return textResult(`罚款操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'notification_admin',
      description:
        '通知管理。action=list（读者看本人/工作人员可指定 readerId）/create（readerId+subject+body）/send（notificationId，标记已发送）。',
      parameters: obj({
        action: str({ description: 'list | create | send' }),
        readerId: opt(str()),
        notificationId: opt(str()),
        type: opt(str()),
        channel: opt(str()),
        subject: opt(str()),
        body: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'notification_admin', args)
        try {
          if (args.action === 'list') {
            const policy = authorize(run, 'notification_list')
            if (policy.decision !== 'allow') {
              traceEnd(event, 'denied', { reason: policy.reason }, policy)
              return textResult(`无法查看通知：${policy.reason}`, { status: 'denied', policy })
            }
            const readerId = run.user.role === 'reader' ? run.user.readerId : args.readerId
            const notifications = business.listNotifications(readerId)
            traceEnd(event, 'ok', { notifications, policy })
            auditTool(run, { tool: 'notification_admin', args, policyDecision: policy.decision, result: 'ok' })
            return textResult(
              notifications.length === 0
                ? '当前没有通知。'
                : notifications
                    .map(
                      (notification) =>
                        `${notification.id}｜${notification.readerName}（${notification.readerId}）｜${notification.type}/${notification.channel}｜${notification.status}｜${notification.subject}`,
                    )
                    .join('\n'),
              { notifications, policy },
            )
          }
          const policy = authorize(run, args.action === 'create' ? 'notification_create' : 'notification_send')
          if (policy.decision !== 'allow') {
            traceEnd(event, 'denied', { reason: policy.reason }, policy)
            return textResult(`无法操作通知：${policy.reason}`, { status: 'denied', policy })
          }
          if (args.action === 'create') {
            if (!args.readerId || !args.subject || !args.body) throw new Error('创建通知需要 readerId/subject/body')
            const notification = business.createNotification({
              readerId: args.readerId,
              type: args.type ?? 'manual',
              channel: args.channel ?? 'sms',
              subject: args.subject,
              body: args.body,
            })
            traceEnd(event, 'ok', { notification, policy })
            auditTool(run, { tool: 'notification_admin', args, policyDecision: policy.decision, result: 'created' })
            return textResult(`通知 ${notification.id} 已创建，状态 ${notification.status}。`, {
              notification,
              policy,
            })
          }
          if (!args.notificationId) throw new Error('send 需要 notificationId')
          const notification = business.markNotificationSent(args.notificationId)
          traceEnd(event, 'ok', { notification, policy })
          auditTool(run, { tool: 'notification_admin', args, policyDecision: policy.decision, result: 'sent' })
          return textResult(`通知 ${notification.id} 已标记为发送。`, { notification, policy })
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          auditTool(run, { tool: 'notification_admin', args, policyDecision: 'error', result: 'error' })
          return textResult(`通知操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'acquisition_admin',
      description:
        '采访/采购。action=vendor_list/vendor_create/request_create/request_list/request_approve/order_create/order_list/order_receive。工作人员使用。',
      parameters: obj({
        action: str({
          description:
            'vendor_list | vendor_create | request_create | request_list | request_approve | order_create | order_list | order_receive',
        }),
        vendorId: opt(str()),
        vendorName: opt(str({ description: '供应商名称，例如 新华书店；没有 vendorId 时按名称匹配' })),
        requestId: opt(str()),
        orderId: opt(str()),
        name: opt(str()),
        contact: opt(str()),
        phone: opt(str()),
        title: opt(str()),
        isbn: opt(str()),
        quantity: opt(num()),
        unitPrice: opt(num()),
        estimatedUnitPrice: opt(num()),
        items: opt(
          arr(
            obj({
              title: str(),
              isbn: str(),
              quantity: num(),
              unitPrice: num(),
            }),
          ),
        ),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'acquisition_admin', args)
        try {
          const action = args.action
          const readActions = new Set(['vendor_list', 'request_list', 'order_list'])
          const policyName = readActions.has(action)
            ? action === 'vendor_list'
              ? 'vendor_list'
              : action === 'request_list'
                ? 'purchase_request_list'
                : 'order_list'
            : action === 'vendor_create'
              ? 'vendor_create'
              : action === 'request_create'
                ? 'purchase_request_create'
                : action === 'request_approve'
                  ? 'purchase_request_approve'
                  : action === 'order_create'
                    ? 'order_create'
                    : 'order_receive'
          const policy = authorize(run, policyName)
          if (policy.decision !== 'allow') {
            traceEnd(event, 'denied', { reason: policy.reason }, policy)
            auditTool(run, { tool: 'acquisition_admin', args, policyDecision: policy.decision, result: 'denied' })
            return textResult(`无法执行采访操作：${policy.reason}`, { status: 'denied', policy })
          }
          let result: unknown
          if (action === 'vendor_list') {
            result = business.listVendors()
          } else if (action === 'vendor_create') {
            if (!args.name || !args.contact || !args.phone) throw new Error('创建供应商需要 name/contact/phone')
            result = business.createVendor({ name: args.name, contact: args.contact, phone: args.phone })
          } else if (action === 'request_create') {
            if (!args.title || !args.isbn) throw new Error('创建采购申请需要 title/isbn')
            result = business.createPurchaseRequest({
              title: args.title,
              isbn: args.isbn,
              quantity: Number(args.quantity ?? 1),
              estimatedUnitPrice: Number(args.estimatedUnitPrice ?? 0),
              requestedBy: run.user.username,
            })
          } else if (action === 'request_list') {
            result = business.listPurchaseRequests()
          } else if (action === 'request_approve') {
            if (!args.requestId) throw new Error('批准采购申请需要 requestId')
            result = business.approvePurchaseRequest(args.requestId, run.user.username)
          } else if (action === 'order_create') {
            let vendorId = args.vendorId
            if (!vendorId && args.vendorName) {
              const matched = business
                .listVendors()
                .find((vendor) => vendor.name === args.vendorName || vendor.name.includes(args.vendorName!))
              if (!matched) {
                const names = business.listVendors().map((vendor) => `${vendor.id} ${vendor.name}`).join('、')
                throw new Error(`没有找到供应商“${args.vendorName}”。可用供应商：${names}`)
              }
              vendorId = matched.id
            }
            if (!vendorId || !Array.isArray(args.items) || args.items.length === 0) {
              throw new Error('创建订单需要 vendorId 或 vendorName，以及 items')
            }
            result = business.createOrder({
              vendorId,
              items: args.items.map((item) => ({
                title: item.title,
                isbn: item.isbn,
                quantity: Number(item.quantity),
                unitPrice: Number(item.unitPrice),
              })),
            })
          } else if (action === 'order_list') {
            result = business.listOrders()
          } else if (action === 'order_receive') {
            if (!args.orderId) throw new Error('验收订单需要 orderId')
            result = business.receiveOrder(args.orderId)
          } else {
            throw new Error(`不支持的 action：${action}`)
          }
          traceEnd(event, 'ok', { result, policy })
          addCitation(run, '采访采购')
          auditTool(run, { tool: 'acquisition_admin', args, policyDecision: policy.decision, result: 'ok', details: { result } })
          let text = `采访操作已完成：${action}`
          if (action === 'vendor_list') {
            const vendors = result as ReturnType<typeof business.listVendors>
            text = vendors
              .map((vendor) => `${vendor.id}｜${vendor.name}｜${vendor.contact}｜${vendor.phone}`)
              .join('\n')
          } else if (action === 'vendor_create') {
            const vendor = result as ReturnType<typeof business.createVendor>
            text = `已创建供应商 ${vendor.name}，ID ${vendor.id}。`
          } else if (action === 'request_create' || action === 'request_approve') {
            const request = result as ReturnType<typeof business.createPurchaseRequest>
            text = `采购申请 ${request.id}｜${request.title}｜数量 ${request.quantity}｜状态 ${request.status}。`
          } else if (action === 'request_list') {
            const requests = result as ReturnType<typeof business.listPurchaseRequests>
            text = requests
              .map(
                (request) =>
                  `${request.id}｜${request.title}｜数量 ${request.quantity}｜预估 ${request.estimatedUnitPrice}｜${request.status}`,
              )
              .join('\n')
          } else if (action === 'order_create' || action === 'order_receive') {
            const order = result as ReturnType<typeof business.createOrder>
            text = `订单 ${order.id}｜供应商 ${order.vendorName}｜状态 ${order.status}｜总额 ${order.totalAmount.toFixed(2)}｜${order.items.length} 个条目。`
          } else if (action === 'order_list') {
            const orders = result as ReturnType<typeof business.listOrders>
            text = orders
              .map(
                (order) =>
                  `${order.id}｜${order.vendorName}｜${order.status}｜${order.totalAmount.toFixed(2)} 元｜${order.items.length} 个条目`,
              )
              .join('\n')
          }
          return textResult(text || `采访操作已完成：${action}`, { action, result, policy })
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          auditTool(run, { tool: 'acquisition_admin', args, policyDecision: 'error', result: 'error' })
          return textResult(`采访操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'serial_admin',
      description: '连续出版物管理。action=list/create/checkin（登记下一期）。工作人员使用。',
      parameters: obj({
        action: str({ description: 'list | create | checkin' }),
        serialId: opt(str()),
        title: opt(str()),
        issn: opt(str()),
        vendorId: opt(str()),
        startDate: opt(str()),
        endDate: opt(str()),
        nextIssueDate: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'serial_admin', args)
        const policyName =
          args.action === 'list' ? 'serial_list' : args.action === 'create' ? 'serial_create' : 'serial_checkin'
        const policy = authorize(run, policyName)
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          return textResult(`无法操作连续出版物：${policy.reason}`, { status: 'denied', policy })
        }
        try {
          let result: unknown
          let text = ''
          if (args.action === 'list') {
            const serials = business.listSerials()
            result = serials
            text = serials
              .map(
                (serial) =>
                  `${serial.id}｜${serial.title}｜ISSN ${serial.issn}｜${serial.status}｜下一期 ${serial.nextIssueDate}`,
              )
              .join('\n')
            text ||= '暂无连续出版物。'
          } else if (args.action === 'create') {
            if (!args.title || !args.issn) throw new Error('创建连续出版物需要 title 和 issn')
            const serial = business.createSerial({
              title: args.title,
              issn: args.issn,
              vendorId: args.vendorId,
              startDate: args.startDate,
              endDate: args.endDate,
            })
            result = serial
            text = `连续出版物 ${serial.title} 已创建，ID ${serial.id}，下一期 ${serial.nextIssueDate}。`
          } else {
            if (!args.serialId) throw new Error('checkin 需要 serialId')
            const serial = business.checkinSerial(args.serialId, args.nextIssueDate)
            result = serial
            text = `连续出版物 ${serial.title} 已登记到刊，下一期 ${serial.nextIssueDate}。`
          }
          traceEnd(event, 'ok', { result, policy })
          addCitation(run, '连续出版物')
          auditTool(run, { tool: 'serial_admin', args, policyDecision: policy.decision, result: 'ok', details: { result } })
          return textResult(text, { action: args.action, result, policy })
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          return textResult(`连续出版物操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'resource_admin',
      description: '电子资源管理。action=list/create。工作人员可维护；读者可查看。',
      parameters: obj({
        action: str({ description: 'list | create' }),
        title: opt(str()),
        provider: opt(str()),
        url: opt(str()),
        licenseStatus: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'resource_admin', args)
        const policy = authorize(run, args.action === 'create' ? 'resource_create' : 'resource_list')
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          return textResult(`无法操作电子资源：${policy.reason}`, { status: 'denied', policy })
        }
        try {
          let result: unknown
          let text = ''
          if (args.action === 'list') {
            const resources = business.listElectronicResources()
            result = resources
            text = resources
              .map((resource) => `${resource.id}｜${resource.title}｜${resource.provider}｜${resource.licenseStatus}｜${resource.url}`)
              .join('\n')
            text ||= '暂无电子资源。'
          } else {
            if (!args.title || !args.provider || !args.url) throw new Error('创建电子资源需要 title/provider/url')
            const resource = business.createElectronicResource({
              title: args.title,
              provider: args.provider,
              url: args.url,
              licenseStatus: args.licenseStatus,
            })
            result = resource
            text = `电子资源 ${resource.title} 已创建，ID ${resource.id}，许可状态 ${resource.licenseStatus}。`
          }
          traceEnd(event, 'ok', { result, policy })
          addCitation(run, '电子资源')
          auditTool(run, { tool: 'resource_admin', args, policyDecision: policy.decision, result: 'ok', details: { result } })
          return textResult(text, { action: args.action, result, policy })
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          return textResult(`电子资源操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'ill_admin',
      description: '馆际互借。action=list（读者看本人/工作人员可指定 readerId）/create（title，读者默认本人）/update_status（illId+status）。',
      parameters: obj({
        action: str({ description: 'list | create | update_status' }),
        readerId: opt(str()),
        illId: opt(str()),
        title: opt(str()),
        status: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'ill_admin', args)
        try {
          if (args.action === 'list') {
            const policy = authorize(run, 'ill_list')
            if (policy.decision !== 'allow') {
              traceEnd(event, 'denied', { reason: policy.reason }, policy)
              return textResult(`无法查看馆际互借：${policy.reason}`, { status: 'denied', policy })
            }
            const readerId = run.user.role === 'reader' ? run.user.readerId : args.readerId
            const requests = business.listIllRequests(readerId)
            traceEnd(event, 'ok', { requests, policy })
            auditTool(run, { tool: 'ill_admin', args, policyDecision: policy.decision, result: 'ok' })
            return textResult(
              requests.length === 0
                ? '当前没有馆际互借申请。'
                : requests
                    .map(
                      (request) =>
                        `${request.id}｜${request.readerId}｜${request.title}｜${request.status}｜${request.createdAt.slice(0, 10)}`,
                    )
                    .join('\n'),
              { requests, policy },
            )
          }
          if (args.action === 'create') {
            if (!args.title) throw new Error('创建馆际互借需要 title')
            const target = args.readerId ?? run.user.readerId
            if (!target) throw new Error('缺少读者 ID')
            if (run.user.role === 'reader' && target !== run.user.readerId) {
              throw new Error('读者只能为本人申请馆际互借')
            }
            const policy = authorize(run, 'ill_create', target)
            if (policy.decision !== 'allow') {
              traceEnd(event, 'denied', { reason: policy.reason }, policy)
              return textResult(`无法申请馆际互借：${policy.reason}`, { status: 'denied', policy })
            }
            const request = business.createIllRequest({ readerId: target, title: args.title })
            traceEnd(event, 'ok', { request, policy })
            addCitation(run, '馆际互借')
            auditTool(run, { tool: 'ill_admin', args, policyDecision: policy.decision, result: 'created' })
            return textResult(`馆际互借申请 ${request.id} 已创建，状态 ${request.status}。`, { request, policy })
          }
          if (!args.illId || !args.status) throw new Error('update_status 需要 illId 和 status')
          const policy = authorize(run, 'ill_update_status')
          if (policy.decision !== 'allow') {
            traceEnd(event, 'denied', { reason: policy.reason }, policy)
            return textResult(`无法更新馆际互借：${policy.reason}`, { status: 'denied', policy })
          }
          const request = business.updateIllStatus(args.illId, args.status)
          traceEnd(event, 'ok', { request, policy })
          auditTool(run, { tool: 'ill_admin', args, policyDecision: policy.decision, result: 'updated' })
          return textResult(`馆际互借申请 ${request.id} 状态已更新为 ${request.status}。`, { request, policy })
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          return textResult(`馆际互借操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'stocktake_admin',
      description: '馆藏盘点。action=list/start（branch）/scan（stocktakeId+barcode）/complete（stocktakeId）。工作人员使用。',
      parameters: obj({
        action: str({ description: 'list | start | scan | complete' }),
        branch: opt(str()),
        stocktakeId: opt(str()),
        barcode: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'stocktake_admin', args)
        try {
          if (args.action === 'list') {
            const policy = authorize(run, 'stocktake_list')
            if (policy.decision !== 'allow') {
              traceEnd(event, 'denied', { reason: policy.reason }, policy)
              return textResult(`无法查看盘点：${policy.reason}`, { status: 'denied', policy })
            }
            const stocktakes = business.listStocktakes()
            traceEnd(event, 'ok', { stocktakes, policy })
            return textResult(
              stocktakes.length === 0
                ? '暂无盘点任务。'
                : stocktakes
                    .map(
                      (item) =>
                        `${item.id}｜${item.branch}｜${item.status}｜已扫描 ${item.scannedCount}/${item.totalCopies}`,
                    )
                    .join('\n'),
              { stocktakes, policy },
            )
          }
          const policyName =
            args.action === 'start'
              ? 'stocktake_start'
              : args.action === 'scan'
                ? 'stocktake_scan'
                : 'stocktake_complete'
          const policy = authorize(run, policyName)
          if (policy.decision !== 'allow') {
            traceEnd(event, 'denied', { reason: policy.reason }, policy)
            return textResult(`无法执行盘点：${policy.reason}`, { status: 'denied', policy })
          }
          let result: unknown
          if (args.action === 'start') {
            if (!args.branch) throw new Error('开始盘点需要 branch')
            result = business.startStocktake(args.branch)
          } else if (args.action === 'scan') {
            if (!args.stocktakeId || !args.barcode) throw new Error('扫描盘点需要 stocktakeId 和 barcode')
            result = business.scanStocktake(args.stocktakeId, args.barcode)
          } else {
            if (!args.stocktakeId) throw new Error('完成盘点需要 stocktakeId')
            result = business.completeStocktake(args.stocktakeId)
          }
          traceEnd(event, 'ok', { result, policy })
          addCitation(run, '馆藏盘点')
          auditTool(run, { tool: 'stocktake_admin', args, policyDecision: policy.decision, result: 'ok', details: { result } })
          const item = result as { id: string; branch: string; status: string; scannedCount: number; totalCopies: number }
          return textResult(
            `盘点 ${item.id}｜${item.branch}｜${item.status}｜已扫描 ${item.scannedCount}/${item.totalCopies}`,
            { action: args.action, result, policy },
          )
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          return textResult(`盘点操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'event_admin',
      description: '阅读推广活动。action=list/create（title/startsAt/endsAt/location/capacity）。',
      parameters: obj({
        action: str({ description: 'list | create' }),
        title: opt(str()),
        startsAt: opt(str()),
        endsAt: opt(str()),
        location: opt(str()),
        capacity: opt(num()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'event_admin', args)
        const policy = authorize(run, args.action === 'create' ? 'event_create' : 'event_list')
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          return textResult(`无法操作活动：${policy.reason}`, { status: 'denied', policy })
        }
        try {
          if (args.action === 'list') {
            const events = business.listEvents()
            traceEnd(event, 'ok', { events, policy })
            return textResult(
              events.length === 0
                ? '暂无活动。'
                : events
                    .map(
                      (item) =>
                        `${item.id}｜${item.title}｜${item.startsAt.slice(0, 16)}｜${item.location}｜${item.status}`,
                    )
                    .join('\n'),
              { events, policy },
            )
          }
          if (!args.title || !args.startsAt || !args.endsAt || !args.location) {
            throw new Error('创建活动需要 title/startsAt/endsAt/location')
          }
          const created = business.createEvent({
            title: args.title,
            startsAt: args.startsAt,
            endsAt: args.endsAt,
            location: args.location,
            capacity: Number(args.capacity ?? 0),
          })
          traceEnd(event, 'ok', { event: created, policy })
          addCitation(run, '阅读活动')
          auditTool(run, { tool: 'event_admin', args, policyDecision: policy.decision, result: 'created' })
          return textResult(`活动 ${created.title} 已创建，ID ${created.id}，地点 ${created.location}。`, {
            event: created,
            policy,
          })
        } catch (error) {
          traceEnd(event, 'error', { message: String(error) })
          return textResult(`活动操作失败：${error instanceof Error ? error.message : String(error)}`, {
            status: 'error',
          })
        }
      },
    }),
    defineTool({
      name: 'report',
      description: '统计报表。action=circulation（可选 branch）/overdue/collection。工作人员与审计员只读。',
      parameters: obj({
        action: str({ description: 'circulation | overdue | collection' }),
        branch: opt(str()),
      }),
      async execute(args, api) {
        const run = currentRun(api)
        const event = traceStart(run, 'capability', 'tool', 'report', args)
        const policyName =
          args.action === 'circulation'
            ? 'report_circulation'
            : args.action === 'overdue'
              ? 'report_overdue'
              : 'report_collection'
        const policy = authorize(run, policyName)
        if (policy.decision !== 'allow') {
          traceEnd(event, 'denied', { reason: policy.reason }, policy)
          return textResult(`无法查看报表：${policy.reason}`, { status: 'denied', policy })
        }
        let report: unknown
        let text = ''
        if (args.action === 'circulation') {
          report = business.circulationReport(args.branch)
          const value = report as ReturnType<typeof business.circulationReport>
          text = `流通概况：在借 ${value.activeLoans} 笔，逾期 ${value.overdueLoans} 笔，今日归还 ${value.returnedToday} 笔。`
        } else if (args.action === 'overdue') {
          report = business.listOverdueLoans()
          const loans = report as ReturnType<typeof business.listOverdueLoans>
          text = `逾期 ${loans.length} 笔。`
        } else {
          report = business.collectionReport()
          const value = report as ReturnType<typeof business.collectionReport>
          text = `馆藏概况：书目 ${value.totalBooks} 种，副本 ${value.totalCopies} 册。`
        }
        traceEnd(event, 'ok', { report, policy })
        addCitation(run, '统计报表')
        auditTool(run, { tool: 'report', args, policyDecision: policy.decision, result: 'ok', details: { report } })
        return textResult(text, { report, policy })
      },
    }),
  ]

  const registry = createRegistry()
  registry.install(
    defineExtension({
      name: 'library',
      tools,
      sections: [
        section('library-agent', (input) => buildSystemPrompt(activeRuns.get(String(input.conversationId)))),
      ],
    }),
  )

  const storage = await openNodeSqliteStorage(join(dataDir, 'agent.sqlite'))
  const harness = await Harness.open(storage, { models, registry }, context)
  harness.resume()

  async function createPiConversation(): Promise<Conversation> {
    return harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: { model: modelRef },
      },
      context,
    )
  }

  async function resolveConversation(
    chatId: string,
    user: AuthUser,
  ): Promise<{ conversation: Conversation; record: ChatConversationView }> {
    const cacheKey = `${user.id}:${chatId}`
    let record = business.getChatConversation(chatId)
    if (record && record.ownerUserId !== user.id) {
      throw new ChatAccessError()
    }

    if (record) {
      const cached = conversationCache.get(cacheKey)
      if (cached) return { conversation: cached, record }
      const piConversationId = Number(record.piConversationId)
      let conversation = Number.isFinite(piConversationId)
        ? await harness.conversation(piConversationId as ConversationId, context)
        : undefined
      if (!conversation) {
        conversation = await createPiConversation()
        business.setChatConversationPiId(chatId, String(conversation.id))
        record = business.getChatConversation(chatId)!
      }
      conversationCache.set(cacheKey, conversation)
      return { conversation, record }
    }

    const conversation = await createPiConversation()
    record = business.createChatConversation({
      id: chatId,
      ownerUserId: user.id,
      ownerUsername: user.username,
      ownerRole: user.role,
      ...(user.readerId ? { readerId: user.readerId } : {}),
      piConversationId: String(conversation.id),
    })
    conversationCache.set(cacheKey, conversation)
    return { conversation, record }
  }

  async function answerFor(conversation: Conversation, entryId: EntryId | undefined): Promise<string> {
    if (entryId === undefined) return ''
    const page = await conversation.entries(
      { minEntryId: entryId, maxEntryId: entryId, order: 'ascending' },
      1,
      undefined,
      context,
    )
    const entry = page.items[0]
    if (!entry?.model) return ''
    return entry.model
      .map((message) => (message.role === 'assistant' ? contentText((message as { content?: unknown }).content) : ''))
      .filter(Boolean)
      .join('\n')
  }

  function enqueue<T>(chatId: string, task: () => Promise<T>): Promise<T> {
    const previous = chatQueues.get(chatId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(task)
    chatQueues.set(
      chatId,
      next.catch(() => undefined),
    )
    return next
  }

  function run(input: AgentRunInput): Promise<AgentRunResult> {
    return enqueue(input.chatId, async () => {
      const { conversation } = await resolveConversation(input.chatId, input.user)
      const run: ActiveRun = {
        chatId: input.chatId,
        runId: `RUN-${randomUUID().slice(0, 8)}`,
        traceId: `TRACE-${randomUUID().slice(0, 8)}`,
        user: input.user,
        trace: [],
        citations: [],
      }
      const piKey = String(conversation.id)
      activeRuns.set(piKey, run)
      const orchestration = traceStart(run, 'orchestration', 'model', 'Pi GenerationTask', {
        message: input.message,
        role: input.user.role,
      })
      try {
        const submission = await conversation.submit({ type: 'input', content: input.message }, context)
        const settled = await submission.wait(context)
        const answer =
          settled.status === 'done'
            ? (await answerFor(conversation, settled.answer)) || '我这次没有生成有效回答，请换一种说法再试。'
            : '我这次没有完成回答，请换一种说法再试。'
        traceEnd(orchestration, settled.status === 'done' ? 'ok' : 'error', {
          status: settled.status,
          role: input.user.role,
        })
        business.touchChatConversation(input.chatId)
        const pendingApproval: ApprovalRequest | undefined = run.pendingApprovalId
          ? business.getApproval(run.pendingApprovalId)
          : undefined
        return {
          runId: run.runId,
          answer,
          citations: [...run.citations],
          trace: [...run.trace],
          ...(pendingApproval ? { pendingApproval } : {}),
        }
      } catch (error) {
        traceEnd(orchestration, 'error', { message: String(error) })
        throw error
      } finally {
        activeRuns.delete(piKey)
      }
    })
  }

  async function close(): Promise<void> {
    await harness.close(context)
  }

  return { run, close }
}

export type LibraryAgent = Awaited<ReturnType<typeof createLibraryAgent>>
