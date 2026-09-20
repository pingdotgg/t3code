import { noopSession } from "@/Report";
import * as Test from "@/Test/Alchemy";
import { Server, ServerProviderLive } from "@/Website/Server";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const { test } = Test.make({ providers: ServerProviderLive() });

for (const location of [
  "root",
  "ancestor",
  "sibling",
  "symlink",
  "dist",
] as const) {
  test.provider(
    `cleanup preserves source when output is ${location}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const root = path.join(directory, "app");
        const dist = path.join(root, "dist");
        const sibling = path.join(directory, "other-app");
        yield* fs.makeDirectory(dist, { recursive: true });
        yield* fs.makeDirectory(sibling);
        const source = path.join(root, "page.tsx");
        yield* fs.writeFileString(source, "export default () => 'keep me';");
        yield* fs.writeFileString(path.join(dist, "index.html"), "generated");
        yield* fs.writeFileString(
          path.join(sibling, "source.ts"),
          "keep sibling",
        );
        const alias = path.join(root, "output-link");
        yield* fs.symlink(root, alias);
        const distDir = {
          root,
          ancestor: directory,
          sibling,
          symlink: alias,
          dist,
        }[location];
        const provider = yield* Server.Provider;
        const remove = provider.delete({
          id: "Build",
          fqn: "Build",
          instanceId: "cleanup-test",
          olds: { framework: "unused", target: "unused", root },
          output: {
            distDir,
            clientDir: undefined,
            serverEntry: undefined,
            url: undefined,
            hash: { input: undefined, output: undefined },
          },
          bindings: [],
          session: { ...noopSession, note: () => Effect.void },
        });
        yield* remove;
        yield* remove;
        expect(yield* fs.readFileString(source)).toBe(
          "export default () => 'keep me';",
        );
        expect(yield* fs.readFileString(path.join(sibling, "source.ts"))).toBe(
          "keep sibling",
        );
        expect(yield* fs.exists(dist)).toBe(location !== "dist");
      }),
    { timeout: 10_000 },
  );
}
