import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AgentSessionImportProjectChangedError,
  NodeId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  type AgentSessionImportInput,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  fakeDriver,
  emitThreadEvent,
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
  using _environment = installFakeEnvironment([]);
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
  await expect.element(page.getByRole("img", { name: "Pi", exact: true })).toBeVisible();
  await expect.element(page.getByRole("img", { name: "Claude Code", exact: true })).toBeVisible();
  await expect.element(page.getByRole("img", { name: "Codex", exact: true })).toBeVisible();
  const importButton = page.getByRole("button", { name: "Import Terminal sessions", exact: true });
  await userEvent.click(importButton);
  await expect.element(page.getByText(/changed directories/)).toBeVisible();
  changed = false;
  await userEvent.click(importButton);
  await expect.element(page.getByText("Terminal sessions: 2 imported, 1 skipped.")).toBeVisible();
  expect(importSessions).toHaveBeenLastCalledWith({
    projectId: PROJECT_ID,
    expectedWorkspaceRoot: "/workspace/render",
  });
  await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
  await expect.poll(() => scan.mock.calls.length).toBe(2);
  await userEvent.click(page.getByRole("link", { name: "Back to app" }));
  await expect
    .element(page.getByRole("heading", { name: "Import conversations" }))
    .not.toBeInTheDocument();
});

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
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

it("answers a pending question while an oversized message draft is set aside", async () => {
  const thread = threadWithHistory("oversized-question-draft", 0);
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const target = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const oversizedDraft = "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  // AppRoot owns the router.
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();

  const requestId = RuntimeRequestId.make("oversized-draft-question");
  const nodeId = NodeId.make("oversized-draft-node");
  const now = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
  await act(async () => {
    await emitThreadEvent(thread.id, {
      type: "runtime-request.updated",
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    await emitThreadEvent(thread.id, {
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make("oversized-draft-question-card"),
        threadId: thread.id,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_input_request",
        requestId,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should we use?",
            options: [],
            initialAnswer: "Composer",
          },
        ],
      },
    });
  });
  await expect.element(page.getByText("Which scope should we use?", { exact: true })).toBeVisible();
  await act(() => {
    useComposerDraftStore.getState().setPrompt(target, oversizedDraft);
  });
  await expect.element(page.getByText(/Prompt is 1 character over/)).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Answer", exact: true }).click();
  await expect.element(page.getByRole("button", { name: /Submitting/ }).first()).toBeVisible();
  expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(oversizedDraft);
});
