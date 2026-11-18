import { type ComputerApproval, EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ respond: vi.fn(), canApprove: true }));

vi.mock("../../state/computer", () => ({
  computerEnvironment: { respondToApproval: {} },
  useCanApproveComputerSteps: () => state.canApprove,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.respond }));

import { ComputerApprovalCard } from "./ComputerApprovalCard";

const environmentId = EnvironmentId.make("env_1");

// The card counts down from the approval's deadline, so the clock is fixed for every render.
const NOW_MS = 1_771_000_000_000;

const approval: ComputerApproval = {
  id: "approval_1",
  binding: {
    hostId: "host_1",
    taskId: "cu_1",
    step: 3,
    app: "Mail",
    title: "Inbox",
    url: "",
    action: { kind: "type", role: "textbox", label: "To", text: "friend@example.com" },
    why: "Typing can send a message.",
    goal: "Reply to the last message",
    requester: "agent: opencode",
  },
  createdAt: DateTime.makeUnsafe(NOW_MS),
  expiresAt: DateTime.makeUnsafe(NOW_MS + 60_000),
  state: "pending",
  decidedBy: "",
};

function setup() {
  state.respond.mockReset();
  state.respond.mockResolvedValue(Effect.void);
  state.canApprove = true;
}

it("approves the step it shows, with the text it types in full", async () => {
  setup();
  using _clock = vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  await using screen = await render(
    <ComputerApprovalCard
      environmentId={environmentId}
      environmentLabel="Studio Mac"
      approval={approval}
    />,
    // The card reads the session grant and an atom command; neither needs a router.
    { router: false },
  );

  await expect.element(screen.getByText("friend@example.com", { exact: true })).toBeInTheDocument();
  await expect.element(screen.getByText(/Type 18 characters/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Approve" }));

  expect(state.respond).toHaveBeenCalledWith({
    environmentId: "env_1",
    input: { approvalId: "approval_1", approve: true },
  });
});

it("denies the step it shows", async () => {
  setup();
  using _clock = vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  await using screen = await render(
    <ComputerApprovalCard
      environmentId={environmentId}
      environmentLabel="Studio Mac"
      approval={approval}
    />,
    { router: false },
  );

  await userEvent.click(screen.getByRole("button", { name: "Deny" }));

  expect(state.respond).toHaveBeenCalledWith({
    environmentId: "env_1",
    input: { approvalId: "approval_1", approve: false },
  });
});

it("disables both answers with a reason when the connection cannot approve", async () => {
  setup();
  state.canApprove = false;
  using _clock = vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  await using screen = await render(
    <ComputerApprovalCard
      environmentId={environmentId}
      environmentLabel="Studio Mac"
      approval={approval}
    />,
    { router: false },
  );

  await expect.element(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  await expect.element(screen.getByText(/cannot approve computer steps/)).toBeInTheDocument();
  expect(state.respond).not.toHaveBeenCalled();
});
