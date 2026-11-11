import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AgentSessionImportProjectChangedError,
  ThreadId,
  WS_METHODS,
  type AgentSessionImportInput,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  fakeDriver,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("imports Pi conversations through the environment RPC and can retry a changed project", async () => {
  using _environment = installFakeEnvironment([], { acceptCommands: true });
  const scan = vi.fn(() =>
    Effect.succeed({
      candidates: [
        {
          path: "/workspace/render",
          title: "Terminal sessions",
          projectId: PROJECT_ID,
          sources: ["claudeAgent", "codex", "pi"] as const,
          threadCount: 3,
          lastActiveAt: "2026-03-17T19:12:28.000Z",
          alreadyImported: true,
        },
      ],
      scannedAt: "2026-03-18T09:00:30.000Z",
    }),
  );
  let changed = true;
  const importSessions = vi.fn((_input: AgentSessionImportInput) =>
    changed
      ? Effect.fail(new AgentSessionImportProjectChangedError({ projectId: PROJECT_ID }))
      : Effect.succeed({ importedCount: 2, skippedCount: 1 }),
  );
  const connect = fakeDriver.connect;
  using _connection = vi.spyOn(fakeDriver, "connect").mockImplementation((entry) =>
    connect(entry).pipe(
      Effect.map((lease) => ({
        ...lease,
        session: {
          ...lease.session,
          client: new Proxy(lease.session.client, {
            get(target, method, receiver) {
              if (method === WS_METHODS.agentSessionsScan) return scan;
              if (method === WS_METHODS.agentSessionsImport) return importSessions;
              if (method === WS_METHODS.projectsReadFile)
                return ({ relativePath }: { relativePath: string }) =>
                  Effect.succeed({
                    relativePath,
                    contents: "",
                    byteLength: 0,
                    truncated: false,
                    exists: false,
                  });
              return Reflect.get(target, method, receiver);
            },
          }),
        },
      })),
    ),
  );
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const router = getRouter(createMemoryHistory({ initialEntries: ["/welcome"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await page.getByRole("button", { name: "Review all 1", exact: true }).click();
  await expect.element(page.getByRole("img", { name: "Pi", exact: true })).toBeVisible();
  await expect.element(page.getByRole("img", { name: "Claude Code", exact: true })).toBeVisible();
  await expect.element(page.getByRole("img", { name: "Codex", exact: true })).toBeVisible();
  await page.getByText("Import projects and their threads", { exact: true }).click();
  await page.getByRole("button", { name: "Import threads and start", exact: true }).click();
  await expect
    .element(page.getByText("Could not import thread history.", { exact: true }))
    .toBeVisible();
  await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));

  expect(importSessions).toHaveBeenCalledTimes(1);
  await expect
    .element(page.getByRole("heading", { name: "Welcome to T3 Code" }))
    .not.toBeInTheDocument();
  changed = false;
  await router.navigate({ to: "/welcome" });
  await expect.element(page.getByRole("heading", { name: "Welcome to T3 Code" })).toBeVisible();
  await page.getByText("Import projects and their threads", { exact: true }).click();
  await page.getByRole("button", { name: "Import threads and start", exact: true }).click();
  await expect
    .element(page.getByText("Imported 2 threads. 1 thread could not be imported.", { exact: true }))
    .toBeVisible();
  expect(importSessions).toHaveBeenCalledTimes(2);
  expect(importSessions).toHaveBeenLastCalledWith({
    projectId: PROJECT_ID,
    expectedWorkspaceRoot: "/workspace/render",
  });
  await expect
    .element(page.getByRole("heading", { name: "Welcome to T3 Code" }))
    .not.toBeInTheDocument();
});

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("opens the thread actions menu for an older settled thread the shell leaves out", async () => {
  const thread = { ...threadWithHistory("older-settled", 1), olderSettled: true as const };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("older-settled: question 0")).toBeVisible();

  await page.getByRole("button", { name: `Thread actions for ${thread.title}` }).click();
  // Without a bound the poll runs to the test deadline and reports a bare timeout.
  await expect
    .element(page.getByRole("menuitem", { name: "Rename thread" }), { timeout: 5_000 })
    .toBeVisible();
});

it("retains each thread's diff selection when returning from another thread or Settings", async () => {
  const a = threadWithHistory("diff-selection-a", 1);
  const b = threadWithHistory("diff-selection-b", 1);
  using _environment = installFakeEnvironment([a, b]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const aRef = scopeThreadRef(ENVIRONMENT_ID, a.id);
  const bRef = scopeThreadRef(ENVIRONMENT_ID, b.id);
  useRightPanelStore.getState().open(aRef, "diff");
  useRightPanelStore.getState().open(bRef, "diff");
  useDiffPanelStore.getState().selectBranchBaseRef(bRef, "origin/release");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  await act(() => useDiffPanelStore.getState().selectGitScope(aRef, "unstaged"));

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: b.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${b.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, bRef)).toEqual({
    kind: "branch",
    baseRef: "origin/release",
  });
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef)).toEqual({
    kind: "unstaged",
  });

  await act(() => useDiffPanelStore.getState().selectTurn(aRef, a.runs[0]!.id));
  await act(() => router.navigate({ to: "/settings/general" }));
  await expect
    .element(page.getByRole("heading", { name: "Time format", exact: true }))
    .toBeVisible();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef),
  ).toMatchObject({
    kind: "turn",
    turnId: a.runs[0]!.id,
  });
});
