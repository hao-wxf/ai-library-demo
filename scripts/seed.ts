import { createBusinessService } from '../packages/capability-sdk/src/index.ts'

const business = createBusinessService('data/library.sqlite')
const books = business.listBooks()
const readers = business.listReaders()
console.log(`Library database ready: ${books.length} books, ${readers.length} readers`)
console.log('Readers:', readers.map((reader) => `${reader.id}/${reader.name}`).join(', '))
business.close()
