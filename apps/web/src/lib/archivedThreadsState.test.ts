import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { fetchArchivedThreadShells } from "./archivedThreadsState";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";
import { resolveOrphanedWorktreePathForDelete } from "../worktreeCleanup";
import { ThreadId } from "@t3tools/contracts";

vi.mock("../state/orchestration", () => ({
  orchestrationEnvironment: { archivedShellSnapshot: vi.fn() },
}));

const environmentId = EnvironmentId.make("archive-freshness-test");
const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-09-06T00:00:00.000Z",
};

afterEach(() => {
  appAtomRegistry.reset();
  vi.clearAllMocks();
});

describe("fetchArchivedThreadShells", () => {
  it("does not authorize cleanup from cached archived data after a failed refresh", async () => {
    let disconnected = false;
    const atom = Atom.make(
      Effect.suspend(() =>
        disconnected ? Effect.die("connection lost") : Effect.succeed(snapshot),
      ),
    );
    vi.mocked(orchestrationEnvironment.archivedShellSnapshot).mockReturnValue(atom);
    const unmount = appAtomRegistry.mount(atom);
    try {
      expect(await fetchArchivedThreadShells(environmentId)).toEqual([]);
      disconnected = true;
      const threadId = ThreadId.make("active-thread");
      const orphan = await resolveOrphanedWorktreePathForDelete({
        threads: [{ id: threadId, worktreePath: "/tmp/shared-worktree" }],
        threadId,
        fetchArchivedThreads: () => fetchArchivedThreadShells(environmentId),
      });
      expect(Option.isSome(AsyncResult.value(appAtomRegistry.get(atom)))).toBe(true);
      expect(orphan).toBeNull();
    } finally {
      unmount();
    }
  });
});
