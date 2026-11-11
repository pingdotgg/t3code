import { expect, it } from "@effect/vitest";
import {
  CURSOR_CLOUD_INSTANCE_ID,
  CursorCloudError,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { ProviderCloudAccess, ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CursorCloud from "./CursorCloud.ts";
import * as ServerSettings from "../serverSettings.ts";

function fixture() {
  const instances = new Map<ProviderInstanceId, ProviderInstance>();
  const checks: Array<ProviderInstanceId> = [];
  const add = (id: ProviderInstanceId, enabled = true, driver = "cursor", authenticated = true) => {
    const cloudAccess: ProviderCloudAccess = {
      check: authenticated
        ? Effect.sync(() => {
            checks.push(id);
          })
        : Effect.fail(new CursorCloudError({ reason: "authentication" })),
    };
    const driverKind = ProviderDriverKind.make(driver);
    instances.set(id, {
      instanceId: id,
      driverKind,
      enabled,
      displayName: undefined,
      cloudAccess,
      continuationIdentity: { driverKind, continuationKey: id },
      get snapshot(): never {
        throw new Error("Cloud access must use live auth rather than a cached snapshot");
      },
      get orchestrationAdapter(): never {
        throw new Error("Cloud access must not start local agents");
      },
      get textGeneration(): never {
        throw new Error("Cloud access must not generate local text");
      },
    });
    return cloudAccess;
  };
  const dependencies = Layer.mergeAll(
    ServerSettings.layerTest(),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) => Effect.sync(() => instances.get(id)),
    }),
  );
  return {
    dependencies,
    layer: CursorCloud.layer.pipe(Layer.provideMerge(dependencies)),
    instances,
    checks,
    add,
  };
}

it.effect(
  "persists only the opted-in account selection, survives recreation and routes to that account",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      const personal = ProviderInstanceId.make("cursor-personal");
      const work = ProviderInstanceId.make("cursor-work");
      test.add(personal);
      test.add(work);
      yield* Effect.gen(function* () {
        const cloud = yield* CursorCloud.CursorCloud;
        expect(yield* cloud.status).toEqual({ enabled: false });
        expect(test.checks).toEqual([]);
        yield* cloud.connect({ instanceId: work });
        expect(test.checks).toEqual([work]);
        expect(yield* cloud.status).toEqual({ enabled: true, instanceId: work });
        const settings = yield* ServerSettings.ServerSettingsService;
        expect(
          (yield* settings.getSettings).providerInstances[CURSOR_CLOUD_INSTANCE_ID],
        ).toMatchObject({
          driver: "cursor",
          displayName: "Cursor Cloud",
          enabled: true,
          config: { cloudSourceInstanceId: work },
        });
        expect(
          yield* CursorCloud.CursorCloud.pipe(
            Effect.flatMap((reopened) => reopened.status),
            Effect.provide(
              CursorCloud.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(ServerSettings.ServerSettingsService, settings),
                    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                      getInstance: (id) => Effect.sync(() => test.instances.get(id)),
                    }),
                  ),
                ),
              ),
            ),
          ),
        ).toEqual({ enabled: true, instanceId: work });
        yield* cloud.disconnect;
        expect(yield* cloud.status).toEqual({ enabled: false });
        expect(test.instances.has(work)).toBe(true);
        expect(
          (yield* settings.getSettings).providerInstances[CURSOR_CLOUD_INSTANCE_ID],
        ).toBeUndefined();
      }).pipe(Effect.provide(test.layer));
    }),
);

it.effect(
  "rejects disabled or unsupported accounts and retains the selection when a new account cannot authenticate",
  () =>
    Effect.gen(function* () {
      const test = fixture();
      const valid = ProviderInstanceId.make("cursor-personal");
      const disabled = ProviderInstanceId.make("cursor-disabled");
      const unsupported = ProviderInstanceId.make("other");
      const signedOut = ProviderInstanceId.make("cursor-signed-out");
      test.add(valid);
      test.add(disabled, false);
      test.add(unsupported, true, "codex");
      test.add(signedOut, true, "cursor", false);
      yield* Effect.gen(function* () {
        const cloud = yield* CursorCloud.CursorCloud;
        yield* cloud.connect({ instanceId: valid });
        for (const instanceId of [
          disabled,
          unsupported,
          signedOut,
          ProviderInstanceId.make("missing"),
        ]) {
          expect((yield* cloud.connect({ instanceId }).pipe(Effect.flip)).reason).toBe(
            "authentication",
          );
          expect(yield* cloud.status).toEqual({ enabled: true, instanceId: valid });
        }
      }).pipe(Effect.provide(test.layer));
    }),
);
