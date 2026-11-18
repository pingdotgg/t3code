import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ respond: vi.fn(), approvalsAtom: null as unknown }));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.respond }));
vi.mock("../../state/threads", () => ({
  childThreadApprovalsAtom: () => state.approvalsAtom,
  threadEnvironment: { respondToApproval: {} },
}));

import { ChildThreadApprovals } from "./ChildThreadApprovals";

function setup(responseCapability: "live" | "not_resumable" = "live") {
  state.respond.mockReset();
  state.respond
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Child environment offline"))))
    .mockResolvedValueOnce(AsyncResult.success(undefined));
  const thread = {
    environmentId: EnvironmentId.make("child-env"),
    threadId: ThreadId.make("child"),
  };
  state.approvalsAtom = Atom.make<ReadonlyArray<ChildThreadApproval>>([
    {
      thread,
      title: "Compile task",
      approval: {
        requestId: RuntimeRequestId.make("approval"),
        requestKind: "command",
        detail: "Run compiler",
        createdAt: "2026-11-01T00:00:00.000Z",
        responseCapability,
        elicitationUrl: "https://example.com/authorize",
      },
    },
  ]);
  return thread;
}

it("shows a failed decision and clears the error when the user retries", async () => {
  const thread = setup();
  await using screen = await render(<ChildThreadApprovals threadRef={thread} />);
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Child environment offline");
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it.each(["live", "not_resumable"] as const)(
  "shows browser steps only for live approvals (%s)",
  async (responseCapability) => {
    const thread = setup(responseCapability);
    await using screen = await render(<ChildThreadApprovals threadRef={thread} />);
    const link = screen.getByRole("link", { name: "Open example.com", exact: true });
    if (responseCapability === "live") {
      await expect.element(link).toHaveAttribute("href", "https://example.com/authorize");
      await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
    } else {
      await expect.element(link).not.toBeInTheDocument();
      await expect
        .element(screen.getByText("Complete the steps in your browser, then choose Continue."))
        .not.toBeInTheDocument();
    }
  },
);
