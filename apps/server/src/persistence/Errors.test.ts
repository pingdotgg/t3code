import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

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
