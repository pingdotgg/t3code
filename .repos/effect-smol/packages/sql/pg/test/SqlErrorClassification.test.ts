import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import type * as SqlError from "effect/unstable/sql/SqlError"

const queryFailureReason = (cause: unknown) =>
  Effect.gen(function*() {
    const client = yield* PgClient.fromPool({
      acquire: Effect.succeed(makeFailingPool(cause) as any)
    })
    const error = yield* Effect.flip(client`SELECT 1`)
    return error.reason
  }).pipe(
    Effect.scoped,
    Effect.provide(Reactivity.layer)
  )

const queryFailureReasonTag = (cause: unknown) => Effect.map(queryFailureReason(cause), (reason) => reason._tag)

const assertUniqueViolation = (reason: SqlError.SqlErrorReason, constraint: string) => {
  assert.strictEqual(reason._tag, "UniqueViolation")
  if (reason._tag === "UniqueViolation") {
    assert.strictEqual(reason.constraint, constraint)
  }
}

const makeFailingPool = (cause: unknown) => ({
  options: {},
  ending: false,
  connect: (cb: (cause: unknown, client: any) => void) => cb(null, makeFailingClient(cause)),
  query: () => undefined
})

const makeFailingClient = (cause: unknown) => ({
  once: () => undefined,
  off: () => undefined,
  release: () => undefined,
  query: (_sql: string, _params: ReadonlyArray<unknown>, cb: (cause: unknown) => void) => cb(cause)
})

describe("PgClient SqlError classification", () => {
  it.effect("checks 42501 before generic 42*", () =>
    Effect.gen(function*() {
      const authorizationTag = yield* queryFailureReasonTag({ code: "42501" })
      assert.strictEqual(authorizationTag, "AuthorizationError")

      const syntaxTag = yield* queryFailureReasonTag({ code: "42P01" })
      assert.strictEqual(syntaxTag, "SqlSyntaxError")
    }))

  it.effect("falls back to UnknownError for unmapped SQLSTATE", () =>
    Effect.gen(function*() {
      const tag = yield* queryFailureReasonTag({ code: "ZZZZZ" })
      assert.strictEqual(tag, "UnknownError")
    }))

  it.effect("classifies 23505 as UniqueViolation and trims the constraint name", () =>
    Effect.gen(function*() {
      const reason = yield* queryFailureReason({ code: "23505", constraint: "  users_email_key  " })
      assertUniqueViolation(reason, "users_email_key")
    }))

  it.effect("uses unknown for missing, non-string, or blank unique violation constraints", () =>
    Effect.gen(function*() {
      const missing = yield* queryFailureReason({ code: "23505" })
      assertUniqueViolation(missing, "unknown")

      const nonString = yield* queryFailureReason({ code: "23505", constraint: 123 })
      assertUniqueViolation(nonString, "unknown")

      const blank = yield* queryFailureReason({ code: "23505", constraint: "   " })
      assertUniqueViolation(blank, "unknown")
    }))

  it.effect("keeps non-unique integrity constraints classified as ConstraintError", () =>
    Effect.gen(function*() {
      const tag = yield* queryFailureReasonTag({ code: "23503", constraint: "orders_user_id_fkey" })
      assert.strictEqual(tag, "ConstraintError")
    }))
})
