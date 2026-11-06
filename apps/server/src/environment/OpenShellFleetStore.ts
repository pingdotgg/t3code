import {
  EnvironmentId,
  OpenShellDrainProgress,
  OpenShellFleetState,
  OpenShellWorkerClass,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeDrain = Schema.decodeUnknownEffect(
  Schema.NullOr(Schema.fromJsonString(OpenShellDrainProgress)),
);
const encodeDrain = Schema.encodeEffect(
  Schema.NullOr(Schema.fromJsonString(OpenShellDrainProgress)),
);

/** One gateway-managed environment as the fleet lifecycle store keeps it. */
export interface FleetEnvironment {
  readonly environmentId: EnvironmentId;
  readonly state: OpenShellFleetState;
  readonly workerClass: OpenShellWorkerClass;
  readonly label: string | null;
  readonly sandboxName: string | null;
  readonly sandboxId: string | null;
  /** Aggregate drain journal progress; per-item acks live with the drain protocol. */
  readonly drain: OpenShellDrainProgress | null;
  /** Ephemeral workers: epoch-ms retirement deadline managed by this instance. */
  readonly expiresAt: number | null;
  readonly lastError: string | null;
  readonly updatedAt: DateTime.Utc;
}

export class OpenShellFleetStoreError extends Schema.TaggedError<OpenShellFleetStoreError>()(
  "OpenShellFleetStoreError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const failStorage = (cause: unknown) =>
  Effect.logWarning("OpenShell fleet state storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new OpenShellFleetStoreError({
          message:
            "The fleet environment state could not be read or saved here. The server log has details.",
          cause,
        }),
      ),
    ),
  );

/**
 * Lifecycle states a restart interrupts. The spec's reconciler (section 5.5)
 * settles them against the gateway once a driver exists; until then the store
 * surfaces them, so nothing is silently dropped and nothing is deleted.
 */
const interruptedStates: ReadonlyArray<OpenShellFleetState> = [
  "provisioning",
  "pairing",
  "draining",
  "deleting",
];

/**
 * Fleet lifecycle state for gateway-managed environments (spec section 5.3):
 * the row, not the gateway phase, is this instance's truth, so state survives
 * a restart. Writes are upserts keyed by environment id.
 */
export class OpenShellFleetStore extends Context.Service<
  OpenShellFleetStore,
  {
    readonly upsert: (input: {
      readonly environmentId: EnvironmentId;
      readonly state: OpenShellFleetState;
      readonly workerClass: OpenShellWorkerClass;
      readonly label?: string;
      readonly sandboxName?: string;
      readonly sandboxId?: string;
      readonly expiresAt?: number;
    }) => Effect.Effect<FleetEnvironment, OpenShellFleetStoreError>;
    readonly setState: (
      environmentId: EnvironmentId,
      state: OpenShellFleetState,
      lastError?: string,
    ) => Effect.Effect<Option.Option<FleetEnvironment>, OpenShellFleetStoreError>;
    readonly setDrain: (
      environmentId: EnvironmentId,
      drain: OpenShellDrainProgress | null,
    ) => Effect.Effect<Option.Option<FleetEnvironment>, OpenShellFleetStoreError>;
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<FleetEnvironment>, OpenShellFleetStoreError>;
    readonly list: Effect.Effect<ReadonlyArray<FleetEnvironment>, OpenShellFleetStoreError>;
    /**
     * Rows the restart interrupted (spec section 5.5): still owed their drain
     * or deletion. OPEN-QUESTION (spec section 5.5): adopt-or-sweep lands
     * with the gateway driver; the default keeps every interrupted row.
     */
    readonly interrupted: Effect.Effect<ReadonlyArray<FleetEnvironment>, OpenShellFleetStoreError>;
    /** Forgets the row; the caller drains first (spec section 7) and deletes the sandbox itself. */
    readonly remove: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<boolean, OpenShellFleetStoreError>;
  }
>()("t3/environment/OpenShellFleetStore") {}

interface FleetRow {
  readonly environment_id: string;
  readonly state: string;
  readonly worker_class: string;
  readonly label: string | null;
  readonly sandbox_name: string | null;
  readonly sandbox_id: string | null;
  readonly drain_json: string | null;
  readonly expires_at: number | null;
  readonly last_error: string | null;
  readonly updated_at: string;
}

const decodeState = Schema.decodeUnknownEffect(OpenShellFleetState);
const decodeWorkerClass = Schema.decodeUnknownEffect(Schema.Literals(["ephemeral", "persistent"]));

const toFleetEnvironment = Effect.fn("OpenShellFleetStore.toFleetEnvironment")(function* (
  row: FleetRow,
) {
  const state = yield* decodeState(row.state).pipe(Effect.catch(failStorage));
  const workerClass = yield* decodeWorkerClass(row.worker_class).pipe(Effect.catch(failStorage));
  return {
    environmentId: EnvironmentId.make(row.environment_id),
    state,
    workerClass,
    label: row.label,
    sandboxName: row.sandbox_name,
    sandboxId: row.sandbox_id,
    drain: yield* decodeDrain(row.drain_json).pipe(Effect.catch(failStorage)),
    expiresAt: row.expires_at,
    lastError: row.last_error,
    updatedAt: DateTime.makeUnsafe(row.updated_at),
  } satisfies FleetEnvironment;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRows = sql<FleetRow>`
    SELECT * FROM openshell_fleet_environments ORDER BY environment_id
  `.pipe(NodeSqliteClient.readOnly, Effect.catch(failStorage));

  const readRow = (environmentId: EnvironmentId) =>
    sql<FleetRow>`
      SELECT * FROM openshell_fleet_environments WHERE environment_id = ${environmentId}
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.catch(failStorage),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  // Crash recovery: what a restart interrupted, read back once at startup so
  // the row states this instance owed are visible without a driver (spec
  // section 5.5). Nothing is mutated: a kept state is a kept obligation.
  yield* Effect.forEach(yield* readRows, toFleetEnvironment).pipe(
    Effect.tap((rows) => {
      const interruptedRows = rows.filter((row) => interruptedStates.includes(row.state));
      return interruptedRows.length > 0
        ? Effect.logWarning("Fleet environments interrupted by this restart keep their state", {
            environments: interruptedRows.map((row) => ({
              environmentId: row.environmentId,
              state: row.state,
            })),
          })
        : Effect.void;
    }),
    Effect.catch(failStorage),
  );

  const upsert: OpenShellFleetStore["Service"]["upsert"] = Effect.fn("OpenShellFleetStore.upsert")(
    function* (input) {
      const now = yield* DateTime.now;
      yield* sql`
      INSERT INTO openshell_fleet_environments (
        environment_id, state, worker_class, label, sandbox_name, sandbox_id,
        drain_json, expires_at, last_error, updated_at
      ) VALUES (
        ${input.environmentId}, ${input.state}, ${input.workerClass},
        ${input.label ?? null}, ${input.sandboxName ?? null}, ${input.sandboxId ?? null},
        NULL, ${input.expiresAt ?? null}, NULL, ${DateTime.formatIso(now)}
      )
      ON CONFLICT (environment_id) DO UPDATE SET
        state = excluded.state,
        worker_class = excluded.worker_class,
        label = excluded.label,
        sandbox_name = excluded.sandbox_name,
        sandbox_id = excluded.sandbox_id,
        expires_at = excluded.expires_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `.pipe(Effect.catch(failStorage));
      return Option.getOrThrow(yield* get(input.environmentId));
    },
  );

  const get: OpenShellFleetStore["Service"]["get"] = (environmentId) =>
    readRow(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => Effect.asSome(toFleetEnvironment(row)),
        }),
      ),
    );

  const setState: OpenShellFleetStore["Service"]["setState"] = (environmentId, state, lastError) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        sql<{ environment_id: string }>`
          UPDATE openshell_fleet_environments
          SET state = ${state}, last_error = ${lastError ?? null},
              updated_at = ${DateTime.formatIso(now)}
          WHERE environment_id = ${environmentId}
          RETURNING environment_id
        `.pipe(Effect.catch(failStorage)),
      ),
      Effect.flatMap((updated) => (updated.length > 0 ? get(environmentId) : Effect.succeedNone)),
    );

  const setDrain: OpenShellFleetStore["Service"]["setDrain"] = (environmentId, drain) =>
    encodeDrain(drain).pipe(
      Effect.catch(failStorage),
      Effect.flatMap((drainJson) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            sql<{ environment_id: string }>`
              UPDATE openshell_fleet_environments
              SET drain_json = ${drainJson}, updated_at = ${DateTime.formatIso(now)}
              WHERE environment_id = ${environmentId}
              RETURNING environment_id
            `.pipe(Effect.catch(failStorage)),
          ),
        ),
      ),
      Effect.flatMap((updated) => (updated.length > 0 ? get(environmentId) : Effect.succeedNone)),
    );

  const list: OpenShellFleetStore["Service"]["list"] = readRows.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, toFleetEnvironment)),
  );

  const interruptedRows = Effect.map(list, (rows) =>
    rows.filter((row) => interruptedStates.includes(row.state)),
  );

  const remove: OpenShellFleetStore["Service"]["remove"] = (environmentId) =>
    sql<{ environment_id: string }>`
      DELETE FROM openshell_fleet_environments WHERE environment_id = ${environmentId}
      RETURNING environment_id
    `.pipe(
      Effect.map((deleted) => deleted.length > 0),
      Effect.catch(failStorage),
    );

  return OpenShellFleetStore.of({
    upsert,
    setState,
    setDrain,
    get,
    list,
    interrupted: interruptedRows,
    remove,
  });
});

export const layer = Layer.effect(OpenShellFleetStore, make);
