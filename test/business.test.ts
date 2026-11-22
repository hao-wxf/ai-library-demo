import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { createBusinessService } from '../packages/capability-sdk/src/index.ts'

const dbPath = `data/test-${randomUUID().slice(0, 8)}.sqlite`
const business = createBusinessService(dbPath)

test('business seeds books, readers, loans and reservations', () => {
  const books = business.listBooks()
  assert.equal(books.length, 5)
  assert.ok(books.some((book) => book.title.includes('计算机系统')))
  const readers = business.listReaders()
  assert.equal(readers.length, 4)

  const overdue = business.getReader('R002')
  assert.equal(overdue?.hasOverdue, true)
  const loans = business.listLoans('R002')
  assert.ok(loans.some((loan) => loan.overdueDays > 0 && loan.fine > 0))

  const search = business.searchBooks('计算机')
  assert.ok(search.length >= 2)
})

test('business creates reservations and approvals', () => {
  const reservation = business.createReservation('B001', 'R001')
  assert.equal(reservation.bookId, 'B001')
  assert.ok(business.listReservations('R001').some((item) => item.id === reservation.id))

  const approval = business.createApproval({
    runId: 'RUN-TEST',
    policyId: 'library.reservation.approval',
    tool: 'reservation_create',
    payload: { bookId: 'B001', readerId: 'R002' },
    requestedBy: 'R002',
  })
  assert.equal(approval.status, 'pending')
  assert.equal(business.getApproval(approval.id)?.status, 'pending')

  const decided = business.decideApproval(approval.id, 'approved', 'librarian', 'test')
  assert.equal(decided.status, 'approved')

  const audit = business.recordAudit({
    runId: 'RUN-TEST',
    traceId: 'TRACE-TEST',
    actor: 'R002',
    agentId: 'library-agent',
    tool: 'reservation_create',
    inputHash: 'abc',
    policyDecision: 'require_approval',
    approvalId: approval.id,
    result: 'pending_approval',
  })
  assert.ok(audit.id.startsWith('AUD-'))
  assert.ok(business.listAudit('RUN-TEST').some((event) => event.id === audit.id))
})

test('circulation supports borrow, renew and return', () => {
  const loan = business.borrowBook('B005', 'R001')
  assert.equal(loan.readerId, 'R001')
  assert.equal(loan.status, 'active')
  assert.ok(business.listCopies('B005').some((copy) => copy.status === 'loaned'))

  const renewed = business.renewLoan(loan.id)
  assert.equal(renewed.renewedCount, 1)
  assert.ok(new Date(renewed.dueAt).getTime() > new Date(loan.dueAt).getTime())

  const result = business.returnLoan(loan.id)
  assert.equal(result.loan.status, 'returned')
  assert.ok(business.listCopies('B005').some((copy) => copy.status === 'available'))
})

test('reservations can be listed, cancelled and fulfilled', () => {
  const reservation = business.createReservation('B003', 'R001', undefined, '总馆')
  assert.ok(reservation.queuePosition >= 1)
  assert.ok(business.listReservations('R001').some((item) => item.id === reservation.id))
  const cancelled = business.cancelReservation(reservation.id)
  assert.equal(cancelled.status, 'cancelled')

  const second = business.createReservation('B002', 'R001', undefined, '总馆')
  const fulfilled = business.fulfillReservation(second.id)
  assert.equal(fulfilled.reservation.status, 'fulfilled')
  assert.equal(fulfilled.loan.readerId, 'R001')
})

test('fines can be paid and waived', () => {
  const unpaid = business.listFines('R002').find((fine) => fine.status === 'unpaid')
  assert.ok(unpaid)
  const paid = business.payFine(unpaid.id, 'TEST-PAY')
  assert.equal(paid.status, 'paid')

  const returned = business.returnLoan('L004')
  assert.ok(returned.fine)
  const waived = business.waiveFine(returned.fine.id, 'librarian')
  assert.equal(waived.status, 'waived')
})

test('reader, book and copy administration works', () => {
  const reader = business.createReader({
    name: '测试读者',
    phone: '13500000000',
    email: 'test@example.com',
    readerTypeId: 'RT-STD',
  })
  assert.equal(reader.status, 'active')
  assert.equal(business.updateReaderStatus(reader.id, 'suspended').status, 'suspended')

  const book = business.createBook({
    title: '测试图书',
    author: '测试作者',
    isbn: '9780000000001',
    category: '测试',
    publisher: '测试出版社',
  })
  assert.equal(book.status, 'active')
  const copy = business.createCopy({ bookId: book.id, branch: '总馆', location: '测试区' })
  assert.equal(copy.status, 'available')
  assert.equal(business.updateCopyStatus(copy.id, 'damaged').status, 'damaged')
  assert.equal(business.transferCopy(copy.id, '少儿分馆').branch, '少儿分馆')
})

test('acquisitions can create vendor, request, order and receive', () => {
  const vendor = business.createVendor({ name: '测试供应商', contact: '张三', phone: '010-90000000' })
  const request = business.createPurchaseRequest({
    title: '采购测试图书',
    isbn: '9780000000002',
    quantity: 2,
    estimatedUnitPrice: 50,
    requestedBy: 'librarian',
  })
  assert.equal(business.approvePurchaseRequest(request.id, 'admin').status, 'approved')
  const order = business.createOrder({
    vendorId: vendor.id,
    items: [{ title: '采购测试图书', isbn: '9780000000002', quantity: 2, unitPrice: 50 }],
  })
  assert.equal(order.items.length, 1)
  const received = business.receiveOrder(order.id)
  assert.equal(received.status, 'received')
  assert.ok(business.searchBooks('采购测试图书').length >= 1)
})

test('serials, electronic resources, ILL, stocktake and events work', () => {
  const serial = business.createSerial({ title: '测试期刊', issn: '1234-5678' })
  assert.equal(serial.status, 'active')
  assert.ok(business.checkinSerial(serial.id, '2027-01-01').nextIssueDate === '2027-01-01')
  assert.ok(business.listSerials().some((item) => item.id === serial.id))

  const resource = business.createElectronicResource({
    title: '测试数据库',
    provider: '测试厂商',
    url: 'https://example.com',
  })
  assert.ok(business.listElectronicResources().some((item) => item.id === resource.id))

  const ill = business.createIllRequest({ readerId: 'R001', title: '馆外图书' })
  assert.equal(business.updateIllStatus(ill.id, 'approved').status, 'approved')

  const stocktake = business.startStocktake('总馆')
  assert.equal(stocktake.status, 'open')
  assert.ok(stocktake.totalCopies > 0)
  const firstCopy = business.listAllCopies('总馆')[0]
  const scanned = business.scanStocktake(stocktake.id, firstCopy.barcode || firstCopy.id)
  assert.equal(scanned.scannedCount, 1)
  assert.equal(business.completeStocktake(stocktake.id).status, 'completed')

  const event = business.createEvent({
    title: '测试活动',
    startsAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    location: '总馆',
    capacity: 10,
  })
  assert.ok(business.listEvents().some((item) => item.id === event.id))
})

test('reports expose circulation and collection summaries', () => {
  const circulation = business.circulationReport()
  assert.ok(circulation.activeLoans >= 0)
  const collection = business.collectionReport()
  assert.ok(collection.totalBooks >= 5)
  assert.ok(collection.totalCopies >= 9)
})

test.after(() => {
  business.close()
  rmSync(dbPath, { force: true })
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })
})
