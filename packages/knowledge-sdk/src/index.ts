import type { KnowledgePassage, KnowledgeResult } from '../../contracts/src/index.ts'

export interface KnowledgeDocument {
  id: string
  title: string
  text: string
  source: string
  version: string
  entities: string[]
}

export interface OntologyEntity {
  name: string
  description: string
  attributes: string[]
  relations: string[]
}

export const ONTOLOGY: Record<string, OntologyEntity> = {
  Book: {
    name: 'Book',
    description: '图书书目，一本图书可以有多个馆藏副本',
    attributes: ['isbn', 'title', 'author', 'category'],
    relations: ['hasMany:Copy', 'hasMany:Reservation'],
  },
  Copy: {
    name: 'Copy',
    description: '馆藏副本，具有条码、馆藏地和借阅状态',
    attributes: ['barcode', 'branch', 'status'],
    relations: ['belongsTo:Book', 'hasMany:Loan'],
  },
  Reader: {
    name: 'Reader',
    description: '读者，具有读者证状态、借阅上限和联系方式',
    attributes: ['readerNo', 'name', 'status', 'maxLoans'],
    relations: ['hasMany:Loan', 'hasMany:Reservation', 'hasMany:Fine'],
  },
  Loan: {
    name: 'Loan',
    description: '借阅记录，包含借出、应还、归还和逾期信息',
    attributes: ['borrowedAt', 'dueAt', 'returnedAt', 'overdueDays'],
    relations: ['belongsTo:Reader', 'belongsTo:Copy'],
  },
  Reservation: {
    name: 'Reservation',
    description: '预约记录，包含排队、保留期限和审批状态',
    attributes: ['status', 'createdAt', 'expiresAt'],
    relations: ['belongsTo:Reader', 'belongsTo:Book'],
  },
  Fine: {
    name: 'Fine',
    description: '逾期罚款，按天计算并设置上限',
    attributes: ['amount', 'status', 'reason'],
    relations: ['belongsTo:Loan'],
  },
  Branch: {
    name: 'Branch',
    description: '馆藏地/分馆',
    attributes: ['name', 'address', 'openHours'],
    relations: ['hasMany:Copy'],
  },
  Policy: {
    name: 'Policy',
    description: '借阅、预约、审批等业务规则',
    attributes: ['policyId', 'scope', 'decision'],
    relations: ['governs:Book', 'governs:Reader', 'governs:Reservation'],
  },
  Regulation: {
    name: 'Regulation',
    description: '图书馆制度与政务规范文件',
    attributes: ['title', 'version', 'effectiveAt'],
    relations: ['supports:Policy'],
  },
}

export const KNOWLEDGE_DOCS: KnowledgeDocument[] = [
  {
    id: 'kb-borrow-rules',
    title: '借阅规则',
    text: '普通读者每次最多借阅 5 册，借阅期限 30 天，可续借 2 次，每次续借 15 天。逾期每天 0.5 元，单册罚款上限 20 元。存在逾期未还图书时不能继续借阅。',
    source: '图书馆借阅管理办法',
    version: '2026.1',
    entities: ['Reader', 'Loan', 'Fine', 'Policy'],
  },
  {
    id: 'kb-reservation-rules',
    title: '预约规则',
    text: '每位读者最多同时保留 3 个预约。预约到馆后保留 3 天，逾期未取自动取消。读者存在逾期未还图书时，预约需要馆员审批。可借副本充足时建议直接借阅。',
    source: '图书馆预约服务规范',
    version: '2026.1',
    entities: ['Reader', 'Reservation', 'Policy'],
  },
  {
    id: 'kb-reader-privacy',
    title: '读者隐私与数据权限',
    text: '读者手机号、证件号等个人信息属于敏感数据。工作人员只能在工作职责范围内查看，系统默认对非本人展示脱敏信息。跨读者查询需要馆员授权并记录审计日志。',
    source: '图书馆读者数据安全规范',
    version: '2026.1',
    entities: ['Reader', 'Policy'],
  },
  {
    id: 'kb-branch-service',
    title: '开放时间与分馆服务',
    text: '总馆开放时间为周一至周日 9:00-21:00，少儿分馆为 9:00-18:00。分馆图书可通过馆际互借预约，预约到馆后 3 天内取书。',
    source: '图书馆服务指南',
    version: '2026.1',
    entities: ['Branch', 'Reservation'],
  },
  {
    id: 'kb-overdue-handling',
    title: '逾期与罚款处理',
    text: '逾期罚款按每天 0.5 元计算，单册上限 20 元。读者归还全部逾期图书后可申请减免；50 元以内由馆员审批，超过 50 元需要馆长审批。所有减免必须留痕。',
    source: '图书馆逾期罚款处理细则',
    version: '2026.1',
    entities: ['Loan', 'Fine', 'Policy'],
  },
]

function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s，。！？、；：""''（）()【】\[\]《》<>]/g, '')
}

function tokens(text: string): string[] {
  const normalized = normalize(text)
  const latin = normalized.match(/[a-z0-9]+/g) ?? []
  const chinese = normalized.match(/[一-鿿]{2,}/g) ?? []
  const bigrams: string[] = []
  for (const run of chinese) {
    for (let i = 0; i < run.length - 1; i++) bigrams.push(run.slice(i, i + 2))
  }
  return [...new Set([...latin, ...chinese, ...bigrams])]
}

export function searchKnowledge(query: string, topK = 3): KnowledgeResult {
  const queryTokens = tokens(query)
  const scored = KNOWLEDGE_DOCS.map((doc) => {
    const haystack = normalize(`${doc.title}${doc.text}${doc.source}`)
    let score = 0
    for (const token of queryTokens) {
      if (token && haystack.includes(token)) score += token.length > 1 ? 3 : 1
    }
    if (normalize(doc.title).includes(normalize(query))) score += 10
    return { doc, score }
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  const selected = (scored.length > 0 ? scored : KNOWLEDGE_DOCS.map((doc) => ({ doc, score: 0 })))
    .slice(0, topK)
    .map<KnowledgePassage>(({ doc, score }) => ({
      id: doc.id,
      text: doc.text,
      source: doc.source,
      version: doc.version,
      score,
    }))

  return {
    passages: selected,
    citations: selected.map((passage) => `${passage.source} · ${passage.version}`),
    entities: [...new Set(selected.flatMap((passage) => {
      const doc = KNOWLEDGE_DOCS.find((item) => item.id === passage.id)
      return doc?.entities ?? []
    }))],
  }
}

export function listKnowledge(): KnowledgeResult {
  const selected = KNOWLEDGE_DOCS.map<KnowledgePassage>((doc) => ({
    id: doc.id,
    text: doc.text,
    source: doc.source,
    version: doc.version,
    score: 0,
  }))
  return {
    passages: selected,
    citations: selected.map((passage) => `${passage.source} · ${passage.version}`),
    entities: [...new Set(KNOWLEDGE_DOCS.flatMap((doc) => doc.entities))],
  }
}

export function describeOntology(): OntologyEntity[] {
  return Object.values(ONTOLOGY)
}
