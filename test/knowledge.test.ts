import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeOntology, listKnowledge, searchKnowledge } from '../packages/knowledge-sdk/src/index.ts'

test('knowledge search returns borrowing rules with citations', () => {
  const result = searchKnowledge('借阅期限是多久？可以续借吗？')
  assert.ok(result.passages.length > 0)
  assert.ok(result.citations.length > 0)
  assert.ok(result.passages.some((passage) => passage.id === 'kb-borrow-rules'))
})

test('knowledge search returns reservation rules', () => {
  const result = searchKnowledge('预约上限和保留时间')
  assert.ok(result.passages.some((passage) => passage.id === 'kb-reservation-rules'))
})

test('knowledge overview returns all rule documents', () => {
  const result = listKnowledge()
  assert.equal(result.passages.length, 5)
  assert.ok(result.passages.some((passage) => passage.id === 'kb-borrow-rules'))
  assert.ok(result.passages.some((passage) => passage.id === 'kb-branch-service'))
  assert.equal(new Set(result.citations).size, 5)
})

test('ontology contains core library entities', () => {
  const names = describeOntology().map((entity) => entity.name)
  for (const name of ['Book', 'Copy', 'Reader', 'Loan', 'Reservation', 'Fine', 'Policy']) {
    assert.ok(names.includes(name), `${name} should be in ontology`)
  }
})
