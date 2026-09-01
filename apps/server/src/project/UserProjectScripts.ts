import { projectScriptsFromFileScripts } from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

export const loadUserProjectScripts = Effect.fn("loadUserProjectScripts")(function* (
  stateDir: string,
) {
  const loader = yield* T3ProjectFileLoader.make;
  const projectFile = yield* loader.load(stateDir);

  return Option.match(projectFile, {
    onNone: () => [],
    onSome: (file) => projectScriptsFromFileScripts(file.scripts ?? []),
  });
});
