/**
 * The version-control pack's checkout handoff, from the real pull-request
 * panel mounted through the real native bridge to the real host handoff
 * provider. Opening the new thread navigates away from the thread whose side
 * panel started the handoff, which disposes that view; the handoff must still
 * finish. The pack's call reaches the provider with the signal it passed, as
 * the HTTP request, the broker and the client-provider cancel frame carry it.
 */
import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type ClientProviderCaller } from "@t3tools/contracts";
import type { ApiInvocation } from "@t3tools/extension-sdk/capabilities";
import type { Json, ViewRecord } from "@t3tools/extension-sdk/contracts";
import type { Extension, ViewSession } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";
import { DraftId } from "../composerDraftStore";
import { createPrHandoffClientProvider } from "./clientProviders";
import type { ClientProviderInvokeCall } from "./clientProviderTypes";
import type { InstalledPackage } from "./installedController";
import { createNativeSurfaceBridge } from "./nativeBridge";

vi.mock("../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/entities")>()),
  readThreadShell: () => ({ projectId: "project-a" }),
  readProject: () => ({ workspaceRoot: "/work/project-a" }),
}));
vi.mock("../components/ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));
const toasts = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ui/toast")>()),
  toastManager: {
    add: (toast: unknown) => {
      const id = `toast-${toasts.size + 1}`;
      toasts.set(id, toast);
      return id;
    },
    update: (id: string, toast: unknown) => toasts.set(id, toast),
    close: (id: string) => toasts.set(id, "closed"),
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type PanelProps = {
  host: unknown;
  session: ViewSession;
  visible: boolean;
  selected: { host: string; repository: string; number: number };
  onSelect: () => void;
};
// The pack is not a web dependency, so it loads by path and is typed by the shape used here.
const { PullRequestsPanel } = (await import(
  "../../../../packages/first-party-extensions/version-control/prsPanel.tsx" as string
)) as { PullRequestsPanel: React.ComponentType<PanelProps> };

const ENV = "env-a";
const INSTALL = "t3.version-control";
const URL = "https://github.com/o/r/pull/3";
const PULL_REQUEST = { number: 3, url: URL, headBranch: "b3", baseBranch: "main" };
const NEW_THREAD = ThreadId.make("thread-b");
const caller: ClientProviderCaller = {
  installationId: INSTALL,
  contentHash: "hash-a",
  installationGeneration: 1,
};
const installation = {
  id: INSTALL,
  contentHash: "hash-a",
  enabled: true,
  installationGeneration: 1,
  grants: {
    capabilities: ["t3.vcs/mutate", "t3.vcs/handoff"],
    projectIds: [ProjectId.make("project-a")],
  },
  package: { manifest: { id: INSTALL, apiVersion: 1, version: "1.0.0", surfaces: [] } },
} as unknown as InstalledPackage;

const record: ViewRecord = {
  version: 1,
  surfaceId: "t3.version-control/prs",
  stateVersion: 1,
  placement: "side-panel",
  restoreState: null,
  fallback: "Pull requests unavailable",
  context: {
    client: "web",
    resource: {
      namespace: INSTALL,
      id: `${INSTALL}/view`,
      environmentId: ENV,
      projectId: "project-a",
      threadId: "thread-a",
    },
  },
};

const detail = {
  provider: "github",
  capabilities: {
    diff: false,
    comment: false,
    actions: [],
    mergeMethods: [],
    search: true,
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    stacks: false,
    stackActions: false,
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
  projectId: "project-a",
  projectTitle: "Project",
  workspaceRoot: "/work/project-a",
  repository: "o/r",
  number: 3,
  title: "Layer 3",
  body: "",
  url: URL,
  author: null,
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  headBranch: "b3",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  autoMergeEnabled: false,
};

const handlers: Record<string, () => unknown> = {
  "t3.prs/read#getCapabilities": () => ({
    hosted: true,
    reason: null,
    detail: null,
    providers: [],
    operations: { "prs.detail": true, "prs.activity": true, "prs.linkedThreads": true },
  }),
  "t3.prs/write#getCapabilities": () => ({
    hosted: true,
    reason: null,
    detail: null,
    operations: {},
    actions: [],
    mergeMethods: [],
    updateMethods: [],
    verdicts: [],
  }),
  "t3.vcs/actions#getCapabilities": () => ({
    detected: true,
    operations: {
      "actions.preparePullRequestThread": true,
      "actions.handoffPullRequest": true,
    },
  }),
  "t3.prs/read#detail": () => detail,
  "t3.prs/read#activity": () => ({
    comments: [],
    commentCount: 0,
    commentsTruncated: false,
    reviewThreads: [],
    commits: [],
    truncated: false,
  }),
  "t3.prs/read#linkedThreads": () => ({ threads: [], truncated: false }),
  "t3.ui/notifications#getCapabilities": () => ({ adapter: "none", operations: {}, clients: [] }),
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => (resolve = settle));
  return { promise, resolve };
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) await new Promise((next) => setTimeout(next, 0));
  });
}

function nodeName(node: { props?: Record<string, unknown> } | string): string {
  if (typeof node === "string") return node;
  const label = node.props?.["aria-label"];
  if (typeof label === "string") return label;
  const text: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "string" || typeof value === "number") text.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if ((value as { props?: { children?: unknown } })?.props?.children !== undefined)
      walk((value as { props: { children: unknown } }).props.children);
  };
  walk(node.props?.children);
  return text.join("").trim();
}

function click(node: { props: Record<string, unknown>; parent: unknown }) {
  const event = {
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    currentTarget: { contains: () => true },
  };
  act(() => {
    for (
      let cursor: { props?: Record<string, unknown>; parent?: unknown } | null = node;
      cursor && !event.propagationStopped;
      cursor = cursor.parent as typeof cursor
    ) {
      const listener = cursor.props?.onClick;
      if (typeof listener === "function") listener(event);
    }
  });
}

function scenario(mode: "worktree" | "local") {
  const worktreePath = mode === "worktree" ? "/work/project-a/.t3/worktrees/b3" : null;
  const steps: unknown[] = [];
  const releasePrepare = gate();
  let session!: ViewSession;
  let navigate!: (threadId: string) => void;

  const provider = createPrHandoffClientProvider(
    {
      environmentId: EnvironmentId.make(ENV),
      client: "web",
      emit: vi.fn(),
      installations: () => [installation],
    },
    {
      openThread: async (_projectRef: unknown, workspace?: unknown) => {
        steps.push(workspace === undefined ? ["open"] : ["point", workspace]);
        // Opening a thread navigates to it: thread A's side panel goes away.
        if (workspace === undefined) act(() => navigate(NEW_THREAD));
        return { draftId: DraftId.make("draft-b"), threadId: NEW_THREAD };
      },
      prepare: async (input: unknown) => {
        steps.push(["prepare", input]);
        await releasePrepare.promise;
        return { ok: true, value: { branch: "b3", worktreePath, isOnPullRequestHead: true } };
      },
    },
  );

  // The installed pack's host: API reads answer at once; the handoff goes to the
  // host provider under the caller's own signal, as the transport forwards it.
  const packHost = {
    React,
    async invokeApi(request: ApiInvocation, signal: AbortSignal) {
      const key = `${request.id}#${request.method}`;
      if (key === "t3.vcs/actions#handoffPullRequest") {
        const input = request.input as { task: string; mode: string };
        return (await provider.invoke({
          method: "start",
          input: {
            target: { kind: "self" },
            task: input.task,
            mode: input.mode,
            pullRequest: PULL_REQUEST,
          } as Json,
          context: request.context,
          caller,
          signal,
        } as ClientProviderInvokeCall)) as Json;
      }
      const handler = handlers[key];
      if (!handler) throw new Error(`unexpected ${key}`);
      return handler() as Json;
    },
    subscribeApi: (_request: unknown, signal: AbortSignal) =>
      (async function* () {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
      })(),
    discoverApis: async () => [],
    invokeTool: async () => null,
  };

  const extension: Extension<SurfaceRenderer> = {
    manifest: {
      id: INSTALL,
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [
        {
          id: record.surfaceId,
          title: "Pull requests",
          placements: ["side-panel"],
          clients: ["web"],
          scope: "thread",
          capabilities: [],
          stateVersion: 1,
        },
      ],
    },
    surfaces: [
      {
        id: record.surfaceId,
        validateRestore: (state) => state === null,
        createView(current) {
          session = current;
          return {
            renderer: () => (
              <PullRequestsPanel
                host={packHost}
                session={current}
                visible
                selected={{ host: "github.com", repository: "o/r", number: 3 }}
                onSelect={() => {}}
              />
            ),
          };
        },
      },
    ],
  };
  const bridge = createNativeSurfaceBridge<null>(() => extension, { authorize: () => true });

  function App() {
    const [threadId, setThreadId] = React.useState("thread-a");
    navigate = setThreadId;
    // The retained side panel belongs to thread A only.
    return threadId === "thread-a" ? (
      <bridge.Surface bindings={null} record={record} visible />
    ) : null;
  }

  let root!: ReactTestRenderer;
  act(() => {
    root = create(<App />, {
      createNodeMock: () => ({ focus() {}, contains: () => false }),
    });
  });
  const buttons = () =>
    root.root.findAll((node) => node.type === "button") as unknown as Array<{
      props: Record<string, unknown>;
      parent: unknown;
    }>;
  return {
    steps,
    worktreePath,
    release: () => releasePrepare.resolve(),
    session: () => session,
    buttons,
    root,
  };
}

beforeEach(() => {
  toasts.clear();
});

describe("a pull-request checkout handoff started from a side panel", () => {
  for (const mode of ["worktree", "local"] as const) {
    it(`finishes in ${mode} mode after opening its thread disposes the panel`, async () => {
      const handoff = scenario(mode);
      await flush();
      const checkout = handoff.buttons().filter((node) => nodeName(node) === "Check out");
      expect(checkout).toHaveLength(1);
      click(checkout[0]!);
      await flush();
      const item = handoff
        .buttons()
        .find(
          (node) =>
            node.props.role === "menuitem" &&
            nodeName(node).startsWith(
              mode === "worktree" ? "In a separate worktree" : "In this repository",
            ),
        );
      expect(item).toBeDefined();
      click(item!);
      await flush();
      // The originating view is gone, and its session with it, while preparation is held.
      expect(handoff.root.toJSON()).toBeNull();
      expect(handoff.session().signal.aborted).toBe(true);
      expect(handoff.steps.map((step) => (step as unknown[])[0])).toEqual(["open", "prepare"]);
      expect([...toasts.values()]).toEqual([
        { type: "loading", title: "Preparing the pull request checkout..." },
      ]);
      handoff.release();
      await flush();

      expect(handoff.steps).toEqual([
        ["open"],
        [
          "prepare",
          {
            environmentId: ENV,
            cwd: "/work/project-a",
            reference: URL,
            mode,
            threadId: NEW_THREAD,
          },
        ],
        [
          "point",
          {
            branch: "b3",
            worktreePath: handoff.worktreePath,
            envMode: mode,
          },
        ],
      ]);
      const settled = [...toasts.values()];
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ type: "success" });
      act(() => handoff.root.unmount());
    });
  }
});
