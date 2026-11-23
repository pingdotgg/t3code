import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ respond: vi.fn() }));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/queries", () => ({
  useTurnItemDetail: () => ({ data: undefined, isPending: false, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.respond }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { respondToApproval: {} },
}));

import { TimelineChildApprovalCard } from "./ChildThreadApprovals";

function setup() {
  state.respond.mockReset();
  state.respond
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Child environment offline"))))
    .mockResolvedValueOnce(AsyncResult.success(undefined));
  const entry: ChildThreadApproval = {
    thread: {
      environmentId: EnvironmentId.make("child-env"),
      threadId: ThreadId.make("child"),
    },
    title: "Compile task",
    approval: {
      requestId: RuntimeRequestId.make("approval"),
      requestKind: "command",
      detail: "Run compiler",
      createdAt: "2026-11-01T00:00:00.000Z",
      responseCapability: "live",
    },
  };
  return entry;
}

it("shows a failed decision, clears the error on retry, and opens the subagent", async () => {
  const entry = setup();
  const onOpenThread = vi.fn();
  await using screen = await render(
    <TimelineChildApprovalCard entry={entry} onOpenThread={onOpenThread} />,
  );
  await expect.element(screen.getByText("Approval needed from Compile task")).toBeVisible();
  await screen.getByRole("button", { name: "Open subagent", exact: true }).click();
  expect(onOpenThread).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Child environment offline");
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});
