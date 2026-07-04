/**
 * WorkSourceConnectionStore - Layer implementation.
 *
 * Persists connection metadata to the `p_workflow_boards_work_source_connection`
 * SQLite table and stores the PAT bytes in the plugin `secrets` capability.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  WorkSourceConnectionView,
  WorkSourceProviderName,
} from "../../../contracts/workSource.ts";
import { isBlockedHost } from "../blockedHost.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import { WorkflowSecretsCapability } from "../Services/WorkflowCapabilities.ts";
import { WorkSourceAuthError } from "../Services/WorkSourceProvider.ts";
import {
  WorkSourceConnectionStore,
  WorkSourceConnectionStoreError,
  type WorkSourceConnectionStoreShape,
} from "../Services/WorkSourceConnectionStore.ts";

interface ConnectionRow {
  readonly connection_ref: string;
  readonly provider: string;
  readonly display_name: string;
  readonly auth_mode: string;
  readonly token_secret_name: string;
  readonly base_url: string | null;
  readonly auth_email: string | null;
  readonly created_at: string;
}

const toWorkSourceConnectionStoreError = (message: string) => (cause: unknown) =>
  new WorkSourceConnectionStoreError({ message, cause });

const toView = (row: ConnectionRow): WorkSourceConnectionView => ({
  connectionRef: row.connection_ref as never,
  provider: row.provider as WorkSourceProviderName,
  displayName: row.display_name as never,
  authMode: row.auth_mode as "pat" | "basic" | "bearer",
  baseUrl: row.base_url,
});

// Host plugin secret names must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$.
// The fork used work-source-token:<connectionRef>, but ":" is rejected by the
// host secrets capability, so the fixture uses the grammar-valid hyphen form.
const tokenSecretNameFor = (connectionRef: string) => `work-source-token-${connectionRef}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* WorkflowSecretsCapability;
  const ids = yield* WorkflowIds;

  // Shared provider-bound lookup: resolves BOTH the connection row AND its
  // decoded token, or fails with WorkSourceAuthError. Provider-bound - only
  // matches when the ref AND the provider agree, so a source can never use
  // another provider's credential. Both public methods build on this.
  const fetchRowAndToken = Effect.fn("WorkSourceConnectionStore.fetchRowAndToken")(function* (
    connectionRef: string,
    expectedProvider: WorkSourceProviderName,
  ) {
    const rows = yield* sql<ConnectionRow>`
        SELECT connection_ref, provider, display_name, auth_mode, token_secret_name, base_url, auth_email, created_at
        FROM p_workflow_boards_work_source_connection
        WHERE connection_ref = ${connectionRef} AND provider = ${expectedProvider}
      `.pipe(
      Effect.mapError((cause) => new WorkSourceAuthError({ connectionRef, cause } as never)),
    );

    const row = rows[0];
    if (row === undefined) {
      return yield* new WorkSourceAuthError({ connectionRef });
    }

    const maybeBytes = yield* secrets
      .get(row.token_secret_name)
      .pipe(Effect.mapError((cause) => new WorkSourceAuthError({ connectionRef, cause } as never)));

    if (maybeBytes === null) {
      return yield* new WorkSourceAuthError({ connectionRef });
    }

    return { row, token: new TextDecoder().decode(maybeBytes) };
  });

  const getToken: WorkSourceConnectionStoreShape["getToken"] = Effect.fn(
    "WorkSourceConnectionStore.getToken",
  )(function* (connectionRef, expectedProvider) {
    const { token } = yield* fetchRowAndToken(connectionRef, expectedProvider);
    return token;
  });

  const getConnectionAuth: WorkSourceConnectionStoreShape["getConnectionAuth"] = Effect.fn(
    "WorkSourceConnectionStore.getConnectionAuth",
  )(function* (connectionRef, expectedProvider) {
    const { row, token } = yield* fetchRowAndToken(connectionRef, expectedProvider);
    return {
      token,
      authMode: row.auth_mode as "pat" | "basic" | "bearer",
      baseUrl: row.base_url,
      email: row.auth_email,
    };
  });

  const create: WorkSourceConnectionStoreShape["create"] = Effect.fn(
    "WorkSourceConnectionStore.create",
  )(function* (input) {
    if (input.provider === "jira") {
      const base = input.baseUrl?.trim();
      if (!base) {
        return yield* new WorkSourceConnectionStoreError({
          message: "Jira connections require a base URL",
        });
      }
      const parsed = yield* Effect.try({
        try: () => {
          const url = new URL(base);
          if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
          return url;
        },
        catch: () =>
          new WorkSourceConnectionStoreError({
            message: "Jira base URL must be a valid http(s) URL",
          }),
      });
      if (isBlockedHost(parsed.hostname)) {
        return yield* new WorkSourceConnectionStoreError({
          message: "Jira base URL host is not allowed",
        });
      }
      if (input.authMode === "basic" && !input.email?.trim()) {
        return yield* new WorkSourceConnectionStoreError({
          message: "Jira Cloud (Basic auth) connections require an email",
        });
      }
    }

    const connectionRef = yield* ids.eventId().pipe(Effect.map((id) => `conn-${id}`));
    const tokenSecretName = tokenSecretNameFor(connectionRef);
    const now = yield* DateTime.now;
    const createdAt = DateTime.formatIso(now);

    const authMode = input.authMode ?? "pat";

    // Insert the row before storing the secret. If the insert fails, we leave no
    // orphaned, unreachable secret behind. The reverse failure mode is graceful:
    // getToken fails with WorkSourceAuthError and remove can still clean up.
    yield* sql`
        INSERT INTO p_workflow_boards_work_source_connection (
          connection_ref,
          provider,
          display_name,
          auth_mode,
          token_secret_name,
          base_url,
          auth_email,
          created_at
        ) VALUES (
          ${connectionRef},
          ${input.provider},
          ${input.displayName},
          ${authMode},
          ${tokenSecretName},
          ${input.baseUrl ?? null},
          ${input.email ?? null},
          ${createdAt}
        )
      `.pipe(
      Effect.mapError(toWorkSourceConnectionStoreError("Failed to insert work source connection")),
    );

    yield* secrets
      .set(tokenSecretName, new TextEncoder().encode(input.token))
      .pipe(Effect.mapError(toWorkSourceConnectionStoreError("Failed to store connection token")));

    return {
      connectionRef: connectionRef as never,
      provider: input.provider,
      displayName: input.displayName as never,
      authMode,
      baseUrl: input.baseUrl ?? null,
    } satisfies WorkSourceConnectionView;
  });

  const list: WorkSourceConnectionStoreShape["list"] = () =>
    sql<ConnectionRow>`
      SELECT connection_ref, provider, display_name, auth_mode, token_secret_name, base_url, auth_email, created_at
      FROM p_workflow_boards_work_source_connection
      ORDER BY created_at ASC
    `.pipe(
      Effect.map((rows) => rows.map(toView)),
      Effect.mapError(toWorkSourceConnectionStoreError("Failed to list work source connections")),
      Effect.withSpan("WorkSourceConnectionStore.list"),
    );

  const remove: WorkSourceConnectionStoreShape["remove"] = Effect.fn(
    "WorkSourceConnectionStore.remove",
  )(function* (connectionRef) {
    const rows = yield* sql<{ readonly token_secret_name: string }>`
        SELECT token_secret_name FROM p_workflow_boards_work_source_connection WHERE connection_ref = ${connectionRef}
      `.pipe(
      Effect.mapError(toWorkSourceConnectionStoreError("Failed to look up connection for removal")),
    );

    const row = rows[0];
    if (row !== undefined) {
      yield* secrets
        .delete(row.token_secret_name)
        .pipe(
          Effect.mapError(
            toWorkSourceConnectionStoreError("Failed to remove connection token secret"),
          ),
        );
    }

    yield* sql`
        DELETE FROM p_workflow_boards_work_source_connection WHERE connection_ref = ${connectionRef}
      `.pipe(
      Effect.mapError(
        toWorkSourceConnectionStoreError("Failed to delete work source connection row"),
      ),
    );
  });

  return {
    getToken,
    getConnectionAuth,
    create,
    list,
    remove,
  } satisfies WorkSourceConnectionStoreShape;
});

export const WorkSourceConnectionStoreLive = Layer.effect(WorkSourceConnectionStore, make);
