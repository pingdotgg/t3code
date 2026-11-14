import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Toml from "effect/encoding/Toml";

const GitInstructions = Schema.Struct({
  "git-commit-instructions": Schema.optional(Schema.Unknown),
  "git-pr-instructions": Schema.optional(Schema.Unknown),
});
const DesktopConfig = Schema.Struct({ desktop: Schema.optional(GitInstructions) });
const decodeConfig = Schema.decodeUnknownEffect(DesktopConfig);

function instruction(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

export const readCodexGitInstructions = Effect.fn("readCodexGitInstructions")(function* (
  homePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const desktop = yield* fs.readFileString(path.join(homePath, "config.toml")).pipe(
    Effect.flatMap((text) => Effect.fromResult(Toml.parse(text))),
    Effect.flatMap(decodeConfig),
    Effect.map((config) => config.desktop ?? {}),
    Effect.orElseSucceed(() => GitInstructions.make({})),
  );
  return {
    commitInstructions: instruction(desktop["git-commit-instructions"]),
    changeRequestInstructions: instruction(desktop["git-pr-instructions"]),
  };
});
