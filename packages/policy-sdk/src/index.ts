import type { PolicyDecision, UserRole } from '../../contracts/src/index.ts'

export interface PolicyActor {
  role: UserRole
  readerId?: string
}

export interface PolicyReader {
  id: string
  status: string
  maxLoans: number
  activeLoans: number
  hasOverdue: boolean
  activeReservations: number
}

export interface PolicyBook {
  id: string
  availableCopies: number
}

export interface ReservationPolicyContext {
  reader: PolicyReader
  book: PolicyBook
}

export type LibraryToolName =
  | 'catalog_search'
  | 'catalog_list'
  | 'book_availability'
  | 'branch_list'
  | 'reader_type_list'
  | 'reader_get'
  | 'reader_search'
  | 'reader_create'
  | 'reader_update'
  | 'reader_update_status'
  | 'book_create'
  | 'book_update'
  | 'book_archive'
  | 'copy_create'
  | 'copy_list'
  | 'copy_update_status'
  | 'copy_transfer'
  | 'loan_list'
  | 'loan_borrow'
  | 'loan_return'
  | 'loan_renew'
  | 'loan_overdue_list'
  | 'reservation_create'
  | 'reservation_list'
  | 'reservation_cancel'
  | 'reservation_fulfill'
  | 'fine_list'
  | 'fine_waive'
  | 'fine_pay'
  | 'notification_list'
  | 'notification_create'
  | 'notification_send'
  | 'vendor_list'
  | 'vendor_create'
  | 'purchase_request_create'
  | 'purchase_request_list'
  | 'purchase_request_approve'
  | 'order_create'
  | 'order_list'
  | 'order_receive'
  | 'report_circulation'
  | 'report_overdue'
  | 'report_collection'
  | 'serial_list'
  | 'serial_create'
  | 'serial_checkin'
  | 'resource_list'
  | 'resource_create'
  | 'ill_list'
  | 'ill_create'
  | 'ill_update_status'
  | 'stocktake_list'
  | 'stocktake_start'
  | 'stocktake_scan'
  | 'stocktake_complete'
  | 'event_list'
  | 'event_create'
  | 'knowledge_search'

function decision(
  value: PolicyDecision['decision'],
  policyId: string,
  reason: string,
  approvalRole?: string,
): PolicyDecision {
  return { decision: value, policyId, reason, ...(approvalRole ? { approvalRole } : {}) }
}

function isStaff(actor: PolicyActor): boolean {
  return actor.role === 'librarian' || actor.role === 'auditor' || actor.role === 'admin'
}

function canManage(actor: PolicyActor): boolean {
  return actor.role === 'librarian' || actor.role === 'admin'
}

const publicReadTools = new Set<LibraryToolName>([
  'catalog_search',
  'catalog_list',
  'book_availability',
  'branch_list',
  'reader_type_list',
  'resource_list',
  'event_list',
  'knowledge_search',
])

const staffReadTools = new Set<LibraryToolName>([
  'reader_search',
  'copy_list',
  'loan_overdue_list',
  'vendor_list',
  'purchase_request_list',
  'order_list',
  'report_circulation',
  'report_overdue',
  'report_collection',
  'serial_list',
  'stocktake_list',
])

const selfReadTools = new Set<LibraryToolName>([
  'reservation_list',
  'fine_list',
  'notification_list',
  'ill_list',
])

const selfServiceTools = new Set<LibraryToolName>([
  'reservation_cancel',
  'loan_borrow',
  'loan_return',
  'loan_renew',
  'fine_pay',
  'ill_create',
])

const manageTools = new Set<LibraryToolName>([
  'reader_create',
  'reader_update',
  'reader_update_status',
  'book_create',
  'book_update',
  'book_archive',
  'copy_create',
  'copy_update_status',
  'copy_transfer',
  'reservation_fulfill',
  'fine_waive',
  'notification_create',
  'notification_send',
  'vendor_create',
  'purchase_request_create',
  'purchase_request_approve',
  'order_create',
  'order_receive',
  'serial_create',
  'serial_checkin',
  'resource_create',
  'ill_update_status',
  'stocktake_start',
  'stocktake_scan',
  'stocktake_complete',
  'event_create',
])

export function canManageReaderData(actor: PolicyActor): PolicyDecision {
  return canManage(actor)
    ? decision('allow', 'library.reader.manage', '馆员或管理员可维护读者资料')
    : decision('deny', 'library.reader.manage', '只有馆员或管理员可维护读者资料')
}

export function canReadCatalog(_actor: PolicyActor): PolicyDecision {
  return decision('allow', 'library.catalog.read', '馆藏信息允许公开查询')
}

export function canReadKnowledge(_actor: PolicyActor): PolicyDecision {
  return decision('allow', 'library.knowledge.read', '制度知识允许公开检索')
}

export function canViewReader(actor: PolicyActor, targetReaderId: string): PolicyDecision {
  if (isStaff(actor)) {
    return decision('allow', 'library.reader.staff', '工作人员可查看读者脱敏信息')
  }
  if (actor.readerId && actor.readerId === targetReaderId) {
    return decision('allow', 'library.reader.self', '读者本人可查看脱敏信息')
  }
  return decision('deny', 'library.reader.pii', '读者只能查看本人信息，其他读者信息需由工作人员查询')
}

/**
 * Actor-level tool authorization. Business rules (overdue, limits, suspension)
 * are separate and live in canReserve/canBorrow below.
 */
export function canUseTool(
  actor: PolicyActor,
  tool: LibraryToolName,
  targetReaderId?: string,
): PolicyDecision {
  if (publicReadTools.has(tool)) {
    return decision('allow', 'library.tool.read', '公共只读工具允许调用')
  }
  if (staffReadTools.has(tool)) {
    return isStaff(actor)
      ? decision('allow', 'library.tool.staff_read', '工作人员可使用该只读工具')
      : decision('deny', 'library.tool.staff_read', '该工具仅工作人员可用')
  }
  if (tool === 'reader_get' || tool === 'loan_list') {
    if (!targetReaderId) return decision('deny', 'library.tool.reader_target', '缺少读者标识')
    return canViewReader(actor, targetReaderId)
  }
  if (selfReadTools.has(tool)) {
    return decision('allow', 'library.tool.self_read', '本人或工作人员可读取该类记录')
  }
  if (tool === 'reservation_create') {
    if (actor.role === 'auditor') {
      return decision('deny', 'library.tool.reservation.audit', '审计角色只读，不能创建预约')
    }
    if (actor.role === 'reader') {
      if (!actor.readerId || targetReaderId !== actor.readerId) {
        return decision('deny', 'library.tool.reservation.self', '读者只能为本人创建预约')
      }
      return decision('allow', 'library.tool.reservation.self', '读者可为本人创建预约')
    }
    return decision('allow', 'library.tool.reservation.staff', '馆员或管理员可代读者创建预约')
  }
  if (tool === 'loan_borrow') {
    if (actor.role === 'auditor') {
      return decision('deny', 'library.tool.loan.audit', '审计角色只读，不能借书')
    }
    if (actor.role === 'reader' && (!actor.readerId || targetReaderId !== actor.readerId)) {
      return decision('deny', 'library.tool.loan.self', '读者只能为本人借书')
    }
    return decision('allow', 'library.tool.loan.self', '可办理借书')
  }
  if (selfServiceTools.has(tool)) {
    if (actor.role === 'auditor') {
      return decision('deny', 'library.tool.self.audit', '审计角色只读，不能执行写操作')
    }
    return decision('allow', 'library.tool.self', '允许本人自助或工作人员办理')
  }
  if (manageTools.has(tool)) {
    return canManage(actor)
      ? decision('allow', 'library.tool.manage', '馆员或管理员可执行业务维护')
      : decision('deny', 'library.tool.manage', '该操作需要馆员或管理员权限')
  }
  return decision('deny', 'library.tool.unknown', '未知工具')
}

export function canViewDeveloper(actor: PolicyActor): PolicyDecision {
  return isStaff(actor)
    ? decision('allow', 'library.developer.read', '工作人员可查看运行 Trace')
    : decision('deny', 'library.developer.read', '读者不能查看运行 Trace')
}

export function canViewAudit(actor: PolicyActor): PolicyDecision {
  return isStaff(actor)
    ? decision('allow', 'library.audit.read', '工作人员可查看审计事件')
    : decision('deny', 'library.audit.read', '读者不能查看审计事件')
}

export function canViewApprovals(actor: PolicyActor): PolicyDecision {
  return isStaff(actor)
    ? decision('allow', 'library.approval.read', '工作人员可查看审批')
    : decision('deny', 'library.approval.read', '读者不能查看审批列表')
}

export function canDecideApproval(actor: PolicyActor): PolicyDecision {
  return actor.role === 'librarian' || actor.role === 'admin'
    ? decision('allow', 'library.approval.decide', '馆员或管理员可处理审批')
    : decision('deny', 'library.approval.decide', '只有馆员或管理员可以处理审批')
}

export function canReserve(context: ReservationPolicyContext): PolicyDecision {
  const { reader, book } = context
  if (reader.status !== 'active') {
    return decision('deny', 'library.reader.status', '读者证状态异常，不能预约')
  }
  if (reader.activeReservations >= 3) {
    return decision('deny', 'library.reservation.limit', '预约数量已达上限（3 个）')
  }
  if (!book || book.availableCopies < 0) {
    return decision('deny', 'library.book.missing', '图书不存在')
  }
  if (reader.hasOverdue) {
    return decision(
      'require_approval',
      'library.reservation.approval',
      '读者存在逾期未还图书，预约需要馆员审批',
      'librarian',
    )
  }
  return decision('allow', 'library.reservation.allow', '读者状态正常，可创建预约')
}

export function canBorrow(context: ReservationPolicyContext): PolicyDecision {
  const { reader } = context
  if (reader.status !== 'active') {
    return decision('deny', 'library.reader.status', '读者证状态异常，不能借阅')
  }
  if (reader.activeLoans >= reader.maxLoans) {
    return decision('deny', 'library.loan.limit', '借阅数量已达上限')
  }
  if (reader.hasOverdue) {
    return decision('deny', 'library.loan.overdue', '存在逾期未还图书，请先归还')
  }
  return decision('allow', 'library.loan.allow', '读者状态正常，可借阅')
}

export function canWaiveFine(amount: number, actorRole: UserRole): PolicyDecision {
  if (amount <= 0) return decision('allow', 'library.fine.none', '没有需要减免的罚款')
  if (amount <= 50 && actorRole === 'librarian') {
    return decision('allow', 'library.fine.waiver.small', '50 元以内由馆员审批')
  }
  if (amount <= 500) {
    return decision(
      'require_approval',
      'library.fine.waiver.medium',
      '500 元以内罚款减免需要馆长审批',
      'director',
    )
  }
  return decision(
    'require_approval',
    'library.fine.waiver.large',
    '超过 500 元的罚款减免需要馆长与财务审批',
    'director',
  )
}
