import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CONTRIBUTOR_BUNDLE_FILE_NAME, type ContributorBundle } from "@t3tools/contracts";
import { ContributorBundleFromJson } from "@t3tools/shared/contributorBundle";

const decodeContributorBundleJson = Schema.decodeEffect(ContributorBundleFromJson);

export class ContributorBundleLoadError extends Schema.TaggedError<ContributorBundleLoadError>()(
  "ContributorBundleLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${CONTRIBUTOR_BUNDLE_FILE_NAME} at ${this.filePath}.`;
  }
}

export class ContributorBundleLoader extends Context.Service<
  ContributorBundleLoader,
  {
    /** Never fails; missing/unreadable/invalid files return none, with warnings for invalid files. */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<ContributorBundle>>;
  }
>()("t3/project/ContributorBundleLoader") {}

const logContributorBundleLoadError = (error: ContributorBundleLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const load: ContributorBundleLoader["Service"]["load"] = Effect.fn(
    "ContributorBundleLoader.load",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, CONTRIBUTOR_BUNDLE_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : logContributorBundleLoadError(
                new ContributorBundleLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                }),
              ).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isNone(raw)) {
      return Option.none<ContributorBundle>();
    }
    return yield* decodeContributorBundleJson(raw.value).pipe(
      Effect.asSome,
      Effect.catchTags({
        SchemaError: (error) =>
          logContributorBundleLoadError(
            new ContributorBundleLoadError({
              operation: "decode",
              workspaceRoot,
              filePath,
              cause: error,
            }),
          ).pipe(Effect.as(Option.none<ContributorBundle>())),
      }),
    );
  });

  return ContributorBundleLoader.of({ load });
});

export const layer = Layer.effect(ContributorBundleLoader, make);
