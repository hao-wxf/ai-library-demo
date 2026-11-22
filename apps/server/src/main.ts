import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBusinessService } from '../../../packages/capability-sdk/src/index.ts'
import { createLibraryAgent, ChatAccessError } from '../../../packages/agent-sdk/src/index.ts'
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  getSession,
  login,
  logout,
  permissionsFor,
  roleLabel,
} from '../../../packages/auth-sdk/src/index.ts'
import { canDecideApproval, canViewApprovals, canViewAudit, canViewDeveloper } from '../../../packages/policy-sdk/src/index.ts'
import type { AuthUser, UserRole } from '../../../packages/contracts/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '../../web')
const dataDir = resolve(here, '../../../data')
const port = Number(process.env.PORT ?? 8787)
const modelId = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'

const business = createBusinessService(join(dataDir, 'library.sqlite'))
let agent: Awaited<ReturnType<typeof createLibraryAgent>>
try {
  agent = await createLibraryAgent({ business, dataDir })
} catch (error) {
  console.error(`Failed to start AI Library agent: ${error instanceof Error ? error.message : String(error)}`)
  business.close()
  process.exit(1)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sendText(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(body)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1_000_000) throw new Error('Request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {} as T
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    try {
      cookies[key] = decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      cookies[key] = part.slice(index + 1).trim()
    }
  }
  return cookies
}

function currentUser(req: IncomingMessage): AuthUser | undefined {
  return getSession(parseCookies(req.headers.cookie)[SESSION_COOKIE])
}

function setSessionCookie(res: ServerResponse, token: string): void {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : ''
  res.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(
      SESSION_TTL_MS / 1000,
    )}${secure}`,
  )
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

const loginAttempts = new Map<string, { count: number; resetAt: number }>()

function allowLoginAttempt(ip: string): boolean {
  const now = Date.now()
  const record = loginAttempts.get(ip)
  if (!record || record.resetAt <= now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 5 * 60 * 1000 })
    return true
  }
  if (record.count >= 20) return false
  record.count += 1
  return true
}

function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip)
}

function actorLabel(user: AuthUser): string {
  return `${user.displayName}（${user.username} / ${roleLabel(user.role)}${user.readerId ? ` / ${user.readerId}` : ''}）`
}

function requireUser(
  req: IncomingMessage,
  res: ServerResponse,
  roles?: UserRole[],
): AuthUser | undefined {
  const user = currentUser(req)
  if (!user) {
    sendJson(res, 401, { error: '请先登录' })
    return undefined
  }
  if (roles && !roles.includes(user.role)) {
    sendJson(res, 403, { error: '当前角色无权访问此功能' })
    return undefined
  }
  return user
}

function staticContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = resolve(webRoot, relative)
  if (!file.startsWith(webRoot)) {
    sendJson(res, 403, { error: 'Forbidden' })
    return true
  }
  try {
    const content = await readFile(file)
    res.writeHead(200, {
      'content-type': staticContentType(file),
      'cache-control': 'no-store',
    })
    res.end(content)
    return true
  } catch {
    return false
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const pathname = decodeURIComponent(url.pathname)
  const method = req.method ?? 'GET'

  try {
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, provider: 'deepseek', model: modelId, layers: 5, rbac: true })
      return
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      const user = currentUser(req)
      sendJson(res, 200, user ? { user, permissions: permissionsFor(user.role) } : { user: null })
      return
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: '跨站请求被拒绝' })
        return
      }
      const ip = req.socket.remoteAddress ?? 'unknown'
      if (!allowLoginAttempt(ip)) {
        sendJson(res, 429, { error: '登录尝试过于频繁，请稍后再试' })
        return
      }
      const body = await readJson<{ username?: string; password?: string }>(req)
      const username = String(body.username ?? '').trim()
      const password = String(body.password ?? '')
      if (!username || !password) {
        sendJson(res, 400, { error: '请输入用户名和密码' })
        return
      }
      const result = login(username, password)
      if (!result) {
        sendJson(res, 401, { error: '用户名或密码错误' })
        return
      }
      clearLoginAttempts(ip)
      setSessionCookie(res, result.token)
      sendJson(res, 200, { user: result.user, permissions: permissionsFor(result.user.role) })
      return
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: '跨站请求被拒绝' })
        return
      }
      logout(parseCookies(req.headers.cookie)[SESSION_COOKIE])
      clearSessionCookie(res)
      sendJson(res, 200, { ok: true })
      return
    }

    if (method === 'GET' && pathname === '/api/books') {
      if (!requireUser(req, res)) return
      sendJson(res, 200, { books: business.listBooks() })
      return
    }

    if (method === 'GET' && pathname === '/api/readers') {
      if (!requireUser(req, res, ['librarian', 'auditor', 'admin'])) return
      sendJson(res, 200, { readers: business.listReaders() })
      return
    }

    if (method === 'GET' && pathname === '/api/branches') {
      if (!requireUser(req, res)) return
      sendJson(res, 200, { branches: business.listBranches() })
      return
    }

    if (method === 'GET' && pathname === '/api/reader-types') {
      if (!requireUser(req, res)) return
      sendJson(res, 200, { readerTypes: business.listReaderTypes() })
      return
    }

    if (method === 'GET' && pathname === '/api/loans') {
      const user = requireUser(req, res)
      if (!user) return
      const readerId = user.role === 'reader' ? user.readerId : url.searchParams.get('readerId') ?? undefined
      sendJson(res, 200, { loans: business.listLoans(readerId) })
      return
    }

    if (method === 'GET' && pathname === '/api/loans/overdue') {
      if (!requireUser(req, res, ['librarian', 'auditor', 'admin'])) return
      sendJson(res, 200, { loans: business.listOverdueLoans() })
      return
    }

    if (method === 'GET' && pathname === '/api/fines') {
      const user = requireUser(req, res)
      if (!user) return
      const readerId = user.role === 'reader' ? user.readerId : url.searchParams.get('readerId') ?? undefined
      sendJson(res, 200, { fines: business.listFines(readerId) })
      return
    }

    if (method === 'GET' && pathname === '/api/notifications') {
      const user = requireUser(req, res)
      if (!user) return
      const readerId = user.role === 'reader' ? user.readerId : url.searchParams.get('readerId') ?? undefined
      sendJson(res, 200, { notifications: business.listNotifications(readerId) })
      return
    }

    if (method === 'GET' && pathname === '/api/vendors') {
      if (!requireUser(req, res, ['librarian', 'auditor', 'admin'])) return
      sendJson(res, 200, { vendors: business.listVendors() })
      return
    }

    if (method === 'GET' && pathname === '/api/purchase-requests') {
      if (!requireUser(req, res, ['librarian', 'auditor', 'admin'])) return
      sendJson(res, 200, { purchaseRequests: business.listPurchaseRequests(url.searchParams.get('status') ?? undefined) })
      return
    }

    if (method === 'GET' && pathname === '/api/orders') {
      if (!requireUser(req, res, ['librarian', 'auditor', 'admin'])) return
      sendJson(res, 200, { orders: business.listOrders(url.searchParams.get('status') ?? undefined) })
      return
    }

    if (method === 'GET' && pathname === '/api/reports/circulation') {
      if (!requireUser(req, res, ['librarian', 'auditor', 'admin'])) return
      sendJson(res, 200, business.circulationReport(url.searchParams.get('branch') ?? undefined))
      return
    }

    if (method === 'GET' && pathname === '/api/reports/collection') {
      if (!requireUser(req, res, ['librarian', 'auditor', 'admin'])) return
      sendJson(res, 200, business.collectionReport())
      return
    }

    if (method === 'GET' && pathname === '/api/reports/overdue') {
      if (!requireUser(req, res, ['librarian', 'auditor', 'admin'])) return
      sendJson(res, 200, { loans: business.listOverdueLoans() })
      return
    }

    if (method === 'GET' && pathname === '/api/reservations') {
      const user = requireUser(req, res)
      if (!user) return
      const requested = url.searchParams.get('readerId') ?? undefined
      if (user.role === 'reader') {
        sendJson(res, 200, { reservations: business.listReservations(user.readerId) })
        return
      }
      sendJson(res, 200, { reservations: business.listReservations(requested) })
      return
    }

    if (method === 'GET' && pathname === '/api/approvals') {
      const user = requireUser(req, res)
      if (!user) return
      if (canViewApprovals(user).decision !== 'allow') {
        sendJson(res, 403, { error: '当前角色无权查看审批' })
        return
      }
      sendJson(res, 200, { approvals: business.listApprovals(url.searchParams.get('status') ?? undefined) })
      return
    }

    if (method === 'GET' && pathname === '/api/audit') {
      const user = requireUser(req, res)
      if (!user) return
      if (canViewAudit(user).decision !== 'allow') {
        sendJson(res, 403, { error: '当前角色无权查看审计' })
        return
      }
      sendJson(res, 200, { audit: business.listAudit(url.searchParams.get('runId') ?? undefined) })
      return
    }

    if (method === 'POST' && pathname === '/api/chat') {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: '跨站请求被拒绝' })
        return
      }
      const user = requireUser(req, res)
      if (!user) return
      const body = await readJson<{ conversationId?: string; message?: string }>(req)
      const conversationId = String(body.conversationId ?? '').trim()
      const message = String(body.message ?? '').trim()
      if (!conversationId || !/^[A-Za-z0-9_-]{8,80}$/.test(conversationId)) {
        sendJson(res, 400, { error: 'conversationId 格式不正确' })
        return
      }
      if (!message || message.length > 4000) {
        sendJson(res, 400, { error: '消息不能为空，且不能超过 4000 字' })
        return
      }
      const result = await agent.run({ chatId: conversationId, message, user })
      const mayViewTrace = canViewDeveloper(user).decision === 'allow'
      sendJson(res, 200, {
        runId: result.runId,
        answer: result.answer,
        citations: result.citations,
        ...(result.pendingApproval ? { pendingApproval: result.pendingApproval } : {}),
        ...(mayViewTrace ? { trace: result.trace } : {}),
      })
      return
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/)
    if (method === 'POST' && approvalMatch) {
      if (!sameOrigin(req)) {
        sendJson(res, 403, { error: '跨站请求被拒绝' })
        return
      }
      const user = requireUser(req, res)
      if (!user) return
      if (canDecideApproval(user).decision !== 'allow') {
        sendJson(res, 403, { error: '当前角色无权处理审批' })
        return
      }
      const id = approvalMatch[1]
      const action = approvalMatch[2]
      const approval = business.getApproval(id)
      if (!approval) {
        sendJson(res, 404, { error: '审批不存在' })
        return
      }
      if (approval.status !== 'pending') {
        sendJson(res, 409, { error: '该审批已处理', approval })
        return
      }
      if (approval.requestedBy === user.username && user.role === 'librarian') {
        sendJson(res, 403, { error: '馆员不能审批自己发起的申请，请由管理员处理' })
        return
      }
      const body = await readJson<{ reason?: string }>(req)
      if (action === 'reject') {
        const rejected = business.decideApproval(id, 'rejected', user.username, body.reason ?? '馆员拒绝')
        business.recordAudit({
          runId: approval.runId,
          traceId: `APPROVAL-${id}`,
          actor: actorLabel(user),
          agentId: 'library-agent',
          tool: approval.tool,
          inputHash: 'approval',
          policyDecision: 'rejected',
          approvalId: id,
          result: 'rejected',
          details: { reason: body.reason ?? '馆员拒绝' },
        })
        sendJson(res, 200, { approval: rejected })
        return
      }
      if (approval.tool === 'fine_waive') {
        const finePayload = approval.payload as { fineId?: string }
        if (!finePayload.fineId) {
          sendJson(res, 400, { error: '审批缺少罚款参数' })
          return
        }
        const fine = business.waiveFine(finePayload.fineId, user.username)
        const approved = business.decideApproval(id, 'approved', user.username, body.reason ?? '管理员批准罚款减免')
        business.recordAudit({
          runId: approval.runId,
          traceId: `APPROVAL-${id}`,
          actor: actorLabel(user),
          agentId: 'library-agent',
          tool: 'fine_waive',
          inputHash: 'approval',
          policyDecision: 'approved',
          approvalId: id,
          result: 'waived',
          details: { fine },
        })
        sendJson(res, 200, { approval: approved, fine })
        return
      }
      const payload = approval.payload as { bookId?: string; readerId?: string }
      if (!payload.bookId || !payload.readerId) {
        sendJson(res, 400, { error: '审批缺少预约参数' })
        return
      }
      const existing = business
        .listReservations(payload.readerId)
        .find((reservation) => reservation.bookId === payload.bookId && reservation.status === 'active')
      const reservation = existing ?? business.createReservation(payload.bookId, payload.readerId, user.username)
      const approved = business.decideApproval(id, 'approved', user.username, body.reason ?? '馆员批准')
      business.recordAudit({
        runId: approval.runId,
        traceId: `APPROVAL-${id}`,
        actor: actorLabel(user),
        agentId: 'library-agent',
        tool: 'reservation_create',
        inputHash: 'approval',
        policyDecision: 'approved',
        approvalId: id,
        result: 'created',
        details: { reservation },
      })
      sendJson(res, 200, { approval: approved, reservation })
      return
    }

    if (method === 'GET' && (await serveStatic(res, pathname))) return
    sendJson(res, 404, { error: 'Not found' })
  } catch (error) {
    if (error instanceof ChatAccessError) {
      sendJson(res, 403, { error: error.message })
      return
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`AI Library Demo: http://127.0.0.1:${port}`)
  console.log(`Model: deepseek / ${modelId}`)
  console.log(`Data: ${join(dataDir, 'library.sqlite')}`)
  console.log(`Agent: ${join(dataDir, 'agent.sqlite')}`)
  console.log('RBAC: reader / librarian / auditor / admin')
})

let closing = false
async function shutdown(signal: string): Promise<void> {
  if (closing) return
  closing = true
  console.log(`\n${signal}: shutting down...`)
  server.close()
  await agent.close().catch(() => undefined)
  business.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
