// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { McpCapability, McpInvocationScope } from "../../McpInvocationContext.ts";
import {
  __testing as brokerTesting,
  registerWorkspaceApprovalChannel,
  resolveWorkspaceApproval,
} from "./WorkspaceApprovalBroker.ts";
import {
  __testing as coordinatorTesting,
  WorkspaceBridgeCoordinator,
  WorkspaceBridgeCoordinatorLive,
  extractPatchPaths,
  filterGitDiff,
  filterGitStatus,
  formatNumberedSlice,
  matchesQuery,
  parseGitStatus,
  splitLines,
  workspaceMutationNeedsApproval,
} from "./WorkspaceBridgeCoordinator.ts";

const threadId = ThreadId.make("thread-chatgpt-1");

const makeScope = (capabilities: ReadonlyArray<McpCapability>): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("chatgpt"),
  capabilities: new Set(capabilities),
  issuedAt: 0,
  expiresAt: Number.MAX_SAFE_INTEGER,
});

const scope = makeScope(["workspace"]);
const fullScope = makeScope(["workspace", "workspace-write", "workspace-bash"]);

const makeThreadShell = (
  worktreePath: string,
  runtimeMode: RuntimeMode = "approval-required",
): OrchestrationThreadShell =>
  ({
    id: threadId,
    projectId: "project-1",
    title: "ChatGPT thread",
    modelSelection: { instanceId: ProviderInstanceId.make("chatgpt"), model: "chatgpt" },
    runtimeMode,
    interactionMode: "default",
    executorModelSelection: null,
    executorMaxSubAgents: 3,
    branch: null,
    worktreePath,
    parentThreadId: null,
    latestTurn: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  }) as OrchestrationThreadShell;

/**
 * Builds a workspace on disk with the shapes the guard has to handle: normal
 * source, a credential file, version-control internals, and a symlink that
 * points outside the tree.
 */
const makeWorkspace = Effect.fn("test.makeWorkspace")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "chatgpt-bridge-" });
  const outside = yield* fs.makeTempDirectoryScoped({ prefix: "chatgpt-outside-" });

  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.join(root, "src"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, ".git"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "node_modules", "left-pad"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, "src", "index.ts"),
      "const greeting = 1;\nconst other = 2;\nexport { greeting };\n",
    );
    await NodeFSP.writeFile(NodePath.join(root, "README.md"), "# Demo\n");
    await NodeFSP.writeFile(NodePath.join(root, "AGENTS.md"), "conventions\n");
    await NodeFSP.writeFile(NodePath.join(root, ".env"), "OPENAI_API_KEY=sk-secret\n");
    await NodeFSP.writeFile(NodePath.join(root, ".git", "config"), "[core]\n");
    await NodeFSP.writeFile(NodePath.join(root, "node_modules", "left-pad", "index.js"), "//\n");
    await NodeFSP.writeFile(NodePath.join(outside, "secrets.txt"), "TOP SECRET\n");
    await NodeFSP.mkdir(NodePath.join(outside, "secret-dir"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(outside, "secret-dir", "secrets.ts"), "OUTSIDE_SECRET\n");
    await NodeFSP.symlink(NodePath.join(outside, "secrets.txt"), NodePath.join(root, "escape.txt"));
    await NodeFSP.symlink(NodePath.join(outside, "secret-dir"), NodePath.join(root, "escape-dir"));
  });

  return { root, outside };
});

const makeHarness = (root: string, runtimeMode: RuntimeMode = "approval-required") => {
  const dispatched: Array<OrchestrationCommand> = [];
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
    streamDomainEvents: Stream.never,
    latestSequence: Effect.succeed(0),
    streamThreadEvents: () => Stream.never,
  });

  const unused = () => Effect.die("unused in WorkspaceBridgeCoordinator tests");
  const snapshotQuery = ProjectionSnapshotQuery.of({
    getCommandReadModel: unused,
    getSnapshot: unused,
    getShellSnapshot: unused,
    getArchivedShellSnapshot: unused,
    getSnapshotSequence: unused,
    getCounts: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getProjectShellById: unused,
    getFirstActiveThreadIdByProjectId: unused,
    getThreadCheckpointContext: unused,
    getFullThreadDiffContext: unused,
    getThreadShellById: () => Effect.succeed(Option.some(makeThreadShell(root, runtimeMode))),
    getThreadDetailById: unused,
    getThreadDetailSnapshot: unused,
    listChildThreadRefs: () => Effect.succeed([]),
  });

  const layer = WorkspaceBridgeCoordinatorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, engine),
        Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
        NodeServices.layer,
      ),
    ),
  );

  return { dispatched, layer };
};

const withCoordinator = <A, E>(
  use: (
    coordinator: WorkspaceBridgeCoordinator["Service"],
    context: { readonly root: string; readonly dispatched: Array<OrchestrationCommand> },
  ) => Effect.Effect<A, E, never>,
  options?: { readonly runtimeMode?: RuntimeMode },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { root } = yield* makeWorkspace();
      const { dispatched, layer } = makeHarness(root, options?.runtimeMode);
      // Build the layer into this test's scope rather than Effect.provide-ing
      // it: the coordinator forks approval executors into its layer scope, and
      // provide would close that scope the moment the service was extracted.
      const built = yield* Layer.build(layer);
      const coordinator = Context.get(built, WorkspaceBridgeCoordinator);
      return yield* use(coordinator, { root, dispatched });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

beforeEach(() => {
  brokerTesting.reset();
});

it.effect("overview reports the repository and hides blocked entries", () =>
  withCoordinator((coordinator) =>
    Effect.gen(function* () {
      const result = yield* coordinator.overview(scope);
      expect(result.entries).toContain("src");
      expect(result.entries).toContain("README.md");
      expect(result.entries).not.toContain(".git");
      expect(result.entries).not.toContain("node_modules");
      expect(result.instructionFiles).toEqual(["AGENTS.md", "README.md"]);
      expect(result.readOnly).toBe(true);
    }),
  ),
);

it.effect("read returns a numbered slice and reports the true total", () =>
  withCoordinator((coordinator) =>
    Effect.gen(function* () {
      const whole = yield* coordinator.read(scope, { path: "src/index.ts" });
      expect(whole.totalLines).toBe(3);
      expect(whole.content).toContain("1\tconst greeting = 1;");

      const slice = yield* coordinator.read(scope, {
        path: "src/index.ts",
        startLine: 2,
        endLine: 2,
      });
      expect(slice.content).toBe("2\tconst other = 2;");
      expect(slice.startLine).toBe(2);
      expect(slice.totalLines).toBe(3);
    }),
  ),
);

it.effect("read refuses credential files, traversal, and symlink escapes", () =>
  withCoordinator((coordinator) =>
    Effect.gen(function* () {
      const blocked = yield* coordinator.read(scope, { path: ".env" }).pipe(Effect.flip);
      expect(blocked.reason).toBe("path-not-allowed");

      const traversal = yield* coordinator
        .read(scope, { path: "../../etc/passwd" })
        .pipe(Effect.flip);
      expect(traversal.reason).toBe("path-not-allowed");

      // The symlink lives inside the workspace, so containment alone would
      // have let this through — only the realpath check stops it.
      const escape = yield* coordinator.read(scope, { path: "escape.txt" }).pipe(Effect.flip);
      expect(escape.reason).toBe("path-not-allowed");
    }),
  ),
);

it.effect("tree skips blocked directories entirely", () =>
  withCoordinator((coordinator) =>
    Effect.gen(function* () {
      const result = yield* coordinator.tree(scope, { path: ".", maxDepth: 4 });
      const paths = result.entries.map((entry) => entry.path);
      expect(paths).toContain("src");
      expect(paths).toContain("src/index.ts");
      expect(paths).not.toContain("escape-dir");
      expect(paths.some((path) => path.startsWith("escape-dir/"))).toBe(false);
      expect(paths.some((path) => path.startsWith(".git"))).toBe(false);
      expect(paths.some((path) => path.startsWith("node_modules"))).toBe(false);
    }),
  ),
);

it.effect("tree reports truncation instead of silently dropping entries", () =>
  withCoordinator((coordinator) =>
    Effect.gen(function* () {
      const result = yield* coordinator.tree(scope, { path: ".", maxEntries: 1 });
      expect(result.entries).toHaveLength(1);
      expect(result.truncated).toBe(true);
    }),
  ),
);

it.effect("search finds matches and never reads blocked files", () =>
  withCoordinator((coordinator) =>
    Effect.gen(function* () {
      const found = yield* coordinator.search(scope, { query: "greeting" });
      expect(found.matches.map((match) => match.path)).toContain("src/index.ts");
      expect(found.matches[0]?.line).toBe(1);

      // The secret exists on disk inside the workspace; the guard is what
      // keeps it out of the result set.
      const secret = yield* coordinator.search(scope, { query: "sk-secret" });
      expect(secret.matches).toHaveLength(0);
    }),
  ),
);

it.effect("every call mirrors one tool activity into the thread", () =>
  withCoordinator((coordinator, context) =>
    Effect.gen(function* () {
      yield* coordinator.overview(scope);
      yield* coordinator.read(scope, { path: "README.md" });

      const activities = context.dispatched.filter(
        (command) => command.type === "thread.activity.append",
      );
      expect(activities).toHaveLength(2);
      for (const command of activities) {
        expect(command.threadId).toBe(threadId);
        const activity = (command as { activity: { tone: string; kind: string } }).activity;
        expect(activity.tone).toBe("tool");
        expect(activity.kind.startsWith("tool.chatgpt-bridge.")).toBe(true);
      }
    }),
  ),
);

it.effect("a missing thread is refused before any filesystem access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const unused = () => Effect.die("unused");
      const snapshotQuery = ProjectionSnapshotQuery.of({
        getCommandReadModel: unused,
        getSnapshot: unused,
        getShellSnapshot: unused,
        getArchivedShellSnapshot: unused,
        getSnapshotSequence: unused,
        getCounts: unused,
        getActiveProjectByWorkspaceRoot: unused,
        getProjectShellById: unused,
        getFirstActiveThreadIdByProjectId: unused,
        getThreadCheckpointContext: unused,
        getFullThreadDiffContext: unused,
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: unused,
        getThreadDetailSnapshot: unused,
        listChildThreadRefs: () => Effect.succeed([]),
      });
      const engine = OrchestrationEngineService.of({
        readEvents: () => Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 1 }),
        streamDomainEvents: Stream.never,
        latestSequence: Effect.succeed(0),
        streamThreadEvents: () => Stream.never,
      });
      const coordinator = yield* WorkspaceBridgeCoordinator.pipe(
        Effect.provide(
          WorkspaceBridgeCoordinatorLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(OrchestrationEngineService, engine),
                Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
                NodeServices.layer,
              ),
            ),
          ),
        ),
      );

      const error = yield* coordinator.read(scope, { path: "README.md" }).pipe(Effect.flip);
      expect(error.reason).toBe("thread-not-found");
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

it.effect("full-access mode executes write, edit, and patch without approval", () =>
  withCoordinator(
    (coordinator, context) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const written = yield* coordinator.write(fullScope, {
          path: "notes/new.md",
          content: "hello\n",
        });
        expect(written.status).toBe("completed");
        expect(written.filesChanged).toEqual(["notes/new.md"]);
        expect(yield* fs.readFileString(NodePath.join(context.root, "notes/new.md"))).toBe(
          "hello\n",
        );

        const edited = yield* coordinator.edit(fullScope, {
          path: "src/index.ts",
          oldText: "const greeting = 1;",
          newText: "const greeting = 42;",
        });
        expect(edited.status).toBe("completed");
        expect(yield* fs.readFileString(NodePath.join(context.root, "src/index.ts"))).toContain(
          "const greeting = 42;",
        );

        const patch = [
          "diff --git a/README.md b/README.md",
          "--- a/README.md",
          "+++ b/README.md",
          "@@ -1 +1,2 @@",
          " # Demo",
          "+patched",
          "",
        ].join("\n");
        const applied = yield* coordinator.patch(fullScope, { patch });
        expect(applied.status).toBe("completed");
        expect(applied.filesChanged).toEqual(["README.md"]);
        expect(yield* fs.readFileString(NodePath.join(context.root, "README.md"))).toBe(
          "# Demo\npatched\n",
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    { runtimeMode: "full-access" },
  ),
);

it.effect("bash is disabled even in full-access mode", () =>
  withCoordinator(
    (coordinator) =>
      Effect.gen(function* () {
        const error = yield* coordinator
          .bash(fullScope, { command: "cat $HOME/.ssh/*" })
          .pipe(Effect.flip);
        expect(error.reason).toBe("invalid-input");
        expect(error.description).toContain("disabled");
      }),
    { runtimeMode: "full-access" },
  ),
);

it.effect("auto-accept-edits auto-approves file changes but not commands", () =>
  withCoordinator(
    (coordinator) =>
      Effect.gen(function* () {
        const written = yield* coordinator.write(fullScope, {
          path: "auto.md",
          content: "x\n",
        });
        expect(written.status).toBe("completed");

        const command = yield* coordinator
          .bash(fullScope, { command: "echo hi" })
          .pipe(Effect.flip);
        expect(command.reason).toBe("invalid-input");
      }),
    { runtimeMode: "auto-accept-edits" },
  ),
);

// `it.live`: the deferral path races a Deferred against a wall-clock timeout,
// and under the default TestClock that timer never fires.
it.live("approval-required defers the write until the user accepts", () =>
  withCoordinator((coordinator, context) =>
    Effect.gen(function* () {
      coordinatorTesting.setInitialApprovalWait("30 millis");
      const opened: Array<{ requestId: string; requestType: string; detail: string }> = [];
      registerWorkspaceApprovalChannel(threadId, {
        emitOpened: (request) =>
          Effect.sync(() => {
            opened.push(request);
          }),
        emitResolved: () => Effect.void,
      });

      const pending = yield* coordinator.write(fullScope, {
        path: "approved.md",
        content: "after approval\n",
      });
      expect(pending.status).toBe("pending-approval");
      expect(opened).toHaveLength(1);
      expect(opened[0]?.requestType).toBe("file_change_approval");
      expect(opened[0]?.detail).toContain("approved.md");

      // Nothing touched disk while pending.
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(NodePath.join(context.root, "approved.md"))).toBe(false);

      yield* resolveWorkspaceApproval(threadId, opened[0]!.requestId, "accept");
      const settled = yield* coordinator.wait(fullScope, { operationId: pending.operationId });
      expect(settled.status).toBe("completed");
      expect(yield* fs.readFileString(NodePath.join(context.root, "approved.md"))).toBe(
        "after approval\n",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("mutations refuse blocked paths, escapes, and missing capabilities", () =>
  withCoordinator(
    (coordinator) =>
      Effect.gen(function* () {
        const secret = yield* coordinator
          .write(fullScope, { path: ".env", content: "X=1\n" })
          .pipe(Effect.flip);
        expect(secret.reason).toBe("path-not-allowed");

        const escape = yield* coordinator
          .write(fullScope, { path: "escape.txt", content: "overwrite\n" })
          .pipe(Effect.flip);
        expect(escape.reason).toBe("path-not-allowed");

        const patchEscape = yield* coordinator
          .patch(fullScope, {
            patch:
              "diff --git a/../outside.txt b/../outside.txt\n--- a/../outside.txt\n+++ b/../outside.txt\n@@ -0,0 +1 @@\n+x\n",
          })
          .pipe(Effect.flip);
        expect(patchEscape.reason).toBe("path-not-allowed");

        // A read-only credential cannot mutate even in full-access mode.
        const readOnly = yield* coordinator
          .write(scope, { path: "ok.md", content: "x\n" })
          .pipe(Effect.flip);
        expect(readOnly.reason).toBe("capability-unavailable");

        const noBash = yield* coordinator
          .bash(makeScope(["workspace", "workspace-write"]), { command: "echo hi" })
          .pipe(Effect.flip);
        expect(noBash.reason).toBe("capability-unavailable");
      }),
    { runtimeMode: "full-access" },
  ),
);

it.effect("a rejected patch reports failed with git's reason", () =>
  withCoordinator(
    (coordinator) =>
      Effect.gen(function* () {
        const result = yield* coordinator.patch(fullScope, {
          patch:
            "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Not The Real Content\n+# Something\n",
        });
        expect(result.status).toBe("failed");
        expect(result.summary).toContain("does not apply");
      }),
    { runtimeMode: "full-access" },
  ),
);

it.effect("wait refuses unknown operations and other threads' operations", () =>
  withCoordinator((coordinator) =>
    Effect.gen(function* () {
      const missing = yield* coordinator
        .wait(fullScope, { operationId: "write:nope" })
        .pipe(Effect.flip);
      expect(missing.reason).toBe("operation-not-found");
    }),
  ),
);

it("workspaceMutationNeedsApproval mirrors the runtime-mode ladder", () => {
  expect(workspaceMutationNeedsApproval("approval-required", "write")).toBe(true);
  expect(workspaceMutationNeedsApproval("approval-required", "bash")).toBe(true);
  expect(workspaceMutationNeedsApproval("auto-accept-edits", "edit")).toBe(false);
  expect(workspaceMutationNeedsApproval("auto-accept-edits", "bash")).toBe(true);
  expect(workspaceMutationNeedsApproval("auto", "patch")).toBe(false);
  expect(workspaceMutationNeedsApproval("auto", "bash")).toBe(true);
  expect(workspaceMutationNeedsApproval("full-access", "write")).toBe(false);
  expect(workspaceMutationNeedsApproval("full-access", "bash")).toBe(false);
});

it("extractPatchPaths reads git headers and ignores /dev/null", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/new.ts b/new.ts",
    "--- /dev/null",
    "+++ b/new.ts",
    "rename from old/name.ts",
    "rename to fresh/name.ts",
  ].join("\n");
  expect([...extractPatchPaths(patch)].sort()).toEqual([
    "fresh/name.ts",
    "new.ts",
    "old/name.ts",
    "src/a.ts",
  ]);
  expect(extractPatchPaths("not a patch at all")).toEqual([]);
});

it("splitLines does not invent a trailing line for newline-terminated files", () => {
  expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  expect(splitLines("a\nb")).toEqual(["a", "b"]);
  expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
  expect(splitLines("")).toEqual([]);
});

it("formatNumberedSlice aligns numbers to the widest line in the slice", () => {
  expect(formatNumberedSlice(["a", "b"], 9)).toBe(" 9\ta\n10\tb");
});

it("matchesQuery is case-insensitive until the query carries a capital", () => {
  expect(matchesQuery("const Greeting = 1", "greeting")).toBe(true);
  expect(matchesQuery("const greeting = 1", "Greeting")).toBe(false);
  expect(matchesQuery("const Greeting = 1", "Greeting")).toBe(true);
});

it("parseGitStatus reports the destination path of a rename", () => {
  expect(
    parseGitStatus("R  old/name.ts -> new/name.ts\n M src/index.ts\n?? untracked.md\n"),
  ).toEqual([
    { path: "new/name.ts", status: "R" },
    { path: "src/index.ts", status: "M" },
    { path: "untracked.md", status: "??" },
  ]);
});

it("filters changed credential files and disables their diff content", () => {
  const root = "/workspace/project";
  const status = " M .env\n M src/index.ts\nR  .env.local -> config.ts\n";
  expect(filterGitStatus(root, status)).toEqual([{ path: "src/index.ts", status: "M" }]);
  expect(filterGitDiff(root, status, "diff --git a/.env b/.env\nSECRET")).toBe("");
});
