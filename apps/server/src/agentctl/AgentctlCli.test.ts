import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as AgentctlCli from "./AgentctlCli.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "agentctl Windows launcher",
  () => {
    it.effect("discovers agents and preserves manifest arguments through a PATH cmd shim", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3 agentctl " });
        const scriptPath = path.join(directory, "agentctl.cjs");
        const argumentsPath = path.join(directory, "arguments.json");
        const agents = [{ metadata: { name: "worker" }, spec: {} }];
        yield* fs.writeFileString(
          scriptPath,
          `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)));
console.log(${JSON.stringify(JSON.stringify(agents))});
`,
        );
        yield* fs.writeFileString(
          path.join(directory, "agentctl.cmd"),
          `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
        );
        yield* Effect.gen(function* () {
          const cli = yield* AgentctlCli.AgentctlCli;
          expect(yield* cli.listAgents).toEqual(agents);
          expect(JSON.parse(yield* fs.readFileString(argumentsPath))).toEqual([
            "get",
            "agents",
            "-o",
            "json",
          ]);

          const manifestPath = path.join(directory, "manifests & projects", "agent.yaml");
          yield* cli.apply({ manifestPath, name: "worker-2" });
          expect(JSON.parse(yield* fs.readFileString(argumentsPath))).toEqual([
            "apply",
            "-f",
            manifestPath,
            "--name",
            "worker-2",
          ]);
        }).pipe(
          Effect.provide(AgentctlCli.layer),
          Effect.provideService(HostProcess.Environment, { PATH: directory, PATHEXT: ".CMD" }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("agentctl get --watch", () => {
  // A stand-in agentctl on PATH that runs `script` with Node.
  const withAgentctl = <A, E>(
    script: string,
    test: (cli: AgentctlCli.AgentctlCli["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agentctl-" });
      const executable = path.join(directory, "agentctl");
      yield* fs.writeFileString(executable, `#!${process.execPath}\n${script}`);
      yield* fs.chmod(executable, 0o755);
      // Spawning looks agentctl up on the process's own PATH outside Windows.
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.stubEnv("PATH", directory)),
        () => Effect.sync(() => vi.unstubAllEnvs()),
      );
      return yield* AgentctlCli.AgentctlCli.pipe(
        Effect.flatMap(test),
        Effect.provide(AgentctlCli.layer),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("reports each list it prints and the trouble it retries, then why it ended", () =>
    withAgentctl(
      `const agents = (name) => JSON.stringify([{ metadata: { name }, spec: {} }]);
console.log(agents("first"));
console.error("agentctl: watch failed, retrying: connection refused");
console.log(agents("second"));
console.error("agentctl: agentd was upgraded; run the command again");
process.exit(1);
`,
      (cli) =>
        Effect.gen(function* () {
          const events: Array<AgentctlCli.AgentctlWatchEvent> = [];
          const error = yield* cli.watchAgents.pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.flip,
          );
          const names = events.flatMap((event) =>
            event._tag === "Agents" ? event.agents.map((agent) => agent.metadata.name) : [],
          );
          expect(names).toEqual(["first", "second"]);
          expect(events.filter((event) => event._tag === "Trouble")).toEqual([
            { _tag: "Trouble", message: "watch failed, retrying: connection refused" },
            { _tag: "Trouble", message: "agentd was upgraded; run the command again" },
          ]);
          expect(error.reason).toBe("failed");
          expect(error.message).toBe("agentd was upgraded; run the command again");
        }),
    ),
  );

  it.effect("tells an agentctl that predates --watch from one that failed", () =>
    withAgentctl(
      `console.error("error: unexpected argument '--watch' found");
console.error("");
console.error("For more information, try '--help'.");
process.exit(2);
`,
      (cli) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Stream.runDrain(cli.watchAgents));
          expect(error.reason).toBe("unsupported");
        }),
    ),
  );
});
