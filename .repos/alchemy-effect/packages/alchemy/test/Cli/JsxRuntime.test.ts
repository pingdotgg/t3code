import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { transformSync } from "rolldown/utils";
import { PlatformServices } from "@/Util/PlatformServices.ts";

// React is only a devDependency (#1636), so a CLI module that compiles to a
// runtime `react` import crashes in consumer projects. A JSX pragma counts
// only in the file's leading comments; anywhere else the package's
// `jsx: react-jsx` falls back to `react/jsx-runtime`.
describe("CLI JSX runtime", { tags: ["unit", "local"] }, () => {
  it.effect("no CLI module imports react at runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cli = yield* path.fromFileUrl(new URL("../../src/Cli/", import.meta.url));
      const files = (yield* fs.readDirectory(cli, { recursive: true })).filter((file) =>
        file.endsWith(".tsx"),
      );
      const offenders: string[] = [];
      for (const file of files) {
        const source = yield* fs.readFileString(path.join(cli, file));
        // The package compiles with `jsx: react-jsx`: automatic runtime, react source.
        const { code } = transformSync(file, source, { jsx: { runtime: "automatic" } });
        if (/from\s+["']react(\/[^"']*)?["']/.test(code)) offenders.push(file);
      }
      expect(files.length).toBeGreaterThan(0);
      expect(offenders).toEqual([]);
    }).pipe(Effect.provide(PlatformServices)),
  );
});
