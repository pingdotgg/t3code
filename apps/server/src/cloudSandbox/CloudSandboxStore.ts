import { ManagedCloudSandboxResource, ManagedCloudSandboxProvisionInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class CloudSandboxManagerError extends Schema.TaggedError<CloudSandboxManagerError>()(
  "CloudSandboxManagerError",
  {
    reason: Schema.Literals([
      "not-found",
      "conflict",
      "deleted",
      "ownership",
      "transport",
      "provider",
      "rate-limited",
      "storage",
      "budget",
      "concurrency",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
    rateLimit: Schema.optionalKey(
      Schema.Struct({
        scope: Schema.Literals(["paced", "capped", "capacity"]),
        window: Schema.optionalKey(Schema.Literals(["minute", "hour", "day"])),
        waitMs: Schema.optionalKey(Schema.Number),
      }),
    ),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not-found":
        return "The managed cloud sandbox does not exist.";
      case "conflict":
        return "The cloud operation conflicts with an existing operation.";
      case "deleted":
        return "The managed cloud sandbox was deleted.";
      case "ownership":
        return "This action is not permitted for this cloud sandbox.";
      case "transport":
        return "The managed cloud connection could not be established.";
      case "provider":
        return "The cloud provider could not complete this operation.";
      case "rate-limited":
        return "The cloud provider rate-limited this operation; retry shortly.";
      case "storage":
        return "The managed cloud state could not be saved or read.";
      case "budget":
        return "The profile's monthly cloud budget is exhausted.";
      case "concurrency":
        return "The profile's concurrent sandbox limit is reached.";
    }
  }
}
const { phase: _phase, ...ResourceFields } = ManagedCloudSandboxResource.fields;
export const CloudSandboxRecord = Schema.Struct({
  ...ResourceFields,
  lifecycle: Schema.Literals(["allocating", "active", "deleting", "deleted", "failed"]),
  power: Schema.Literals(["running", "stopped"]),
  intent: Schema.Literals(["connected", "disconnected"]),
  selection: ManagedCloudSandboxProvisionInput.fields.sandbox,
  snapshotName: Schema.NullOr(Schema.String),
  snapshotReady: Schema.Boolean,
  deletionOperationId: Schema.NullOr(Schema.String),
  finalSpendUsd: Schema.NullOr(Schema.Number),
  enableLinkedEnvironments: Schema.Boolean,
});
export type CloudSandboxRecord = typeof CloudSandboxRecord.Type;

/** A sandbox that holds, or is still acquiring, a VM against its profile's limits. */
/** A deleting record still has a VM, and its cost, until deletion finishes. */
export const isLiveRecord = (record: CloudSandboxRecord): boolean =>
  record.lifecycle === "allocating" ||
  record.lifecycle === "active" ||
  (record.lifecycle === "deleting" && record.sandboxId !== null);

export const isRunningRecord = (record: CloudSandboxRecord): boolean =>
  isLiveRecord(record) && record.power === "running";
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudSandboxRecord));
export class CloudSandboxStore extends Context.Service<
  CloudSandboxStore,
  {
    readonly get: (
      resourceId: string,
    ) => Effect.Effect<Option.Option<CloudSandboxRecord>, CloudSandboxManagerError>;
    readonly list: Effect.Effect<readonly CloudSandboxRecord[], CloudSandboxManagerError>;
    readonly save: (record: CloudSandboxRecord) => Effect.Effect<void, CloudSandboxManagerError>;
  }
>()("t3/cloudSandbox/CloudSandboxStore") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const list = sql<{ payload_json: string }>`SELECT payload_json FROM managed_cloud_sandboxes`.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decode(row.payload_json))),
    Effect.mapError((cause) => new CloudSandboxManagerError({ reason: "storage", cause })),
  );
  return CloudSandboxStore.of({
    list,
    get: Effect.fn("CloudSandboxStore.get")(
      function* (resourceId) {
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM managed_cloud_sandboxes WHERE resource_id = ${resourceId}`;
        const row = rows[0];
        return row ? Option.some(yield* decode(row.payload_json)) : Option.none();
      },
      Effect.mapError((cause) => new CloudSandboxManagerError({ reason: "storage", cause })),
    ),
    save: Effect.fn("CloudSandboxStore.save")((record) =>
      sql`
      INSERT INTO managed_cloud_sandboxes(resource_id, payload_json)
      VALUES (${record.resourceId}, ${JSON.stringify(record)})
      ON CONFLICT(resource_id) DO UPDATE SET payload_json = excluded.payload_json
    `.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new CloudSandboxManagerError({ reason: "storage", cause })),
      ),
    ),
  });
});
export const layer = Layer.effect(CloudSandboxStore, make);
