import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  PlanId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

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

it("a plan refinement that fails after a thread switch leaves the new thread's composer alone", async () => {
  const alpha = threadWithHistory("alpha", 1);
  const plan: OrchestrationV2ThreadProjection["plans"][number] = {
    id: PlanId.make("alpha-plan"),
    threadId: alpha.id,
    runId: alpha.runs[0]!.id,
    nodeId: NodeId.make("alpha-node"),
    status: "active",
    kind: "proposed_plan",
    markdown: "Plan for alpha",
  };
  const beta = threadWithHistory("beta", 1);
  using _environment = installFakeEnvironment([
    { ...alpha, plans: [plan], interactionMode: "plan" },
    beta,
  ]);
  let failRefinement: (() => void) | undefined;
  const sent: Array<{ readonly threadId: string; readonly text: string }> = [];
  using _dispatch = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
    (command: { readonly type: string; readonly threadId: string; readonly text: string }) => {
      if (command.type !== "message.dispatch") return Effect.succeed({ sequence: 2 });
      if (command.threadId === alpha.id) {
        return Effect.callback<never, string>((resume) => {
          failRefinement = () => resume(Effect.fail("refinement rejected"));
        });
      }
      sent.push({ threadId: command.threadId, text: command.text });
      return Effect.succeed({ sequence: 3 });
    },
  );
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    planModeEnabled: true,
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${alpha.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const composer = page.getByTestId("composer-editor");
  await expect.element(composer).toBeVisible();
  await userEvent.click(composer);
  await userEvent.keyboard("draft alpha");
  await expect.element(page.getByRole("button", { name: "Refine" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(failRefinement).toBeDefined());

  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENVIRONMENT_ID, threadId: beta.id },
  });
  await expect.element(page.getByText("beta: question 0")).toBeVisible();
  await userEvent.click(composer);
  await userEvent.keyboard("draft beta");
  await expect.element(composer).toHaveTextContent("draft beta");

  failRefinement?.();
  const alphaDraft = () =>
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, alpha.id));
  await vi.waitFor(() => expect(alphaDraft()?.prompt).toBe("draft alpha"));
  await expect.element(composer).toHaveTextContent("draft beta");

  await userEvent.click(composer);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(sent).toEqual([{ threadId: beta.id, text: "draft beta" }]));
});
