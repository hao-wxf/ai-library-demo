const state = {
  user: null,
  permissions: null,
  conversations: [],
  activeId: null,
  busy: false,
  pendingCount: 0,
  health: null,
}

const DEMO_ACCOUNTS = [
  { username: 'zhangwei', password: 'reader123', name: '张伟', meta: '读者 · R001' },
  { username: 'lina', password: 'reader123', name: '李娜', meta: '读者 · R002 · 有逾期' },
  { username: 'wangfang', password: 'reader123', name: '王芳', meta: '读者 · R003' },
]

const ROLE_LABELS = {
  reader: '读者',
  librarian: '馆员',
  auditor: '审计员',
  admin: '管理员',
}

const layerNames = {
  intent: '意图',
  knowledge: '知识',
  orchestration: '编排',
  capability: '能力',
  infrastructure: '基础设施',
}

const statusNames = {
  ok: '成功',
  pending: '待处理',
  denied: '已拒绝',
  error: '失败',
}

const approvalStatusNames = {
  pending: '待审批',
  approved: '已批准',
  rejected: '已拒绝',
}

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' })

const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => Array.from(document.querySelectorAll(selector))

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined && text !== null) node.textContent = String(text)
  return node
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

function formatClock(value) {
  const date = value ? new Date(value) : new Date()
  return Number.isNaN(date.getTime()) ? '' : clock.format(date)
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return data
}

function roleLabel(role) {
  return ROLE_LABELS[role] ?? role
}

/* ---------- login ---------- */

function renderDemoAccounts() {
  const list = $('#demo-account-list')
  clear(list)
  for (const account of DEMO_ACCOUNTS) {
    const button = el('button', 'demo-account')
    button.type = 'button'
    button.dataset.username = account.username
    button.dataset.password = account.password
    button.append(el('strong', '', `${account.name} · ${account.meta}`))
    button.append(el('span', '', `${account.username} / ${account.password}`))
    list.append(button)
  }
}

function showLogin(message = '') {
  state.user = null
  state.permissions = null
  state.conversations = []
  state.activeId = null
  state.pendingCount = 0
  state.busy = false
  hideDrawer()
  $('#app').classList.add('hidden')
  $('#login-view').classList.remove('hidden')
  $('#login-error').classList.toggle('hidden', !message)
  $('#login-error').textContent = message
  $('#login-password').value = ''
  $('#login-username').focus()
  updateBadges()
  $('#messages').innerHTML = ''
  $('#conversation-list').innerHTML = ''
  $('#approval-list').innerHTML = ''
  $('#audit-list').innerHTML = ''
  $('#home-input').value = ''
  $('#chat-input').value = ''
  $('#user-avatar').textContent = 'AI'
  $('#user-name').textContent = '未登录'
  $('#user-role').textContent = '—'
  $('#approval-hint').classList.add('hidden')
  const toast = $('#toast')
  if (toast) {
    toast.classList.add('hidden')
    toast.textContent = ''
  }
  if (toastTimer) {
    clearTimeout(toastTimer)
    toastTimer = null
  }
}

async function handleLogin(event) {
  event.preventDefault()
  const username = $('#login-username').value.trim()
  const password = $('#login-password').value
  if (!username || !password) return
  const submit = $('#login-submit')
  submit.disabled = true
  $('#login-error').classList.add('hidden')
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    startSession(result.user, result.permissions)
  } catch (error) {
    $('#login-error').classList.remove('hidden')
    $('#login-error').textContent = error.message
  } finally {
    submit.disabled = false
  }
}

function startSession(user, permissions) {
  state.user = user
  state.permissions = permissions
  $('#login-view').classList.add('hidden')
  $('#app').classList.remove('hidden')
  updateIdentity()
  const developer = Boolean(permissions?.developerView)
  $('#developer-toggle').classList.toggle('hidden', !developer)
  loadConversations()
  renderConversations()
  renderSuggestions()
  if (state.activeId) openConversation(state.activeId, { restore: true })
  else showHome()
  if (developer) void refreshApprovals().catch(reportError)
  $('#home-input').focus()
}

async function logout() {
  if (state.busy) return
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' })
  } catch {
    // The local session is cleared even if the network call fails.
  }
  showLogin()
}

function updateIdentity() {
  if (!state.user) return
  $('#user-avatar').textContent = state.user.displayName.slice(0, 1)
  $('#user-name').textContent = state.user.displayName
  const reader = state.user.readerId ? ` · ${state.user.readerId}` : ''
  $('#user-role').textContent = `${roleLabel(state.user.role)}${reader}`
}

/* ---------- conversations ---------- */

function storageKey() {
  return `ai-library.conversations.v1.${state.user?.id ?? 'anon'}`
}

function newConversationId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `c-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createConversation() {
  const now = Date.now()
  return {
    id: newConversationId(),
    title: '新对话',
    messages: [],
    createdAt: now,
    updatedAt: now,
  }
}

function activeConversation() {
  return state.conversations.find((conversation) => conversation.id === state.activeId)
}

function ensureConversation() {
  let conversation = activeConversation()
  if (!conversation) {
    conversation = createConversation()
    state.conversations.unshift(conversation)
    state.activeId = conversation.id
  }
  return conversation
}

function serializeConversation(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages.map((message) => ({
      role: message.role,
      text: message.text,
      citations: message.citations,
      at: message.at,
    })),
  }
}

function saveConversations() {
  if (!state.user) return
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        conversations: state.conversations.map(serializeConversation),
        activeId: state.activeId,
      }),
    )
  } catch {
    // Storage may be unavailable; the in-memory conversation still works.
  }
}

function loadConversations() {
  state.conversations = []
  state.activeId = null
  try {
    const raw = localStorage.getItem(storageKey())
    if (!raw) return
    const parsed = JSON.parse(raw)
    const conversations = Array.isArray(parsed?.conversations) ? parsed.conversations : []
    state.conversations = conversations
      .filter((conversation) => conversation && typeof conversation.id === 'string' && Array.isArray(conversation.messages))
      .map((conversation) => ({
        id: conversation.id,
        title: typeof conversation.title === 'string' ? conversation.title : '对话',
        createdAt: Number(conversation.createdAt) || Date.now(),
        updatedAt: Number(conversation.updatedAt) || Number(conversation.createdAt) || Date.now(),
        messages: conversation.messages
          .filter((message) => message && typeof message.text === 'string')
          .map((message) => ({
            role: message.role === 'user' ? 'user' : 'assistant',
            text: message.text,
            citations: Array.isArray(message.citations) ? message.citations : [],
            at: typeof message.at === 'string' ? message.at : new Date().toISOString(),
          })),
      }))
    if (typeof parsed?.activeId === 'string' && state.conversations.some((item) => item.id === parsed.activeId)) {
      state.activeId = parsed.activeId
    }
  } catch {
    state.conversations = []
    state.activeId = null
  }
}

function touchConversation(conversation) {
  conversation.updatedAt = Date.now()
  state.conversations = [conversation, ...state.conversations.filter((item) => item.id !== conversation.id)]
  saveConversations()
  renderConversations()
}

function bucketFor(timestamp) {
  const date = new Date(timestamp)
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (date.getTime() >= start) return '今天'
  if (date.getTime() >= start - 24 * 60 * 60 * 1000) return '昨天'
  return '更早'
}

function renderConversations() {
  const list = $('#conversation-list')
  clear(list)
  if (state.conversations.length === 0) {
    list.append(el('div', 'conv-empty', '还没有对话，直接在右侧输入框里提问。'))
    return
  }
  let currentBucket = ''
  for (const conversation of [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const bucket = bucketFor(conversation.updatedAt)
    if (bucket !== currentBucket) {
      currentBucket = bucket
      list.append(el('div', 'conv-group-label', bucket))
    }
    const item = el('button', 'conv-item', conversation.title)
    item.type = 'button'
    item.title = conversation.title
    item.dataset.conversationId = conversation.id
    if (conversation.id === state.activeId) item.classList.add('active')
    list.append(item)
  }
}

function newChat() {
  if (state.busy) return
  state.activeId = null
  saveConversations()
  renderConversations()
  $('#messages').innerHTML = ''
  $('#home-input').value = ''
  $('#chat-input').value = ''
  renderTrace([], null, null)
  showHome()
  $('#home-input').focus()
}

function openConversation(id, options = {}) {
  if (state.busy && !options.restore) return
  const conversation = state.conversations.find((item) => item.id === id)
  if (!conversation) return
  state.activeId = id
  saveConversations()
  renderConversations()
  showChat()
  renderMessages()
  updateChatHead()
  renderTrace([], null, null)
  scrollMessages()
}

function updateChatHead() {
  const conversation = activeConversation()
  $('#chat-title').textContent = conversation?.title ?? '对话'
  if (!state.user) {
    $('#chat-context').textContent = ''
    return
  }
  const reader = state.user.readerId ? ` · ${state.user.readerId}` : ''
  $('#chat-context').textContent = `${state.user.displayName} · ${roleLabel(state.user.role)}${reader}`
}

/* ---------- suggestions / identity ---------- */

function renderSuggestions() {
  const container = $('#suggestions')
  clear(container)
  const prompts = state.user?.role === 'reader'
    ? [
        '帮我查一下《深入理解计算机系统》现在能不能借。',
        '借阅期限是多久？可以续借吗？',
        '帮我看看我的借阅和逾期情况。',
      ]
    : [
        '查一下李娜的借阅和逾期情况。',
        '帮李娜预约《人工智能：一种现代的方法》。',
        '借阅期限和续借规则是什么？',
      ]
  for (const prompt of prompts) {
    const button = el('button', 'suggestion')
    button.type = 'button'
    button.dataset.prompt = prompt
    button.append(el('span', 'suggestion-icon', '↗'))
    button.append(el('span', '', prompt))
    container.append(button)
  }
}

/* ---------- views ---------- */

function showHome() {
  $('#home-view').classList.remove('hidden')
  $('#chat-view').classList.add('hidden')
  updateApprovalHint()
}

function showChat() {
  $('#home-view').classList.add('hidden')
  $('#chat-view').classList.remove('hidden')
  updateApprovalHint()
}

function setBusy(busy) {
  state.busy = busy
  for (const button of $$('.send-button')) button.disabled = busy
  $('#home-input').disabled = busy
  $('#chat-input').disabled = busy
}

/* ---------- messages ---------- */

function appendMessage(conversation, role, text, extra = {}) {
  const message = {
    role,
    text: String(text ?? ''),
    citations: Array.isArray(extra.citations) ? extra.citations : [],
    run: extra.run ?? null,
    at: new Date().toISOString(),
  }
  conversation.messages.push(message)
  return message
}

function appendAssistantText(container, text) {
  const parts = String(text ?? '').split(/(\*\*[^*\n]+\*\*)/g)
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      container.append(el('strong', '', part.slice(2, -2)))
    } else if (part) {
      container.append(document.createTextNode(part))
    }
  }
}

function buildMessage(message) {
  const wrap = el('div', `message ${message.role}`)
  const who = message.role === 'user'
    ? `${state.user?.displayName ?? '我'} · ${formatClock(message.at)}`
    : `AI Library · ${formatClock(message.at)}`
  wrap.append(el('div', 'message-meta', who))

  const body = el('div', 'message-body')
  if (message.role === 'assistant') appendAssistantText(body, message.text)
  else body.textContent = message.text
  wrap.append(body)

  if (message.citations.length > 0) {
    const sources = el('div', 'source-chips')
    for (const citation of [...new Set(message.citations)]) {
      sources.append(el('span', 'source-chip', citation))
    }
    wrap.append(sources)
  }

  if (message.run) {
    const actions = el('div', 'message-actions')
    const detail = el('button', 'message-link', '查看运行详情')
    detail.type = 'button'
    detail.addEventListener('click', () => openTraceFor(message))
    actions.append(detail)
    if (message.run.pendingApproval && state.permissions?.developerView) {
      const handle = el('button', 'message-link', '查看审批')
      handle.type = 'button'
      handle.addEventListener('click', () => showDrawer('approvals'))
      actions.append(handle)
    }
    wrap.append(actions)
  }

  return wrap
}

function renderMessages() {
  const container = $('#messages')
  clear(container)
  const conversation = activeConversation()
  if (!conversation) return
  for (const message of conversation.messages) container.append(buildMessage(message))
  container.scrollTop = container.scrollHeight
}

function scrollMessages() {
  const container = $('#messages')
  container.scrollTop = container.scrollHeight
}

function typingMessage() {
  const wrap = el('div', 'message assistant typing')
  wrap.append(el('div', 'message-meta', 'AI Library · 正在处理'))
  const body = el('div', 'message-body')
  const dots = el('span', 'typing-dots')
  dots.append(el('span'), el('span'), el('span'))
  body.append(dots)
  wrap.append(body)
  return wrap
}

function titleFor(text) {
  const title = String(text).replace(/\s+/g, ' ').trim()
  return title.length > 24 ? `${title.slice(0, 24)}…` : title || '新对话'
}

async function sendMessage(raw) {
  const text = String(raw ?? '').trim()
  if (!text || state.busy) return

  const conversation = ensureConversation()
  if (conversation.messages.length === 0) conversation.title = titleFor(text)
  appendMessage(conversation, 'user', text)
  $('#home-input').value = ''
  $('#chat-input').value = ''
  touchConversation(conversation)
  showChat()
  renderMessages()
  updateChatHead()

  const typing = typingMessage()
  $('#messages').append(typing)
  scrollMessages()
  setBusy(true)

  try {
    const result = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ conversationId: conversation.id, message: text }),
    })
    typing.remove()
    appendMessage(conversation, 'assistant', result.answer ?? '（没有返回内容）', {
      citations: result.citations ?? [],
      run: Array.isArray(result.trace)
        ? { runId: result.runId, trace: result.trace, pendingApproval: result.pendingApproval ?? null }
        : null,
    })
    touchConversation(conversation)
    renderMessages()
    if (Array.isArray(result.trace)) {
      renderTrace(result.trace, result.runId, result.pendingApproval ?? null)
    }
    if (state.permissions?.developerView) {
      await Promise.allSettled([refreshApprovals(), refreshAudit()])
    }
    updateApprovalHint()
  } catch (error) {
    typing.remove()
    if (error.status === 401) {
      handleUnauthorized()
      return
    }
    appendMessage(conversation, 'assistant', `抱歉，这次没有完成：${error.message}`)
    touchConversation(conversation)
    renderMessages()
  } finally {
    setBusy(false)
  }
}

function handleComposerKeydown(event) {
  if (event.isComposing) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    const form = event.target.closest('form')
    if (form) form.requestSubmit()
  }
}

/* ---------- developer drawer ---------- */

function showDrawer(tab) {
  if (!state.permissions?.developerView) return
  $('#drawer-backdrop').classList.remove('hidden')
  $('#developer-drawer').classList.remove('hidden')
  switchDrawerTab(tab)
}

function hideDrawer() {
  $('#drawer-backdrop').classList.add('hidden')
  $('#developer-drawer').classList.add('hidden')
}

function switchDrawerTab(tab) {
  for (const button of $$('.drawer-tab')) {
    button.classList.toggle('active', button.dataset.drawerTab === tab)
  }
  for (const pane of $$('.drawer-pane')) {
    pane.classList.toggle('active', pane.id === `drawer-${tab}`)
  }
  if (tab === 'approvals') void refreshApprovals().catch(reportError)
  if (tab === 'audit') void refreshAudit().catch(reportError)
}

function openTraceFor(message) {
  if (!message.run || !state.permissions?.developerView) return
  showDrawer('trace')
  renderTrace(message.run.trace ?? [], message.run.runId, message.run.pendingApproval ?? null)
}

function traceSummary(event) {
  if (event.type === 'policy') return event.policy ? event.policy.reason ?? '' : ''
  if (event.type === 'approval') return '等待馆员审批'
  const output = event.output
  if (!output || typeof output !== 'object') return ''
  if (Array.isArray(output.books)) return `返回 ${output.books.length} 本图书`
  if (Array.isArray(output.passages)) return `检索到 ${output.passages.length} 条制度`
  if (Array.isArray(output.loans)) return `返回 ${output.loans.length} 条借阅`
  if (Array.isArray(output.readers)) return `找到 ${output.readers.length} 位读者`
  if (output.book) return `《${output.book.title}》 可借 ${output.book.availableCopies}/${output.book.totalCopies}`
  if (output.reader) return `${output.reader.name}（${output.reader.id}） · 借阅 ${output.reader.activeLoans}/${output.reader.maxLoans}`
  if (output.status) return `状态：${output.status}`
  if (output.reason) return String(output.reason)
  if (output.message) return String(output.message)
  return ''
}

function traceInput(event) {
  const input = event.input
  if (!input || typeof input !== 'object') return ''
  const parts = []
  if (input.query) parts.push(`query: ${input.query}`)
  if (input.readerId) parts.push(`reader: ${input.readerId}`)
  if (input.bookId) parts.push(`book: ${input.bookId}`)
  if (input.bookTitle) parts.push(`bookTitle: ${input.bookTitle}`)
  return parts.join(' · ')
}

function renderTrace(trace, runId, pendingApproval) {
  const list = $('#trace-list')
  $('#drawer-run-label').textContent = runId ? `运行 ${runId} · ${trace.length} 步` : '尚无运行'
  clear(list)
  if (!trace || trace.length === 0) {
    list.className = 'trace-list empty'
    list.textContent = '发送一条消息后，这里会显示五层调用链。'
    return
  }
  list.className = 'trace-list'
  for (const event of trace) {
    const item = el('div', 'trace-item')
    const top = el('div', 'trace-top')
    const name = el('div', 'trace-name', event.name)
    const meta = el('div', 'trace-meta')
    const layer = el('span', `layer-tag ${event.layer}`, layerNames[event.layer] ?? event.layer)
    const status = el('span', `trace-status ${event.status}`, statusNames[event.status] ?? event.status)
    meta.append(layer, status)
    top.append(name, meta)
    item.append(top)

    const input = traceInput(event)
    if (input) item.append(el('div', 'trace-detail', input))
    const summary = traceSummary(event)
    if (summary) item.append(el('div', 'trace-detail', summary))
    if (event.policy) {
      item.append(el('div', 'policy-line', `策略 ${event.policy.policyId} · ${event.policy.decision}`))
    }
    list.append(item)
  }
  if (pendingApproval) {
    const note = el('div', 'trace-item')
    note.append(el('div', 'trace-name', `审批 ${pendingApproval.id}`))
    note.append(el('div', 'trace-detail', '本次运行产生待审批事项，请在审批面板处理。'))
    list.append(note)
  }
}

/* ---------- approvals / audit ---------- */

function updateBadges() {
  const badge = $('#drawer-badge')
  if (!badge) return
  badge.textContent = String(state.pendingCount)
  badge.classList.toggle('hidden', state.pendingCount === 0)
}

function updateApprovalHint() {
  const hint = $('#approval-hint')
  if (!hint) return
  const inChat = !$('#chat-view').classList.contains('hidden')
  const show = Boolean(state.permissions?.developerView) && state.pendingCount > 0 && inChat
  hint.classList.toggle('hidden', !show)
}

function renderApprovals(approvals) {
  const list = $('#approval-list')
  clear(list)
  if (approvals.length === 0) {
    list.className = 'approval-list empty'
    list.textContent = '暂无审批。'
    return
  }
  list.className = 'approval-list'
  for (const approval of approvals.slice(0, 20)) {
    const card = el('div', `approval${approval.status === 'pending' ? '' : ' done'}`)
    const isFine = approval.tool === 'fine_waive'
    const title = isFine ? '罚款减免审批' : '预约审批'
    card.append(el('div', 'approval-title', `${title} · ${approvalStatusNames[approval.status] ?? approval.status}`))
    const payload = approval.payload ?? {}
    if (isFine) {
      card.append(
        el(
          'div',
          'approval-meta',
          `读者 ${payload.readerId ?? '未知'} · 罚款 ${payload.fineId ?? '未知'} · ${Number(payload.amount ?? 0).toFixed(2)} 元`,
        ),
      )
    } else {
      const book = payload.bookTitle ? `《${payload.bookTitle}》` : payload.bookId ?? '未知图书'
      card.append(el('div', 'approval-meta', `为读者 ${payload.readerId ?? '未知'} 预约 ${book}`))
    }
    card.append(
      el(
        'div',
        'approval-meta',
        `审批号 ${approval.id} · 策略 ${approval.policyId} · 申请人 ${approval.requestedBy} · ${formatTime(approval.createdAt)}`,
      ),
    )
    if (approval.reason) card.append(el('div', 'approval-meta', `原因：${approval.reason}`))

    if (approval.status === 'pending' && state.permissions?.decideApprovals) {
      const self = approval.requestedBy === state.user?.username && state.user?.role === 'librarian'
      if (self) {
        card.append(el('div', 'approval-meta', '不能审批自己发起的申请，请由管理员处理。'))
      } else {
        const actions = el('div', 'approval-actions')
        const approve = el('button', 'approve', isFine ? '批准减免' : '批准并创建预约')
        const reject = el('button', 'reject', '拒绝')
        approve.type = 'button'
        reject.type = 'button'
        approve.addEventListener('click', () => void decideApproval(approval.id, 'approve', card))
        reject.addEventListener('click', () => void decideApproval(approval.id, 'reject', card))
        actions.append(approve, reject)
        card.append(actions)
      }
    } else if (approval.status === 'pending') {
      card.append(el('div', 'approval-meta', '审计角色只读，不能处理审批。'))
    }
    list.append(card)
  }
}

async function refreshApprovals() {
  if (!state.permissions?.developerView) return
  const data = await api('/api/approvals')
  const approvals = data.approvals ?? []
  state.pendingCount = approvals.filter((approval) => approval.status === 'pending').length
  renderApprovals(approvals)
  updateBadges()
  updateApprovalHint()
}

async function decideApproval(id, action, card) {
  for (const button of card.querySelectorAll('button')) button.disabled = true
  try {
    const result = await api(`/api/approvals/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ reason: action === 'approve' ? '馆员批准' : '馆员拒绝' }),
    })
    const suffix = result.reservation
      ? `，预约号 ${result.reservation.id}`
      : result.fine
        ? `，罚款 ${result.fine.id} 已减免`
        : ''
    showToast(`审批 ${id} 已${action === 'approve' ? '批准' : '拒绝'}${suffix}`)
    await Promise.allSettled([refreshApprovals(), refreshAudit()])
  } catch (error) {
    if (error.status === 401) {
      handleUnauthorized()
      return
    }
    card.append(el('div', 'approval-meta', `处理失败：${error.message}`))
    for (const button of card.querySelectorAll('button')) button.disabled = false
  }
}

function renderAudit(events) {
  const list = $('#audit-list')
  clear(list)
  if (events.length === 0) {
    list.className = 'audit-list empty'
    list.textContent = '暂无审计事件。'
    return
  }
  list.className = 'audit-list'
  for (const event of events.slice(0, 60)) {
    const item = el('div', 'audit-item')
    const first = el('div')
    first.append(el('strong', '', event.tool), document.createTextNode(' · '))
    first.append(el('span', 'audit-tool', event.policyDecision), document.createTextNode(` · ${event.result}`))
    item.append(first)
    const meta = ` ${event.actor} · ${formatTime(event.createdAt)} · ${event.runId}${event.approvalId ? ` · 审批 ${event.approvalId}` : ''}`
    item.append(document.createTextNode(meta))
    list.append(item)
  }
}

async function refreshAudit() {
  if (!state.permissions?.developerView) return
  const data = await api('/api/audit')
  renderAudit(data.audit ?? [])
}

/* ---------- utilities ---------- */

let toastTimer = null

function showToast(message) {
  const toast = $('#toast')
  toast.textContent = message
  toast.classList.remove('hidden')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200)
}

function reportError(error) {
  if (error?.status === 401) {
    handleUnauthorized()
    return
  }
  console.error(error)
}

function handleUnauthorized() {
  if (!state.user) return
  showLogin('登录已过期，请重新登录。')
}

async function loadHealth() {
  try {
    const health = await api('/api/health')
    state.health = health
    $('#drawer-subtitle').textContent = `DeepSeek · ${health.model ?? 'deepseek'} · 五层调用链 · 审批 · 审计`
  } catch {
    // The login screen still works if health is temporarily unavailable.
  }
}

/* ---------- wiring ---------- */

function wire() {
  renderDemoAccounts()

  $('#login-form').addEventListener('submit', (event) => void handleLogin(event))
  $('#demo-account-list').addEventListener('click', (event) => {
    const button = event.target.closest('.demo-account')
    if (!button) return
    $('#login-username').value = button.dataset.username ?? ''
    $('#login-password').value = button.dataset.password ?? ''
    $('#login-submit').focus()
  })

  $('#logout').addEventListener('click', () => void logout())
  $('#new-chat').addEventListener('click', newChat)
  $('#back-home').addEventListener('click', newChat)

  $('#conversation-list').addEventListener('click', (event) => {
    const item = event.target.closest('.conv-item')
    if (item?.dataset.conversationId) openConversation(item.dataset.conversationId)
  })

  $('#suggestions').addEventListener('click', (event) => {
    const button = event.target.closest('.suggestion')
    if (button?.dataset.prompt) void sendMessage(button.dataset.prompt)
  })

  $('#home-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void sendMessage($('#home-input').value)
  })
  $('#chat-form').addEventListener('submit', (event) => {
    event.preventDefault()
    void sendMessage($('#chat-input').value)
  })
  $('#home-input').addEventListener('keydown', handleComposerKeydown)
  $('#chat-input').addEventListener('keydown', handleComposerKeydown)

  $('#developer-toggle').addEventListener('click', () => {
    const conversation = activeConversation()
    const lastRunMessage = [...(conversation?.messages ?? [])].reverse().find((message) => message.run)
    showDrawer('trace')
    renderTrace(
      lastRunMessage?.run.trace ?? [],
      lastRunMessage?.run.runId ?? null,
      lastRunMessage?.run.pendingApproval ?? null,
    )
  })
  $('#drawer-close').addEventListener('click', hideDrawer)
  $('#drawer-backdrop').addEventListener('click', hideDrawer)
  for (const tab of $$('.drawer-tab')) {
    tab.addEventListener('click', () => switchDrawerTab(tab.dataset.drawerTab))
  }
  $('#open-approvals').addEventListener('click', () => showDrawer('approvals'))
  $('#refresh-approvals').addEventListener('click', () => void refreshApprovals().catch(reportError))
  $('#refresh-audit').addEventListener('click', () => void refreshAudit().catch(reportError))
}

async function bootstrap() {
  wire()
  void loadHealth()
  try {
    const me = await api('/api/auth/me')
    if (me.user) startSession(me.user, me.permissions)
    else showLogin()
  } catch {
    showLogin('无法连接服务，请确认本地服务已启动。')
  }
}

void bootstrap()
