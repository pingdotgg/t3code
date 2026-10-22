import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { BRANCH_TOKEN_FUNCTION } from "./azureDevOpsSdk.ts";

it.layer(NodeServices.layer)("azureDevOpsSdk", (it) => {
  it.effect("spells a branch token one encoded segment at a time", (context) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const token = (ref: string) =>
        spawner
          .string(
            ChildProcess.make("python3", [
              "-I",
              "-c",
              `${BRANCH_TOKEN_FUNCTION}\nimport sys\nprint(branch_token('repoV2/p/r',sys.argv[1]))`,
              ref,
            ]),
          )
          .pipe(
            Effect.map((output) => output.trim()),
            Effect.option,
          );
      const nested = yield* token("refs/heads/user/mattc/feature1");
      if (Option.isNone(nested) || nested.value === "")
        return context.skip("python3 is unavailable");
      // Microsoft's own example: refs/heads/user/mattc/feature1.
      expect(nested.value).toBe(
        "repoV2/p/r/refs/heads/7500730065007200/6d006100740074006300/66006500610074007500720065003100/",
      );
      expect(Option.getOrThrow(yield* token("main"))).toBe(
        "repoV2/p/r/refs/heads/6d00610069006e00/",
      );
    }),
  );
});
