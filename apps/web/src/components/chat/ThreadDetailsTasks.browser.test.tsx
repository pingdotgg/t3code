import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "../../index.css";

import { render } from "../../../test/render";
import { ThreadDetailsTasks } from "./ThreadDetailsTasks";

const lists = vi.hoisted(() => new Map<string, unknown>());
const settings = vi.hoisted(() => ({ threadTasksEnabled: true }));

vi.mock(import("~/hooks/useSettings"), async (importOriginal) => ({
  ...(await importOriginal()),
  useClientSettings: ((select: (value: typeof settings) => unknown) => select(settings)) as never,
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadTodoLists: ((ref: { threadId: string } | null) =>
    ref === null ? [] : (lists.get(ref.threadId) ?? [])) as never,
}));

const environmentId = EnvironmentId.make("environment");
const LONG =
  "Run the unit tests (python -m unittest discover -s tests -v) and confirm every case passes, including the edge cases for empty names and unicode input (check the output carefully)";

function list(...steps: ReadonlyArray<[string, "pending" | "running" | "completed"]>) {
  return [entry("plan", ...steps)];
}

function entry(id: string, ...steps: ReadonlyArray<[string, "pending" | "running" | "completed"]>) {
  return {
    id,
    steps: steps.map(([text, status], index) => ({ id: `${id}-step-${index}`, text, status })),
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

it("groups phases with their own counts and keeps the total on steps", async () => {
  lists.set(
    "thread-phases",
    list(
      ["Phase 1: Setup", "completed"],
      ["Init repo", "completed"],
      ["Phase 2: API", "running"],
      ["Write route", "running"],
      ["Test route", "pending"],
    ),
  );
  await using screen = await render(
    <ThreadDetailsTasks environmentId={environmentId} threadId={ThreadId.make("thread-phases")} />,
  );

  await expect.element(screen.getByText("1/3")).toBeVisible();
  const phases = screen.container.querySelectorAll("[data-task-phase]");
  expect([...phases].map((phase) => phase.getAttribute("data-task-phase"))).toEqual([
    "completed",
    "running",
  ]);
  expect(phases[1]!.querySelectorAll("[data-task-status]")).toHaveLength(2);
  expect(phases[1]!.textContent).toContain("In progress: Phase 2: API");
  expect(phases[1]!.textContent).toContain("0/2");
});

it("stacks earlier lists above the newest one, folded, and counts every step", async () => {
  lists.set("thread-stack", [
    entry("first", ["Write hello()", "completed"], ["Add tests", "completed"]),
    entry("second", ["Add --version", "running"], ["Document it", "pending"]),
  ]);
  await using screen = await render(
    <ThreadDetailsTasks environmentId={environmentId} threadId={ThreadId.make("thread-stack")} />,
  );

  await expect.element(screen.getByText("2/4")).toBeVisible();
  const earlier = screen.container.querySelector<HTMLDetailsElement>('[data-task-list="earlier"]')!;
  expect(earlier.open).toBe(false);
  expect(earlier.querySelector("summary")!.textContent).toContain("Earlier list 1");
  expect(earlier.querySelector("summary")!.textContent).toContain("2/2");
  const latest = screen.container.querySelector('[data-task-list="latest"]')!;
  expect([...latest.querySelectorAll("li")].map((row) => row.textContent)).toEqual([
    "In progress: Add --version",
    "Pending: Document it",
  ]);
  await screen.getByText("Earlier list 1").click();
  expect(earlier.open).toBe(true);
  await expect.element(screen.getByText(/Write hello/)).toBeVisible();
});

it("shows nothing when the tasks setting is off", async () => {
  lists.set("thread-off", list(["Probe A", "running"]));
  settings.threadTasksEnabled = false;
  try {
    await using screen = await render(
      <ThreadDetailsTasks environmentId={environmentId} threadId={ThreadId.make("thread-off")} />,
    );
    expect(screen.container.querySelector("section")).toBeNull();
  } finally {
    settings.threadTasksEnabled = true;
  }
});
