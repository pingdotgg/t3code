import {
  CURSOR_CLOUD_INSTANCE_ID,
  CursorCloudConnectInput,
  CursorCloudError,
  CursorCloudStatus,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

const decodeSelection = Schema.decodeUnknownOption(
  Schema.Struct({ cloudSourceInstanceId: ProviderInstanceId }),
);
export class CursorCloud extends Context.Service<
  CursorCloud,
  {
    readonly status: Effect.Effect<typeof CursorCloudStatus.Type, CursorCloudError>;
    readonly connect: (
      input: typeof CursorCloudConnectInput.Type,
    ) => Effect.Effect<typeof CursorCloudStatus.Type, CursorCloudError>;
    readonly disconnect: Effect.Effect<typeof CursorCloudStatus.Type, CursorCloudError>;
  }
>()("t3/cursorCloud/CursorCloud") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return CursorCloud.of({
    status: settings.getSettings.pipe(
      Effect.mapError(() => new CursorCloudError({ reason: "credentials" })),
      Effect.map((current) => {
        const cloud = current.providerInstances[CURSOR_CLOUD_INSTANCE_ID];
        const config = decodeSelection(cloud?.config);
        return cloud?.enabled && Option.isSome(config)
          ? { enabled: true, instanceId: config.value.cloudSourceInstanceId }
          : { enabled: false };
      }),
    ),
    connect: Effect.fn("CursorCloud.connect")(function* ({ instanceId }) {
      const source = yield* instances.getInstance(instanceId);
      if (
        instanceId === CURSOR_CLOUD_INSTANCE_ID ||
        !source?.enabled ||
        source.driverKind !== "cursor" ||
        source.cloudAccess === undefined
      ) {
        return yield* new CursorCloudError({ reason: "authentication" });
      }
      yield* source.cloudAccess.check;
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() => new CursorCloudError({ reason: "credentials" })),
      );
      const environment = current.providerInstances[instanceId]?.environment;
      yield* settings
        .updateProviderInstance({
          operation: "upsert",
          instanceId: CURSOR_CLOUD_INSTANCE_ID,
          instance: {
            driver: ProviderDriverKind.make("cursor"),
            displayName: "Cursor Cloud",
            enabled: true,
            ...(environment === undefined ? {} : { environment }),
            config: { cloudSourceInstanceId: instanceId },
          },
        })
        .pipe(Effect.mapError(() => new CursorCloudError({ reason: "credentials" })));
      return { enabled: true, instanceId };
    }),
    disconnect: settings
      .updateProviderInstance({ operation: "remove", instanceId: CURSOR_CLOUD_INSTANCE_ID })
      .pipe(
        Effect.mapError(() => new CursorCloudError({ reason: "credentials" })),
        Effect.as({ enabled: false }),
      ),
  });
});
export const layer = Layer.effect(CursorCloud, make);
