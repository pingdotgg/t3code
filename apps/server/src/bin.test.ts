import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const DISPATCH_MODULES = ["mcp/AcpMcpStdioBridge.ts", "cli/consoleStdin.ts", "binCli.ts"];

// Loads before bin.ts. A fake macOS and a setTypeOfService that always throws
// EINVAL make the guard install on any host and runtime. Each module bin.ts
// dispatches to is replaced with a no-op, and the hook prints whether EINVAL
// still escapes at the moment that module loads.
const PRELOAD = `
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";

Object.defineProperty(process, "platform", { value: "darwin" });
NodeNet.Socket.prototype.setTypeOfService = () => {
  throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL" });
};
const dispatchModules = ${JSON.stringify(DISPATCH_MODULES)};
NodeModule.registerHooks({
  load(url, context, nextLoad) {
    const path = dispatchModules.find((path) => url.endsWith("/src/" + path));
    if (path === undefined) return nextLoad(url, context);
    let state = "guarded";
    try {
      NodeNet.Socket.prototype.setTypeOfService.call(new NodeNet.Socket(), 0);
    } catch (error) {
      state = error.code;
    }
    console.log(path + " " + state);
    return {
      format: "module",
      source: "export const runAcpMcpCliFastPath = async () => {}; export const attachConsoleStdin = () => {}; export const runCli = () => {};",
      shortCircuit: true,
    };
  },
});
`;

describe("bin.ts", () => {
  it.effect.each([
    { command: "acp-mcp-call", loaded: ["mcp/AcpMcpStdioBridge.ts guarded"] },
    { command: "--version", loaded: ["cli/consoleStdin.ts guarded", "binCli.ts guarded"] },
  ])("guards setTypeOfService before $command dispatches", ({ command, loaded }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, [
          "--experimental-strip-types",
          "--import",
          `data:text/javascript,${encodeURIComponent(PRELOAD)}`,
          NodeURL.fileURLToPath(new URL("./bin.ts", import.meta.url)),
          command,
        ]),
      );
      const [stdout, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (acc, chunk) => acc + chunk,
            ),
          ),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );

      assert.equal(exitCode, 0);
      assert.deepStrictEqual(stdout.trim().split("\n"), loaded);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
