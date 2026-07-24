import type { DesktopRendererStateKey } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const rendererStateFileNames = {
  "ui-state": "ui-state.json",
  "composer-preferences": "composer-preferences.json",
} as const satisfies Record<DesktopRendererStateKey, string>;

const DesktopRendererStateWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "create-directory",
  "write-temporary-file",
  "replace-state-file",
  "remove-state-file",
]);

export class DesktopRendererStateReadError extends Schema.TaggedErrorClass<DesktopRendererStateReadError>()(
  "DesktopRendererStateReadError",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read desktop renderer state at ${this.path}.`;
  }
}

export class DesktopRendererStateWriteError extends Schema.TaggedErrorClass<DesktopRendererStateWriteError>()(
  "DesktopRendererStateWriteError",
  {
    operation: DesktopRendererStateWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop renderer state write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopRendererState extends Context.Service<
  DesktopRendererState,
  {
    readonly get: (
      key: DesktopRendererStateKey,
    ) => Effect.Effect<Option.Option<string>, DesktopRendererStateReadError>;
    readonly set: (
      key: DesktopRendererStateKey,
      value: string | null,
    ) => Effect.Effect<void, DesktopRendererStateWriteError>;
  }
>()("@t3tools/desktop/settings/DesktopRendererState") {}

function statePath(
  environment: DesktopEnvironment.DesktopEnvironment["Service"],
  key: DesktopRendererStateKey,
): string {
  return environment.path.join(environment.stateDir, "renderer-state", rendererStateFileNames[key]);
}

const readState = (
  fileSystem: FileSystem.FileSystem,
  path: string,
): Effect.Effect<Option.Option<string>, DesktopRendererStateReadError> =>
  fileSystem.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(new DesktopRendererStateReadError({ path, cause })),
    ),
  );

const writeState = Effect.fn("desktop.rendererState.writeState")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly pathService: Path.Path;
  readonly destinationPath: string;
  readonly value: string;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopRendererStateWriteError> {
  const directory = input.pathService.dirname(input.destinationPath);
  const temporaryPath = `${input.destinationPath}.${process.pid}.${input.suffix}.tmp`;

  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopRendererStateWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* Effect.gen(function* () {
    yield* input.fileSystem.writeFileString(temporaryPath, input.value).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopRendererStateWriteError({
            operation: "write-temporary-file",
            path: temporaryPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.rename(temporaryPath, input.destinationPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopRendererStateWriteError({
            operation: "replace-state-file",
            path: input.destinationPath,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.ensuring(
      input.fileSystem.remove(temporaryPath, { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove a temporary renderer state file.", {
            temporaryPath,
            error,
          }),
        ),
      ),
    ),
  );
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const writeLock = yield* Semaphore.make(1);

  return DesktopRendererState.of({
    get: (key) =>
      readState(fileSystem, statePath(environment, key)).pipe(
        Effect.withSpan("desktop.rendererState.get", { attributes: { key } }),
      ),
    set: (key, value) =>
      writeLock
        .withPermit(
          Effect.gen(function* () {
            const destinationPath = statePath(environment, key);
            if (value === null) {
              yield* fileSystem.remove(destinationPath, { force: true }).pipe(
                Effect.mapError(
                  (cause) =>
                    new DesktopRendererStateWriteError({
                      operation: "remove-state-file",
                      path: destinationPath,
                      cause,
                    }),
                ),
              );
              return;
            }

            const suffix = yield* crypto.randomUUIDv4.pipe(
              Effect.map((uuid) => uuid.replace(/-/g, "")),
              Effect.mapError(
                (cause) =>
                  new DesktopRendererStateWriteError({
                    operation: "create-temporary-file-name",
                    path: destinationPath,
                    cause,
                  }),
              ),
            );
            yield* writeState({
              fileSystem,
              pathService,
              destinationPath,
              value,
              suffix,
            });
          }),
        )
        .pipe(Effect.withSpan("desktop.rendererState.set", { attributes: { key } })),
  });
});

export const layer = Layer.effect(DesktopRendererState, make);
