import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canBorrow,
  canDecideApproval,
  canReserve,
  canUseTool,
  canViewReader,
} from '../packages/policy-sdk/src/index.ts'

const baseReader = {
  id: 'R001',
  status: 'active',
  maxLoans: 5,
  activeLoans: 1,
  hasOverdue: false,
  activeReservations: 0,
}

test('normal reader can reserve a book', () => {
  const result = canReserve({ reader: baseReader, book: { id: 'B001', availableCopies: 1 } })
  assert.equal(result.decision, 'allow')
})

test('reader with overdue needs librarian approval', () => {
  const result = canReserve({
    reader: { ...baseReader, hasOverdue: true },
    book: { id: 'B001', availableCopies: 1 },
  })
  assert.equal(result.decision, 'require_approval')
  assert.equal(result.approvalRole, 'librarian')
  assert.match(result.reason, /逾期/)
})

test('reader at reservation limit is denied', () => {
  const result = canReserve({
    reader: { ...baseReader, activeReservations: 3 },
    book: { id: 'B001', availableCopies: 1 },
  })
  assert.equal(result.decision, 'deny')
  assert.match(result.reason, /上限/)
})

test('suspended reader is denied', () => {
  const result = canReserve({
    reader: { ...baseReader, status: 'suspended' },
    book: { id: 'B001', availableCopies: 1 },
  })
  assert.equal(result.decision, 'deny')
})

test('borrow policy denies overdue reader and maxed reader', () => {
  assert.equal(
    canBorrow({ reader: { ...baseReader, hasOverdue: true }, book: { id: 'B001', availableCopies: 1 } }).decision,
    'deny',
  )
  assert.equal(
    canBorrow({ reader: { ...baseReader, activeLoans: 5 }, book: { id: 'B001', availableCopies: 1 } }).decision,
    'deny',
  )
})

test('reader cannot view another reader PII', () => {
  const result = canViewReader({ role: 'reader', readerId: 'R001' }, 'R002')
  assert.equal(result.decision, 'deny')
})

test('reader can view own profile and staff can view any reader', () => {
  assert.equal(canViewReader({ role: 'reader', readerId: 'R001' }, 'R001').decision, 'allow')
  assert.equal(canViewReader({ role: 'librarian' }, 'R002').decision, 'allow')
  assert.equal(canViewReader({ role: 'auditor' }, 'R002').decision, 'allow')
})

test('catalog list is a public read tool for all authenticated roles', () => {
  for (const actor of [
    { role: 'reader' as const, readerId: 'R001' },
    { role: 'librarian' as const },
    { role: 'auditor' as const },
    { role: 'admin' as const },
  ]) {
    assert.equal(canUseTool(actor, 'catalog_list').decision, 'allow')
  }
})

test('auditor is read-only and readers cannot reserve for others', () => {
  assert.equal(canUseTool({ role: 'auditor' }, 'reservation_create', 'R002').decision, 'deny')
  assert.equal(canUseTool({ role: 'reader', readerId: 'R001' }, 'reservation_create', 'R002').decision, 'deny')
  assert.equal(canUseTool({ role: 'reader', readerId: 'R001' }, 'reservation_create', 'R001').decision, 'allow')
  assert.equal(canUseTool({ role: 'librarian' }, 'reservation_create', 'R002').decision, 'allow')
})

test('only librarian and admin can decide approvals', () => {
  assert.equal(canDecideApproval({ role: 'librarian' }).decision, 'allow')
  assert.equal(canDecideApproval({ role: 'admin' }).decision, 'allow')
  assert.equal(canDecideApproval({ role: 'auditor' }).decision, 'deny')
  assert.equal(canDecideApproval({ role: 'reader', readerId: 'R001' }).decision, 'deny')
})
