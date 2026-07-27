import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";

import * as AI from "alchemy/AI";

export const regex = AI.Parameter("regex")(
  S.String,
)`The regex pattern to search for.`;

export class Grep extends AI.Tool<Grep>()("grep")`
Search files for a ${regex} pattern and return the matching lines with their file paths and line numbers.` {}

export const GrepLive = Layer.effect(
  Grep,
  Effect.gen(function* () {
    const _fs = yield* FileSystem.FileSystem;
    return Effect.fn(function* ({ regex }) {
      void regex;
    });
  }),
);
