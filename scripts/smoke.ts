const base = 'http://127.0.0.1:8787'
const stamp = Date.now().toString(36)

interface Session {
  cookie: string
  user: { username: string; role: string; readerId?: string }
}

async function request(
  path: string,
  options: {
    method?: string
    body?: unknown
    cookie?: string
  } = {},
): Promise<{ status: number; data: Record<string, unknown>; cookie: string }> {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(180_000),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const setCookies = response.headers.getSetCookie?.() ?? []
  return { status: response.status, data, cookie: setCookies[0]?.split(';')[0] ?? options.cookie ?? '' }
}

async function login(username: string, password: string): Promise<Session> {
  const result = await request('/api/auth/login', { method: 'POST', body: { username, password } })
  if (result.status !== 200) throw new Error(`login ${username} failed: ${result.status} ${String(result.data.error ?? '')}`)
  const user = result.data.user as Session['user']
  console.log(`login: ${user.username} / ${user.role}${user.readerId ? ` / ${user.readerId}` : ''}`)
  return { cookie: result.cookie, user }
}

async function chat(session: Session, label: string, message: string): Promise<Record<string, unknown>> {
  const conversationId = `smoke-${label}-${stamp}`
  const result = await request('/api/chat', {
    method: 'POST',
    cookie: session.cookie,
    body: { conversationId, message },
  })
  if (result.status !== 200) throw new Error(`${label} failed: ${result.status} ${String(result.data.error ?? '')}`)
  console.log(`\n=== ${label} ===`)
  console.log('answer:', String(result.data.answer ?? '').slice(0, 500))
  console.log('citations:', result.data.citations)
  const trace = result.data.trace as { layer: string; name: string; status: string }[] | undefined
  console.log('trace:', trace?.map((event) => `${event.layer}/${event.name}/${event.status}`).join(' | '))
  if (result.data.pendingApproval) {
    console.log('pendingApproval:', (result.data.pendingApproval as { id: string }).id)
  }
  return result.data
}

const reader = await login('zhangwei', 'reader123')
if (await request('/api/approvals', { cookie: reader.cookie }).then((result) => result.status !== 403)) {
  throw new Error('reader should not access approvals')
}

const search = await chat(reader, 'reader-search', '帮我查一下《深入理解计算机系统》现在能不能借。')
if (!String(search.answer ?? '').includes('深入理解计算机系统')) throw new Error('search answer missing book title')
if (!Array.isArray(search.citations) || search.citations.length === 0) throw new Error('search citations missing')
if (search.trace !== undefined) throw new Error('reader response must not expose trace')

const knowledge = await chat(reader, 'reader-knowledge', '借阅期限是多久？可以续借吗？')
if (!String(knowledge.answer ?? '').includes('借阅')) throw new Error('knowledge answer missing borrowing rule')
if (!Array.isArray(knowledge.citations) || knowledge.citations.length === 0) throw new Error('knowledge citations missing')
if (knowledge.trace !== undefined) throw new Error('reader response must not expose trace')

const listAll = await chat(reader, 'reader-list-all', '把馆里现在所有的书都给我列举出来。')
const listAnswer = String(listAll.answer ?? '')
if (!listAnswer.includes('深入理解计算机系统') || !listAnswer.includes('人工智能')) {
  throw new Error('list-all answer did not include the catalog')
}
if (listAll.trace !== undefined) throw new Error('reader list-all must not expose trace')

const overview = await chat(reader, 'reader-overview', '告诉我现在的馆藏和图书馆的制度。')
const overviewAnswer = String(overview.answer ?? '')
if (!overviewAnswer.includes('深入理解计算机系统')) throw new Error('overview answer missing catalog')
if (!overviewAnswer.replace(/\s+/g, '').includes('30天')) throw new Error('overview answer missing borrowing period')
if (!/开放|预约/.test(overviewAnswer)) throw new Error('overview answer missing rules')
if (!Array.isArray(overview.citations) || overview.citations.length < 3) throw new Error('overview citations missing')

const lina = await login('lina', 'reader123')
const reservation = await chat(
  lina,
  'reader-reservation',
  '帮我预约《人工智能：一种现代的方法》，我是李娜，读者 R002。',
)
const pending = reservation.pendingApproval as { id: string; status: string } | undefined
if (!pending || pending.status !== 'pending') throw new Error('expected a pending approval')

const crossUser = await request('/api/chat', {
  method: 'POST',
  cookie: reader.cookie,
  body: { conversationId: `smoke-reader-reservation-${stamp}`, message: '继续' },
})
if (crossUser.status !== 403) throw new Error(`cross-user conversation should be 403, got ${crossUser.status}`)

const librarian = await login('librarian', 'librarian123')
const approvals = await request('/api/approvals', { cookie: librarian.cookie })
const approvalList = (approvals.data.approvals ?? []) as { id: string; status: string }[]
if (!approvalList.some((approval) => approval.id === pending.id && approval.status === 'pending')) {
  throw new Error('librarian cannot see the pending approval')
}
const approvalResult = await request(`/api/approvals/${pending.id}/approve`, {
  method: 'POST',
  cookie: librarian.cookie,
  body: { reason: 'smoke test approval' },
})
if (approvalResult.status !== 200) throw new Error(`approve failed: ${approvalResult.status}`)
console.log('\n=== approval ===')
console.log(JSON.stringify(approvalResult.data))

const staffLookup = await chat(librarian, 'staff-reader', '查一下李娜的借阅和逾期情况。')
if (!String(staffLookup.answer ?? '').includes('李娜')) throw new Error('staff lookup answer missing reader name')
const staffTrace = staffLookup.trace as { name: string }[] | undefined
if (!staffTrace?.some((event) => ['reader_search', 'reader_get', 'loan_list'].includes(event.name))) {
  throw new Error('staff lookup did not call reader/loan tools')
}

const audit = await request('/api/audit', { cookie: librarian.cookie })
const auditList = (audit.data.audit ?? []) as { tool: string; policyDecision: string; result: string }[]
console.log('\n=== audit (latest 8) ===')
for (const event of auditList.slice(0, 8)) {
  console.log(`${event.tool} | ${event.policyDecision} | ${event.result}`)
}
for (const tool of ['catalog_search', 'catalog_list', 'knowledge_search', 'reservation_create']) {
  if (!auditList.some((event) => event.tool === tool)) throw new Error(`audit missing ${tool}`)
}

console.log('\nSMOKE OK')
