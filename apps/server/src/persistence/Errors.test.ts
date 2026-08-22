import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PersistenceDecodeError, PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

const decodeRuntimePayload = Schema.decodeUnknownEffect(
  Schema.Struct({
    runtimePayload: Schema.Struct({
      attempt: Schema.Number,
    }),
  }),
);

it("keeps SQL operation context without a tautological detail", () => {
  const cause = new Error("database unavailable");
  const error = new PersistenceSqlError({
    operation: "AuthSessionRepository.list:query",
    cause,
  });

  assert.equal(error.operation, "AuthSessionRepository.list:query");
  assert.equal(error.detail, undefined);
  assert.equal(error.cause, cause);
  assert.equal(error.message, "SQL error in AuthSessionRepository.list:query");
});

it("names the SQLite condition by its normalized result code", () => {
  const cause = Object.assign(new Error("UNIQUE constraint failed: orders.customer_email"), {
    errcode: 1555,
    errstr: "constraint failed",
  });
  const error = toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")(cause);

  assert.equal(error.detail, "SQLITE(1555) constraint failed");
  assert.equal(error.cause, cause);
});

it("reads the condition through a wrapping driver error", () => {
  const driver = Object.assign(new Error("locked"), { errcode: 5, errstr: "database is locked" });
  const error = toPersistenceSqlError("AuthSessionRepository.list:query")(
    new Error("Failed to prepare statement", { cause: driver }),
  );

  assert.equal(error.detail, "SQLITE(5) database is locked");
});

it("keeps the driver's own prose out of the message", () => {
  const cause = Object.assign(new Error("UNIQUE constraint failed: orders.customer_email"), {
    errcode: 1555,
    errstr: "constraint failed",
  });
  const error = toPersistenceSqlError("AuthSessionRepository.create:query")(cause);

  assert.ok(!error.message.includes("customer_email"));
});

it("omits a detail for a cause it cannot categorize", () => {
  const error = toPersistenceSqlError("AuthSessionRepository.list:query")(new Error("unhelpful"));

  assert.equal(error.detail, undefined);
  assert.equal(error.message, "SQL error in AuthSessionRepository.list:query");
});

it.effect("summarizes a schema cause by issue tag instead of by rejected value", () =>
  Effect.gen(function* () {
    const rejectedPayload = "sql-mapper-secret-sentinel";
    const cause = yield* Effect.flip(
      decodeRuntimePayload({ runtimePayload: { attempt: rejectedPayload } }),
    );
    const error = toPersistenceSqlError("ProviderSessionRuntimeRepository.list:query")(cause);

    assert.ok(error.detail !== undefined);
    assert.ok(!error.message.includes(rejectedPayload));
  }),
);

it.effect("maps schema errors without copying rejected payloads into diagnostics", () =>
  Effect.gen(function* () {
    const rejectedPayload = "runtime-payload-secret-sentinel";
    const cause = yield* Effect.flip(
      decodeRuntimePayload({
        runtimePayload: {
          attempt: rejectedPayload,
        },
      }),
    );
    const error = PersistenceDecodeError.fromSchemaError(
      "ProviderSessionRuntimeRepository.list:decodeRows",
      cause,
    );

    assert.equal(error.operation, "ProviderSessionRuntimeRepository.list:decodeRows");
    assert.equal(error.cause, cause);
    assert.notInclude(error.issue, rejectedPayload);
    assert.notInclude(error.message, rejectedPayload);
    assert.include(error.issue, "InvalidType");
  }),
);
