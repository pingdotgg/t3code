import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import { fromHarnessOptions } from "../index.ts";
import { make, readNitroOutput, SERVER_ENTRY_NAME } from "../Nuxt.ts";

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("readNitroOutput", () => {
  it("maps a nitro .output tree onto the BuildOutput contract, entry first", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "nuxt-output-",
        });
        const serverDir = path.join(dir, "server");
        const publicDir = path.join(dir, "public");
        yield* fs.makeDirectory(path.join(serverDir, "chunks"), {
          recursive: true,
        });
        yield* fs.makeDirectory(publicDir, { recursive: true });
        // alphabetically before index.mjs, to prove entry-first sorting
        yield* fs.writeFileString(
          path.join(serverDir, "chunks", "a.mjs"),
          "export const a = 1;",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "index.mjs"),
          "export default {};",
        );
        yield* fs.writeFileString(
          path.join(publicDir, "robots.txt"),
          "User-agent: *\n",
        );
        return yield* readNitroOutput({ dir, serverDir, publicDir });
      }),
    );
    expect(output.serverModules?.map((module) => module.name)).toEqual([
      SERVER_ENTRY_NAME,
      "server/chunks/a.mjs",
    ]);
    expect(output.serverModules?.[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(output.clientDirectory).toBeDefined();
    expect(output.distDirectory).toBeDefined();
    expect(output.externalWorkspaces.size).toBe(0);
  });

  it("fails when the server directory has no index.mjs entry", async () => {
    const result = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "nuxt-output-",
        });
        const serverDir = path.join(dir, "server");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, "other.mjs"),
          "export const x = 1;",
        );
        return yield* Effect.result(
          readNitroOutput({
            dir,
            serverDir,
            publicDir: path.join(dir, "public"),
          }),
        );
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.failure)).toContain("server/index.mjs");
    }
  });
});

describe("make", () => {
  it("dev fails with a descriptive FrameworkError outside a Nuxt project", async () => {
    // /tmp has no nuxt install: resolving the project's kit is the first
    // step of `dev` and must surface a FrameworkError (not a raw throw).
    const result = await runWithNode(
      Effect.gen(function* () {
        const framework = yield* make({ root: "/tmp/does-not-matter" });
        return yield* Effect.result(framework.dev());
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("FrameworkError");
    }
  });
});

describe("fromHarnessOptions", () => {
  it("prefers the target-scoped carriage over the deprecated vite alias", () => {
    const options = fromHarnessOptions({
      target: {
        cloudflare: {
          worker: {
            compatibilityDate: "2026-03-10",
            compatibilityFlags: ["nodejs_compat"],
            main: "./worker-entry.ts",
          },
        },
      },
      vite: { compatibilityDate: "1999-01-01" },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(options.main).toBe("./worker-entry.ts");
  });

  it("falls back to the vite alias when no target carriage exists", () => {
    const options = fromHarnessOptions({
      vite: { compatibilityDate: "2026-03-10" },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.main).toBeUndefined();
  });
});
