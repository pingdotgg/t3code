import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProjectExportThreadResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommand } from "./runtime.ts";
import {
  moveThreadToMachine,
  threadMachineMoveTargets,
  type ThreadMachineMoveCommands,
} from "./threadMachineMove.ts";

const source = { environmentId: EnvironmentId.make("laptop"), threadId: ThreadId.make("old") };
const target = { environmentId: EnvironmentId.make("vps"), projectId: ProjectId.make("api") };
const exported: ProjectExportThreadResult = {
  bundle: {
    title: "Port the parser",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    messages: [{ role: "user", text: "Port it.", createdAt: "2026-01-01T00:00:00.000Z" }],
  },
  leftBehind: { diffs: true, worktree: false, attachments: 0, scheduledTasks: 0 },
  revision: "1:run",
};

type Step = "export" | "import" | "finish";

function setup(failing: ReadonlySet<Step>, exportGate: Promise<void> = Promise.resolve()) {
  const calls: Array<{ readonly step: Step; readonly environmentId: string }> = [];
  const command = <A>(
    step: Step,
    value: A,
  ): AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: unknown },
    A,
    unknown
  > => ({
    label: step,
    run: async (_registry, { environmentId }) => {
      calls.push({ step, environmentId });
      if (step === "export") await exportGate;
      return failing.has(step)
        ? AsyncResult.failure(Cause.fail(new Error(`${step} failed`)))
        : AsyncResult.success(value);
    },
  });
  const commands: ThreadMachineMoveCommands = {
    exportThread: command("export", exported),
    importThread: command("import", { threadId: ThreadId.make("new") }),
    finishThreadMove: command("finish", undefined),
  };
  const move = (confirm = true) =>
    moveThreadToMachine({
      registry: AtomRegistry.make(),
      commands,
      source,
      sourceLabel: "Laptop",
      target,
      targetLabel: "api on VPS",
      confirm: async () => confirm,
    });
  return { calls, move };
}

describe("moveThreadToMachine", () => {
  it("imports on the target before archiving on the source", async () => {
    const { calls, move } = setup(new Set());
    expect(await move()).toEqual({
      _tag: "Moved",
      threadRef: { environmentId: "vps", threadId: "new" },
      archiveError: null,
    });
    expect(calls).toEqual([
      { step: "export", environmentId: "laptop" },
      { step: "import", environmentId: "vps" },
      { step: "finish", environmentId: "laptop" },
    ]);
  });

  it.each([
    { failing: "export" as const, reached: ["export"] },
    { failing: "import" as const, reached: ["export", "import"] },
  ])("archives nothing when $failing fails", async ({ failing, reached }) => {
    const { calls, move } = setup(new Set([failing]));
    expect(await move()).toEqual({ _tag: "Failed", message: `${failing} failed` });
    expect(calls.map((call) => call.step)).toEqual(reached);
  });

  it("changes nothing when the move is not confirmed", async () => {
    const { calls, move } = setup(new Set());
    expect(await move(false)).toEqual({ _tag: "Cancelled" });
    expect(calls.map((call) => call.step)).toEqual(["export"]);
  });

  it("reports the new thread and the archive failure, so the user knows both copies exist", async () => {
    const { move } = setup(new Set(["finish"]));
    expect(await move()).toEqual({
      _tag: "Moved",
      threadRef: { environmentId: "vps", threadId: "new" },
      archiveError: "finish failed",
    });
  });

  it("ignores a second move of the same thread while one is in flight", async () => {
    let release = () => {};
    const { calls, move } = setup(new Set(), new Promise<void>((resolve) => (release = resolve)));
    const first = move();
    expect(await move()).toEqual({ _tag: "Cancelled" });
    release();
    expect((await first)._tag).toBe("Moved");
    expect(calls.filter((call) => call.step === "import")).toHaveLength(1);
  });
});

describe("threadMachineMoveTargets", () => {
  const laptop = EnvironmentId.make("laptop");
  const vps = EnvironmentId.make("vps");
  const supported = { environment: { capabilities: { threadMoveToMachine: true } } };
  const targets = (canOperate: ReadonlySet<string>) =>
    threadMachineMoveTargets({
      sourceEnvironmentId: laptop,
      connectedEnvironmentIds: [laptop, vps],
      serverConfigs: new Map([
        [laptop, supported],
        [vps, supported],
      ]),
      projects: [{ id: ProjectId.make("api"), environmentId: vps, workspaceRoot: "/api" }],
      labelOf: (environmentId) => environmentId,
      canOperate: (environmentId) => canOperate.has(environmentId),
    }).map((machine) => machine.environmentId);

  it("lists machines only when this connection can change threads on both ends", () => {
    expect(targets(new Set(["laptop", "vps"]))).toEqual(["vps"]);
    expect(targets(new Set(["vps"]))).toEqual([]);
    expect(targets(new Set(["laptop"]))).toEqual([]);
  });
});
