import { Interaction, layerNonInteractive, accessors } from "@/Interaction.ts";
import { nodeLoaderArgs } from "@/Util/Node.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { nodePath, nodeSupportsDevMode } from "./nodeProbe.ts";

class CaptureStream extends PassThrough {
  readonly columns = 80;
  readonly rows = 24;
  readonly isTTY = false;
  output = "";

  constructor() {
    super();
    this.on("data", (chunk) => {
      this.output += chunk.toString();
    });
  }
}

const nonInteractive = (stdout: CaptureStream) =>
  layerNonInteractive({ stdout: stdout as unknown as NodeJS.WriteStream });

it("prints plain status lines and fails prompts typed", () => {
  const stdout = new CaptureStream();
  return Effect.gen(function* () {
    const interaction = yield* Interaction;
    yield* interaction.output.info({ message: "plain info", detail: "extra" });
    yield* accessors.output.success("plain success");
    const failure = yield* Effect.flip(
      interaction.prompt.confirm({ message: "proceed?" }),
    );
    expect(failure._tag).toBe("NonInteractiveTerminal");
    const select = yield* Effect.flip(
      accessors.prompt.select({ message: "pick", options: [] }),
    );
    expect(select._tag).toBe("NonInteractiveTerminal");
    const lines = stdout.output.split("\n");
    expect(lines[0]).toContain("plain info");
    expect(lines[0]).toContain("· extra");
    expect(lines[1]).toContain("plain success");
  }).pipe(Effect.provide(nonInteractive(stdout)));
});

it("task prints a start line and settles with a status line", () => {
  const stdout = new CaptureStream();
  return Effect.gen(function* () {
    const interaction = yield* Interaction;
    yield* interaction.task({ label: "working", detail: "step" }, Effect.void);
    const failed = yield* Effect.result(
      interaction.task({ label: "breaking" }, Effect.fail("boom")),
    );
    expect(failed._tag).toBe("Failure");
    const lines = stdout.output.trimEnd().split("\n");
    expect(lines[0]).toContain("working");
    expect(lines[0]).toContain("· step");
    expect(lines[1]).toContain("working");
    expect(lines[2]).toContain("breaking");
    expect(lines[3]).toContain("breaking");
  }).pipe(Effect.provide(nonInteractive(stdout)));
});

// The regression this pins: spawned dev children carry NO interaction
// services at all, so the vite child runner's entire module graph must load
// under node (the same dev-mode loader `ViteChild.ts` spawns it with) and
// proceed to config resolution — the original bug was an eager CliKit import
// killing every `runtime: "node"` dev child at startup.
it.live.skipIf(!nodeSupportsDevMode)(
  "the vite child runner's module graph loads under node",
  () =>
    Effect.gen(function* () {
      const runner = fileURLToPath(
        new URL(
          "../src/Cloudflare/Workers/ViteChildRunner.ts",
          import.meta.url,
        ),
      );
      const handle = yield* ChildProcess.make(
        nodePath!,
        [...nodeLoaderArgs(runner), runner],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { NO_COLOR: "1" },
          extendEnv: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          killSignal: "SIGKILL",
        },
      );
      const [stdout, stderr] = yield* Effect.all(
        [
          handle.stdout.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          handle.stderr.pipe(
            Stream.decodeText,
            Stream.runCollect,
            Effect.map((chunks) => chunks.join("")),
          ),
          // Exit code is irrelevant — with no stdin config the runner is
          // EXPECTED to fail; what matters is WHERE it fails.
          handle.exitCode,
        ],
        { concurrency: 3 },
      );
      const combined = `${stdout}\n${stderr}`;
      expect(combined).not.toContain("Unknown file extension");
      expect(combined).not.toContain("ERR_MODULE_NOT_FOUND");
      // Reaching environment/config resolution proves the whole module
      // graph (auth providers, credentials, vite loader) parsed under node.
      expect(combined).toContain("ALCHEMY_RPC_SERVER_ENVIRONMENT");
    }).pipe(Effect.scoped, Effect.provide(PlatformServices)),
  { timeout: 60_000 },
);
