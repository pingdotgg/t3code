/**
 * WorkflowOutboundConnectionStore — Layer implementation.
 *
 * Persists outbound connection metadata to the `workflow_outbound_connection`
 * SQLite table and stores the destination URL bytes in `ServerSecretStore`
 * under `outbound-target:<connectionRef>`.
 *
 * create: SSRF-validate the URL via OutboundUrlValidator first (fail early,
 *   no row or secret written). Then generate connectionRef via
 *   WorkflowIds.eventId() (produces "evt-<uuid>"), prefix to "conn-<id>",
 *   store URL in secret store, INSERT row, return view (no URL).
 *
 * list: SELECT all rows DESC by created_at → views (no URL).
 *
 * getTarget: SELECT kind + secret_name WHERE connection_ref=?, then read
 *   the secret → { kind, url }. Fails OutboundConfigError if not found.
 *
 * remove: read secret_name, DELETE row, best-effort delete secret.
 *   Does NOT scan boards for dangling refs (matches WorkSourceConnectionStore).
 *
 * Validator injection seam: the Live layer accepts an optional `lookup`
 * function (UrlValidatorDeps) that is forwarded to OutboundUrlValidator.validate.
 * Production wiring uses the real DNS default (undefined → defaultLookup).
 * Tests inject a stub lookup that resolves to a fixed public IP (SSRF ok) or
 * a private IP (SSRF reject) — no real DNS queries in the test suite.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OutboundConnectionKind, OutboundConnectionView } from "@t3tools/contracts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { OutboundUrlValidator, type UrlValidatorDeps } from "../outbound/OutboundUrlValidator.ts";
import { WorkflowIds } from "../Services/WorkflowIds.ts";
import {
  OutboundConfigError,
  WorkflowOutboundConnectionStore,
  type WorkflowOutboundConnectionStoreShape,
} from "../Services/WorkflowOutboundConnectionStore.ts";

interface ConnectionRow {
  readonly connection_ref: string;
  readonly kind: string;
  readonly display_name: string;
  readonly secret_name: string;
  readonly created_at: string;
}

const toOutboundConfigError = (reason: string) => (cause: unknown) =>
  new OutboundConfigError({ reason: `${reason}: ${String(cause)}` });

const toView = (row: ConnectionRow): OutboundConnectionView => ({
  connectionRef: row.connection_ref,
  kind: row.kind as OutboundConnectionKind,
  displayName: row.display_name,
  createdAt: row.created_at,
});

/**
 * Build the WorkflowOutboundConnectionStore implementation.
 *
 * @param validatorDeps - Optional DNS lookup override for OutboundUrlValidator.
 *   Pass undefined (default) to use the real DNS resolver in production.
 *   Pass a stub lookup in tests to keep them hermetic.
 */
const makeWithDeps = (validatorDeps: UrlValidatorDeps | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const ids = yield* WorkflowIds;

    const create: WorkflowOutboundConnectionStoreShape["create"] = Effect.fn(
      "WorkflowOutboundConnectionStore.create",
    )(function* (input) {
      // SSRF validation first — fail before touching DB or secret store.
      yield* OutboundUrlValidator.validate(input.url, validatorDeps).pipe(
        Effect.mapError((e) => new OutboundConfigError({ reason: e.reason })),
      );

      const eventId = yield* ids.eventId();
      const connectionRef = `conn-${eventId}`;
      const secretName = `outbound-target:${connectionRef}`;
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);

      // Store the secret BEFORE inserting the row so a LISTED connection always
      // has a usable secret (no row-exists-but-secret-missing state, which would
      // make getTarget fail at delivery time for a connection the UI shows as
      // valid). If the row insert then fails, best-effort remove the just-written
      // secret so it isn't orphaned (secretStore.remove is idempotent on missing;
      // connectionRef is unique per call, so there is nothing else to clobber).
      yield* secretStore
        .set(secretName, new TextEncoder().encode(input.url))
        .pipe(Effect.mapError(toOutboundConfigError("Failed to store connection URL secret")));

      yield* sql`
          INSERT INTO workflow_outbound_connection (
            connection_ref,
            kind,
            display_name,
            secret_name,
            created_at
          ) VALUES (
            ${connectionRef},
            ${input.kind},
            ${input.displayName},
            ${secretName},
            ${createdAt}
          )
        `.pipe(
        Effect.tapError(() => secretStore.remove(secretName).pipe(Effect.ignore)),
        Effect.mapError(toOutboundConfigError("Failed to insert outbound connection")),
      );

      return {
        connectionRef,
        kind: input.kind,
        displayName: input.displayName,
        createdAt,
      } satisfies OutboundConnectionView;
    });

    const list: WorkflowOutboundConnectionStoreShape["list"] = () =>
      sql<ConnectionRow>`
        SELECT connection_ref, kind, display_name, secret_name, created_at
        FROM workflow_outbound_connection
        ORDER BY created_at DESC
      `.pipe(
        Effect.map((rows) => rows.map(toView)),
        Effect.mapError(toOutboundConfigError("Failed to list outbound connections")),
        Effect.withSpan("WorkflowOutboundConnectionStore.list"),
      );

    const getTarget: WorkflowOutboundConnectionStoreShape["getTarget"] = Effect.fn(
      "WorkflowOutboundConnectionStore.getTarget",
    )(function* (connectionRef) {
      const rows = yield* sql<{ readonly kind: string; readonly secret_name: string }>`
          SELECT kind, secret_name
          FROM workflow_outbound_connection
          WHERE connection_ref = ${connectionRef}
        `.pipe(Effect.mapError(toOutboundConfigError("Failed to look up outbound connection")));

      const row = rows[0];
      if (row === undefined) {
        return yield* new OutboundConfigError({
          reason: `No outbound connection found for ref: ${connectionRef}`,
        });
      }

      const maybeBytes = yield* secretStore
        .get(row.secret_name)
        .pipe(
          Effect.mapError(toOutboundConfigError("Failed to read outbound connection URL secret")),
        );

      if (Option.isNone(maybeBytes)) {
        return yield* new OutboundConfigError({
          reason: `Secret missing for outbound connection: ${connectionRef}`,
        });
      }

      return {
        kind: row.kind as OutboundConnectionKind,
        url: new TextDecoder().decode(maybeBytes.value),
      };
    });

    const remove: WorkflowOutboundConnectionStoreShape["remove"] = Effect.fn(
      "WorkflowOutboundConnectionStore.remove",
    )(function* (connectionRef) {
      const rows = yield* sql<{ readonly secret_name: string }>`
          SELECT secret_name FROM workflow_outbound_connection WHERE connection_ref = ${connectionRef}
        `.pipe(
        Effect.mapError(toOutboundConfigError("Failed to look up outbound connection for removal")),
      );

      // Delete the secret BEFORE the row, surfacing errors (do NOT ignore).
      // This makes the durable step retryable: if the secret delete fails the
      // row still exists, so a retried remove can complete the full deletion.
      // ServerSecretStore.remove is idempotent on a missing secret (catches
      // NotFound → void), so re-removal of an already-secretless row succeeds.
      // Mirrors WorkSourceConnectionStore.remove exactly.
      const row = rows[0];
      if (row !== undefined) {
        yield* secretStore
          .remove(row.secret_name)
          .pipe(Effect.mapError(toOutboundConfigError("Failed to remove connection URL secret")));
      }

      yield* sql`
          DELETE FROM workflow_outbound_connection WHERE connection_ref = ${connectionRef}
        `.pipe(Effect.mapError(toOutboundConfigError("Failed to delete outbound connection row")));
    });

    return {
      create,
      list,
      getTarget,
      remove,
    } satisfies WorkflowOutboundConnectionStoreShape;
  });

/** Production layer — uses real DNS for SSRF validation. */
export const WorkflowOutboundConnectionStoreLive = Layer.effect(
  WorkflowOutboundConnectionStore,
  makeWithDeps(undefined),
);

/**
 * Factory for test/custom layers — inject a stub `lookup` to avoid real DNS.
 *
 * Example (test):
 *   const stubDeps = { lookup: (_host) => Effect.succeed(["140.82.112.3"]) }
 *   WorkflowOutboundConnectionStoreLayer(stubDeps)
 */
export const WorkflowOutboundConnectionStoreLayer = (
  validatorDeps: UrlValidatorDeps,
): Layer.Layer<
  WorkflowOutboundConnectionStore,
  never,
  SqlClient.SqlClient | ServerSecretStore.ServerSecretStore | WorkflowIds
> => Layer.effect(WorkflowOutboundConnectionStore, makeWithDeps(validatorDeps));
