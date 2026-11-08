import { cloudSandboxCapabilities, createCloudSandboxDriver } from "@t3tools/cloud-sandbox";
import {
  CloudSandboxProfile,
  CloudSandboxProfileError,
  type CloudSandboxProfileSaveInput,
  type CloudSandboxProfileTestInput,
  type CloudSandboxProfileStatus,
  type CloudSandboxProfileSpend,
  type CloudSandboxCapabilities,
  type SandboxProfileId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Store from "./CloudSandboxStore.ts";

const secretKey = (profileId: string) => `cloud-sandbox-profile-${profileId}`;

/** Stored per profile; the API key lives only in the secret store. */
const Payload = Schema.Struct({
  profile: CloudSandboxProfile,
  spend: Schema.optionalKey(
    Schema.Struct({
      period: Schema.String,
      usd: Schema.Number,
      resourceIds: Schema.Array(Schema.String),
    }),
  ),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Payload));
const encode = Schema.encodeEffect(Schema.fromJsonString(Payload));
const currentPeriod = Effect.map(DateTime.now, (now) => DateTime.formatIso(now).slice(0, 7));

export class CloudSandboxProfiles extends Context.Service<
  CloudSandboxProfiles,
  {
    readonly list: Effect.Effect<
      readonly {
        readonly profile: CloudSandboxProfile;
        readonly spend: CloudSandboxProfileSpend | null;
      }[],
      CloudSandboxProfileError
    >;
    readonly save: (
      input: CloudSandboxProfileSaveInput,
    ) => Effect.Effect<CloudSandboxProfile, CloudSandboxProfileError>;
    readonly saveStatus: (
      input: CloudSandboxProfileSaveInput,
    ) => Effect.Effect<CloudSandboxProfileStatus, CloudSandboxProfileError>;
    readonly remove: (profileId: SandboxProfileId) => Effect.Effect<void, CloudSandboxProfileError>;
    /** The profile and its provider credential, for provision paths. */
    readonly resolve: (
      profileId: SandboxProfileId,
    ) => Effect.Effect<
      { readonly profile: CloudSandboxProfile; readonly apiKey: string },
      CloudSandboxProfileError
    >;
    readonly recordSpend: (
      profileId: SandboxProfileId,
      resourceId: string,
      usd: number,
    ) => Effect.Effect<CloudSandboxProfileSpend, CloudSandboxProfileError>;
    readonly spendOf: (
      profileId: SandboxProfileId,
    ) => Effect.Effect<CloudSandboxProfileSpend | null, CloudSandboxProfileError>;
    readonly test: (
      input: CloudSandboxProfileTestInput,
    ) => Effect.Effect<CloudSandboxCapabilities, CloudSandboxProfileError>;
  }
>()("t3/cloudSandbox/CloudSandboxProfiles") {}

const isCloudSandboxProfileError = Schema.is(CloudSandboxProfileError);

const storage = (cause: unknown): CloudSandboxProfileError =>
  isCloudSandboxProfileError(cause) ? cause : new CloudSandboxProfileError({ reason: "storage" });

const runningCount = (
  profileId: SandboxProfileId,
  sandboxes: readonly Store.CloudSandboxRecord[],
): number =>
  sandboxes.filter(
    (resource) => resource.profileId === profileId && Store.isRunningRecord(resource),
  ).length;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const resources = yield* Store.CloudSandboxStore;
  const writes = yield* Semaphore.make(1);
  const testCredential = Effect.fn("CloudSandboxProfiles.testCredential")(
    function* (driverKind: CloudSandboxProfile["driverKind"], apiKey: string) {
      const driver = yield* createCloudSandboxDriver(driverKind, { apiKey, httpClient });
      yield* driver.list();
      return cloudSandboxCapabilities(driver);
    },
    Effect.mapError(() => new CloudSandboxProfileError({ reason: "provider" })),
  );
  const load = Effect.fn("CloudSandboxProfiles.load")(function* (profileId: string) {
    const rows = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM sandbox_profiles WHERE profile_id = ${profileId}
      `;
    const row = rows[0];
    return row ? Option.some(yield* decode(row.payload_json)) : Option.none();
  }, Effect.mapError(storage));
  const readKey = Effect.fn("CloudSandboxProfiles.readKey")(function* (profileId: string) {
    const stored = yield* secrets.get(secretKey(profileId));
    return Option.isSome(stored) ? new TextDecoder().decode(stored.value) : "";
  }, Effect.mapError(storage));
  const spendOf = Effect.fn("CloudSandboxProfiles.spendOf")(function* (
    profileId: SandboxProfileId,
  ) {
    const found = yield* load(profileId);
    if (Option.isNone(found)) return yield* new CloudSandboxProfileError({ reason: "not-found" });
    const period = yield* currentPeriod;
    const spend = found.value.spend;
    if (spend === undefined || spend.period !== period) return null;
    const sandboxes = yield* resources.list.pipe(Effect.mapError(storage));
    return {
      period: spend.period,
      usd: spend.usd,
      running: runningCount(profileId, sandboxes),
    };
  });
  const saveUnlocked = Effect.fn("CloudSandboxProfiles.saveUnlocked")(function* (
    input: CloudSandboxProfileSaveInput,
  ) {
    const existing = yield* load(input.profileId);
    const apiKey = input.apiKey?.trim();
    if (apiKey !== undefined && apiKey !== "") {
      yield* testCredential(input.driverKind, apiKey);
      yield* secrets.set(secretKey(input.profileId), new TextEncoder().encode(apiKey));
    }
    const apiKeySet =
      apiKey !== undefined && apiKey !== ""
        ? true
        : Option.isSome(existing)
          ? existing.value.profile.apiKeySet
          : false;
    const payload: typeof Payload.Type = {
      profile: {
        profileId: input.profileId,
        name: input.name,
        driverKind: input.driverKind,
        apiKeySet,
        defaultSize: input.defaultSize,
        autoStopMinutes: input.autoStopMinutes,
        template: input.template,
        monthlyBudgetUsd: input.monthlyBudgetUsd,
        maxConcurrentSandboxes: input.maxConcurrentSandboxes,
      },
      ...(Option.isSome(existing) && existing.value.spend !== undefined
        ? { spend: existing.value.spend }
        : {}),
    };
    yield* sql`
        INSERT INTO sandbox_profiles(profile_id, payload_json)
        VALUES (${input.profileId}, ${yield* encode(payload)})
        ON CONFLICT(profile_id) DO UPDATE SET payload_json = excluded.payload_json
      `;
    return payload.profile;
  }, Effect.mapError(storage));
  const save = Effect.fn("CloudSandboxProfiles.save")(function* (
    input: CloudSandboxProfileSaveInput,
  ) {
    return yield* writes.withPermits(1)(saveUnlocked(input));
  });
  const recordSpendUnlocked = Effect.fn("CloudSandboxProfiles.writeSpend")(function* (
    profileId: SandboxProfileId,
    resourceId: string,
    usd: number,
  ) {
    const found = yield* load(profileId);
    if (Option.isNone(found)) return yield* new CloudSandboxProfileError({ reason: "not-found" });
    const period = yield* currentPeriod;
    const current = found.value.spend?.period === period ? found.value.spend : undefined;
    const counted = current?.resourceIds ?? [];
    const baseUsd =
      current !== undefined && Number.isFinite(current.usd) && current.usd > 0 ? current.usd : 0;
    const deltaUsd = Number.isFinite(usd) && usd > 0 ? usd : 0;
    const spend = counted.includes(resourceId)
      ? { period, usd: baseUsd, resourceIds: counted }
      : { period, usd: baseUsd + deltaUsd, resourceIds: [...counted, resourceId] };
    if (!counted.includes(resourceId)) {
      const payload: typeof Payload.Type = { ...found.value, spend };
      yield* sql`
        INSERT INTO sandbox_profiles(profile_id, payload_json)
        VALUES (${profileId}, ${yield* encode(payload)})
        ON CONFLICT(profile_id) DO UPDATE SET payload_json = excluded.payload_json
      `;
    }
    const sandboxes = yield* resources.list;
    return { period, usd: spend.usd, running: runningCount(profileId, sandboxes) };
  }, Effect.mapError(storage));
  return CloudSandboxProfiles.of({
    list: Effect.gen(function* () {
      const rows = yield* sql<{ payload_json: string }>`
        SELECT payload_json FROM sandbox_profiles
      `;
      const payloads = yield* Effect.forEach(rows, (row) => decode(row.payload_json));
      const sandboxes = yield* resources.list;
      const period = yield* currentPeriod;
      return payloads.flatMap((payload) => {
        const spend =
          payload.spend === undefined || payload.spend.period !== period
            ? null
            : {
                period: payload.spend.period,
                usd: payload.spend.usd,
                running: runningCount(payload.profile.profileId, sandboxes),
              };
        return [{ profile: payload.profile, spend }];
      });
    }).pipe(Effect.mapError(storage), Effect.withSpan("CloudSandboxProfiles.list")),
    save,
    saveStatus: Effect.fn("CloudSandboxProfiles.saveStatus")(function* (
      input: CloudSandboxProfileSaveInput,
    ) {
      const profile = yield* save(input);
      return { profile, spend: yield* spendOf(profile.profileId) };
    }),
    remove: Effect.fn("CloudSandboxProfiles.remove")(function* (profileId: SandboxProfileId) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const sandboxes = yield* resources.list;
          if (
            sandboxes.some(
              (resource) => resource.profileId === profileId && resource.lifecycle !== "deleted",
            )
          )
            return yield* new CloudSandboxProfileError({
              reason: "in-use",
              detail: "Sandboxes provisioned from this profile still exist. Remove them first.",
            });
          yield* sql`DELETE FROM sandbox_profiles WHERE profile_id = ${profileId}`;
        }),
      );
      yield* secrets.remove(secretKey(profileId));
    }, Effect.mapError(storage)),
    resolve: Effect.fn("CloudSandboxProfiles.resolve")(function* (profileId: SandboxProfileId) {
      const found = yield* load(profileId);
      if (Option.isNone(found)) return yield* new CloudSandboxProfileError({ reason: "not-found" });
      const apiKey = yield* readKey(profileId);
      if (apiKey === "") return yield* new CloudSandboxProfileError({ reason: "missing-key" });
      return { profile: found.value.profile, apiKey };
    }),
    recordSpend: Effect.fn("CloudSandboxProfiles.recordSpend")((profileId, resourceId, usd) =>
      writes.withPermits(1)(recordSpendUnlocked(profileId, resourceId, usd)),
    ),
    spendOf,
    test: Effect.fn("CloudSandboxProfiles.test")(function* (input: CloudSandboxProfileTestInput) {
      if ("apiKey" in input) return yield* testCredential(input.driverKind, input.apiKey);
      const { profileId } = input;
      const found = yield* load(profileId);
      if (Option.isNone(found)) return yield* new CloudSandboxProfileError({ reason: "not-found" });
      const apiKey = yield* readKey(profileId);
      if (apiKey === "") return yield* new CloudSandboxProfileError({ reason: "missing-key" });
      return yield* testCredential(found.value.profile.driverKind, apiKey);
    }),
  });
});
export const layer = Layer.effect(CloudSandboxProfiles, make).pipe(Layer.provide(Store.layer));
