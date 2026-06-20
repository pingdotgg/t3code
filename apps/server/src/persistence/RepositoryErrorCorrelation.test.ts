import { AuthSessionId, ThreadId, type AuthEnvironmentScope } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as PersistenceErrors from "./Errors.ts";
import { AuthPairingLinkRepositoryLive } from "./Layers/AuthPairingLinks.ts";
import { AuthSessionRepositoryLive } from "./Layers/AuthSessions.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./Layers/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { AuthPairingLinkRepository } from "./Services/AuthPairingLinks.ts";
import { AuthSessionRepository } from "./Services/AuthSessions.ts";
import { ProviderSessionRuntimeRepository } from "./Services/ProviderSessionRuntime.ts";

const issuedAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const expiresAt = DateTime.makeUnsafe("2027-06-20T00:00:00.000Z");
const now = DateTime.makeUnsafe("2026-06-21T00:00:00.000Z");
const scopes: ReadonlyArray<AuthEnvironmentScope> = ["access:read"];

const authSessionLayer = AuthSessionRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const authPairingLinkLayer = AuthPairingLinkRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const providerSessionRuntimeLayer = ProviderSessionRuntimeRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

describe("persistence error correlation", () => {
  it.effect("correlates auth session SQL and row-decode failures without sensitive fields", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessionRepository;
      const sql = yield* SqlClient.SqlClient;
      const sessionId = AuthSessionId.make("session-correlation");
      const currentSessionId = AuthSessionId.make("current-session-correlation");
      const subject = "session-subject-secret-sentinel";

      yield* sessions.create({
        sessionId,
        subject,
        scopes,
        method: "browser-session-cookie",
        client: {
          label: null,
          ipAddress: null,
          userAgent: null,
          deviceType: "desktop",
          os: null,
          browser: null,
        },
        issuedAt,
        expiresAt,
      });
      yield* sql`
        UPDATE auth_sessions
        SET scopes = ${"session-scopes-secret-sentinel"}
        WHERE session_id = ${sessionId}
      `;

      const decodeError = yield* Effect.flip(sessions.listActive({ now }));
      assert.instanceOf(decodeError, PersistenceErrors.PersistenceDecodeError);
      assert.deepStrictEqual(decodeError.correlation, { sessionId });
      assert.equal(
        decodeError.message,
        `Decode error in AuthSessionRepository.listActive:decodeRows: ${decodeError.issue}`,
      );
      assert.notInclude(decodeError.issue, subject);
      assert.notInclude(decodeError.issue, "session-scopes-secret-sentinel");
      assert.notInclude(decodeError.message, subject);

      yield* sql`DROP TABLE auth_sessions`;
      const createError = yield* Effect.flip(
        sessions.create({
          sessionId,
          subject,
          scopes,
          method: "browser-session-cookie",
          client: {
            label: null,
            ipAddress: null,
            userAgent: null,
            deviceType: "desktop",
            os: null,
            browser: null,
          },
          issuedAt,
          expiresAt,
        }),
      );
      assert.instanceOf(createError, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(createError.correlation, { sessionId });
      assert.equal(createError.message, "SQL error in AuthSessionRepository.create:query");
      assert.notInclude(createError.message, subject);
      assert.notInclude(createError.message, DateTime.formatIso(issuedAt));

      const revokeOtherError = yield* Effect.flip(
        sessions.revokeAllExcept({ currentSessionId, revokedAt: now }),
      );
      assert.instanceOf(revokeOtherError, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(revokeOtherError.correlation, { currentSessionId });
      assert.equal(
        revokeOtherError.message,
        "SQL error in AuthSessionRepository.revokeAllExcept:query",
      );
      assert.notInclude(revokeOtherError.message, DateTime.formatIso(now));
    }).pipe(Effect.provide(authSessionLayer)),
  );

  it.effect("correlates pairing-link create and revoke failures by id only", () =>
    Effect.gen(function* () {
      const pairingLinks = yield* AuthPairingLinkRepository;
      const sql = yield* SqlClient.SqlClient;
      const id = "pairing-link-correlation";
      const credential = "pairing-credential-secret-sentinel";
      const subject = "pairing-subject-secret-sentinel";
      const scopesPayload = "pairing-scopes-secret-sentinel";

      yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          proof_key_thumbprint,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        VALUES (
          ${id},
          ${credential},
          ${"one-time-token"},
          ${scopesPayload},
          ${subject},
          NULL,
          NULL,
          ${DateTime.formatIso(issuedAt)},
          ${DateTime.formatIso(expiresAt)},
          NULL,
          NULL
        )
      `;

      const decodeError = yield* Effect.flip(pairingLinks.getByCredential({ credential }));
      assert.instanceOf(decodeError, PersistenceErrors.PersistenceDecodeError);
      assert.deepStrictEqual(decodeError.correlation, { pairingLinkId: id });
      assert.equal(
        decodeError.message,
        `Decode error in AuthPairingLinkRepository.getByCredential:decodeRow: ${decodeError.issue}`,
      );
      assert.notInclude(decodeError.issue, credential);
      assert.notInclude(decodeError.issue, subject);
      assert.notInclude(decodeError.issue, scopesPayload);
      assert.notInclude(decodeError.message, DateTime.formatIso(issuedAt));

      yield* sql`DROP TABLE auth_pairing_links`;
      const createError = yield* Effect.flip(
        pairingLinks.create({
          id,
          credential,
          method: "one-time-token",
          scopes,
          subject,
          label: null,
          proofKeyThumbprint: null,
          createdAt: issuedAt,
          expiresAt,
        }),
      );
      assert.instanceOf(createError, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(createError.correlation, { pairingLinkId: id });
      assert.notInclude(createError.message, credential);
      assert.notInclude(createError.message, subject);
      assert.notInclude(createError.message, DateTime.formatIso(issuedAt));

      const revokeError = yield* Effect.flip(pairingLinks.revoke({ id, revokedAt: now }));
      assert.instanceOf(revokeError, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(revokeError.correlation, { pairingLinkId: id });
      assert.notInclude(revokeError.message, credential);
      assert.notInclude(revokeError.message, DateTime.formatIso(now));
    }).pipe(Effect.provide(authPairingLinkLayer)),
  );

  it.effect("correlates provider runtime SQL and per-row decode failures by thread", () =>
    Effect.gen(function* () {
      const runtimes = yield* ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-correlation");
      const runtimePayload = "runtime-payload-secret-sentinel";
      const lastSeenAt = "2026-06-20T00:00:00.000Z";

      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${threadId},
          ${"codex"},
          NULL,
          ${"codex"},
          ${"invalid-runtime-mode"},
          ${"running"},
          ${lastSeenAt},
          NULL,
          ${`{"secret":"${runtimePayload}"}`}
        )
      `;

      const decodeError = yield* Effect.flip(runtimes.list());
      assert.instanceOf(decodeError, PersistenceErrors.PersistenceDecodeError);
      assert.deepStrictEqual(decodeError.correlation, { threadId });
      assert.equal(
        decodeError.message,
        `Decode error in ProviderSessionRuntimeRepository.list:decodeRows: ${decodeError.issue}`,
      );
      assert.notInclude(decodeError.issue, runtimePayload);
      assert.notInclude(decodeError.message, runtimePayload);
      assert.notInclude(decodeError.message, lastSeenAt);

      yield* sql`DROP TABLE provider_session_runtime`;
      const sqlFailure = yield* Effect.flip(
        runtimes.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: null,
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt,
          resumeCursor: null,
          runtimePayload: { secret: runtimePayload },
        }),
      );
      assert.instanceOf(sqlFailure, PersistenceErrors.PersistenceSqlError);
      assert.deepStrictEqual(sqlFailure.correlation, { threadId });
      assert.equal(
        sqlFailure.message,
        "SQL error in ProviderSessionRuntimeRepository.upsert:query",
      );
      assert.notInclude(sqlFailure.message, runtimePayload);
      assert.notInclude(sqlFailure.message, lastSeenAt);
    }).pipe(Effect.provide(providerSessionRuntimeLayer)),
  );
});
