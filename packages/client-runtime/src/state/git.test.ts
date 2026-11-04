import { describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  ThreadId,
  type GitStartCommitWorkflowResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { AtomCommandResult } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import { createVcsActionManager, EMPTY_VCS_ACTION_STATE } from "./vcsAction.ts";
import { createGitEnvironmentAtoms } from "./git.ts";

const rpc = vi.hoisted(() => ({
  execute: undefined as
    | undefined
    | (() => Promise<AtomCommandResult<GitStartCommitWorkflowResult, Error>>),
}));
vi.mock("./runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.ts")>()),
  createEnvironmentRpcCommand: (_runtime: unknown, options: { label: string }) => ({
    label: options.label,
    permissionAtom: () => Atom.make(true),
    run: () => rpc.execute!(),
  }),
}));

const environmentId = EnvironmentId.make("remote");
const target = { environmentId, cwd: "/repo" };

describe("commit splitting progress", () => {
  it.each(["success", "failure"] as const)(
    "tracks the action outside the dialog until %s",
    async (outcome) => {
      const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
        EnvironmentRegistry | EnvironmentCacheStore,
        never
      >;
      const manager = createVcsActionManager(runtime);
      const commands = createGitEnvironmentAtoms(runtime, manager.track);
      const registry = AtomRegistry.make();
      let complete!: (value: AtomCommandResult<GitStartCommitWorkflowResult, Error>) => void;
      rpc.execute = () =>
        new Promise((resolve) => {
          complete = resolve;
        });
      const commandId = CommandId.make("split-action");
      const running = commands.startCommitWorkflow.run(registry, {
        environmentId,
        input: {
          commandId,
          cwd: target.cwd,
          threadId: ThreadId.make("thread"),
          expectedBranch: "feature",
          scope: { type: "working_tree" },
        },
      });
      try {
        expect(registry.get(manager.stateAtom(target))).toMatchObject({
          isRunning: true,
          operation: "split_commits",
          actionId: commandId,
          currentLabel: "Splitting into logical commits...",
        });
        expect(registry.get(manager.stateAtom({ ...target, cwd: "/another-repo" }))).toEqual(
          EMPTY_VCS_ACTION_STATE,
        );
        complete(
          outcome === "success"
            ? AsyncResult.success({ summary: "Created three commits" })
            : AsyncResult.failure(Cause.fail(new Error("Split cancelled"))),
        );
        const result = await running;
        expect(result._tag).toBe(outcome === "success" ? "Success" : "Failure");
        const finished = registry.get(manager.stateAtom(target));
        expect(finished.isRunning).toBe(false);
        if (outcome === "success") expect(finished).toEqual(EMPTY_VCS_ACTION_STATE);
        else expect(finished.error).toBe("Split cancelled");
      } finally {
        registry.dispose();
      }
    },
  );
});
