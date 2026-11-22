import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  NodeId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  ProviderSessionId,
  RuntimeRequestId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { buildThreadRouteParams } from "~/threadRoutes";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const AT = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");

function seatAsking(
  seat: FakeThread,
  parentId: ThreadId,
  kind: OrchestrationV2RuntimeRequest["kind"],
): FakeThread {
  const id = RuntimeRequestId.make(`${seat.id}-request`);
  const nodeId = NodeId.make(`${seat.id}-request`);
  const base = {
    id: TurnItemId.make(`${seat.id}-request`),
    threadId: seat.id,
    runId: seat.runs[0]!.id,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 99,
    status: "waiting" as const,
    title: null,
    startedAt: AT,
    completedAt: null,
    updatedAt: AT,
    requestId: id,
  };
  const item: OrchestrationV2TurnItem =
    kind === "user_input"
      ? {
          ...base,
          type: "user_input_request",
          questions: [
            {
              id: "q",
              header: "Database",
              question: "Which database should I use?",
              options: [{ label: "Postgres", description: "Relational" }],
              multiSelect: false,
            },
          ],
        }
      : { ...base, type: "approval_request", requestKind: "command", prompt: "rm -rf build" };
  return {
    ...seat,
    sideChatOf: parentId,
    items: [...seat.items, item],
    runtimeRequests: [
      {
        id,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability: { type: "live", providerSessionId: ProviderSessionId.make(seat.id) },
        createdAt: AT,
        resolvedAt: null,
      },
    ],
  };
}

it.each(["panel", "main"] as const)(
  "a seated seat in the %s view shows the composer only while it waits on an answer",
  async (surface) => {
    const parent = threadWithHistory("thread-parent", 1);
    const idle = threadWithHistory("thread-idle", 1);
    const asking = threadWithHistory("thread-asking", 1);
    const approving = threadWithHistory("thread-approving", 1);
    const seats = [idle, asking, approving];
    using _environment = installFakeEnvironment([
      {
        ...parent,
        group: {
          status: "active",
          primary: { model: "gpt-5", label: "Fable", handle: "fable" },
          seats: seats.map((seat) => ({
            threadId: seat.id,
            handle: seat.id,
            label: seat.id,
            status: "seated",
            joinedAfterRun: 0,
          })),
          discussion: { mode: "direct", turnsLeft: 1, delivering: [] },
          closedBecause: null,
          closedAt: null,
        },
      },
      { ...idle, sideChatOf: parent.id },
      seatAsking(asking, parent.id, "user_input"),
      seatAsking(approving, parent.id, "command"),
    ]);
    await page.viewport(1400, 900);
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    });
    const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, {
      // AppRoot brings its own router.
      router: false,
    });
    const composers = page.getByTestId("composer-editor");
    const openSeat = async (threadId: ThreadId) => {
      if (surface === "panel") {
        useRightPanelStore.getState().openThread(parentRef, threadId);
        return;
      }
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(ENVIRONMENT_ID, threadId)),
      });
    };

    await openSeat(idle.id);
    await expect.element(page.getByText("Answer 0 for thread-idle.")).toBeVisible();
    expect(composers.all()).toHaveLength(surface === "panel" ? 1 : 0);

    await openSeat(asking.id);
    await expect.element(page.getByText("Which database should I use?").first()).toBeVisible();
    await expect.element(page.getByText("Postgres").first()).toBeVisible();
    expect(composers.all()).toHaveLength(surface === "panel" ? 2 : 1);

    await openSeat(approving.id);
    await expect.element(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Decline" })).toBeVisible();
  },
);
