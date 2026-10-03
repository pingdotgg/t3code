import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const ArcConfig = Schema.Struct({
  "phabricator.uri": Schema.optional(Schema.String),
  conduit_uri: Schema.optional(Schema.String),
});

const decodeConfig = Schema.decodeEffect(Schema.fromJsonString(ArcConfig));

export const makeConfiguredOrigin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return Effect.fn("PhabricatorSourceControlProvider.configuredOrigin")(function* (cwd: string) {
    for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
      const content = yield* fs
        .readFileString(path.join(directory, ".arcconfig"))
        .pipe(Effect.option);
      if (Option.isSome(content)) {
        const config = yield* decodeConfig(content.value).pipe(Effect.option);
        if (Option.isNone(config)) return null;
        const uri = config.value["phabricator.uri"] ?? config.value.conduit_uri;
        if (!uri) return null;
        return yield* Effect.try(() => new URL(uri)).pipe(
          Effect.map((url) =>
            url.protocol === "https:" || url.protocol === "http:" ? url.origin : null,
          ),
          Effect.orElseSucceed(() => null),
        );
      }
      if (path.dirname(directory) === directory) return null;
    }
  });
});
