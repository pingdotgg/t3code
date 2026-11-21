import type { SqlStorage } from "@cloudflare/workers-types"
import type { DatabaseSync, SQLInputValue } from "node:sqlite"

// Durable Object storage over node:sqlite. Both transaction APIs use
// savepoints so the cluster's `transactionSync` and `SqliteClient`'s
// `transaction` can nest, as they do on SQLite-backed Durable Objects. The
// alarm is only recorded; tests fire due work themselves.
export class SqliteStorage {
  readonly sql: SqlStorage
  alarm: number | null = null
  #savepoints = 0

  constructor(readonly database: DatabaseSync) {
    this.sql = {
      exec: (query: string, ...bindings: Array<unknown>) => {
        const statement = database.prepare(query)
        const columnNames = statement.columns().map((column) => column.name)
        const rows = statement.all(...bindings as Array<SQLInputValue>) as Array<Record<string, unknown>>
        return {
          columnNames,
          toArray: () => rows,
          raw: () => rows.map((row) => columnNames.map((column) => row[column]))[Symbol.iterator]()
        }
      }
    } as unknown as SqlStorage
  }

  #begin(): string {
    const name = `sp_${this.#savepoints++}`
    this.database.exec(`SAVEPOINT ${name}`)
    return name
  }

  #end(name: string, commit: boolean): void {
    if (!commit) this.database.exec(`ROLLBACK TO ${name}`)
    this.database.exec(`RELEASE ${name}`)
  }

  transactionSync<A>(f: () => A): A {
    const name = this.#begin()
    try {
      const value = f()
      this.#end(name, true)
      return value
    } catch (error) {
      this.#end(name, false)
      throw error
    }
  }

  async transaction<A>(f: (txn: { readonly rollback: () => void }) => Promise<A>): Promise<A> {
    const name = this.#begin()
    let rolledBack = false
    try {
      const value = await f({
        rollback: () => {
          rolledBack = true
        }
      })
      this.#end(name, !rolledBack)
      return value
    } catch (error) {
      this.#end(name, false)
      throw error
    }
  }
  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm)
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime
    return Promise.resolve()
  }

  deleteAlarm(): Promise<void> {
    this.alarm = null
    return Promise.resolve()
  }
}
