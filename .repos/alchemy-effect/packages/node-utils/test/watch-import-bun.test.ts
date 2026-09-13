import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { trackBunImports } from "../src/watch-import-bun.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("trackBunImports", () => {
  it("records project-local modules and reports changes to them", async () => {
    const temporaryDirectory = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "alchemy-import-bun-")),
    );
    temporaryDirectories.push(temporaryDirectory);
    const directory = path.join(temporaryDirectory, "project");
    mkdirSync(directory);
    const entry = path.join(directory, "entry.ts");
    const dependency = path.join(directory, "dependency.ts");
    const external = path.join(temporaryDirectory, "external.ts");
    writeFileSync(
      entry,
      [
        'import { text } from "./dependency.ts";',
        'import { externalText } from "../external.ts";',
        "interface Result { text: string; externalText: string }",
        "export const result: Result = { text, externalText };",
      ].join("\n"),
    );
    writeFileSync(dependency, 'export const text: string = "original";\n');
    writeFileSync(
      external,
      'export const externalText: string = "external";\n',
    );

    // The project root is wider than the entrypoint directory, as it is in a
    // stack with `infra/alchemy.run.ts` importing from sibling `src/` trees.
    const tracker = trackBunImports({
      root: temporaryDirectory,
      debounceMs: 10,
    });
    try {
      const module = (await import(entry)) as {
        result: { text: string; externalText: string };
      };
      expect(module.result).toEqual({
        text: "original",
        externalText: "external",
      });
      expect(tracker.dependencies).toEqual(
        new Set([entry, dependency, external]),
      );

      const unchanged: ReadonlySet<string>[] = [];
      const unsubscribeUnchanged = tracker.subscribe(({ paths }) =>
        unchanged.push(paths),
      );
      // Give chokidar a moment to arm the file watchers before writing.
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeFileSync(dependency, 'export const text: string = "original";\n');
      await new Promise((resolve) => setTimeout(resolve, 100));
      unsubscribeUnchanged();
      expect(unchanged).toEqual([]);

      const changed = new Promise<ReadonlySet<string>>((resolve) =>
        tracker.subscribe(({ paths }) => resolve(paths)),
      );
      writeFileSync(dependency, 'export const text: string = "changed";\n');
      const paths = await Promise.race([
        changed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watch timed out")), 3000),
        ),
      ]);
      expect(paths).toEqual(new Set([dependency]));
    } finally {
      await tracker.close();
    }
  });
});
