import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { EnvironmentId, ManagedCloudSandboxResourceId, SandboxProfileId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Profiles from "./CloudSandboxProfiles.ts";
import * as Store from "./CloudSandboxStore.ts";

const profileId = SandboxProfileId.make("boat");
const input = {
  profileId,
  name: "Boat",
  driverKind: "boat",
  defaultSize: "small",
  autoStopMinutes: 60,
  template: null,
  monthlyBudgetUsd: 25,
  maxConcurrentSandboxes: 3,
} as const;
const resource: Store.CloudSandboxRecord = {
  resourceId: ManagedCloudSandboxResourceId.make("owned"),
  controllerEnvironmentId: EnvironmentId.make("controller"),
  profileId,
  driverKind: "boat",
  sandboxId: "bx_23456789",
  parentResourceId: null,
  lifecycle: "active",
  power: "running",
  intent: "connected",
  environmentId: EnvironmentId.make("child"),
  label: "Child",
  recordingIds: [],
  selection: { name: "Child", size: "small", autoStopMinutes: 60 },
  snapshotName: null,
  snapshotReady: false,
  deletionOperationId: null,
  finalSpendUsd: null,
  enableLinkedEnvironments: true,
};
const layer = Profiles.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-sandbox-profiles-" })),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provide(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.headers.authorization === "Bearer working-key"
              ? Response.json({ ok: true, sandboxes: [] })
              : Response.json({ message: "Invalid API key" }, { status: 401 }),
          ),
        ),
      ),
    ),
  ),
);

it.effect("preserves the stored credential when replacement validation fails", () =>
  Effect.gen(function* () {
    const profiles = yield* Profiles.CloudSandboxProfiles;
    yield* profiles.save({ ...input, apiKey: "working-key" });
    yield* profiles.test({ driverKind: "boat", apiKey: "working-key" });
    expect((yield* profiles.resolve(profileId)).apiKey).toBe("working-key");
    const rejected = yield* profiles.save({ ...input, apiKey: "invalid-key" }).pipe(Effect.result);
    expect(rejected._tag).toBe("Failure");
    expect((yield* profiles.resolve(profileId)).apiKey).toBe("working-key");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("refuses to delete a profile while it owns a sandbox", () =>
  Effect.gen(function* () {
    const profiles = yield* Profiles.CloudSandboxProfiles;
    const sql = yield* SqlClient.SqlClient;
    yield* profiles.save({ ...input, apiKey: "working-key" });
    yield* sql`INSERT INTO managed_cloud_sandboxes(resource_id, payload_json)
      VALUES ('owned', ${JSON.stringify(resource)})`;
    const refused = yield* profiles.remove(profileId).pipe(Effect.result);
    expect(refused._tag).toBe("Failure");
    expect((yield* profiles.resolve(profileId)).profile.profileId).toBe(profileId);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("persists the concurrent sandbox limit with the profile", () =>
  Effect.gen(function* () {
    const profiles = yield* Profiles.CloudSandboxProfiles;
    yield* profiles.save({ ...input, apiKey: "working-key", maxConcurrentSandboxes: 7 });
    expect((yield* profiles.resolve(profileId)).profile.maxConcurrentSandboxes).toBe(7);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("keeps monthly spend monotonic and finite when given NaN or negative increments", () =>
  Effect.gen(function* () {
    const profiles = yield* Profiles.CloudSandboxProfiles;
    yield* profiles.save({ ...input, apiKey: "working-key" });
    expect((yield* profiles.recordSpend(profileId, "a", 5)).usd).toBe(5);
    expect((yield* profiles.recordSpend(profileId, "b", Number.NaN)).usd).toBe(5);
    expect((yield* profiles.recordSpend(profileId, "c", -3)).usd).toBe(5);
    expect((yield* profiles.recordSpend(profileId, "d", 2.5)).usd).toBe(7.5);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("counts a resource's spend once when its release is recorded again", () =>
  Effect.gen(function* () {
    const profiles = yield* Profiles.CloudSandboxProfiles;
    yield* profiles.save({ ...input, apiKey: "working-key" });
    expect((yield* profiles.recordSpend(profileId, "owned", 5)).usd).toBe(5);
    expect((yield* profiles.recordSpend(profileId, "owned", 5)).usd).toBe(5);
    expect((yield* profiles.recordSpend(profileId, "other", 2)).usd).toBe(7);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
