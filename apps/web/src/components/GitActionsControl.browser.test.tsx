import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ThreadId,
  type GitRunStackedActionResult,
  type GitStackedAction,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { memo } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";

type Branched = { readonly branch: string };
type GitActionInput = { featureBranch?: boolean; threadId?: string; action: GitStackedAction };

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  shell: null as Branched | null,
  detail: null as Branched | null,
  draft: null as (Branched & { worktreePath: null; envMode: "local" }) | null,
  branch: "main",
  isDefaultRef: false,
  actions: [] as { scope: { cwd: string | null }; input: GitActionInput }[],
  metadataRequests: [] as { environmentId: string; branch: string }[],
  afterGitAction: undefined as (() => void) | undefined,
  workingTreeRoot: undefined as string | undefined,
  files: [{ path: "file.ts", insertions: 1, deletions: 0 }],
  editorOpens: [] as { environmentId: string; input: { cwd: string; editor: string } }[],
}));

vi.mock(import("~/state/session"), async (original) => {
  const hasScope = (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: { threadId: string } | null) =>
    ref === null || state.shell === null ? null : { ...state.shell, id: ref.threadId }) as never,
  useQuietThreadProjection: ((ref: unknown) =>
    ref === null || state.detail === null
      ? null
      : { projection: { thread: state.detail } }) as never,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  // Serves VCS status, source-control discovery, and change-preview queries.
  useEnvironmentQuery: (() => ({
    data: {
      versionControlSystems: [],
      sourceControlProviders: [],
      sources: [],
      isRepo: true,
      refName: state.branch,
      isDefaultRef: state.isDefaultRef,
      hasPrimaryRemote: true,
      hasWorkingTreeChanges: true,
      workingTree: {
        ...(state.workingTreeRoot === undefined ? {} : { rootPath: state.workingTreeRoot }),
        files: state.files,
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    },
    error: null,
  })) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { shellEnvironment } = await import("~/state/shell");
  return {
    ...(await original()),
    // Only the thread's branch metadata update and editor opens are observed here.
    useAtomCommand: ((command: unknown, options: unknown) =>
      options === "thread branch metadata update"
        ? async ({
            environmentId,
            input,
          }: {
            environmentId: string;
            input: { branch: string };
          }) => {
            state.metadataRequests.push({ environmentId, branch: input.branch });
            if (!state.scopes.has(AuthOrchestrationOperateScope))
              return AsyncResult.failure(Cause.fail(new Error("Task denied")));
            if (state.shell) state.shell = { branch: input.branch };
            if (state.detail) state.detail = { branch: input.branch };
            return AsyncResult.success(undefined);
          }
        : command === shellEnvironment.openInEditor
          ? async (request: (typeof state.editorOpens)[number]) => {
              state.editorOpens.push(request);
              return AsyncResult.success(undefined);
            }
          : async () => AsyncResult.success(undefined)) as never,
  };
});
// The preferred-editor flow needs one editor the environment reports as installed.
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => ({
    availableEditors: ["cursor"],
    settings: DEFAULT_SERVER_SETTINGS,
  }));
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
  };
});
vi.mock(import("~/state/sourceControlActions"), async (original) => ({
  ...(await original()),
  useSourceControlActionRunning: () => false,
  useGitStackedAction: ((scope: { cwd: string | null }) => ({
    run: async (input: GitActionInput) => {
      state.actions.push({ scope, input });
      if (input.featureBranch) state.branch = "feature";
      state.afterGitAction?.();
      return AsyncResult.success<GitRunStackedActionResult>({
        action: input.action,
        branch: input.featureBranch
          ? { status: "created", name: "feature" }
          : { status: "skipped_not_requested" },
        commit: { status: "created" },
        push: { status: "skipped_not_requested" },
        pr: { status: "skipped_not_requested" },
        toast: {
          title: "Committed",
          description: "Committed",
          cta: {
            kind: "run_action",
            label: "Push & create PR",
            action: { kind: "commit_push_pr" },
          },
        },
      });
    },
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => async () => {}) as never,
}));

import { useComposerDraftStore } from "~/composerDraftStore";
import GitActionsControl from "./GitActionsControl";

// ThreadDetailsPanel keeps this component mounted behind React.memo when threads change.
const MemoGitActionsControl = memo(GitActionsControl);

function control(thread = "thread", cwd = "/repo") {
  return (
    <MemoGitActionsControl
      gitCwd={cwd}
      name={cwd}
      activeThreadRef={{
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make(thread),
      }}
    />
  );
}

const button = (name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

// The mocked modules read `state`, so every test starts by resetting all of it.
function setup() {
  state.scopes = new Set([AuthSourceControlWriteScope]);
  state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
  state.shell = { branch: "main" };
  state.detail = null;
  state.draft = null;
  state.branch = "main";
  state.isDefaultRef = false;
  state.actions = [];
  state.metadataRequests = [];
  state.afterGitAction = undefined;
  state.workingTreeRoot = undefined;
  state.files = [{ path: "file.ts", insertions: 1, deletions: 0 }];
  state.editorOpens = [];
  useComposerDraftStore.setState({
    getDraftSession: () => state.draft as never,
    getDraftThreadByRef: () => state.draft as never,
    setDraftThreadContext: (_target, input) => {
      if (state.draft && input.branch) state.draft = { ...state.draft, branch: input.branch };
    },
  });
}

describe("Git action targets across thread navigation", () => {
  const quickAction = () => button(/^Commit, push & /);

  it("runs the memoized panel button in the current thread after navigation", async () => {
    setup();
    await using screen = await render(control("first", "/first"));
    for (const [thread, cwd] of [
      ["first", "/first"],
      ["second", "/second"],
      ["first", "/first"],
    ] as const) {
      await screen.rerender(control(thread, cwd));
      await userEvent.click(quickAction());
      expect(state.actions.at(-1)).toMatchObject({ scope: { cwd }, input: { threadId: thread } });
    }
  });
});

async function openCommitDialog(): Promise<void> {
  await userEvent.click(button("Git action options"));
  await userEvent.click(page.getByRole("menuitem", { name: "Commit", exact: true }));
  await expect.element(page.getByRole("dialog")).toBeVisible();
}

describe("Git actions while thread details load", () => {
  it("does not create a feature branch for a server thread without task permission", async () => {
    setup();
    await using _screen = await render(control());
    await openCommitDialog();
    await expect.element(button("Commit on new branch")).toBeDisabled();
    expect(state.actions).toHaveLength(0);
    expect(state.shell?.branch).toBe("main");
  });

  it("commits and synchronizes the server thread before details finish loading", async () => {
    setup();
    state.primaryScopes.clear();
    state.scopes.add(AuthOrchestrationOperateScope);
    await using _screen = await render(control());
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));
    expect(state.branch).toBe("feature");
    expect(state.actions).toHaveLength(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("synchronizes archived thread detail after its shell disappears", async () => {
    setup();
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "main" };
    await using screen = await render(control());
    state.shell = null;
    await screen.rerender(control());
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));
    expect(state.actions).toHaveLength(1);
    expect(state.detail.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("requires task permission before changing an archived thread's branch", async () => {
    setup();
    state.shell = null;
    state.detail = { branch: "main" };
    await using _screen = await render(control());
    await openCommitDialog();
    await expect.element(button("Commit on new branch")).toBeDisabled();
    expect(state.actions).toHaveLength(0);
    expect(state.detail.branch).toBe("main");
    expect(state.metadataRequests).toEqual([]);
  });

  it("uses the current shell branch when cached detail names the new branch", async () => {
    setup();
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { branch: "feature" };
    await using _screen = await render(control());
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));
    expect(state.actions).toHaveLength(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });

  it("enables branch creation after the thread grant is gained", async () => {
    setup();
    await using screen = await render(control());
    await openCommitDialog();
    await expect.element(button("Commit on new branch")).toBeDisabled();
    state.scopes.add(AuthOrchestrationOperateScope);
    await screen.rerender(control());
    await userEvent.click(button("Commit on new branch"));
    expect(state.actions).toHaveLength(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toHaveLength(1);
  });

  it.each([
    [AuthOrchestrationOperateScope, false],
    [AuthSourceControlWriteScope, true],
  ] as const)(
    "uses the fresh task grant after Git finishes, revoking %s",
    async (revokedScope, syncsThread) => {
      setup();
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(revokedScope);
      await using _screen = await render(control());
      await openCommitDialog();
      await userEvent.click(button("Commit on new branch"));
      expect(state.actions).toHaveLength(1);
      expect(state.branch).toBe("feature");
      expect(state.shell?.branch).toBe(syncsThread ? "feature" : "main");
      expect(state.metadataRequests).toHaveLength(syncsThread ? 1 : 0);
    },
  );

  it("keeps ordinary commits available while details load", async () => {
    setup();
    await using _screen = await render(control());
    await openCommitDialog();
    await userEvent.click(button("Commit"));
    expect(state.actions).toHaveLength(1);
    expect(state.branch).toBe("main");
  });

  it("keeps feature-branch commits available for a local draft", async () => {
    setup();
    state.shell = null;
    state.draft = { branch: "main", worktreePath: null, envMode: "local" };
    await using _screen = await render(control());
    await openCommitDialog();
    await userEvent.click(button("Commit on new branch"));
    expect(state.actions).toHaveLength(1);
    expect(state.draft.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([]);
  });
});
