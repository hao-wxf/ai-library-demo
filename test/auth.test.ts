import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSession, login, logout, permissionsFor } from '../packages/auth-sdk/src/index.ts'

test('demo reader can log in with a hashed password and gets a session', () => {
  const result = login('lina', 'reader123')
  assert.ok(result)
  assert.equal(result.user.role, 'reader')
  assert.equal(result.user.readerId, 'R002')
  assert.equal(result.user.username, 'lina')
  assert.ok(result.token.length > 20)
  const session = getSession(result.token)
  assert.equal(session?.id, result.user.id)
  logout(result.token)
  assert.equal(getSession(result.token), undefined)
})

test('wrong password and unknown user are rejected', () => {
  assert.equal(login('lina', 'wrong-password'), undefined)
  assert.equal(login('nobody', 'reader123'), undefined)
})

test('staff roles have developer permissions and auditor cannot decide approvals', () => {
  assert.equal(permissionsFor('reader').developerView, false)
  assert.equal(permissionsFor('librarian').decideApprovals, true)
  assert.equal(permissionsFor('admin').decideApprovals, true)
  assert.equal(permissionsFor('auditor').developerView, true)
  assert.equal(permissionsFor('auditor').decideApprovals, false)
})
