import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ThreadId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { VerificationPanel } from "./ThreadVerification";
import { buildVerificationRequest } from "./threadVerification.logic";

vi.mock("./ThreadDetailsChecks", () => ({ ThreadDetailsChecks: () => null }));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

const threadRef = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("thread") };

it("requests verification only on click, honors recording choices, and supports retry after failure", async () => {
  const onRequest = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue(undefined);
  await using screen = await render(
    <VerificationPanel
      projection={null}
      threadRef={threadRef}
      busy={false}
      canRequest
      workspaceRoot="/work/app"
      onRequest={onRequest}
    />,
  );
  expect(onRequest).not.toHaveBeenCalled();
  await expect
    .element(screen.getByRole("checkbox", { name: "Record browser session" }))
    .toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: "Browser checks", exact: true }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Record browser session" }));
  await userEvent.click(screen.getByRole("button", { name: "Run verification" }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Offline");
  expect(onRequest).toHaveBeenCalledTimes(1);
  expect(onRequest.mock.calls[0]![0]).toContain("Record the browser checks");
  await userEvent.click(screen.getByRole("button", { name: "Run verification" }));
  await expect.element(screen.getByRole("button", { name: "Run verification" })).toBeEnabled();
  expect(onRequest).toHaveBeenCalledTimes(2);
});

it.each([
  { busy: true, canRequest: true },
  { busy: false, canRequest: false },
])("does not dispatch while unavailable: %o", async ({ busy, canRequest }) => {
  const onRequest = vi.fn();
  await using screen = await render(
    <VerificationPanel
      projection={null}
      threadRef={threadRef}
      busy={busy}
      canRequest={canRequest}
      workspaceRoot={undefined}
      onRequest={onRequest}
    />,
  );
  await expect.element(screen.getByRole("button", { name: "Run verification" })).toBeDisabled();
  expect(onRequest).not.toHaveBeenCalled();
});

it("preserves command failures and unknown outcomes when reviewing a completed run", async () => {
  const projection = {
    turnItems: [
      {
        type: "user_message",
        id: "request",
        runId: "verify",
        ordinal: 0,
        text: buildVerificationRequest({ tests: true, browser: false, recording: false }),
      },
      {
        type: "command_execution",
        id: "failed",
        runId: "verify",
        ordinal: 1,
        input: "npm test",
        status: "completed",
        exitCode: 1,
        output: "Test failed",
      },
      {
        type: "command_execution",
        id: "unknown",
        runId: "verify",
        ordinal: 2,
        input: "npm run lint",
        status: "completed",
      },
      {
        type: "assistant_message",
        id: "answer",
        runId: "verify",
        ordinal: 3,
        phase: "final_answer",
        text: "Browser checks were not requested.",
        streaming: false,
      },
    ],
    runs: [{ id: "verify", status: "completed" }],
  } as unknown as OrchestrationV2ThreadProjection;
  const onRequest = vi.fn();
  const onOpenChanges = vi.fn();
  await using screen = await render(
    <div style={{ width: 340 }}>
      <VerificationPanel
        projection={projection}
        threadRef={threadRef}
        busy={false}
        canRequest
        workspaceRoot="/work/app"
        onRequest={onRequest}
        onOpenChanges={onOpenChanges}
      />
    </div>,
  );
  await expect.element(screen.getByText("Failed", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Unconfirmed", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Browser checks were not requested.")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "View diff" }));
  expect(onOpenChanges).toHaveBeenCalledTimes(1);
  expect(onRequest).not.toHaveBeenCalled();
});
