import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ApprovalRequest, AuditEvent, UserRole } from '../../contracts/src/index.ts'

export interface BookView {
  id: string
  title: string
  author: string
  isbn: string
  category: string
  publisher: string
  publishedYear: number
  edition: string
  language: string
  pages: number
  price: number
  summary: string
  keywords: string
  status: string
  totalCopies: number
  availableCopies: number
}

export interface ReaderView {
  id: string
  name: string
  status: string
  readerTypeId: string
  readerTypeName: string
  maxLoans: number
  maxReservations: number
  loanDays: number
  maxRenews: number
  renewDays: number
  phoneMasked: string
  emailMasked: string
  registeredAt: string
  expiresAt: string
  activeLoans: number
  activeReservations: number
  hasOverdue: boolean
}

export interface LoanView {
  id: string
  copyId: string
  bookId: string
  bookTitle: string
  readerId: string
  readerName: string
  borrowedAt: string
  dueAt: string
  returnedAt: string | null
  renewedCount: number
  status: string
  overdueDays: number
  fine: number
}

export interface ReservationView {
  id: string
  bookId: string
  bookTitle: string
  readerId: string
  readerName: string
  pickupBranch: string
  queuePosition: number
  status: string
  createdAt: string
  expiresAt: string
}

export interface BranchView {
  id: string
  name: string
  address: string
  phone: string
  openingHours: string
  status: string
}

export interface ReaderTypeView {
  id: string
  name: string
  maxLoans: number
  maxReservations: number
  loanDays: number
  maxRenews: number
  renewDays: number
  status: string
}

export interface CopyView {
  id: string
  bookId: string
  bookTitle: string
  barcode: string
  branch: string
  location: string
  callNumber: string
  status: string
  condition: string
  acquiredAt: string
}

export interface FineView {
  id: string
  loanId: string
  readerId: string
  readerName: string
  amount: number
  reason: string
  status: string
  createdAt: string
  paidAt?: string
  waivedBy?: string
  paymentRef?: string
}

export interface NotificationView {
  id: string
  readerId: string
  readerName: string
  type: string
  channel: string
  subject: string
  body: string
  status: string
  createdAt: string
  sentAt?: string
}

export interface VendorView {
  id: string
  name: string
  contact: string
  phone: string
  status: string
}

export interface PurchaseRequestView {
  id: string
  title: string
  isbn: string
  quantity: number
  estimatedUnitPrice: number
  requestedBy: string
  status: string
  createdAt: string
  approvedBy?: string
  approvedAt?: string
}

export interface OrderView {
  id: string
  vendorId: string
  vendorName: string
  status: string
  totalAmount: number
  createdAt: string
  receivedAt?: string
  items: {
    id: string
    title: string
    isbn: string
    quantity: number
    unitPrice: number
    receivedQuantity: number
  }[]
}

export interface SerialView {
  id: string
  title: string
  issn: string
  vendorId: string
  status: string
  startDate: string
  endDate: string
  nextIssueDate: string
}

export interface ElectronicResourceView {
  id: string
  title: string
  provider: string
  url: string
  licenseStatus: string
  createdAt: string
}

export interface IllRequestView {
  id: string
  readerId: string
  title: string
  status: string
  createdAt: string
  updatedAt: string
}

export interface StocktakeView {
  id: string
  branch: string
  status: string
  startedAt: string
  completedAt?: string
  scannedCount: number
  totalCopies: number
}

export interface EventView {
  id: string
  title: string
  startsAt: string
  endsAt: string
  location: string
  capacity: number
  status: string
}

export interface CreateApprovalInput {
  runId: string
  toolCallId?: string
  policyId: string
  tool: string
  payload: Record<string, unknown>
  requestedBy: string
}

export interface ChatConversationView {
  id: string
  ownerUserId: string
  ownerUsername: string
  ownerRole: UserRole
  readerId?: string
  piConversationId: string
  createdAt: string
  updatedAt: string
}

export interface CreateChatConversationInput {
  id: string
  ownerUserId: string
  ownerUsername: string
  ownerRole: UserRole
  readerId?: string
  piConversationId: string
}

type Row = Record<string, unknown>

function str(row: Row, key: string): string {
  return String(row[key] ?? '')
}

function num(row: Row, key: string): number {
  return Number(row[key] ?? 0)
}

function maskPhone(phone: string): string {
  if (phone.length < 8) return phone
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@')
  if (!name || !domain) return email
  return `${name.slice(0, 1)}***@${domain}`
}

function all<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[]
}

function get<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined
}

function run(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): void {
  db.prepare(sql).run(...params)
}

export function createBusinessService(dbPath: string) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      isbn TEXT NOT NULL,
      category TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS copies (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id),
      branch TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS readers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      max_loans INTEGER NOT NULL,
      phone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loans (
      id TEXT PRIMARY KEY,
      copy_id TEXT NOT NULL REFERENCES copies(id),
      reader_id TEXT NOT NULL REFERENCES readers(id),
      due_at TEXT NOT NULL,
      returned_at TEXT
    );
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id),
      reader_id TEXT NOT NULL REFERENCES readers(id),
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_by TEXT
    );
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      tool_call_id TEXT,
      policy_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      payload TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      policy_decision TEXT NOT NULL,
      approval_id TEXT,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_events(run_id);
    CREATE INDEX IF NOT EXISTS idx_approval_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_loans_reader ON loans(reader_id);
    CREATE INDEX IF NOT EXISTS idx_reservations_reader ON reservations(reader_id);
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT NOT NULL,
      opening_hours TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reader_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      max_loans INTEGER NOT NULL,
      max_reservations INTEGER NOT NULL,
      loan_days INTEGER NOT NULL,
      max_renews INTEGER NOT NULL,
      renew_days INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS fines (
      id TEXT PRIMARY KEY,
      loan_id TEXT NOT NULL,
      reader_id TEXT NOT NULL,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      paid_at TEXT,
      waived_by TEXT,
      payment_ref TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      reader_id TEXT NOT NULL,
      type TEXT NOT NULL,
      channel TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS vendors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchase_requests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      isbn TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      estimated_unit_price REAL NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      vendor_id TEXT NOT NULL,
      status TEXT NOT NULL,
      total_amount REAL NOT NULL,
      created_at TEXT NOT NULL,
      received_at TEXT
    );
    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      title TEXT NOT NULL,
      isbn TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      received_quantity INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fines_reader ON fines(reader_id);
    CREATE INDEX IF NOT EXISTS idx_fines_status ON fines(status);
    CREATE INDEX IF NOT EXISTS idx_notifications_reader ON notifications(reader_id);
    CREATE INDEX IF NOT EXISTS idx_purchase_status ON purchase_requests(status);
    CREATE TABLE IF NOT EXISTS serials (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      issn TEXT NOT NULL,
      vendor_id TEXT,
      status TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      next_issue_date TEXT
    );
    CREATE TABLE IF NOT EXISTS electronic_resources (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      url TEXT NOT NULL,
      license_status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ill_requests (
      id TEXT PRIMARY KEY,
      reader_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stocktakes (
      id TEXT PRIMARY KEY,
      branch TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS stocktake_items (
      id TEXT PRIMARY KEY,
      stocktake_id TEXT NOT NULL,
      copy_id TEXT NOT NULL,
      scanned INTEGER NOT NULL,
      result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      location TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ill_reader ON ill_requests(reader_id);
    CREATE INDEX IF NOT EXISTS idx_stocktake_items ON stocktake_items(stocktake_id);
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      owner_username TEXT NOT NULL,
      owner_role TEXT NOT NULL,
      reader_id TEXT,
      pi_conversation_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_owner ON chat_conversations(owner_user_id);
  `)

  function ensureColumn(table: string, column: string, definition: string): void {
    const columns = all<{ name: string }>(db, `PRAGMA table_info(${table})`)
    if (!columns.some((item) => item.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
  }

  ensureColumn('books', 'publisher', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('books', 'published_year', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('books', 'edition', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('books', 'language', "TEXT NOT NULL DEFAULT '中文'")
  ensureColumn('books', 'pages', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('books', 'price', 'REAL NOT NULL DEFAULT 0')
  ensureColumn('books', 'summary', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('books', 'keywords', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('books', 'status', "TEXT NOT NULL DEFAULT 'active'")
  ensureColumn('books', 'created_at', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('copies', 'barcode', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('copies', 'location', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('copies', 'call_number', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('copies', 'condition', "TEXT NOT NULL DEFAULT 'good'")
  ensureColumn('copies', 'acquired_at', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('readers', 'reader_type_id', "TEXT NOT NULL DEFAULT 'RT-STD'")
  ensureColumn('readers', 'email', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('readers', 'registered_at', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('readers', 'expires_at', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('loans', 'borrowed_at', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('loans', 'renewed_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('loans', 'status', "TEXT NOT NULL DEFAULT 'active'")
  ensureColumn('reservations', 'pickup_branch', "TEXT NOT NULL DEFAULT ''")
  ensureColumn('reservations', 'queue_position', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('reservations', 'notified_at', 'TEXT')
  ensureColumn('reservations', 'fulfilled_at', 'TEXT')
  ensureColumn('reservations', 'cancelled_at', 'TEXT')

  seedMasterData()
  seed()

  function seedMasterData(): void {
    const branchCount = get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM branches')
    if (!branchCount || Number(branchCount.count) === 0) {
      const branches: [string, string, string, string, string, string][] = [
        ['BR-MAIN', '总馆', '城市中心馆区', '010-60000001', '周一至周日 9:00-21:00', 'active'],
        ['BR-CHILD', '少儿分馆', '青少年活动中心', '010-60000002', '周一至周日 9:00-18:00', 'active'],
        ['BR-GOV', '政务分馆', '政务服务中心', '010-60000003', '工作日 9:00-17:00', 'active'],
      ]
      for (const branch of branches) {
        run(db, 'INSERT INTO branches (id, name, address, phone, opening_hours, status) VALUES (?, ?, ?, ?, ?, ?)', ...branch)
      }
    }

    const typeCount = get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM reader_types')
    if (!typeCount || Number(typeCount.count) === 0) {
      const types: [string, string, number, number, number, number, number, string][] = [
        ['RT-STD', '普通读者', 5, 3, 30, 2, 15, 'active'],
        ['RT-TEACHER', '教师读者', 10, 5, 60, 2, 30, 'active'],
        ['RT-CHILD', '少儿读者', 3, 2, 30, 1, 15, 'active'],
      ]
      for (const type of types) {
        run(
          db,
          'INSERT INTO reader_types (id, name, max_loans, max_reservations, loan_days, max_renews, renew_days, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ...type,
        )
      }
    }
  }

  function seed(): void {
    const count = get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM books')
    if (count && Number(count.count) > 0) return

    const now = new Date().toISOString()
    const books: [string, string, string, string, string, string, number, string, string, number, number, string, string, string, string][] = [
      ['B001', '深入理解计算机系统', 'Randal E. Bryant', '9787111544937', '计算机', '机械工业出版社', 2016, '第3版', '中文', 737, 139, '计算机系统经典教材', '计算机,系统,CSAPP', 'active', now],
      ['B002', '人工智能：一种现代的方法', 'Stuart Russell', '9787115362223', '计算机', '人民邮电出版社', 2013, '第3版', '中文', 918, 128, '人工智能经典教材', '人工智能,机器学习', 'active', now],
      ['B003', '中国图书馆分类法', '国家图书馆', '9787501345670', '图书馆学', '国家图书馆出版社', 2010, '第5版', '中文', 1200, 380, '图书馆分类法', '分类法,编目,图书馆', 'active', now],
      ['B004', '百年孤独', '加西亚·马尔克斯', '9787544253994', '文学', '南海出版公司', 2011, '第1版', '中文', 360, 39, '魔幻现实主义文学', '文学,小说,经典', 'active', now],
      ['B005', '政府数字化转型', '李明', '9787300000001', '政务', '清华大学出版社', 2024, '第1版', '中文', 280, 68, '政府数字化转型实践', '政务,数字化,治理', 'active', now],
    ]
    for (const book of books) {
      run(
        db,
        `INSERT INTO books
         (id, title, author, isbn, category, publisher, published_year, edition, language, pages, price, summary, keywords, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ...book,
      )
    }

    const copies: [string, string, string, string, string, string, string, string, string][] = [
      ['C001-1', 'B001', '总馆', 'loaned', 'A区-01-03', 'TP312/B915', 'BC001-1', 'good', now],
      ['C001-2', 'B001', '总馆', 'available', 'A区-01-03', 'TP312/B915', 'BC001-2', 'good', now],
      ['C002-1', 'B002', '总馆', 'loaned', 'A区-02-01', 'TP18/R911', 'BC002-1', 'good', now],
      ['C002-2', 'B002', '少儿分馆', 'available', 'B区-01-02', 'TP18/R911', 'BC002-2', 'good', now],
      ['C003-1', 'B003', '总馆', 'loaned', 'C区-03-01', 'G254.1/G932', 'BC003-1', 'good', now],
      ['C003-2', 'B003', '总馆', 'available', 'C区-03-01', 'G254.1/G932', 'BC003-2', 'good', now],
      ['C004-1', 'B004', '总馆', 'loaned', 'D区-01-01', 'I775.45/M245', 'BC004-1', 'good', now],
      ['C004-2', 'B004', '少儿分馆', 'available', 'B区-02-01', 'I775.45/M245', 'BC004-2', 'good', now],
      ['C005-1', 'B005', '政务分馆', 'available', 'E区-01-01', 'D63/L212', 'BC005-1', 'good', now],
    ]
    for (const copy of copies) {
      run(
        db,
        'INSERT INTO copies (id, book_id, branch, status, location, call_number, barcode, condition, acquired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ...copy,
      )
    }

    const readers: [string, string, string, number, string, string, string, string, string][] = [
      ['R001', '张伟', 'active', 5, '13800000001', 'RT-STD', 'zhangwei@example.com', now, '2027-12-31T00:00:00.000Z'],
      ['R002', '李娜', 'active', 5, '13900000002', 'RT-STD', 'lina@example.com', now, '2027-12-31T00:00:00.000Z'],
      ['R003', '王芳', 'active', 3, '13700000003', 'RT-CHILD', 'wangfang@example.com', now, '2027-12-31T00:00:00.000Z'],
      ['R004', '停用读者', 'suspended', 5, '13600000004', 'RT-STD', 'suspended@example.com', now, '2026-12-31T00:00:00.000Z'],
    ]
    for (const reader of readers) {
      run(
        db,
        'INSERT INTO readers (id, name, status, max_loans, phone, reader_type_id, email, registered_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ...reader,
      )
    }

    const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString()
    const loans: [string, string, string, string, string | null, string, number, string][] = [
      ['L001', 'C001-1', 'R003', iso(12), null, iso(-18), 0, 'active'],
      ['L002', 'C002-1', 'R003', iso(20), null, iso(-10), 0, 'active'],
      ['L003', 'C003-1', 'R003', iso(5), null, iso(-25), 0, 'active'],
      ['L004', 'C004-1', 'R002', iso(-9), null, iso(-39), 0, 'overdue'],
      ['L005', 'C004-2', 'R001', iso(-30), iso(-20), iso(-60), 0, 'returned'],
    ]
    for (const loan of loans) {
      run(
        db,
        'INSERT INTO loans (id, copy_id, reader_id, due_at, returned_at, borrowed_at, renewed_count, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ...loan,
      )
    }

    const fines: [string, string, string, number, string, string, string][] = [
      ['F001', 'L004', 'R002', 5, '《百年孤独》逾期 10 天', 'unpaid', now],
    ]
    for (const fine of fines) {
      run(db, 'INSERT INTO fines (id, loan_id, reader_id, amount, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ...fine)
    }

    const notifications: [string, string, string, string, string, string, string, string, string | null][] = [
      ['N001', 'R002', 'overdue', 'sms', '逾期提醒', '您借阅的《百年孤独》已逾期 10 天，请尽快归还。', 'queued', now, null],
    ]
    for (const notification of notifications) {
      run(
        db,
        'INSERT INTO notifications (id, reader_id, type, channel, subject, body, status, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ...notification,
      )
    }

    const vendors: [string, string, string, string, string][] = [
      ['V001', '新华书店', '王经理', '010-80000001', 'active'],
      ['V002', '人天书店', '李经理', '010-80000002', 'active'],
    ]
    for (const vendor of vendors) {
      run(db, 'INSERT INTO vendors (id, name, contact, phone, status) VALUES (?, ?, ?, ?, ?)', ...vendor)
    }

    run(
      db,
      'INSERT INTO serials (id, title, issn, vendor_id, status, start_date, end_date, next_issue_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      'SER-001',
      '图书馆论坛',
      '1002-1167',
      'V001',
      'active',
      '2026-01-01',
      '2026-12-31',
      '2026-12-01',
    )
    run(
      db,
      'INSERT INTO electronic_resources (id, title, provider, url, license_status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      'ER-001',
      '中国知网',
      'CNKI',
      'https://www.cnki.net',
      'active',
      now,
    )
    run(
      db,
      'INSERT INTO events (id, title, starts_at, ends_at, location, capacity, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'EV-001',
      '周末亲子阅读会',
      iso(3),
      iso(3),
      '少儿分馆活动区',
      30,
      'open',
    )
  }

  function bookRow(row: Row): BookView {
    return {
      id: str(row, 'id'),
      title: str(row, 'title'),
      author: str(row, 'author'),
      isbn: str(row, 'isbn'),
      category: str(row, 'category'),
      publisher: str(row, 'publisher'),
      publishedYear: num(row, 'published_year'),
      edition: str(row, 'edition'),
      language: str(row, 'language'),
      pages: num(row, 'pages'),
      price: num(row, 'price'),
      summary: str(row, 'summary'),
      keywords: str(row, 'keywords'),
      status: str(row, 'status'),
      totalCopies: num(row, 'totalCopies'),
      availableCopies: num(row, 'availableCopies'),
    }
  }

  function listBooks(): BookView[] {
    const rows = all<Row>(
      db,
      `SELECT b.*,
              COUNT(c.id) AS totalCopies,
              SUM(CASE WHEN c.status = 'available' THEN 1 ELSE 0 END) AS availableCopies
       FROM books b LEFT JOIN copies c ON c.book_id = b.id
       GROUP BY b.id ORDER BY b.id`,
    )
    return rows.map(bookRow)
  }

  function searchBooks(query: string): BookView[] {
    const like = `%${query.trim()}%`
    const rows = all<Row>(
      db,
      `SELECT b.*,
              COUNT(c.id) AS totalCopies,
              SUM(CASE WHEN c.status = 'available' THEN 1 ELSE 0 END) AS availableCopies
       FROM books b LEFT JOIN copies c ON c.book_id = b.id
       WHERE b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ? OR b.category LIKE ? OR b.keywords LIKE ?
       GROUP BY b.id ORDER BY b.id`,
      like,
      like,
      like,
      like,
      like,
    )
    return rows.map(bookRow)
  }

  function getBook(bookId: string): BookView | undefined {
    const rows = all<Row>(
      db,
      `SELECT b.*,
              COUNT(c.id) AS totalCopies,
              SUM(CASE WHEN c.status = 'available' THEN 1 ELSE 0 END) AS availableCopies
       FROM books b LEFT JOIN copies c ON c.book_id = b.id
       WHERE b.id = ? GROUP BY b.id`,
      bookId,
    )
    return rows[0] ? bookRow(rows[0]) : undefined
  }

  function listCopies(bookId: string): CopyView[] {
    return all<Row>(
      db,
      `SELECT c.*, b.title AS book_title
       FROM copies c JOIN books b ON b.id = c.book_id
       WHERE c.book_id = ? ORDER BY c.id`,
      bookId,
    ).map((row) => ({
      id: str(row, 'id'),
      bookId: str(row, 'book_id'),
      bookTitle: str(row, 'book_title'),
      barcode: str(row, 'barcode'),
      branch: str(row, 'branch'),
      location: str(row, 'location'),
      callNumber: str(row, 'call_number'),
      status: str(row, 'status'),
      condition: str(row, 'condition'),
      acquiredAt: str(row, 'acquired_at'),
    }))
  }

  function readerView(row: Row): ReaderView {
    const id = str(row, 'id')
    const activeLoans = get<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM loans WHERE reader_id = ? AND returned_at IS NULL',
      id,
    )
    const activeReservations = get<{ count: number }>(
      db,
      "SELECT COUNT(*) AS count FROM reservations WHERE reader_id = ? AND status = 'active'",
      id,
    )
    const overdue = get<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count FROM loans
       WHERE reader_id = ? AND returned_at IS NULL AND due_at < ?`,
      id,
      new Date().toISOString(),
    )
    return {
      id,
      name: str(row, 'name'),
      status: str(row, 'status'),
      readerTypeId: str(row, 'reader_type_id'),
      readerTypeName: str(row, 'reader_type_name'),
      maxLoans: num(row, 'max_loans'),
      maxReservations: num(row, 'max_reservations'),
      loanDays: num(row, 'loan_days'),
      maxRenews: num(row, 'max_renews'),
      renewDays: num(row, 'renew_days'),
      phoneMasked: maskPhone(str(row, 'phone')),
      emailMasked: maskEmail(str(row, 'email')),
      registeredAt: str(row, 'registered_at'),
      expiresAt: str(row, 'expires_at'),
      activeLoans: Number(activeLoans?.count ?? 0),
      activeReservations: Number(activeReservations?.count ?? 0),
      hasOverdue: Number(overdue?.count ?? 0) > 0,
    }
  }

  const readerSelect = `SELECT r.*, t.name AS reader_type_name,
      COALESCE(t.max_reservations, 3) AS max_reservations,
      COALESCE(t.loan_days, 30) AS loan_days,
      COALESCE(t.max_renews, 2) AS max_renews,
      COALESCE(t.renew_days, 15) AS renew_days
    FROM readers r LEFT JOIN reader_types t ON t.id = r.reader_type_id`

  function listReaders(): ReaderView[] {
    return all<Row>(db, `${readerSelect} ORDER BY r.id`).map(readerView)
  }

  function getReader(readerId: string): ReaderView | undefined {
    const row = get<Row>(db, `${readerSelect} WHERE r.id = ?`, readerId)
    return row ? readerView(row) : undefined
  }

  function loanRow(row: Row): LoanView {
    const due = new Date(str(row, 'due_at')).getTime()
    const returned = row.returned_at ? str(row, 'returned_at') : null
    const overdueDays = returned ? 0 : Math.max(0, Math.ceil((Date.now() - due) / 86_400_000))
    return {
      id: str(row, 'id'),
      copyId: str(row, 'copy_id'),
      bookId: str(row, 'book_id'),
      bookTitle: str(row, 'book_title'),
      readerId: str(row, 'reader_id'),
      readerName: str(row, 'reader_name'),
      borrowedAt: str(row, 'borrowed_at'),
      dueAt: str(row, 'due_at'),
      returnedAt: returned,
      renewedCount: num(row, 'renewed_count'),
      status: str(row, 'status'),
      overdueDays,
      fine: Math.min(20, overdueDays * 0.5),
    }
  }

  const loanSelect = `SELECT l.*, c.book_id AS book_id, b.title AS book_title, r.name AS reader_name
    FROM loans l
    JOIN copies c ON c.id = l.copy_id
    JOIN books b ON b.id = c.book_id
    JOIN readers r ON r.id = l.reader_id`

  function listLoans(readerId?: string): LoanView[] {
    const rows = readerId
      ? all<Row>(db, `${loanSelect} WHERE l.reader_id = ? ORDER BY l.due_at ASC`, readerId)
      : all<Row>(db, `${loanSelect} ORDER BY l.due_at ASC`)
    return rows.map(loanRow)
  }

  function getLoan(loanId: string): LoanView | undefined {
    const row = get<Row>(db, `${loanSelect} WHERE l.id = ?`, loanId)
    return row ? loanRow(row) : undefined
  }

  function listOverdueLoans(): LoanView[] {
    return listLoans().filter((loan) => loan.returnedAt === null && loan.overdueDays > 0)
  }

  function borrowBook(bookId: string, readerId: string, approvedBy?: string, branch?: string): LoanView {
    const book = getBook(bookId)
    if (!book) throw new Error('图书不存在')
    if (book.status !== 'active') throw new Error('图书已停用或下架')
    const reader = getReader(readerId)
    if (!reader) throw new Error('读者不存在')
    if (reader.status !== 'active') throw new Error('读者证状态异常，不能借阅')
    if (reader.expiresAt && new Date(reader.expiresAt).getTime() < Date.now()) {
      throw new Error('读者证已过期')
    }
    if (reader.hasOverdue) throw new Error('读者存在逾期未还图书，请先归还')
    if (reader.activeLoans >= reader.maxLoans) throw new Error(`借阅数量已达上限（${reader.maxLoans} 册）`)

    const copyRows = branch
      ? all<Row>(db, "SELECT * FROM copies WHERE book_id = ? AND status = 'available' AND branch = ? ORDER BY id LIMIT 1", bookId, branch)
      : all<Row>(db, "SELECT * FROM copies WHERE book_id = ? AND status = 'available' ORDER BY id LIMIT 1", bookId)
    const copy = copyRows[0]
    if (!copy) throw new Error('当前没有可借副本')

    const id = `L-${randomUUID().slice(0, 8)}`
    const now = new Date()
    const due = new Date(now.getTime() + reader.loanDays * 86_400_000)
    run(
      db,
      `INSERT INTO loans (id, copy_id, reader_id, due_at, returned_at, borrowed_at, renewed_count, status)
       VALUES (?, ?, ?, ?, NULL, ?, 0, 'active')`,
      id,
      str(copy, 'id'),
      readerId,
      due.toISOString(),
      now.toISOString(),
    )
    run(db, "UPDATE copies SET status = 'loaned' WHERE id = ?", str(copy, 'id'))
    return getLoan(id)!
  }

  function calculateFine(loan: LoanView): number {
    if (loan.returnedAt) return 0
    return Math.min(20, loan.overdueDays * 0.5)
  }

  function returnLoan(loanId: string): { loan: LoanView; fine?: FineView } {
    const loan = getLoan(loanId)
    if (!loan) throw new Error('借阅记录不存在')
    if (loan.returnedAt) throw new Error('该借阅已归还')
    const returnedAt = new Date().toISOString()
    const fineAmount = calculateFine(loan)
    run(
      db,
      "UPDATE loans SET returned_at = ?, status = 'returned' WHERE id = ?",
      returnedAt,
      loanId,
    )
    run(db, "UPDATE copies SET status = 'available' WHERE id = ?", loan.copyId)

    let fine: FineView | undefined
    if (fineAmount > 0) {
      fine = createFine({
        loanId,
        readerId: loan.readerId,
        amount: fineAmount,
        reason: `《${loan.bookTitle}》逾期 ${loan.overdueDays} 天`,
      })
    }

    const nextReservation = get<Row>(
      db,
      "SELECT * FROM reservations WHERE book_id = ? AND status = 'active' ORDER BY queue_position ASC, created_at ASC LIMIT 1",
      loan.bookId,
    )
    if (nextReservation) {
      run(
        db,
        "UPDATE reservations SET status = 'ready', notified_at = ? WHERE id = ?",
        returnedAt,
        str(nextReservation, 'id'),
      )
      createNotification({
        readerId: str(nextReservation, 'reader_id'),
        type: 'reservation_ready',
        channel: 'sms',
        subject: '预约到书提醒',
        body: `您预约的《${loan.bookTitle}》已到馆，请在 3 天内取书。`,
      })
    }

    return { loan: getLoan(loanId)!, ...(fine ? { fine } : {}) }
  }

  function renewLoan(loanId: string): LoanView {
    const loan = getLoan(loanId)
    if (!loan) throw new Error('借阅记录不存在')
    if (loan.returnedAt) throw new Error('该借阅已归还')
    if (loan.overdueDays > 0) throw new Error('逾期图书不能续借，请先归还')
    const reader = getReader(loan.readerId)
    if (!reader) throw new Error('读者不存在')
    if (loan.renewedCount >= reader.maxRenews) throw new Error(`续借次数已达上限（${reader.maxRenews} 次）`)
    const queued = listReservations().some(
      (reservation) =>
        reservation.bookId === loan.bookId
        && reservation.readerId !== loan.readerId
        && (reservation.status === 'active' || reservation.status === 'ready'),
    )
    if (queued) throw new Error('该书已有其他读者预约，不能续借')
    const base = Math.max(Date.now(), new Date(loan.dueAt).getTime())
    const nextDue = new Date(base + reader.renewDays * 86_400_000).toISOString()
    run(
      db,
      'UPDATE loans SET due_at = ?, renewed_count = renewed_count + 1, status = ? WHERE id = ?',
      nextDue,
      'active',
      loanId,
    )
    return getLoan(loanId)!
  }

  const reservationSelect = `SELECT r.*, b.title AS book_title, u.name AS reader_name
    FROM reservations r
    JOIN books b ON b.id = r.book_id
    JOIN readers u ON u.id = r.reader_id`

  function reservationRow(row: Row): ReservationView {
    return {
      id: str(row, 'id'),
      bookId: str(row, 'book_id'),
      bookTitle: str(row, 'book_title'),
      readerId: str(row, 'reader_id'),
      readerName: str(row, 'reader_name'),
      pickupBranch: str(row, 'pickup_branch'),
      queuePosition: num(row, 'queue_position'),
      status: str(row, 'status'),
      createdAt: str(row, 'created_at'),
      expiresAt: str(row, 'expires_at'),
    }
  }

  function getReservation(id: string): ReservationView | undefined {
    const row = get<Row>(db, `${reservationSelect} WHERE r.id = ?`, id)
    return row ? reservationRow(row) : undefined
  }

  function createReservation(
    bookId: string,
    readerId: string,
    approvedBy?: string,
    pickupBranch = '总馆',
  ): ReservationView {
    const book = getBook(bookId)
    if (!book) throw new Error('图书不存在')
    const reader = getReader(readerId)
    if (!reader) throw new Error('读者不存在')
    const id = `RSV-${randomUUID().slice(0, 8)}`
    const now = new Date()
    const expires = new Date(now.getTime() + 3 * 86_400_000)
    const ahead = get<{ count: number }>(
      db,
      "SELECT COUNT(*) AS count FROM reservations WHERE book_id = ? AND status IN ('active', 'ready')",
      bookId,
    )
    run(
      db,
      `INSERT INTO reservations
       (id, book_id, reader_id, status, created_at, expires_at, approved_by, pickup_branch, queue_position)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      id,
      bookId,
      readerId,
      now.toISOString(),
      expires.toISOString(),
      approvedBy ?? null,
      pickupBranch,
      Number(ahead?.count ?? 0) + 1,
    )
    return getReservation(id)!
  }

  function listReservations(readerId?: string): ReservationView[] {
    const rows = readerId
      ? all<Row>(db, `${reservationSelect} WHERE r.reader_id = ? ORDER BY r.created_at DESC`, readerId)
      : all<Row>(db, `${reservationSelect} ORDER BY r.created_at DESC`)
    return rows.map(reservationRow)
  }

  function cancelReservation(id: string): ReservationView {
    const reservation = getReservation(id)
    if (!reservation) throw new Error('预约不存在')
    if (reservation.status !== 'active' && reservation.status !== 'ready') {
      throw new Error('该预约当前不能取消')
    }
    run(
      db,
      "UPDATE reservations SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
      new Date().toISOString(),
      id,
    )
    return getReservation(id)!
  }

  function fulfillReservation(id: string, approvedBy?: string): { reservation: ReservationView; loan: LoanView } {
    const reservation = getReservation(id)
    if (!reservation) throw new Error('预约不存在')
    if (reservation.status !== 'active' && reservation.status !== 'ready') {
      throw new Error('该预约当前不能取书')
    }
    const loan = borrowBook(reservation.bookId, reservation.readerId, approvedBy)
    run(
      db,
      "UPDATE reservations SET status = 'fulfilled', fulfilled_at = ? WHERE id = ?",
      new Date().toISOString(),
      id,
    )
    return { reservation: getReservation(id)!, loan }
  }

  const fineSelect = `SELECT f.*, r.name AS reader_name
    FROM fines f JOIN readers r ON r.id = f.reader_id`

  function fineRow(row: Row): FineView {
    return {
      id: str(row, 'id'),
      loanId: str(row, 'loan_id'),
      readerId: str(row, 'reader_id'),
      readerName: str(row, 'reader_name'),
      amount: num(row, 'amount'),
      reason: str(row, 'reason'),
      status: str(row, 'status'),
      createdAt: str(row, 'created_at'),
      ...(row.paid_at ? { paidAt: str(row, 'paid_at') } : {}),
      ...(row.waived_by ? { waivedBy: str(row, 'waived_by') } : {}),
      ...(row.payment_ref ? { paymentRef: str(row, 'payment_ref') } : {}),
    }
  }

  function createFine(input: { loanId: string; readerId: string; amount: number; reason: string }): FineView {
    const id = `F-${randomUUID().slice(0, 8)}`
    const createdAt = new Date().toISOString()
    run(
      db,
      'INSERT INTO fines (id, loan_id, reader_id, amount, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      input.loanId,
      input.readerId,
      input.amount,
      input.reason,
      'unpaid',
      createdAt,
    )
    return getFine(id)!
  }

  function getFine(id: string): FineView | undefined {
    const row = get<Row>(db, `${fineSelect} WHERE f.id = ?`, id)
    return row ? fineRow(row) : undefined
  }

  function listFines(readerId?: string): FineView[] {
    const rows = readerId
      ? all<Row>(db, `${fineSelect} WHERE f.reader_id = ? ORDER BY f.created_at DESC`, readerId)
      : all<Row>(db, `${fineSelect} ORDER BY f.created_at DESC`)
    return rows.map(fineRow)
  }

  function payFine(id: string, paymentRef?: string): FineView {
    const fine = getFine(id)
    if (!fine) throw new Error('罚款记录不存在')
    if (fine.status !== 'unpaid') throw new Error('该罚款当前不能支付')
    run(
      db,
      "UPDATE fines SET status = 'paid', paid_at = ?, payment_ref = ? WHERE id = ?",
      new Date().toISOString(),
      paymentRef ?? `PAY-${randomUUID().slice(0, 8)}`,
      id,
    )
    return getFine(id)!
  }

  function waiveFine(id: string, waivedBy: string): FineView {
    const fine = getFine(id)
    if (!fine) throw new Error('罚款记录不存在')
    if (fine.status !== 'unpaid') throw new Error('该罚款当前不能减免')
    run(db, "UPDATE fines SET status = 'waived', waived_by = ? WHERE id = ?", waivedBy, id)
    return getFine(id)!
  }

  const notificationSelect = `SELECT n.*, r.name AS reader_name
    FROM notifications n JOIN readers r ON r.id = n.reader_id`

  function notificationRow(row: Row): NotificationView {
    return {
      id: str(row, 'id'),
      readerId: str(row, 'reader_id'),
      readerName: str(row, 'reader_name'),
      type: str(row, 'type'),
      channel: str(row, 'channel'),
      subject: str(row, 'subject'),
      body: str(row, 'body'),
      status: str(row, 'status'),
      createdAt: str(row, 'created_at'),
      ...(row.sent_at ? { sentAt: str(row, 'sent_at') } : {}),
    }
  }

  function getNotification(id: string): NotificationView | undefined {
    const row = get<Row>(db, `${notificationSelect} WHERE n.id = ?`, id)
    return row ? notificationRow(row) : undefined
  }

  function createNotification(input: {
    readerId: string
    type: string
    channel: string
    subject: string
    body: string
  }): NotificationView {
    const id = `N-${randomUUID().slice(0, 8)}`
    const createdAt = new Date().toISOString()
    run(
      db,
      `INSERT INTO notifications (id, reader_id, type, channel, subject, body, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
      id,
      input.readerId,
      input.type,
      input.channel,
      input.subject,
      input.body,
      createdAt,
    )
    return getNotification(id)!
  }

  function listNotifications(readerId?: string): NotificationView[] {
    const rows = readerId
      ? all<Row>(db, `${notificationSelect} WHERE n.reader_id = ? ORDER BY n.created_at DESC`, readerId)
      : all<Row>(db, `${notificationSelect} ORDER BY n.created_at DESC`)
    return rows.map(notificationRow)
  }

  function markNotificationSent(id: string): NotificationView {
    const notification = getNotification(id)
    if (!notification) throw new Error('通知不存在')
    run(
      db,
      "UPDATE notifications SET status = 'sent', sent_at = ? WHERE id = ?",
      new Date().toISOString(),
      id,
    )
    return getNotification(id)!
  }

  function createApproval(input: CreateApprovalInput): ApprovalRequest {
    const id = `APR-${randomUUID().slice(0, 8)}`
    const createdAt = new Date().toISOString()
    run(
      db,
      `INSERT INTO approvals
       (id, run_id, tool_call_id, policy_id, tool, payload, requested_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      input.runId,
      input.toolCallId ?? null,
      input.policyId,
      input.tool,
      JSON.stringify(input.payload),
      input.requestedBy,
      createdAt,
    )
    return {
      id,
      runId: input.runId,
      toolCallId: input.toolCallId,
      policyId: input.policyId,
      tool: input.tool,
      payload: input.payload,
      requestedBy: input.requestedBy,
      status: 'pending',
      createdAt,
    }
  }

  function approvalRow(row: Row): ApprovalRequest {
    return {
      id: str(row, 'id'),
      runId: str(row, 'run_id'),
      toolCallId: row.tool_call_id ? str(row, 'tool_call_id') : undefined,
      policyId: str(row, 'policy_id'),
      tool: str(row, 'tool'),
      payload: JSON.parse(str(row, 'payload')) as Record<string, unknown>,
      requestedBy: str(row, 'requested_by'),
      status: str(row, 'status') as ApprovalRequest['status'],
      createdAt: str(row, 'created_at'),
      decidedAt: row.decided_at ? str(row, 'decided_at') : undefined,
      decidedBy: row.decided_by ? str(row, 'decided_by') : undefined,
      reason: row.reason ? str(row, 'reason') : undefined,
    }
  }

  function listApprovals(status?: string): ApprovalRequest[] {
    const rows = status
      ? all<Row>(db, 'SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC', status)
      : all<Row>(db, 'SELECT * FROM approvals ORDER BY created_at DESC')
    return rows.map(approvalRow)
  }

  function getApproval(id: string): ApprovalRequest | undefined {
    const row = get<Row>(db, 'SELECT * FROM approvals WHERE id = ?', id)
    return row ? approvalRow(row) : undefined
  }

  function decideApproval(
    id: string,
    status: 'approved' | 'rejected',
    decidedBy: string,
    reason?: string,
  ): ApprovalRequest {
    const approval = getApproval(id)
    if (!approval) throw new Error('审批不存在')
    if (approval.status !== 'pending') throw new Error('该审批已处理')
    run(
      db,
      'UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, reason = ? WHERE id = ?',
      status,
      new Date().toISOString(),
      decidedBy,
      reason ?? null,
      id,
    )
    return getApproval(id)!
  }

  function recordAudit(event: Omit<AuditEvent, 'id' | 'createdAt'>): AuditEvent {
    const id = `AUD-${randomUUID().slice(0, 8)}`
    const createdAt = new Date().toISOString()
    run(
      db,
      `INSERT INTO audit_events
       (id, run_id, trace_id, actor, agent_id, tool, input_hash, policy_decision, approval_id, result, created_at, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      event.runId,
      event.traceId,
      event.actor,
      event.agentId,
      event.tool,
      event.inputHash,
      event.policyDecision,
      event.approvalId ?? null,
      event.result,
      createdAt,
      event.details ? JSON.stringify(event.details) : null,
    )
    return { ...event, id, createdAt }
  }

  function listAudit(runId?: string): AuditEvent[] {
    const rows = runId
      ? all<Row>(db, 'SELECT * FROM audit_events WHERE run_id = ? ORDER BY created_at ASC', runId)
      : all<Row>(db, 'SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 100')
    return rows.map((row) => ({
      id: str(row, 'id'),
      runId: str(row, 'run_id'),
      traceId: str(row, 'trace_id'),
      actor: str(row, 'actor'),
      agentId: str(row, 'agent_id'),
      tool: str(row, 'tool'),
      inputHash: str(row, 'input_hash'),
      policyDecision: str(row, 'policy_decision'),
      approvalId: row.approval_id ? str(row, 'approval_id') : undefined,
      result: str(row, 'result'),
      createdAt: str(row, 'created_at'),
      details: row.details ? (JSON.parse(str(row, 'details')) as Record<string, unknown>) : undefined,
    }))
  }

  function chatConversationRow(row: Row): ChatConversationView {
    return {
      id: str(row, 'id'),
      ownerUserId: str(row, 'owner_user_id'),
      ownerUsername: str(row, 'owner_username'),
      ownerRole: str(row, 'owner_role') as UserRole,
      ...(row.reader_id ? { readerId: str(row, 'reader_id') } : {}),
      piConversationId: str(row, 'pi_conversation_id'),
      createdAt: str(row, 'created_at'),
      updatedAt: str(row, 'updated_at'),
    }
  }

  function createChatConversation(input: CreateChatConversationInput): ChatConversationView {
    const now = new Date().toISOString()
    run(
      db,
      `INSERT INTO chat_conversations
       (id, owner_user_id, owner_username, owner_role, reader_id, pi_conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.ownerUserId,
      input.ownerUsername,
      input.ownerRole,
      input.readerId ?? null,
      input.piConversationId,
      now,
      now,
    )
    return getChatConversation(input.id)!
  }

  function getChatConversation(id: string): ChatConversationView | undefined {
    const row = get<Row>(db, 'SELECT * FROM chat_conversations WHERE id = ?', id)
    return row ? chatConversationRow(row) : undefined
  }

  function setChatConversationPiId(id: string, piConversationId: string): void {
    run(
      db,
      'UPDATE chat_conversations SET pi_conversation_id = ?, updated_at = ? WHERE id = ?',
      piConversationId,
      new Date().toISOString(),
      id,
    )
  }

  function touchChatConversation(id: string): void {
    run(db, 'UPDATE chat_conversations SET updated_at = ? WHERE id = ?', new Date().toISOString(), id)
  }

  function branchRow(row: Row): BranchView {
    return {
      id: str(row, 'id'),
      name: str(row, 'name'),
      address: str(row, 'address'),
      phone: str(row, 'phone'),
      openingHours: str(row, 'opening_hours'),
      status: str(row, 'status'),
    }
  }

  function listBranches(): BranchView[] {
    return all<Row>(db, 'SELECT * FROM branches ORDER BY id').map(branchRow)
  }

  function getBranch(id: string): BranchView | undefined {
    const row = get<Row>(db, 'SELECT * FROM branches WHERE id = ?', id)
    return row ? branchRow(row) : undefined
  }

  function readerTypeRow(row: Row): ReaderTypeView {
    return {
      id: str(row, 'id'),
      name: str(row, 'name'),
      maxLoans: num(row, 'max_loans'),
      maxReservations: num(row, 'max_reservations'),
      loanDays: num(row, 'loan_days'),
      maxRenews: num(row, 'max_renews'),
      renewDays: num(row, 'renew_days'),
      status: str(row, 'status'),
    }
  }

  function listReaderTypes(): ReaderTypeView[] {
    return all<Row>(db, 'SELECT * FROM reader_types ORDER BY id').map(readerTypeRow)
  }

  function getReaderType(id: string): ReaderTypeView | undefined {
    const row = get<Row>(db, 'SELECT * FROM reader_types WHERE id = ?', id)
    return row ? readerTypeRow(row) : undefined
  }

  function createBook(input: {
    id?: string
    title: string
    author: string
    isbn: string
    category: string
    publisher?: string
    publishedYear?: number
    edition?: string
    language?: string
    pages?: number
    price?: number
    summary?: string
    keywords?: string
  }): BookView {
    const id = input.id?.trim() || `B-${randomUUID().slice(0, 8)}`
    const createdAt = new Date().toISOString()
    run(
      db,
      `INSERT INTO books
       (id, title, author, isbn, category, publisher, published_year, edition, language, pages, price, summary, keywords, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      id,
      input.title,
      input.author,
      input.isbn,
      input.category,
      input.publisher ?? '',
      input.publishedYear ?? 0,
      input.edition ?? '',
      input.language ?? '中文',
      input.pages ?? 0,
      input.price ?? 0,
      input.summary ?? '',
      input.keywords ?? '',
      createdAt,
    )
    return getBook(id)!
  }

  function updateBook(
    bookId: string,
    input: Partial<{
      title: string
      author: string
      isbn: string
      category: string
      publisher: string
      publishedYear: number
      edition: string
      language: string
      pages: number
      price: number
      summary: string
      keywords: string
      status: string
    }>,
  ): BookView {
    const current = getBook(bookId)
    if (!current) throw new Error('图书不存在')
    run(
      db,
      `UPDATE books SET
        title = ?, author = ?, isbn = ?, category = ?, publisher = ?,
        published_year = ?, edition = ?, language = ?, pages = ?, price = ?,
        summary = ?, keywords = ?, status = ?
       WHERE id = ?`,
      input.title ?? current.title,
      input.author ?? current.author,
      input.isbn ?? current.isbn,
      input.category ?? current.category,
      input.publisher ?? current.publisher,
      input.publishedYear ?? current.publishedYear,
      input.edition ?? current.edition,
      input.language ?? current.language,
      input.pages ?? current.pages,
      input.price ?? current.price,
      input.summary ?? current.summary,
      input.keywords ?? current.keywords,
      input.status ?? current.status,
      bookId,
    )
    return getBook(bookId)!
  }

  function archiveBook(bookId: string): BookView {
    return updateBook(bookId, { status: 'archived' })
  }

  function createCopy(input: {
    id?: string
    bookId: string
    branch: string
    location?: string
    callNumber?: string
    barcode?: string
    condition?: string
  }): CopyView {
    const book = getBook(input.bookId)
    if (!book) throw new Error('图书不存在')
    const id = input.id?.trim() || `C-${randomUUID().slice(0, 8)}`
    const acquiredAt = new Date().toISOString()
    run(
      db,
      `INSERT INTO copies (id, book_id, branch, status, location, call_number, barcode, condition, acquired_at)
       VALUES (?, ?, ?, 'available', ?, ?, ?, ?, ?)`,
      id,
      input.bookId,
      input.branch,
      input.location ?? '',
      input.callNumber ?? '',
      input.barcode ?? id,
      input.condition ?? 'good',
      acquiredAt,
    )
    return listCopies(input.bookId).find((copy) => copy.id === id)!
  }

  function updateCopyStatus(copyId: string, status: string): CopyView {
    const allowed = new Set(['available', 'loaned', 'reserved', 'damaged', 'lost', 'withdrawn', 'in_transit', 'bindery'])
    if (!allowed.has(status)) throw new Error(`不支持的副本状态：${status}`)
    const row = get<Row>(db, 'SELECT * FROM copies WHERE id = ?', copyId)
    if (!row) throw new Error('副本不存在')
    run(db, 'UPDATE copies SET status = ? WHERE id = ?', status, copyId)
    return listCopies(str(row, 'book_id')).find((copy) => copy.id === copyId)!
  }

  function transferCopy(copyId: string, branch: string, location?: string): CopyView {
    const row = get<Row>(db, 'SELECT * FROM copies WHERE id = ?', copyId)
    if (!row) throw new Error('副本不存在')
    run(
      db,
      "UPDATE copies SET branch = ?, location = ?, status = 'in_transit' WHERE id = ?",
      branch,
      location ?? str(row, 'location'),
      copyId,
    )
    return listCopies(str(row, 'book_id')).find((copy) => copy.id === copyId)!
  }

  function listAllCopies(branch?: string): CopyView[] {
    const rows = branch
      ? all<Row>(
          db,
          `SELECT c.*, b.title AS book_title FROM copies c JOIN books b ON b.id = c.book_id WHERE c.branch = ? ORDER BY c.id`,
          branch,
        )
      : all<Row>(
          db,
          `SELECT c.*, b.title AS book_title FROM copies c JOIN books b ON b.id = c.book_id ORDER BY c.id`,
        )
    return rows.map((row) => ({
      id: str(row, 'id'),
      bookId: str(row, 'book_id'),
      bookTitle: str(row, 'book_title'),
      barcode: str(row, 'barcode'),
      branch: str(row, 'branch'),
      location: str(row, 'location'),
      callNumber: str(row, 'call_number'),
      status: str(row, 'status'),
      condition: str(row, 'condition'),
      acquiredAt: str(row, 'acquired_at'),
    }))
  }

  function createReader(input: {
    name: string
    readerTypeId?: string
    phone: string
    email?: string
    expiresAt?: string
  }): ReaderView {
    const type = getReaderType(input.readerTypeId ?? 'RT-STD')
    if (!type) throw new Error('读者类型不存在')
    const id = `R-${randomUUID().slice(0, 8)}`
    const registeredAt = new Date().toISOString()
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 365 * 86_400_000).toISOString()
    run(
      db,
      `INSERT INTO readers
       (id, name, status, max_loans, phone, reader_type_id, email, registered_at, expires_at)
       VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      type.maxLoans,
      input.phone,
      type.id,
      input.email ?? '',
      registeredAt,
      expiresAt,
    )
    return getReader(id)!
  }

  function updateReader(
    readerId: string,
    input: Partial<{ name: string; readerTypeId: string; phone: string; email: string; expiresAt: string }>,
  ): ReaderView {
    const current = getReader(readerId)
    if (!current) throw new Error('读者不存在')
    const raw = get<Row>(db, 'SELECT phone, email FROM readers WHERE id = ?', readerId)!
    const type = input.readerTypeId ? getReaderType(input.readerTypeId) : undefined
    if (input.readerTypeId && !type) throw new Error('读者类型不存在')
    run(
      db,
      'UPDATE readers SET name = ?, reader_type_id = ?, max_loans = ?, phone = ?, email = ?, expires_at = ? WHERE id = ?',
      input.name ?? current.name,
      input.readerTypeId ?? current.readerTypeId,
      type ? type.maxLoans : current.maxLoans,
      input.phone ?? str(raw, 'phone'),
      input.email ?? str(raw, 'email'),
      input.expiresAt ?? current.expiresAt,
      readerId,
    )
    return getReader(readerId)!
  }

  function updateReaderStatus(readerId: string, status: string): ReaderView {
    const allowed = new Set(['active', 'suspended', 'expired', 'lost'])
    if (!allowed.has(status)) throw new Error(`不支持的读者状态：${status}`)
    if (!getReader(readerId)) throw new Error('读者不存在')
    run(db, 'UPDATE readers SET status = ? WHERE id = ?', status, readerId)
    return getReader(readerId)!
  }

  function vendorRow(row: Row): VendorView {
    return {
      id: str(row, 'id'),
      name: str(row, 'name'),
      contact: str(row, 'contact'),
      phone: str(row, 'phone'),
      status: str(row, 'status'),
    }
  }

  function listVendors(): VendorView[] {
    return all<Row>(db, 'SELECT * FROM vendors ORDER BY id').map(vendorRow)
  }

  function createVendor(input: { name: string; contact: string; phone: string }): VendorView {
    const id = `V-${randomUUID().slice(0, 8)}`
    run(db, 'INSERT INTO vendors (id, name, contact, phone, status) VALUES (?, ?, ?, ?, ?)', id, input.name, input.contact, input.phone, 'active')
    const row = get<Row>(db, 'SELECT * FROM vendors WHERE id = ?', id)!
    return vendorRow(row)
  }

  function purchaseRequestRow(row: Row): PurchaseRequestView {
    return {
      id: str(row, 'id'),
      title: str(row, 'title'),
      isbn: str(row, 'isbn'),
      quantity: num(row, 'quantity'),
      estimatedUnitPrice: num(row, 'estimated_unit_price'),
      requestedBy: str(row, 'requested_by'),
      status: str(row, 'status'),
      createdAt: str(row, 'created_at'),
      ...(row.approved_by ? { approvedBy: str(row, 'approved_by') } : {}),
      ...(row.approved_at ? { approvedAt: str(row, 'approved_at') } : {}),
    }
  }

  function createPurchaseRequest(input: {
    title: string
    isbn: string
    quantity: number
    estimatedUnitPrice: number
    requestedBy: string
  }): PurchaseRequestView {
    const id = `PR-${randomUUID().slice(0, 8)}`
    run(
      db,
      `INSERT INTO purchase_requests (id, title, isbn, quantity, estimated_unit_price, requested_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id,
      input.title,
      input.isbn,
      input.quantity,
      input.estimatedUnitPrice,
      input.requestedBy,
      new Date().toISOString(),
    )
    return getPurchaseRequest(id)!
  }

  function getPurchaseRequest(id: string): PurchaseRequestView | undefined {
    const row = get<Row>(db, 'SELECT * FROM purchase_requests WHERE id = ?', id)
    return row ? purchaseRequestRow(row) : undefined
  }

  function listPurchaseRequests(status?: string): PurchaseRequestView[] {
    const rows = status
      ? all<Row>(db, 'SELECT * FROM purchase_requests WHERE status = ? ORDER BY created_at DESC', status)
      : all<Row>(db, 'SELECT * FROM purchase_requests ORDER BY created_at DESC')
    return rows.map(purchaseRequestRow)
  }

  function approvePurchaseRequest(id: string, approvedBy: string): PurchaseRequestView {
    const request = getPurchaseRequest(id)
    if (!request) throw new Error('采购申请不存在')
    if (request.status !== 'pending') throw new Error('该采购申请当前不能批准')
    run(
      db,
      "UPDATE purchase_requests SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?",
      approvedBy,
      new Date().toISOString(),
      id,
    )
    return getPurchaseRequest(id)!
  }

  function orderItems(orderId: string): OrderView['items'] {
    return all<Row>(db, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY id', orderId).map((row) => ({
      id: str(row, 'id'),
      title: str(row, 'title'),
      isbn: str(row, 'isbn'),
      quantity: num(row, 'quantity'),
      unitPrice: num(row, 'unit_price'),
      receivedQuantity: num(row, 'received_quantity'),
    }))
  }

  function orderRow(row: Row): OrderView {
    const vendor = get<Row>(db, 'SELECT name FROM vendors WHERE id = ?', str(row, 'vendor_id'))
    return {
      id: str(row, 'id'),
      vendorId: str(row, 'vendor_id'),
      vendorName: vendor ? str(vendor, 'name') : '',
      status: str(row, 'status'),
      totalAmount: num(row, 'total_amount'),
      createdAt: str(row, 'created_at'),
      ...(row.received_at ? { receivedAt: str(row, 'received_at') } : {}),
      items: orderItems(str(row, 'id')),
    }
  }

  function createOrder(input: {
    vendorId: string
    items: { title: string; isbn: string; quantity: number; unitPrice: number }[]
  }): OrderView {
    const vendor = get<Row>(db, 'SELECT * FROM vendors WHERE id = ?', input.vendorId)
    if (!vendor) throw new Error('供应商不存在')
    if (input.items.length === 0) throw new Error('订单至少需要一个条目')
    const id = `O-${randomUUID().slice(0, 8)}`
    const total = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
    run(
      db,
      'INSERT INTO orders (id, vendor_id, status, total_amount, created_at) VALUES (?, ?, ?, ?, ?)',
      id,
      input.vendorId,
      'created',
      total,
      new Date().toISOString(),
    )
    for (const item of input.items) {
      run(
        db,
        `INSERT INTO order_items (id, order_id, title, isbn, quantity, unit_price, received_quantity)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
        `OI-${randomUUID().slice(0, 8)}`,
        id,
        item.title,
        item.isbn,
        item.quantity,
        item.unitPrice,
      )
    }
    return getOrder(id)!
  }

  function getOrder(id: string): OrderView | undefined {
    const row = get<Row>(db, 'SELECT * FROM orders WHERE id = ?', id)
    return row ? orderRow(row) : undefined
  }

  function listOrders(status?: string): OrderView[] {
    const rows = status
      ? all<Row>(db, 'SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC', status)
      : all<Row>(db, 'SELECT * FROM orders ORDER BY created_at DESC')
    return rows.map(orderRow)
  }

  function receiveOrder(id: string): OrderView {
    const order = getOrder(id)
    if (!order) throw new Error('订单不存在')
    if (order.status === 'received') return order
    if (order.status === 'cancelled') throw new Error('已取消订单不能验收')
    for (const item of order.items) {
      const existing = all<Row>(db, 'SELECT * FROM books WHERE isbn = ? LIMIT 1', item.isbn)[0]
      let bookId = existing ? str(existing, 'id') : ''
      if (!bookId) {
        const book = createBook({
          title: item.title,
          author: '待补充',
          isbn: item.isbn,
          category: '待分类',
          summary: '采购验收自动创建，待编目完善',
        })
        bookId = book.id
      }
      createCopy({ bookId, branch: '总馆', location: '新书区', barcode: `BC-${randomUUID().slice(0, 8)}` })
      run(db, 'UPDATE order_items SET received_quantity = quantity WHERE id = ?', item.id)
    }
    run(db, "UPDATE orders SET status = 'received', received_at = ? WHERE id = ?", new Date().toISOString(), id)
    return getOrder(id)!
  }

  function circulationReport(branch?: string): {
    activeLoans: number
    overdueLoans: number
    returnedToday: number
    topBooks: { bookId: string; title: string; count: number }[]
  } {
    const loans = listLoans().filter((loan) => {
      if (!branch) return true
      const copy = get<Row>(db, 'SELECT branch FROM copies WHERE id = ?', loan.copyId)
      return copy ? str(copy, 'branch') === branch : false
    })
    const today = new Date().toISOString().slice(0, 10)
    const counts = new Map<string, { title: string; count: number }>()
    for (const loan of loans) {
      const entry = counts.get(loan.bookId) ?? { title: loan.bookTitle, count: 0 }
      entry.count += 1
      counts.set(loan.bookId, entry)
    }
    return {
      activeLoans: loans.filter((loan) => !loan.returnedAt).length,
      overdueLoans: loans.filter((loan) => !loan.returnedAt && loan.overdueDays > 0).length,
      returnedToday: loans.filter((loan) => loan.returnedAt?.startsWith(today)).length,
      topBooks: [...counts.entries()]
        .map(([bookId, value]) => ({ bookId, ...value }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
    }
  }

  function collectionReport(): {
    totalBooks: number
    totalCopies: number
    byBranch: { branch: string; total: number; available: number; loaned: number }[]
    byStatus: { status: string; count: number }[]
  } {
    const books = get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM books')!
    const copies = get<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM copies')!
    const byBranch = all<Row>(
      db,
      `SELECT branch,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available,
        SUM(CASE WHEN status = 'loaned' THEN 1 ELSE 0 END) AS loaned
       FROM copies GROUP BY branch ORDER BY branch`,
    ).map((row) => ({
      branch: str(row, 'branch'),
      total: num(row, 'total'),
      available: num(row, 'available'),
      loaned: num(row, 'loaned'),
    }))
    const byStatus = all<Row>(db, 'SELECT status, COUNT(*) AS count FROM copies GROUP BY status ORDER BY status').map(
      (row) => ({ status: str(row, 'status'), count: num(row, 'count') }),
    )
    return { totalBooks: Number(books.count), totalCopies: Number(copies.count), byBranch, byStatus }
  }

  function serialRow(row: Row): SerialView {
    return {
      id: str(row, 'id'),
      title: str(row, 'title'),
      issn: str(row, 'issn'),
      vendorId: str(row, 'vendor_id'),
      status: str(row, 'status'),
      startDate: str(row, 'start_date'),
      endDate: str(row, 'end_date'),
      nextIssueDate: str(row, 'next_issue_date'),
    }
  }

  function listSerials(): SerialView[] {
    return all<Row>(db, 'SELECT * FROM serials ORDER BY id').map(serialRow)
  }

  function createSerial(input: {
    title: string
    issn: string
    vendorId?: string
    startDate?: string
    endDate?: string
  }): SerialView {
    const id = `SER-${randomUUID().slice(0, 8)}`
    const now = new Date()
    run(
      db,
      'INSERT INTO serials (id, title, issn, vendor_id, status, start_date, end_date, next_issue_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.title,
      input.issn,
      input.vendorId ?? null,
      'active',
      input.startDate ?? now.toISOString().slice(0, 10),
      input.endDate ?? new Date(now.getTime() + 365 * 86_400_000).toISOString().slice(0, 10),
      new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10),
    )
    return serialRow(get<Row>(db, 'SELECT * FROM serials WHERE id = ?', id)!)
  }

  function checkinSerial(id: string, nextIssueDate?: string): SerialView {
    const row = get<Row>(db, 'SELECT * FROM serials WHERE id = ?', id)
    if (!row) throw new Error('连续出版物不存在')
    const next = nextIssueDate ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
    run(db, 'UPDATE serials SET next_issue_date = ? WHERE id = ?', next, id)
    return serialRow(get<Row>(db, 'SELECT * FROM serials WHERE id = ?', id)!)
  }

  function resourceRow(row: Row): ElectronicResourceView {
    return {
      id: str(row, 'id'),
      title: str(row, 'title'),
      provider: str(row, 'provider'),
      url: str(row, 'url'),
      licenseStatus: str(row, 'license_status'),
      createdAt: str(row, 'created_at'),
    }
  }

  function listElectronicResources(): ElectronicResourceView[] {
    return all<Row>(db, 'SELECT * FROM electronic_resources ORDER BY id').map(resourceRow)
  }

  function createElectronicResource(input: {
    title: string
    provider: string
    url: string
    licenseStatus?: string
  }): ElectronicResourceView {
    const id = `ER-${randomUUID().slice(0, 8)}`
    run(
      db,
      'INSERT INTO electronic_resources (id, title, provider, url, license_status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      input.title,
      input.provider,
      input.url,
      input.licenseStatus ?? 'active',
      new Date().toISOString(),
    )
    return resourceRow(get<Row>(db, 'SELECT * FROM electronic_resources WHERE id = ?', id)!)
  }

  function illRow(row: Row): IllRequestView {
    return {
      id: str(row, 'id'),
      readerId: str(row, 'reader_id'),
      title: str(row, 'title'),
      status: str(row, 'status'),
      createdAt: str(row, 'created_at'),
      updatedAt: str(row, 'updated_at'),
    }
  }

  function listIllRequests(readerId?: string): IllRequestView[] {
    const rows = readerId
      ? all<Row>(db, 'SELECT * FROM ill_requests WHERE reader_id = ? ORDER BY created_at DESC', readerId)
      : all<Row>(db, 'SELECT * FROM ill_requests ORDER BY created_at DESC')
    return rows.map(illRow)
  }

  function createIllRequest(input: { readerId: string; title: string }): IllRequestView {
    const id = `ILL-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    run(
      db,
      "INSERT INTO ill_requests (id, reader_id, title, status, created_at, updated_at) VALUES (?, ?, ?, 'requested', ?, ?)",
      id,
      input.readerId,
      input.title,
      now,
      now,
    )
    return illRow(get<Row>(db, 'SELECT * FROM ill_requests WHERE id = ?', id)!)
  }

  function updateIllStatus(id: string, status: string): IllRequestView {
    const row = get<Row>(db, 'SELECT * FROM ill_requests WHERE id = ?', id)
    if (!row) throw new Error('馆际互借申请不存在')
    const allowed = new Set(['requested', 'approved', 'shipped', 'received', 'fulfilled', 'cancelled', 'rejected'])
    if (!allowed.has(status)) throw new Error(`不支持的馆际互借状态：${status}`)
    run(db, 'UPDATE ill_requests SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id)
    return illRow(get<Row>(db, 'SELECT * FROM ill_requests WHERE id = ?', id)!)
  }

  function stocktakeRow(row: Row): StocktakeView {
    const id = str(row, 'id')
    const scanned = get<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM stocktake_items WHERE stocktake_id = ? AND scanned = 1',
      id,
    )
    const total = get<{ count: number }>(
      db,
      'SELECT COUNT(*) AS count FROM stocktake_items WHERE stocktake_id = ?',
      id,
    )
    return {
      id,
      branch: str(row, 'branch'),
      status: str(row, 'status'),
      startedAt: str(row, 'started_at'),
      ...(row.completed_at ? { completedAt: str(row, 'completed_at') } : {}),
      scannedCount: Number(scanned?.count ?? 0),
      totalCopies: Number(total?.count ?? 0),
    }
  }

  function listStocktakes(): StocktakeView[] {
    return all<Row>(db, 'SELECT * FROM stocktakes ORDER BY started_at DESC').map(stocktakeRow)
  }

  function startStocktake(branch: string): StocktakeView {
    const id = `ST-${randomUUID().slice(0, 8)}`
    const startedAt = new Date().toISOString()
    run(
      db,
      "INSERT INTO stocktakes (id, branch, status, started_at) VALUES (?, ?, 'open', ?)",
      id,
      branch,
      startedAt,
    )
    const copies = listAllCopies(branch)
    for (const copy of copies) {
      run(
        db,
        "INSERT INTO stocktake_items (id, stocktake_id, copy_id, scanned, result) VALUES (?, ?, ?, 0, 'pending')",
        `STI-${randomUUID().slice(0, 8)}`,
        id,
        copy.id,
      )
    }
    return stocktakeRow(get<Row>(db, 'SELECT * FROM stocktakes WHERE id = ?', id)!)
  }

  function scanStocktake(stocktakeId: string, barcodeOrCopyId: string): StocktakeView {
    const stocktake = get<Row>(db, 'SELECT * FROM stocktakes WHERE id = ?', stocktakeId)
    if (!stocktake) throw new Error('盘点任务不存在')
    if (str(stocktake, 'status') !== 'open') throw new Error('盘点任务已结束')
    const copy = get<Row>(
      db,
      'SELECT * FROM copies WHERE id = ? OR barcode = ? LIMIT 1',
      barcodeOrCopyId,
      barcodeOrCopyId,
    )
    if (!copy) throw new Error('没有找到对应副本')
    const copyId = str(copy, 'id')
    const item = get<Row>(
      db,
      'SELECT * FROM stocktake_items WHERE stocktake_id = ? AND copy_id = ?',
      stocktakeId,
      copyId,
    )
    if (!item) throw new Error('该副本不属于本次盘点范围')
    run(
      db,
      "UPDATE stocktake_items SET scanned = 1, result = 'found' WHERE id = ?",
      str(item, 'id'),
    )
    return stocktakeRow(stocktake)
  }

  function completeStocktake(stocktakeId: string): StocktakeView {
    const stocktake = get<Row>(db, 'SELECT * FROM stocktakes WHERE id = ?', stocktakeId)
    if (!stocktake) throw new Error('盘点任务不存在')
    if (str(stocktake, 'status') !== 'open') throw new Error('盘点任务已结束')
    run(
      db,
      "UPDATE stocktake_items SET result = 'missing' WHERE stocktake_id = ? AND scanned = 0",
      stocktakeId,
    )
    run(
      db,
      "UPDATE stocktakes SET status = 'completed', completed_at = ? WHERE id = ?",
      new Date().toISOString(),
      stocktakeId,
    )
    return stocktakeRow(get<Row>(db, 'SELECT * FROM stocktakes WHERE id = ?', stocktakeId)!)
  }

  function eventRow(row: Row): EventView {
    return {
      id: str(row, 'id'),
      title: str(row, 'title'),
      startsAt: str(row, 'starts_at'),
      endsAt: str(row, 'ends_at'),
      location: str(row, 'location'),
      capacity: num(row, 'capacity'),
      status: str(row, 'status'),
    }
  }

  function listEvents(): EventView[] {
    return all<Row>(db, 'SELECT * FROM events ORDER BY starts_at ASC').map(eventRow)
  }

  function createEvent(input: {
    title: string
    startsAt: string
    endsAt: string
    location: string
    capacity: number
  }): EventView {
    const id = `EV-${randomUUID().slice(0, 8)}`
    run(
      db,
      "INSERT INTO events (id, title, starts_at, ends_at, location, capacity, status) VALUES (?, ?, ?, ?, ?, ?, 'open')",
      id,
      input.title,
      input.startsAt,
      input.endsAt,
      input.location,
      input.capacity,
    )
    return eventRow(get<Row>(db, 'SELECT * FROM events WHERE id = ?', id)!)
  }

  function close(): void {
    db.close()
  }

  return {
    listBooks,
    searchBooks,
    getBook,
    createBook,
    updateBook,
    archiveBook,
    listCopies,
    listAllCopies,
    createCopy,
    updateCopyStatus,
    transferCopy,
    listBranches,
    getBranch,
    listReaders,
    getReader,
    createReader,
    updateReader,
    updateReaderStatus,
    listReaderTypes,
    getReaderType,
    listLoans,
    getLoan,
    listOverdueLoans,
    borrowBook,
    returnLoan,
    renewLoan,
    createReservation,
    listReservations,
    getReservation,
    cancelReservation,
    fulfillReservation,
    listFines,
    getFine,
    payFine,
    waiveFine,
    listNotifications,
    getNotification,
    createNotification,
    markNotificationSent,
    listVendors,
    createVendor,
    listPurchaseRequests,
    getPurchaseRequest,
    createPurchaseRequest,
    approvePurchaseRequest,
    listOrders,
    getOrder,
    createOrder,
    receiveOrder,
    listSerials,
    createSerial,
    checkinSerial,
    listElectronicResources,
    createElectronicResource,
    listIllRequests,
    createIllRequest,
    updateIllStatus,
    listStocktakes,
    startStocktake,
    scanStocktake,
    completeStocktake,
    listEvents,
    createEvent,
    circulationReport,
    collectionReport,
    createApproval,
    listApprovals,
    getApproval,
    decideApproval,
    recordAudit,
    listAudit,
    createChatConversation,
    getChatConversation,
    setChatConversationPiId,
    touchChatConversation,
    close,
  }
}

export type BusinessService = ReturnType<typeof createBusinessService>
