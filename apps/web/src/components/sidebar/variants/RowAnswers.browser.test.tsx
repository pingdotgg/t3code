import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../../test/render";

const state = vi.hoisted(() => ({
  respondApproval: vi.fn(),
  respondInput: vi.fn(),
  pendingAtom: null as unknown,
}));

vi.mock("../../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "approval" ? state.respondApproval : state.respondInput,
}));
vi.mock("../../../state/threads", () => ({
  environmentThreadDetails: { pendingRequestsAtom: () => state.pendingAtom },
  threadEnvironment: { respondToApproval: "approval", respondToUserInput: "input" },
}));

import { InlineRowAnswers, RowAnswersPopover } from "./RowAnswers";
import { resolveVariantRow } from "./variantRow";

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-a");
const requestId = RuntimeRequestId.make("request-a");
const thread = { environmentId, id: threadId } as unknown as EnvironmentThreadShell;

function setup(pending: Partial<PendingThreadRequests>) {
  state.respondApproval.mockReset();
  state.respondInput.mockReset();
  state.respondApproval.mockResolvedValue(AsyncResult.success(undefined));
  state.respondInput.mockResolvedValue(AsyncResult.success(undefined));
  state.pendingAtom = Atom.make<PendingThreadRequests | null>({
    approvals: [],
    userInputs: [],
    ...pending,
  } as PendingThreadRequests);
}

const approval = {
  requestId,
  requestKind: "command",
  detail: "psql -f rotate_keys.sql",
  createdAt: "2026-11-01T00:00:00.000Z",
  responseCapability: "live",
} as PendingThreadRequests["approvals"][number];

const question = (extra: Record<string, unknown> = {}) =>
  ({
    requestId,
    createdAt: "2026-11-01T00:00:00.000Z",
    responseCapability: "live",
    questions: [
      {
        id: "rounding",
        header: "Rounding",
        question: "Round per line or per total?",
        options: [{ label: "Per line", description: "Totals can drift" }, { label: "Per total" }],
        multiSelect: false,
        ...extra,
      },
    ],
  }) as unknown as PendingThreadRequests["userInputs"][number];

it("sends an approval from the row without activating the row", async () => {
  setup({ approvals: [approval] });
  const onRowClick = vi.fn();
  await using screen = await render(
    <div onClick={onRowClick}>
      <InlineRowAnswers thread={thread} />
    </div>,
  );
  await expect.element(screen.getByText("psql -f rotate_keys.sql")).toBeVisible();
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  expect(state.respondApproval).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, requestId, decision: "accept" },
  });
  expect(onRowClick).not.toHaveBeenCalled();
});

it("shows a failed answer on the row and clears it on retry", async () => {
  setup({ approvals: [approval] });
  state.respondApproval.mockReset();
  state.respondApproval
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Environment offline"))))
    .mockResolvedValueOnce(AsyncResult.success(undefined));
  await using screen = await render(<InlineRowAnswers thread={thread} />);
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Environment offline");
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it("answers a one-question request with the option's value", async () => {
  setup({ userInputs: [question()] });
  await using screen = await render(<InlineRowAnswers thread={thread} />);
  await screen.getByRole("button", { name: "Per total", exact: true }).click();
  expect(state.respondInput).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, requestId, answers: { rounding: "Per total" } },
  });
});

it("draws nothing on the row for a question that needs the full thread", async () => {
  setup({ userInputs: [question({ multiSelect: true })] });
  await using screen = await render(<InlineRowAnswers thread={thread} />);
  expect(screen.container.querySelector("[data-row-answers]")?.childElementCount).toBe(0);
});

it("closes the popover and focuses the question when opening its thread", async () => {
  setup({ userInputs: [question({ multiSelect: true })] });
  const onOpenThread = vi.fn();
  function AnswerPopover() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <RowAnswersPopover
          thread={thread}
          label="Input"
          className=""
          open={open}
          onOpenChange={setOpen}
          onOpenThread={onOpenThread}
        />
        <div data-pending-user-input-panel>
          <button type="button">Question</button>
        </div>
      </>
    );
  }
  await using screen = await render(<AnswerPopover />);
  await screen.getByRole("button", { name: "Open thread" }).click();
  expect(onOpenThread).toHaveBeenCalledOnce();
  await expect.element(screen.getByRole("button", { name: "Open thread" })).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Question", exact: true })).toHaveFocus();
  await screen.getByRole("button", { name: "Input: answer without opening the thread" }).click();
  await expect.element(screen.getByRole("button", { name: "Open thread" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Open thread" })).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Input: answer without opening the thread" }))
    .toHaveFocus();
});

const rowShowingAnswers = (
  lineWidth: number,
  extra: Partial<Parameters<typeof resolveVariantRow>[0]> = {},
) => (
  <div style={{ width: lineWidth + 20 }}>
    {
      resolveVariantRow({
        style: "folder-detailed",
        threadKey: "environment-a:thread-a",
        thread: { ...thread, title: "A thread", hasPendingUserInput: true },
        status: "ready",
        statusWord: null,
        wokePill: null,
        time: "1m",
        isUnread: false,
        isWoke: false,
        isActive: false,
        isSelected: false,
        hasDraftSurface: false,
        nested: false,
        lastNested: false,
        inFolder: true,
        repo: null,
        mark: null,
        title: <span>Title</span>,
        draft: null,
        pin: null,
        where: <span>branch</span>,
        lineExtras: null,
        remote: null,
        terminal: <button type="button" aria-label="Open terminal" style={{ width: 20 }} />,
        jumpHint: null,
        workerCount: 2,
        workerSummary: "2 workers · 1 working",
        workersOpen: false,
        onToggleWorkers: () => {},
        answersOpen: false,
        onAnswersOpenChange: () => {},
        onOpenThread: () => {},
        statusSlot: (content) => (
          <span data-status-slot>
            {content}
            <button type="button" aria-label="Settle thread" style={{ width: 28 }} />
          </span>
        ),
        ...extra,
      }).body
    }
  </div>
);

const longLabels = question({
  options: [{ label: "Round every line on its own and accept drift" }, { label: "Per total" }],
});

it("gives answers that do not fit a full line under the chip, terminal and Settle", async () => {
  setup({ userInputs: [longLabels] });
  await using screen = await render(rowShowingAnswers(135));
  const line = screen.container.querySelector("[data-row-line2]")!.getBoundingClientRect();
  const answers = screen.container.querySelector("[data-row-answers]")!.getBoundingClientRect();
  expect(answers.width).toBeCloseTo(line.width, 0);
  for (const name of ["Open terminal", "Settle thread"]) {
    const control = screen.getByRole("button", { name }).element().getBoundingClientRect();
    expect(control.bottom).toBeLessThanOrEqual(answers.top);
  }
  const chip = screen.container.querySelector("[data-worker-fold]")!.getBoundingClientRect();
  expect(chip.bottom).toBeLessThanOrEqual(answers.top);
  const option = screen.getByRole("button", { name: /Round every line/ }).element();
  const box = option.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(100);
  expect(box.right).toBeLessThanOrEqual(line.right + 0.5);
  expect(box.left).toBeGreaterThanOrEqual(line.left - 0.5);
  const middle = box.top + box.height / 2;
  // A wrapped pill's area meets this one's at the 24px edge, and hit tests snap fractional rows.
  for (const offset of [-11, 11]) {
    const hit = document.elementFromPoint(box.left + box.width / 2, middle + offset);
    expect(option.contains(hit)).toBe(true);
  }
});

it("keeps a coarse pointer's answer areas off the terminal and Settle beside them", async () => {
  setup({ approvals: [approval] });
  const session = cdp();
  // Chromium's touch emulation is what flips (pointer: coarse); emulated media features cannot.
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    for (const workerCount of [null, 2]) {
      await using screen = await render(
        rowShowingAnswers(320, {
          thread: { ...thread, title: "A thread", hasPendingApprovals: true },
          workerCount,
          workerSummary: workerCount === null ? null : "2 workers · 1 working",
          terminal: (
            <button type="button" aria-label="Open terminal" style={{ width: 20, height: 14 }} />
          ),
        }),
      );
      expect(matchMedia("(pointer: coarse)").matches).toBe(true);
      const answers = screen.container.querySelector("[data-row-answers]")!;
      const controls = ["Open terminal", "Settle thread"].map((name) =>
        screen.getByRole("button", { name }).element(),
      );
      if (workerCount !== null)
        controls.push(screen.container.querySelector("[data-worker-fold]")!);
      for (const control of controls) {
        const box = control.getBoundingClientRect();
        const middle = box.top + box.height / 2;
        for (const x of [box.left + 0.5, box.left + box.width / 2, box.right - 0.5]) {
          const hit = document.elementFromPoint(x, middle);
          expect(answers.contains(hit), `${control.ariaLabel} at ${x}`).toBe(false);
        }
      }
      const approve = screen.getByRole("button", { name: "Approve", exact: true }).element();
      const box = approve.getBoundingClientRect();
      for (const offset of [-11, 11]) {
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2 + offset,
        );
        expect(approve.contains(hit)).toBe(true);
      }
    }
  } finally {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
});

it("keeps answers on line 2 when they fit", async () => {
  setup({ userInputs: [question()] });
  await using screen = await render(rowShowingAnswers(400));
  const answers = screen.container.querySelector("[data-row-answers]")!.getBoundingClientRect();
  const settle = screen.getByRole("button", { name: "Settle thread" }).element();
  expect(settle.getBoundingClientRect().left).toBeGreaterThanOrEqual(answers.right);
  const chip = screen.container.querySelector("[data-worker-fold]")!.getBoundingClientRect();
  expect(Math.abs(chip.top + chip.height / 2 - (answers.top + answers.height / 2))).toBeLessThan(2);
});

const slimRow = (extra: Partial<Parameters<typeof resolveVariantRow>[0]>) => (
  <div className="sidebar-row-look">
    {
      resolveVariantRow({
        style: "folder-slim",
        threadKey: "environment-a:thread-a",
        thread: { ...thread, title: "A thread", hasPendingUserInput: true },
        status: "ready",
        statusWord: { label: "Input", className: "text-indigo-600" },
        wokePill: null,
        time: "1m",
        isUnread: false,
        isWoke: false,
        isActive: false,
        isSelected: false,
        hasDraftSurface: false,
        nested: false,
        lastNested: false,
        inFolder: false,
        repo: null,
        mark: null,
        title: <span>Title</span>,
        draft: null,
        pin: null,
        where: null,
        lineExtras: null,
        remote: null,
        terminal: null,
        jumpHint: null,
        workerCount: null,
        workerSummary: null,
        workersOpen: null,
        onToggleWorkers: () => {},
        answersOpen: false,
        onAnswersOpenChange: () => {},
        onOpenThread: () => {},
        statusSlot: (content, keepsLabel) => (
          <span data-status-slot>
            <span
              data-testid="label"
              data-yields-to-action={keepsLabel ? undefined : ""}
              style={{ transition: "none" }}
            >
              {content}
            </span>
            {keepsLabel ? null : <button type="button" aria-label="Settle thread" />}
          </span>
        ),
        ...extra,
      }).body
    }
  </div>
);

it("keeps Slim's answer button visible while it has keyboard focus", async () => {
  setup({ userInputs: [question()] });
  await using screen = await render(slimRow({}));
  const answer = screen.getByRole("button", { name: /answer without opening/ }).element();
  // why: script focus only counts as focus-visible after keyboard input.
  await userEvent.keyboard("{Shift}");
  (answer as HTMLElement).focus();
  expect(answer.matches(":focus-visible")).toBe(true);
  expect(getComputedStyle(screen.getByTestId("label").element()).opacity).toBe("1");
});

it("hides the time only while the action beside it has keyboard focus", async () => {
  setup({});
  await using screen = await render(
    slimRow({
      thread: { ...thread, title: "A thread" },
      statusWord: null,
      wokePill: <button type="button">Woke</button>,
    }),
  );
  const label = screen.getByTestId("label").element();
  await userEvent.keyboard("{Shift}");
  (screen.getByRole("button", { name: "Woke" }).element() as HTMLElement).focus();
  expect(getComputedStyle(label).opacity).toBe("1");
  (screen.getByRole("button", { name: "Settle thread" }).element() as HTMLElement).focus();
  expect(getComputedStyle(label).opacity).toBe("0");
});
