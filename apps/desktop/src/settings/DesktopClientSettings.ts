import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const ClientSettingsDocumentSchema = Schema.Struct({
  settings: ClientSettingsSchema,
});

const ClientSettingsJson = fromLenientJson(ClientSettingsSchema);
const LegacyClientSettingsDocumentJson = fromLenientJson(ClientSettingsDocumentSchema);
const decodeLegacyClientSettingsDocumentJson = Schema.decodeEffect(
  LegacyClientSettingsDocumentJson,
);
const decodeClientSettingsJsonValue = Schema.decodeEffect(ClientSettingsJson);
const decodeClientSettingsJson = (raw: string): Effect.Effect<ClientSettings, Schema.SchemaError> =>
  decodeLegacyClientSettingsDocumentJson(raw).pipe(
    Effect.map((document) => document.settings),
    Effect.catch(() => decodeClientSettingsJsonValue(raw)),
  );
const encodeClientSettingsJson = Schema.encodeEffect(ClientSettingsJson);

export class DesktopClientSettingsWriteError extends Data.TaggedError(
  "DesktopClientSettingsWriteError",
)<{
  readonly cause: PlatformError.PlatformError | Schema.SchemaError;
}> {
  override get message() {
    return `Failed to write desktop client settings: ${this.cause.message}`;
  }
}

export interface DesktopClientSettingsShape {
  readonly get: Effect.Effect<Option.Option<ClientSettings>>;
  readonly set: (settings: ClientSettings) => Effect.Effect<void, DesktopClientSettingsWriteError>;
}

export class DesktopClientSettings extends Context.Service<
  DesktopClientSettings,
  DesktopClientSettingsShape
>()("t3/desktop/ClientSettings") {}

const readClientSettings = (
  fileSystem: FileSystem.FileSystem,
  settingsPath: string,
): Effect.Effect<Option.Option<ClientSettings>> =>
  fileSystem.readFileString(settingsPath).pipe(
    Effect.option,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(Option.none<ClientSettings>()),
        onSome: (raw) =>
          decodeClientSettingsJson(raw).pipe(
            Effect.map((settings) => Option.some(settings)),
            Effect.catch(() => Effect.succeed(Option.none<ClientSettings>())),
          ),
      }),
    ),
  );

const writeClientSettings = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly settingsPath: string;
  readonly settings: ClientSettings;
}): Effect.fn.Return<void, PlatformError.PlatformError | Schema.SchemaError> {
  const directory = input.path.dirname(input.settingsPath);
  const suffix = (yield* Random.nextUUIDv4).replace(/-/g, "");
  const tempPath = `${input.settingsPath}.${process.pid}.${suffix}.tmp`;
  const encoded = yield* encodeClientSettingsJson(input.settings);
  yield* input.fileSystem.makeDirectory(directory, { recursive: true });
  yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`);
  yield* input.fileSystem.rename(tempPath, input.settingsPath);
});

export const layer = Layer.effect(
  DesktopClientSettings,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return DesktopClientSettings.of({
      get: readClientSettings(fileSystem, environment.clientSettingsPath).pipe(
        Effect.withSpan("desktop.clientSettings.get"),
      ),
      set: (settings) =>
        writeClientSettings({
          fileSystem,
          path,
          settingsPath: environment.clientSettingsPath,
          settings,
        }).pipe(
          Effect.mapError((cause) => new DesktopClientSettingsWriteError({ cause })),
          Effect.withSpan("desktop.clientSettings.set"),
        ),
    });
  }),
);

export const layerTest = (initialSettings: Option.Option<ClientSettings> = Option.none()) =>
  Layer.effect(
    DesktopClientSettings,
    Effect.gen(function* () {
      const settingsRef = yield* Ref.make(initialSettings);
      return DesktopClientSettings.of({
        get: Ref.get(settingsRef),
        set: (settings) => Ref.set(settingsRef, Option.some(settings)),
      });
    }),
  );
