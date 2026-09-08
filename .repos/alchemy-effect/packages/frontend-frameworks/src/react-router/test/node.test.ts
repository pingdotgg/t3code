import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { describe, expect, it } from "vitest";
import {
  NODE_BUNDLE_CONDITIONS,
  NODE_SERVE_ENTRY_FILE_NAME,
} from "../../core/NodeServe.ts";
import { SERVER_ENTRY_FILE_NAME, makeNodeTarget, target } from "../node.ts";
import { DEFAULT_SERVER_BUILD_FILE } from "../ReactRouter.ts";

const runWithNode = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(NodeServices.layer),
    ) as Effect.Effect<A, E>,
  );

describe("makeNodeTarget", () => {
  it("declares the node platform, Node bundle conditions, and a finish pass", () => {
    const node = makeNodeTarget();
    expect(node.platform).toBe("node");
    expect(node.serverEntryFileName).toBe(DEFAULT_SERVER_BUILD_FILE);
    expect(SERVER_ENTRY_FILE_NAME).toBe("index.js");
    expect(node.bundle?.conditions).toEqual([...NODE_BUNDLE_CONDITIONS]);
    expect(node.bundle?.external ?? []).not.toContain("cloudflare:");
    expect(node.bundle?.external ?? []).not.toContain("@aws-sdk/");
    expect(node.bundle?.conditions ?? []).not.toContain("workerd");
    expect(node.finish).toBeTypeOf("function");
    expect(node.build).toBeTypeOf("function");
  });

  it("carries the buildDirectory override on its config", () => {
    expect(
      makeNodeTarget({ buildDirectory: "dist" }).config.buildDirectory,
    ).toBe("dist");
  });

  it("exposes the named `target` module export as the factory", () => {
    expect(target).toBe(makeNodeTarget);
  });
});

describe("finish", () => {
  it("emits a Node serve entry around the fetch handler, not a Lambda adapter", async () => {
    const output = await runWithNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: "react-router-node-finish-",
        });
        const serverDir = path.join(dir, "server");
        const clientDir = path.join(dir, "client");
        yield* fs.makeDirectory(serverDir, { recursive: true });
        yield* fs.makeDirectory(clientDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(serverDir, SERVER_ENTRY_FILE_NAME),
          "export default { fetch() {} };",
        );
        const node = makeNodeTarget();
        return yield* node.finish!(
          {
            distDirectory: dir,
            clientDirectory: clientDir,
            serverModules: [],
            externalWorkspaces: new Set<string>(),
          },
          {
            root: dir,
            framework: "react-router",
            entry: path.join(serverDir, SERVER_ENTRY_FILE_NAME),
          },
        );
      }),
    );
    const names = output.serverModules?.map((module) => module.name) ?? [];
    expect(names[0]).toBe(`server/${NODE_SERVE_ENTRY_FILE_NAME}`);
    const serve = output.serverModules?.[0];
    const source = String(serve?.content);
    expect(source).toContain("/health");
    expect(source).toContain("process.env.PORT");
    expect(source).toContain(`from "./${SERVER_ENTRY_FILE_NAME}"`);
    expect(source).toContain("fetchHandler");
    expect(source).not.toContain("aws-lambda");
    expect(source).not.toContain("streamifyResponse");
    expect(source).not.toContain("workerd");
    expect(source).not.toContain("@aws-sdk/");
  });

  it("fails when the framework produced no on-disk entry", async () => {
    const error = await runWithNode(
      Effect.gen(function* () {
        const node = makeNodeTarget();
        return yield* node.finish!(
          {
            distDirectory: "/tmp",
            clientDirectory: "/tmp/client",
            serverModules: [],
            externalWorkspaces: new Set<string>(),
          },
          { root: "/tmp", framework: "react-router" },
        ).pipe(Effect.flip);
      }),
    );
    expect(error._tag).toBe("DeployTargetError");
    expect(error.message).toContain("no on-disk server entry");
  });
});
