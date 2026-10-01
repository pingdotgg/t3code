import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ClientProviderCaller } from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import type { Json, ViewContext } from "@t3tools/extension-sdk/contracts";
import { CLIENT_PROVIDER_APIS } from "@t3tools/extension-sdk/clientProviders";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { buildResolveConflictsPrompt } from "../components/pullRequest/pullRequestDetail.logic";
import { shouldRenderThreadScopedToast } from "../components/ui/toast.logic";
// A namespace import, so a missing provider fails each test on its own assertion.
import * as ClientProviders from "./clientProviders";
import { ClientProviderOpError, type ClientProviderInvokeCall } from "./clientProviderTypes";
import type { InstalledPackage } from "./installedController";

const shells = vi.hoisted(() => new Map<string, { projectId: string }>());
vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  readThreadShell: (ref: { threadId: string }) => shells.get(ref.threadId) ?? null,
  readProject: (ref: { projectId: string }) =>
    ref.projectId.startsWith("project-") ? { workspaceRoot: `/work/${ref.projectId}` } : null,
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));
/** Host steps and native toasts, in the order they happened. */
const timeline = vi.hoisted(() => [] as unknown[][]);
vi.mock("../components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui/toast")>()),
  toastManager: {
    add: (toast: unknown) => {
      timeline.push(["toast", toast]);
      return `toast-${timeline.length}`;
    },
    update: (id: string, toast: unknown) => timeline.push(["toast-update", id, toast]),
    close: (id: string) => timeline.push(["toast-close", id]),
  },
}));

const ENV = "env-a";
const INSTALL = "t3.version-control";
const GRANTS = ["t3.vcs/mutate", "t3.vcs/handoff"];
const PULL_REQUEST = {
  number: 12,
  url: "https://github.com/o/r/pull/12",
  headBranch: "feat/x",
  baseBranch: "main",
};
const TASK_PROMPT = buildResolveConflictsPrompt(PULL_REQUEST);
const NEW_DRAFT = DraftId.make("draft-handoff");
const NEW_THREAD = ThreadId.make("thread-handoff");

const caller: ClientProviderCaller = {
  installationId: INSTALL,
  contentHash: "hash-a",
  installationGeneration: 1,
};

const contextOf = (threadId: string | null, projectId = "project-a"): ViewContext => ({
  client: "web",
  resource: {
    namespace: INSTALL,
    id: `${INSTALL}/view`,
    environmentId: ENV,
    projectId,
    ...(threadId === null ? {} : { threadId }),
  },
});

function installation(
  capabilities: readonly string[],
  projectIds: readonly string[] = ["project-a"],
): InstalledPackage {
  return {
    id: INSTALL,
    contentHash: "hash-a",
    enabled: true,
    installationGeneration: 1,
    grants: {
      capabilities: [...capabilities],
      projectIds: projectIds.map((id) => ProjectId.make(id)),
    },
    package: { manifest: { id: INSTALL, apiVersion: 1, version: "1.0.0", surfaces: [] } },
  } as unknown as InstalledPackage;
}

type Prepared =
  | {
      readonly ok: true;
      readonly value: {
        branch: string;
        worktreePath: string | null;
        isOnPullRequestHead: boolean;
        isTrackingPullRequestHead?: boolean;
      };
    }
  | { readonly ok: false; readonly detail: string | null };

function setup(
  options: {
    grants?: readonly string[];
    projectId?: string;
    opened?: ReadonlyArray<{ draftId: DraftId; threadId: ThreadId } | null>;
    prepared?: Prepared;
    /** A host step that waits for `release` before it settles. */
    hold?: HostStep;
  } = {},
) {
  expect(ClientProviders.createPrHandoffClientProvider).toBeTypeOf("function");
  const steps: unknown[] = [];
  const opened = [...(options.opened ?? [{ draftId: NEW_DRAFT, threadId: NEW_THREAD }])];
  const held = gate();
  const reached = gate();
  const step = async (name: HostStep, entry: unknown[]) => {
    steps.push(entry);
    timeline.push([name]);
    if (options.hold === name) {
      reached.resolve();
      await held.promise;
    }
  };
  const host = {
    openThread: vi.fn(async (projectRef: unknown, workspace?: unknown) => {
      await step(
        workspace === undefined ? "openThread" : "point",
        workspace === undefined ? ["openThread", projectRef] : ["point", workspace],
      );
      return opened.length > 1 ? opened.shift()! : (opened[0] ?? null);
    }),
    prepare: vi.fn(async (input: unknown) => {
      await step("prepare", ["prepare", input]);
      return (
        options.prepared ?? {
          ok: true as const,
          value: {
            branch: "feat/x",
            worktreePath: "/work/project-a/.t3/worktrees/feat-x",
            isOnPullRequestHead: true,
          },
        }
      );
    }),
  };
  const projectId = options.projectId ?? "project-a";
  const installed = installation(options.grants ?? GRANTS, [projectId]);
  let installations: readonly InstalledPackage[] = [installed];
  const call = new AbortController();
  const provider = ClientProviders.createPrHandoffClientProvider(
    {
      environmentId: EnvironmentId.make(ENV),
      client: "web",
      emit: vi.fn(),
      installations: () => installations,
    },
    host,
  );
  const start = (input: Record<string, unknown>, threadId: string | null = "thread-a") =>
    Promise.resolve(
      provider.invoke({
        method: "start",
        // The adapter always names the mode; the worktree is native's default.
        input: { target: { kind: "self" }, mode: "worktree", ...input } as Json,
        context: contextOf(threadId, projectId),
        caller,
        signal: call.signal,
      } as ClientProviderInvokeCall),
    );
  const interruptions = {
    cancelled: () => call.abort(),
    uninstalled: () => {
      installations = [];
    },
    disabled: () => {
      installations = [{ ...installed, enabled: false }];
    },
    "stripped of its handoff grant": () => {
      installations = [installation(["t3.vcs/mutate"], [projectId])];
    },
  };
  return {
    host,
    steps,
    start,
    provider,
    interruptions,
    reached: reached.promise,
    release: () => held.resolve(),
  };
}

type HostStep = "openThread" | "prepare" | "point";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type DraftTarget = Parameters<
  ReturnType<typeof useComposerDraftStore.getState>["getComposerDraft"]
>[0];
const draftPrompt = (target: DraftTarget) =>
  useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
const threadA = scopeThreadRef(EnvironmentId.make(ENV), ThreadId.make("thread-a"));

/** The native toasts the handoff posted, each as its latest state. */
const toastsSoFar = () => {
  const toasts = new Map<string, Record<string, unknown> | "closed">();
  timeline.forEach((entry, index) => {
    if (entry[0] === "toast") toasts.set(`toast-${index + 1}`, entry[1] as Record<string, unknown>);
    if (entry[0] === "toast-update")
      toasts.set(entry[1] as string, entry[2] as Record<string, unknown>);
    if (entry[0] === "toast-close") toasts.set(entry[1] as string, "closed");
  });
  return [...toasts.values()];
};
const newThreadRef = scopeThreadRef(EnvironmentId.make(ENV), NEW_THREAD);

beforeEach(() => {
  timeline.length = 0;
  shells.clear();
  shells.set("thread-a", { projectId: "project-a" });
  useComposerDraftStore.getState().clearDraftThread(threadA);
  useComposerDraftStore.getState().setPrompt(NEW_DRAFT, "");
});

describe("pull-request handoff provider", () => {
  it("drafts native's resolve-conflicts prompt into the thread beside it, and never sends", async () => {
    const { host, start } = setup();
    await expect(start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST })).resolves.toEqual({
      status: "drafted",
    });
    // Still in the draft: a send would have cleared it.
    expect(draftPrompt(threadA)).toBe(TASK_PROMPT);
    expect(host.openThread).not.toHaveBeenCalled();
    expect(host.prepare).not.toHaveBeenCalled();
    // The reader's own words stay, with the task under them, and a repeat does not stack.
    useComposerDraftStore.getState().setPrompt(threadA, "My note");
    await start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST });
    await start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST });
    expect(draftPrompt(threadA)).toBe(`My note\n\n${TASK_PROMPT}`);
  });

  it("checks out into a worktree for a thread it opens first, then points that thread at it", async () => {
    const { steps, start } = setup();
    await expect(start({ task: "checkout", pullRequest: PULL_REQUEST })).resolves.toEqual({
      status: "ready",
      branch: "feat/x",
      worktreePath: "/work/project-a/.t3/worktrees/feat-x",
      isOnPullRequestHead: true,
    });
    const projectRef = scopeProjectRef(EnvironmentId.make(ENV), ProjectId.make("project-a"));
    expect(steps).toEqual([
      ["openThread", projectRef],
      // The setup script runs for the thread the checkout was prepared for.
      [
        "prepare",
        {
          environmentId: ENV,
          cwd: "/work/project-a",
          reference: PULL_REQUEST.url,
          mode: "worktree",
          threadId: NEW_THREAD,
        },
      ],
      [
        "point",
        {
          branch: "feat/x",
          worktreePath: "/work/project-a/.t3/worktrees/feat-x",
          envMode: "worktree",
        },
      ],
    ]);
    // A checkout carries no task, so nothing lands in either composer.
    expect(draftPrompt(NEW_DRAFT)).toBe("");
    expect(draftPrompt(threadA)).toBe("");
  });

  it("checks out in this repository for a thread it opens first, then points that thread there", async () => {
    const { steps, start } = setup({
      prepared: {
        ok: true,
        value: { branch: "feat/x", worktreePath: null, isOnPullRequestHead: true },
      },
    });
    await expect(
      start({ task: "checkout", mode: "local", pullRequest: PULL_REQUEST }),
    ).resolves.toEqual({
      status: "ready",
      branch: "feat/x",
      worktreePath: null,
      isOnPullRequestHead: true,
    });
    expect(steps).toEqual([
      ["openThread", scopeProjectRef(EnvironmentId.make(ENV), ProjectId.make("project-a"))],
      [
        "prepare",
        {
          environmentId: ENV,
          cwd: "/work/project-a",
          reference: PULL_REQUEST.url,
          mode: "local",
          threadId: NEW_THREAD,
        },
      ],
      // No worktree of its own, so the thread runs where the repository already is.
      ["point", { branch: "feat/x", worktreePath: null, envMode: "local" }],
    ]);
  });

  // Native offers no checkout without a project to check out into, and opens nothing.
  it("refuses a project it cannot resolve without opening a thread", async () => {
    const { host, start } = setup({ projectId: "gone" });
    await expect(
      start({ task: "checkout", pullRequest: PULL_REQUEST }, null),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    await expect(
      start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST }, null),
    ).rejects.toMatchObject({ code: "provider-rejected" });
    expect(host.openThread).not.toHaveBeenCalled();
    expect(host.prepare).not.toHaveBeenCalled();
  });

  it("with no thread beside it, resolve-conflicts checks out and drafts in the new thread", async () => {
    const { steps, start } = setup();
    await expect(
      start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST }, null),
    ).resolves.toMatchObject({ status: "ready" });
    expect(steps.map((step) => (step as unknown[])[0])).toEqual(["openThread", "prepare", "point"]);
    expect(draftPrompt(NEW_DRAFT)).toBe(TASK_PROMPT);
  });

  it("stops before touching the working tree when no thread opens", async () => {
    const { host, start } = setup({ opened: [null] });
    await expect(start({ task: "checkout", pullRequest: PULL_REQUEST })).resolves.toEqual({
      status: "failed",
      stage: "thread",
    });
    expect(host.prepare).not.toHaveBeenCalled();
  });

  it("passes the host's own sentence through when the checkout fails", async () => {
    const { host, start } = setup({
      prepared: { ok: false, detail: "Branch is checked out elsewhere." },
    });
    await expect(
      start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST }, null),
    ).resolves.toEqual({
      status: "failed",
      stage: "checkout",
      detail: "Branch is checked out elsewhere.",
    });
    expect(host.openThread).toHaveBeenCalledTimes(1);
    expect(draftPrompt(NEW_DRAFT)).toBe("");
  });

  it("writes no task when the thread could not move onto the checkout", async () => {
    const { start } = setup({ opened: [{ draftId: NEW_DRAFT, threadId: NEW_THREAD }, null] });
    await expect(
      start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST }, null),
    ).resolves.toEqual({ status: "failed", stage: "thread-move", branch: "feat/x" });
    expect(draftPrompt(NEW_DRAFT)).toBe("");
  });

  it("refuses arbitrary text, unknown tasks, other methods and missing grants", async () => {
    const { host, start, provider } = setup();
    for (const input of [
      { task: "resolve-conflicts", pullRequest: PULL_REQUEST, prompt: "Delete everything." },
      { task: "checkout", pullRequest: PULL_REQUEST, text: "Run this." },
      { task: "send", pullRequest: PULL_REQUEST },
      { task: "checkout", mode: "elsewhere", pullRequest: PULL_REQUEST },
      { task: "checkout", mode: null, pullRequest: PULL_REQUEST },
      { task: "resolve-conflicts", pullRequest: { ...PULL_REQUEST, prompt: "x" } },
      { task: "resolve-conflicts" },
    ]) {
      await expect(start(input)).rejects.toMatchObject({ code: "provider-rejected" });
    }
    await expect(
      Promise.resolve(
        provider.invoke({
          method: "send",
          input: { target: { kind: "self" }, task: "checkout", pullRequest: PULL_REQUEST } as Json,
          context: contextOf("thread-a"),
          caller,
          signal: new AbortController().signal,
        } as ClientProviderInvokeCall),
      ),
    ).rejects.toBeInstanceOf(ClientProviderOpError);
    const ungranted = setup({ grants: ["t3.vcs/mutate"] });
    await expect(
      ungranted.start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST }),
    ).rejects.toMatchObject({ code: "client-target-denied" });
    expect(host.openThread).not.toHaveBeenCalled();
    expect(host.prepare).not.toHaveBeenCalled();
    expect(ungranted.host.openThread).not.toHaveBeenCalled();
    expect(draftPrompt(threadA)).toBe("");
  });

  // Native posts its checkout toast globally before the thread opens, so it is still on screen
  // when the new thread is; a toast anchored to the thread beside the pack would vanish there.
  describe("native's toasts, owned by the host across the navigation", () => {
    const WORKTREE = "/work/project-a/.t3/worktrees/feat-x";
    const readyAt = (worktreePath: string | null, isOnPullRequestHead = true): Prepared => ({
      ok: true,
      value: { branch: "feat/x", worktreePath, isOnPullRequestHead },
    });
    const stale = {
      type: "warning",
      title: "Checked out, but the latest commits are unconfirmed",
      description:
        "The pull request's latest commits could not be confirmed or applied here, so this checkout may be behind the pull request.",
    };
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly input: Record<string, unknown>;
      readonly options?: Parameters<typeof setup>[0];
      /** Started beside thread A, whose toasts the new thread would hide, unless null. */
      readonly beside?: null;
      readonly settled: Record<string, unknown>;
    }> = [
      {
        name: "a worktree checkout",
        input: { task: "checkout" },
        options: { prepared: readyAt(WORKTREE) },
        settled: {
          type: "success",
          title: "Checked out",
          description: "The pull request is in its own worktree, with a thread open on it.",
        },
      },
      {
        name: "a checkout in this repository",
        input: { task: "checkout", mode: "local" },
        options: { prepared: readyAt(null) },
        settled: {
          type: "success",
          title: "Checked out here",
          description: "This repository is on the pull request's branch, with a thread open on it.",
        },
      },
      {
        name: "a stale worktree checkout",
        input: { task: "checkout" },
        options: { prepared: readyAt(WORKTREE, false) },
        settled: stale,
      },
      {
        name: "a checkout whose branch could not track the pull request",
        input: { task: "checkout" },
        options: {
          prepared: {
            ok: true,
            value: {
              branch: "feat/x",
              worktreePath: WORKTREE,
              isOnPullRequestHead: true,
              isTrackingPullRequestHead: false,
            },
          },
        },
        settled: {
          type: "warning",
          title: "Checked out, but its upstream is unconfirmed",
          description:
            "Setting the branch to track the pull request's branch failed, so it keeps any upstream it had. Pull and push may not reach the pull request.",
        },
      },
      {
        name: "a stale checkout in this repository",
        input: { task: "checkout", mode: "local" },
        options: { prepared: readyAt(null, false) },
        settled: stale,
      },
      {
        name: "resolve conflicts with no thread beside it",
        input: { task: "resolve-conflicts" },
        beside: null,
        settled: {
          type: "success",
          title: "Checkout ready",
          description: "The task is in the composer — read it over, then send.",
        },
      },
      {
        name: "a thread that would not open",
        input: { task: "checkout" },
        options: { opened: [null] },
        settled: {
          type: "error",
          title: "Could not open a thread for the checkout",
          description: "Try again from the project, or open a thread first.",
        },
      },
      {
        name: "a checkout the host refused",
        input: { task: "checkout", mode: "local" },
        options: { prepared: { ok: false, detail: "Branch is checked out elsewhere." } },
        settled: {
          type: "error",
          title: "Could not prepare the pull request checkout",
          description: "Branch is checked out elsewhere.",
        },
      },
      {
        name: "a thread that stayed where it was",
        input: { task: "checkout" },
        options: { opened: [{ draftId: NEW_DRAFT, threadId: NEW_THREAD }, null] },
        settled: {
          type: "error",
          title: "Checked out, but the thread stayed where it was",
          description:
            "The checkout is ready on `feat/x`. Point a thread at it from the branch picker, then ask again.",
        },
      },
    ];
    for (const { name, input, options, beside, settled } of cases) {
      it(`reports ${name} on the thread it opened`, async () => {
        const { start } = setup(options);
        await start({ ...input, pullRequest: PULL_REQUEST }, beside === null ? null : "thread-a");
        expect(timeline[0]).toEqual([
          "toast",
          { type: "loading", title: "Preparing the pull request checkout..." },
        ]);
        expect(timeline[1]).toEqual(["openThread"]);
        expect(timeline.at(-1)).toEqual(["toast-update", "toast-1", settled]);
        expect(toastsSoFar()).toEqual([settled]);
        for (const entry of timeline.filter((item) => String(item[0]).startsWith("toast")))
          expect(
            shouldRenderThreadScopedToast(
              (entry.at(-1) as { data?: { threadId?: ThreadId } }).data,
              newThreadRef,
            ),
          ).toBe(true);
      });
    }

    it("drafting beside a thread says so at once, with no loading toast", async () => {
      const { start } = setup();
      await start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST }, "thread-a");
      expect(timeline).toEqual([
        [
          "toast",
          {
            type: "success",
            title: "Added to the composer",
            description: "The task is in the composer — read it over, then send.",
          },
        ],
      ]);
    });

    it("says nothing for a handoff it refused", async () => {
      const { start } = setup({ projectId: "gone" });
      await expect(start({ task: "checkout", pullRequest: PULL_REQUEST }, null)).rejects.toThrow();
      expect(timeline).toEqual([]);
    });
  });

  // The server can cancel the call, and the pack can lose its install or grants, while a host
  // step is in flight. Nothing further may start after that: no checkout, no move, no task.
  describe("a handoff cancelled or revoked between steps", () => {
    const next: Record<HostStep, readonly string[]> = {
      openThread: ["openThread"],
      prepare: ["openThread", "prepare"],
      point: ["openThread", "prepare", "point"],
    };
    // Cancellation leaves the step's outcome unknown, so it names the pending stage rather than
    // reporting native's definitive failure.
    const abandoned: Record<HostStep, Record<string, unknown>> = {
      openThread: {
        type: "warning",
        title: "Handoff stopped",
        description: "Stopped while opening a thread; it may still finish.",
      },
      prepare: {
        type: "warning",
        title: "Handoff stopped",
        description: "Stopped while preparing the checkout; it may still finish.",
      },
      point: {
        type: "warning",
        title: "Handoff stopped",
        description: "Stopped while moving the thread to the checkout; it may still finish.",
      },
    };
    const interruptions = [
      "cancelled",
      "uninstalled",
      "disabled",
      "stripped of its handoff grant",
    ] as const;
    // Native moves the thread's workspace before its navigation settles, so a move cancelled
    // mid-flight may already have happened; claiming the thread stayed put would be false.
    it("says it stopped, not that the thread stayed, when cancelled after the move was applied", async () => {
      const handoff = setup({ hold: "point" });
      const started = handoff.start({ task: "resolve-conflicts", pullRequest: PULL_REQUEST }, null);
      await handoff.reached;
      expect(handoff.steps.at(-1)).toEqual([
        "point",
        {
          branch: "feat/x",
          worktreePath: "/work/project-a/.t3/worktrees/feat-x",
          envMode: "worktree",
        },
      ]);
      handoff.interruptions.cancelled();
      await expect(started).rejects.toBeInstanceOf(ClientProviderOpError);
      expect(toastsSoFar()).toEqual([abandoned.point]);
      handoff.release();
      expect(await handoff.host.openThread.mock.results.at(-1)?.value).toEqual({
        draftId: NEW_DRAFT,
        threadId: NEW_THREAD,
      });
      expect(toastsSoFar()).toEqual([abandoned.point]);
      expect(JSON.stringify(timeline)).not.toContain("the thread stayed where it was");
      expect(draftPrompt(NEW_DRAFT)).toBe("");
    });
    for (const hold of ["openThread", "prepare", "point"] as const) {
      for (const interruption of interruptions) {
        it(`starts nothing after ${hold} when ${interruption}`, async () => {
          const handoff = setup({ hold });
          const started = handoff.start(
            { task: "resolve-conflicts", pullRequest: PULL_REQUEST },
            null,
          );
          await handoff.reached;
          handoff.interruptions[interruption]();
          handoff.release();
          await expect(started).rejects.toBeInstanceOf(ClientProviderOpError);
          expect(handoff.steps.map((step) => (step as unknown[])[0])).toEqual(next[hold]);
          expect(draftPrompt(NEW_DRAFT)).toBe("");
          // No spinner is left behind for a handoff that stopped. A cancelled call fails the step
          // still running as native would; a revocation is noticed only once it returns.
          expect(toastsSoFar()).toEqual([
            interruption === "cancelled" ? abandoned[hold] : "closed",
          ]);
        });
      }
    }
  });

  it("registers at the version the SDK seam declares", () => {
    expect(ClientProviders.CLIENT_PROVIDER_DESCRIPTORS).toContainEqual({
      id: "t3.client/pr-handoff",
      version: CLIENT_PROVIDER_APIS.get("t3.client/pr-handoff")?.version,
    });
  });
});
