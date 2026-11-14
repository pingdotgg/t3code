import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { readCodexGitInstructions } from "./CodexGitInstructions.ts";

const cases = [
  { name: "missing config", expected: {} },
  {
    name: "current desktop config with multiline instructions",
    config:
      '[desktop]\ngit-commit-instructions = """Use conventional commits.\nInclude the ticket."""\ngit-pr-instructions = "Describe tests."',
    expected: {
      commitInstructions: "Use conventional commits.\nInclude the ticket.",
      changeRequestInstructions: "Describe tests.",
    },
  },
  {
    name: "trims instructions and preserves absent fields",
    config: '[desktop]\ngit-commit-instructions = "  Use the new format.  "',
    expected: {
      commitInstructions: "Use the new format.",
    },
  },
  {
    name: "cleared config instructions",
    config: '[desktop]\ngit-commit-instructions = "  "',
    expected: { commitInstructions: "" },
  },
  {
    name: "invalid instruction values preserve valid fields",
    config: '[desktop]\ngit-commit-instructions = 42\ngit-pr-instructions = "Describe tests."',
    expected: {
      changeRequestInstructions: "Describe tests.",
    },
  },
  {
    name: "malformed config",
    config: "[desktop",
    expected: {},
  },
  { name: "invalid desktop shape", config: "desktop = false", expected: {} },
] as const;

it.layer(NodeServices.layer)("CodexGitInstructions", (it) => {
  it.effect.each(cases)("reads $name", (testCase) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      if ("config" in testCase) {
        yield* fs.writeFileString(path.join(home, "config.toml"), testCase.config);
      }
      const instructions = yield* readCodexGitInstructions(home);
      expect(instructions).toEqual({
        commitInstructions: undefined,
        changeRequestInstructions: undefined,
        ...testCase.expected,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reads edits and removal without restarting the provider", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const configPath = path.join(home, "config.toml");
      yield* fs.writeFileString(configPath, '[desktop]\ngit-commit-instructions = "First format"');
      expect((yield* readCodexGitInstructions(home)).commitInstructions).toBe("First format");
      yield* fs.writeFileString(configPath, '[desktop]\ngit-commit-instructions = "Second format"');
      expect((yield* readCodexGitInstructions(home)).commitInstructions).toBe("Second format");
      yield* fs.remove(configPath);
      expect((yield* readCodexGitInstructions(home)).commitInstructions).toBeUndefined();
    }).pipe(Effect.scoped),
  );
});
