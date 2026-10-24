// @effect-diagnostics nodeBuiltinImport:off -- the tests type into a real Nushell.
import * as NodeChildProcess from "node:child_process";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const nushell = "nu";
const hasNushell = NodeChildProcess.spawnSync(nushell, ["--version"]).status === 0;

/** Types the runner's input into a real Nushell and reports its output as terminal events. */
const runSetupInNushell = (command: string) => {
  type Listener = Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0];
  const listeners: Array<Listener> = [];
  const emit = (event: Parameters<Listener>[0]) =>
    Effect.forEach(listeners, (listener) => listener(event), { discard: true });
  const projectId = ProjectId.make("project:setup-runner-nushell");
  const layer = ProjectSetupScriptRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              id: projectId,
              title: "Project",
              workspaceRoot: "/repo",
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: null,
              scripts: [
                {
                  id: "setup",
                  name: "Setup",
                  command,
                  icon: "configure" as const,
                  runOnWorktreeCreate: true,
                },
              ],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            }),
        }),
        Layer.mock(TerminalManager.TerminalManager)({
          open: (input) =>
            Effect.succeed({
              threadId: input.threadId,
              terminalId: input.terminalId,
              cwd: input.cwd,
              worktreePath: input.worktreePath ?? null,
              status: "running" as const,
              pid: 123,
              history: "",
              exitCode: null,
              exitSignal: null,
              label: "Shell",
              updatedAt: "2026-06-20T00:00:00.000Z",
            }),
          subscribe: (listener) =>
            Effect.sync(() => {
              listeners.push(listener);
              return () => undefined;
            }),
          write: (input) =>
            Effect.suspend(() => {
              // The terminal submits each carriage-return-separated line as Enter.
              const typed = input.data.trimStart().replace(/\r$/, "").replaceAll("\r", "\n");
              const result = NodeChildProcess.spawnSync(
                nushell,
                ["--no-config-file", "-c", typed],
                {
                  encoding: "utf8",
                },
              );
              const base = { threadId: input.threadId, terminalId: input.terminalId };
              return emit({
                ...base,
                type: "output",
                data: `${result.stdout}${result.stderr}nu> `,
              }).pipe(
                Effect.andThen(
                  emit({ ...base, type: "exited", exitCode: result.status, exitSignal: null }),
                ),
              );
            }),
          closeIdle: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        NodeCrypto.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const started = yield* runner.runForThread({
      threadId: "thread-1",
      projectId,
      worktreePath: "/repo-worktree",
      observeCompletion: {},
    });
    assert.equal(started.status, "started");
    assert(started.status === "started" && started.completion);
    return yield* started.completion;
  }).pipe(
    Effect.provide(layer),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.Environment, { SHELL: "/usr/bin/nu" }),
  );
};

it.effect.skipIf(!hasNushell)("reports a Nushell setup script's success exit code", () =>
  Effect.gen(function* () {
    const completion = yield* runSetupInNushell("echo setup-ok");
    assert.equal(completion.exitCode, 0);
  }),
);

it.effect.skipIf(!hasNushell)("reports a Nushell setup script's failure exit code", () =>
  Effect.gen(function* () {
    const completion = yield* runSetupInNushell("bash -c 'exit 3'");
    assert.equal(completion.exitCode, 3);
  }),
);

it.effect.skipIf(!hasNushell)(
  "reports success when a Nushell setup script recovers a failure",
  () =>
    Effect.gen(function* () {
      const completion = yield* runSetupInNushell(
        "try { bash -c 'exit 3' } catch { print recovered }",
      );
      assert.equal(completion.exitCode, 0);
    }),
);
