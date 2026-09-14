import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { applyShellStreamEvent } from "@t3tools/client-runtime/state/shell";

vi.mock("./shell", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const Queue = await import("effect/Queue");
  const Stream = await import("effect/Stream");
  const { createEnvironmentSnapshotAtom } = await import("@t3tools/client-runtime/state/shell");
  type State = import("@t3tools/client-runtime/state/shell").EnvironmentShellState;
  const state = (snapshot: OrchestrationShellSnapshot | null): State => ({
    status: "live",
    snapshot: Option.fromNullishOr(snapshot),
    error: Option.none(),
  });
  type Emit = (snapshots: ReadonlyArray<OrchestrationShellSnapshot | null>) => void;
  let resolveEmitter: (emit: Emit) => void;
  const emitter = new Promise<Emit>((resolve) => {
    resolveEmitter = resolve;
  });
  const events = Stream.callback<ReadonlyArray<State>>((queue) =>
    Effect.sync(() => {
      resolveEmitter((snapshots) => {
        Queue.offerUnsafe(queue, snapshots.map(state));
      });
    }),
  );
  const runtime = Atom.runtime(Layer.empty);
  const source = runtime.atom(events.pipe(Stream.flatMap(Stream.fromIterable)), {
    initialValue: state(null),
  });
  return {
    environmentSnapshotAtom: createEnvironmentSnapshotAtom(() => source),
    allEnvironmentProjectSnapshotsReadyAtom: Atom.make(true),
    allEnvironmentShellsBootstrappedAtom: Atom.make(true),
    publish: async (snapshots: ReadonlyArray<OrchestrationShellSnapshot | null>) => {
      (await emitter)(snapshots);
    },
  };
});
vi.mock("./projects", async () => {
  const { createEnvironmentProjectAtoms } = await import("@t3tools/client-runtime/state/projects");
  const { environmentSnapshotAtom } = await import("./shell");
  return {
    environmentProjects: createEnvironmentProjectAtoms({
      catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }),
      snapshotAtom: environmentSnapshotAtom,
    }),
  };
});

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSnapshotAtom } from "./shell";
import { waitForProject } from "./entities";

const ref = {
  environmentId: EnvironmentId.make("folder-environment"),
  projectId: ProjectId.make("project"),
};
const fixture = await vi.importMock<{
  publish: (snapshots: ReadonlyArray<OrchestrationShellSnapshot | null>) => Promise<void>;
}>("./shell");
const atom = environmentSnapshotAtom(ref.environmentId);
let unmount: () => void;
beforeAll(() => {
  unmount = appAtomRegistry.mount(atom);
});
function snapshot(sequence: number, workspaceRoot: string): OrchestrationShellSnapshot {
  return {
    snapshotSequence: sequence,
    updatedAt: "2026-09-05T00:00:00.000Z",
    threads: [],
    projects: [
      {
        id: ref.projectId,
        title: "Project",
        workspaceRoot,
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      },
    ],
  };
}
async function publish(snapshots: ReadonlyArray<OrchestrationShellSnapshot | null>) {
  const expected = snapshots.at(-1);
  const delivered = new Promise<void>((resolve) => {
    const stop = appAtomRegistry.subscribe(atom, (current) => {
      if (current === expected) {
        stop();
        resolve();
      }
    });
  });
  await fixture.publish(snapshots);
  await delivered;
}
afterEach(async () => {
  vi.useRealTimers();
  await publish([null]);
});
afterAll(() => {
  unmount();
  appAtomRegistry.dispose();
});

describe("project folder updates", () => {
  it("preserves the existing newly-created-project wait", async () => {
    const pending = waitForProject(ref);
    await publish([snapshot(1, "/created")]);
    expect((await pending).workspaceRoot).toBe("/created");
  });

  it("waits through unrelated cursor15 for a coalesced target20", async () => {
    const old = snapshot(1, "/old");
    await publish([old]);
    let settled = false;
    const pending = waitForProject(ref, { workspaceRoot: "/selected" }).then((project) => {
      settled = true;
      return project;
    });
    const unrelated15 = applyShellStreamEvent(old, {
      kind: "thread-removed",
      sequence: 15,
      threadId: ThreadId.make("unrelated"),
    });
    await publish([unrelated15]);
    expect(settled).toBe(false);
    await publish([snapshot(20, "/selected")]);
    expect((await pending).workspaceRoot).toBe("/selected");
  });

  it("does not mistake project8 bundled with unrelated15 for the requested folder", async () => {
    await publish([snapshot(1, "/old")]);
    const seen: number[] = [];
    const stop = appAtomRegistry.subscribe(atom, (current) => {
      if (current) seen.push(current.snapshotSequence);
    });
    let settled = false;
    const pending = waitForProject(ref, { workspaceRoot: "/selected" }).then((project) => {
      settled = true;
      return project;
    });
    const project8 = snapshot(8, "/intermediate");
    const unrelated15 = applyShellStreamEvent(project8, {
      kind: "thread-removed",
      sequence: 15,
      threadId: ThreadId.make("unrelated"),
    });
    await publish([project8, unrelated15]);
    expect(seen).toEqual([15]);
    expect(settled).toBe(false);
    const target = snapshot(20, "/selected");
    const identity = {
      canonicalKey: "github.com/example/relinked",
      rootPath: "/selected",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/relinked.git",
      },
      provider: "github",
      owner: "example",
      name: "relinked",
      displayName: "Relinked",
    };
    await publish([
      { ...target, projects: [{ ...target.projects[0]!, repositoryIdentity: identity }] },
    ]);
    const project = await pending;
    expect(project.workspaceRoot).toBe("/selected");
    expect(project.repositoryIdentity).toEqual(identity);
    stop();
  });

  it.each([
    ["/selected/", "/selected"],
    ["C:/Selected/", "c:\\selected"],
  ])("accepts an already-delivered server path %s", async (selected, actual) => {
    await publish([snapshot(20, actual)]);
    expect((await waitForProject(ref, { workspaceRoot: selected })).workspaceRoot).toBe(actual);
  });

  it("times out honestly if a later retarget coalesces the requested folder away", async () => {
    await publish([snapshot(1, "/old")]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = waitForProject(ref, { workspaceRoot: "/selected", timeoutMs: 10 });
    const failure = expect(pending).rejects.toThrow("project did not appear");
    await publish([snapshot(20, "/selected"), snapshot(30, "/elsewhere")]);
    await vi.advanceTimersByTimeAsync(10);
    await failure;
    expect(appAtomRegistry.get(atom)?.projects[0]?.workspaceRoot).toBe("/elsewhere");
  });
});
