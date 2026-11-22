import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { AuthUser, UserRole } from '../../contracts/src/index.ts'

export interface PermissionSet {
  developerView: boolean
  viewApprovals: boolean
  decideApprovals: boolean
  viewAudit: boolean
}

interface AccountRecord extends AuthUser {
  salt: Buffer
  passwordHash: Buffer
}

interface SessionRecord {
  userId: string
  expiresAt: number
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000

const DEMO_ACCOUNTS: {
  username: string
  password: string
  displayName: string
  role: UserRole
  readerId?: string
}[] = [
  { username: 'zhangwei', password: 'reader123', displayName: '张伟', role: 'reader', readerId: 'R001' },
  { username: 'lina', password: 'reader123', displayName: '李娜', role: 'reader', readerId: 'R002' },
  { username: 'wangfang', password: 'reader123', displayName: '王芳', role: 'reader', readerId: 'R003' },
  { username: 'librarian', password: 'librarian123', displayName: '馆员', role: 'librarian' },
  { username: 'auditor', password: 'auditor123', displayName: '审计员', role: 'auditor' },
  { username: 'admin', password: 'admin123', displayName: '管理员', role: 'admin' },
]

const accounts = new Map<string, AccountRecord>()
for (const account of DEMO_ACCOUNTS) {
  const salt = randomBytes(16)
  accounts.set(account.username, {
    id: `u-${account.username}`,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    ...(account.readerId ? { readerId: account.readerId } : {}),
    salt,
    passwordHash: scryptSync(account.password, salt, 64),
  })
}

const dummySalt = randomBytes(16)
const dummyHash = scryptSync('not-a-real-password', dummySalt, 64)
const sessions = new Map<string, SessionRecord>()

function publicUser(account: AccountRecord): AuthUser {
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    role: account.role,
    ...(account.readerId ? { readerId: account.readerId } : {}),
  }
}

function passwordMatches(account: AccountRecord | undefined, password: string): boolean {
  const salt = account?.salt ?? dummySalt
  const expected = account?.passwordHash ?? dummyHash
  const actual = scryptSync(password, salt, 64)
  return timingSafeEqual(actual, expected) && account !== undefined
}

export function login(username: string, password: string): {
  token: string
  expiresAt: number
  user: AuthUser
} | undefined {
  const account = accounts.get(username.trim())
  if (!passwordMatches(account, password)) return undefined
  if (!account) return undefined
  const token = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + SESSION_TTL_MS
  sessions.set(token, { userId: account.id, expiresAt })
  return { token, expiresAt, user: publicUser(account) }
}

export function getSession(token: string | undefined): AuthUser | undefined {
  if (!token) return undefined
  const session = sessions.get(token)
  if (!session) return undefined
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return undefined
  }
  for (const [key, value] of sessions) {
    if (value.expiresAt <= Date.now()) sessions.delete(key)
  }
  const account = [...accounts.values()].find((item) => item.id === session.userId)
  return account ? publicUser(account) : undefined
}

export function logout(token: string | undefined): void {
  if (token) sessions.delete(token)
}

export function permissionsFor(role: UserRole): PermissionSet {
  if (role === 'admin') {
    return { developerView: true, viewApprovals: true, decideApprovals: true, viewAudit: true }
  }
  if (role === 'librarian') {
    return { developerView: true, viewApprovals: true, decideApprovals: true, viewAudit: true }
  }
  if (role === 'auditor') {
    return { developerView: true, viewApprovals: true, decideApprovals: false, viewAudit: true }
  }
  return { developerView: false, viewApprovals: false, decideApprovals: false, viewAudit: false }
}

export function roleLabel(role: UserRole): string {
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

export function isStaffRole(role: UserRole): boolean {
  return role === 'librarian' || role === 'auditor' || role === 'admin'
}

export const SESSION_COOKIE = 'ai_library_session'
export { SESSION_TTL_MS }
