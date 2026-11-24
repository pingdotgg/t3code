import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "../../index.css";

import { render } from "../../../test/render";
import { ThreadDetailsTasks } from "./ThreadDetailsTasks";

const lists = vi.hoisted(() => new Map<string, unknown>());

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadLatestTodoList: ((ref: { threadId: string } | null) =>
    ref === null ? null : (lists.get(ref.threadId) ?? null)) as never,
}));

const environmentId = EnvironmentId.make("environment");
const LONG =
  "Run the unit tests (python -m unittest discover -s tests -v) and confirm every case passes, including the edge cases for empty names and unicode input (check the output carefully)";

function list(...steps: ReadonlyArray<[string, "pending" | "running" | "completed"]>) {
  return {
    kind: "todo_list",
    steps: steps.map(([text, status], index) => ({ id: `step-${index}`, text, status })),
  };
}

it("lists each step with its status and the completed count", async () => {
  lists.set(
    "thread-a",
    list(["Write hello()", "completed"], ["Add tests", "running"], [LONG, "pending"]),
  );
  await using screen = await render(
    <ThreadDetailsTasks environmentId={environmentId} threadId={ThreadId.make("thread-a")} />,
  );

  await expect.element(screen.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect.element(screen.getByText("1/3")).toBeVisible();
  await expect.element(screen.getByText("1 of 3 tasks complete")).toBeInTheDocument();
  const rows = screen.container.querySelectorAll("li");
  expect(rows).toHaveLength(3);
  expect(rows[0]!.textContent).toBe("Completed: Write hello()");
  expect(rows[1]!.textContent).toBe("In progress: Add tests");
  expect(rows[2]!.textContent).toBe(`Pending: ${LONG}`);
  expect(rows[0]!.querySelector(".lucide-check")).not.toBeNull();
  expect(rows[1]!.querySelector(".lucide-loader-circle")).not.toBeNull();
  expect(rows[1]!.querySelector("[role=status]")).toBeNull();
  expect(rows[2]!.querySelector(".lucide-circle-dashed")).not.toBeNull();

  // A long step wraps, and its icon stays beside the first line.
  const longRow = rows[2]!;
  longRow.parentElement!.style.width = "240px";
  const icon = (longRow.firstElementChild as HTMLElement).getBoundingClientRect();
  const text = (longRow.lastElementChild as HTMLElement).getBoundingClientRect();
  expect(text.height).toBeGreaterThan(icon.height * 2);
  expect(Math.abs(icon.top - text.top)).toBeLessThan(2);
});

it("renders nothing without a list and follows the thread it is given", async () => {
  lists.set("thread-a", list(["Probe A", "running"], ["Probe B", "pending"]));
  await using screen = await render(
    <ThreadDetailsTasks environmentId={environmentId} threadId={ThreadId.make("thread-empty")} />,
  );
  expect(screen.container.querySelector("section")).toBeNull();

  await screen.rerender(
    <ThreadDetailsTasks environmentId={environmentId} threadId={ThreadId.make("thread-a")} />,
  );
  await expect.element(screen.getByText("0/2")).toBeVisible();
  await expect.element(screen.getByText(/Probe A/)).toBeVisible();

  await screen.rerender(
    <ThreadDetailsTasks environmentId={environmentId} threadId={ThreadId.make("thread-empty")} />,
  );
  expect(screen.container.querySelector("section")).toBeNull();
});

it("caps a long plan's height and keeps the step in progress in view", async () => {
  const steps = Array.from(
    { length: 30 },
    (_, index): [string, "pending" | "running" | "completed"] => [
      `Step ${index + 1}`,
      index < 24 ? "completed" : index === 24 ? "running" : "pending",
    ],
  );
  lists.set("thread-long", list(...steps));
  await using screen = await render(
    <div style={{ height: "600px" }}>
      <ThreadDetailsTasks environmentId={environmentId} threadId={ThreadId.make("thread-long")} />
    </div>,
  );

  await expect.element(screen.getByText("24/30")).toBeVisible();
  const scroller = screen.container.querySelector<HTMLElement>("[data-thread-details-tasks-list]")!;
  expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  const running = scroller.querySelector<HTMLElement>('[data-task-status="running"]')!;
  const box = scroller.getBoundingClientRect();
  const row = running.getBoundingClientRect();
  expect(row.top).toBeGreaterThanOrEqual(box.top - 1);
  expect(row.bottom).toBeLessThanOrEqual(box.bottom + 1);
});
