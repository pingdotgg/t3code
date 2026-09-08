import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_NAME,
  ADAPTER_PACKAGE,
  makeCloudflareTarget,
} from "../cloudflare.ts";
import { fromHarnessOptions } from "../index.ts";
import { readOctaneOutput } from "../Octane.ts";

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("readOctaneOutput", () => {
  it("maps an octane dist tree onto the BuildOutput contract, entry first", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "octane-output-",
        });
        const serverDir = path.join(dir, "server");
        const clientDir = path.join(dir, "client");
        yield* fs.makeDirectory(path.join(serverDir, "chunks"), {
          recursive: true,
        });
        yield* fs.makeDirectory(clientDir, { recursive: true });
        // alphabetically before worker.js, to prove entry-first sorting
        yield* fs.writeFileString(
          path.join(serverDir, "chunks", "a.js"),
          "export const a = 1;",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "entry.js"),
          "export const e = 1;",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "worker.js"),
          "export default {};",
        );
        // adapt() inputs embedded into worker.js — must NOT surface as modules
        yield* fs.writeFileString(
          path.join(serverDir, "index.html"),
          "<!doctype html>",
        );
        yield* fs.writeFileString(
          path.join(serverDir, "octane-client-assets.json"),
          "{}",
        );
        yield* fs.writeFileString(
          path.join(clientDir, "robots.txt"),
          "User-agent: *\n",
        );
        return yield* readOctaneOutput({ dir, serverDir, clientDir });
      }),
    );
    expect(output.serverModules?.map((module) => module.name)).toEqual([
      "server/worker.js",
      "server/chunks/a.js",
      "server/entry.js",
    ]);
    expect(output.clientDirectory?.endsWith("client")).toBe(true);
    expect(output.externalWorkspaces.size).toBe(0);
  });

  it("fails actionably when the adapter entry is missing", async () => {
    const error = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "octane-output-",
        });
        const serverDir = path.join(dir, "server");
        const clientDir = path.join(dir, "client");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.makeDirectory(clientDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, "entry.js"),
          "export const e = 1;",
        );
        return yield* readOctaneOutput({ dir, serverDir, clientDir }).pipe(
          Effect.flip,
        );
      }),
    );
    expect(error.message).toContain('no "server/worker.js" entry');
    expect(error.message).toContain("adapt()");
  });
});

describe("makeCloudflareTarget", () => {
  it("declares the adapter contract octane.config.ts must satisfy", () => {
    const target = makeCloudflareTarget({ compatibilityDate: "2026-03-10" });
    expect(target.platform).toBe("cloudflare");
    expect(target.adapterName).toBe(ADAPTER_NAME);
    expect(target.adapterPackage).toBe(ADAPTER_PACKAGE);
    expect(target.serverEntryFileName).toBe("worker.js");
    expect(target.config.compatibilityDate).toBe("2026-03-10");
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
          },
        },
      },
      vite: { compatibilityDate: "2020-01-01" },
    });
    expect(options.compatibilityDate).toBe("2026-03-10");
    expect(options.compatibilityFlags).toEqual(["nodejs_compat"]);
  });
});
