import { Atom } from "effect/reactivity";
import {
  EnvironmentId,
  type WorkflowQuestion,
  type WorkflowRun,
  type WorkflowRunsSnapshot,
  type WorkflowStep,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as browserPage, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { WorkflowsEnvironment } from "./WorkflowsPage";

const environmentId = EnvironmentId.make("laptop");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString();
const run = (fields: Partial<WorkflowRun> & Pick<WorkflowRun, "runId" | "title">): WorkflowRun => ({
  workflow: "release",
  version: 1,
  status: "running",
  detail: null,
  result: null,
  pauses: 0,
  retired: false,
  parentRunId: null,
  parentStep: null,
  startedAt: at(0),
  updatedAt: at(5),
  endedAt: null,
  ...fields,
});
const step = (
  fields: Partial<WorkflowStep> & Pick<WorkflowStep, "name" | "kind">,
): WorkflowStep => ({
  status: "completed",
  attempts: 1,
  detail: null,
  threadId: null,
  environmentId: null,
  result: null,
  startedAt: at(0),
  endedAt: at(0),
  ...fields,
});

const state = vi.hoisted(() => ({
  live: { query: "live" },
  snapshot: { workflows: [], runs: [], questions: [] } as {
    workflows: ReadonlyArray<unknown>;
    runs: ReadonlyArray<unknown>;
    questions: ReadonlyArray<unknown>;
  },
  steps: {} as Record<string, ReadonlyArray<unknown>>,
  commands: [] as Array<readonly [label: string | undefined, input: unknown]>,
  permitted: true,
}));
const canOperate = Atom.make(true);
const cannotOperate = Atom.make(false);

function setup(
  given: Omit<WorkflowRunsSnapshot, "workflows"> & Partial<Pick<WorkflowRunsSnapshot, "workflows">>,
  steps: Record<string, ReadonlyArray<WorkflowStep>> = {},
) {
  state.snapshot = { workflows: [], ...given };
  state.steps = steps;
  state.commands = [];
  state.permitted = true;
}

const environment = { environmentId, label: "Laptop" };

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const permissionAtom = () => (state.permitted ? canOperate : cannotOperate);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      workflowsLive: (() => state.live) as never,
      workflowRun: ((target: { readonly input: { readonly runId: string } }) =>
        target.input) as never,
      answerWorkflowQuestion: {
        ...actual.serverEnvironment.answerWorkflowQuestion,
        permissionAtom,
      },
      resumeWorkflowRun: { ...actual.serverEnvironment.resumeWorkflowRun, permissionAtom },
      cancelWorkflowRun: { ...actual.serverEnvironment.cancelWorkflowRun, permissionAtom },
    },
  };
});
// Stands in for the live list and for one run's detail, which the mocked atoms above name.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: { readonly runId?: string }) => ({
    data:
      request === state.live
        ? state.snapshot
        : { run: null, steps: state.steps[request.runId ?? ""] ?? [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((_command: unknown, options: { readonly label: string }) =>
    (value: { readonly input: unknown }) => {
      state.commands.push([options.label, value.input]);
      return Promise.resolve({ _tag: "Success", value: undefined });
    }) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId | null) =>
    id === environmentId ? environment : null) as never,
}));
// The chat's renderer loads its highlighter; a question's body only has to reach the page.
vi.mock("../ChatMarkdown", () => ({
  default: ({ text }: { readonly text: string }) => <div>{text}</div>,
}));

const question: WorkflowQuestion = {
  runId: "ship",
  name: "approve",
  request: {
    title: "Ship release 1.2?",
    choices: ["Ship", "Hold"],
    data: { body: "The diff touches the installer." },
  },
  askedAt: at(4),
  thread: { threadId: "thread-9", environmentId: null },
};

/** Wide enough for the list and the run side by side; put back when the test ends. */
async function desktop() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  await browserPage.viewport(1280, 800);
  return { [Symbol.asyncDispose]: () => browserPage.viewport(width, height) };
}

const page = (selectedRunId: string | null = null, onSelect = vi.fn()) => (
  <WorkflowsEnvironment
    environmentId={environmentId}
    selectedRunId={selectedRunId}
    onSelect={onSelect}
  />
);

describe("WorkflowsPage", () => {
  it("opens on the question that waits, and answers it with the reason given", async () => {
    setup({
      runs: [
        run({ runId: "busy", title: "Nightly sync" }),
        run({ runId: "ship", title: "Release 1.2", status: "waiting", detail: "approve" }),
      ],
      questions: [question],
    });
    await using _desktop = await desktop();
    await using screen = await render(page());

    const needsYou = screen.getByRole("region", { name: "Needs you" });
    await expect.element(needsYou.getByRole("button", { name: /Release 1\.2/ })).toBeVisible();
    // Nothing was picked, so the run that asks is the one shown, with its question.
    await expect.element(screen.getByText("The diff touches the installer.")).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Talk to the agent first" }))
      .toHaveAttribute("href", "/laptop/thread-9");

    await screen.getByRole("button", { name: "Add a reason" }).click();
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Reason for Ship release 1.2?" }),
      "  Too risky today ",
    );
    await screen.getByRole("button", { name: "Hold", exact: true }).click();

    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        [
          "workflow answer",
          { runId: "ship", name: "approve", choice: "Hold", reason: "Too risky today" },
        ],
      ]),
    );
  });

  it("turns the answers off for a session that may not operate", async () => {
    setup({
      runs: [run({ runId: "ship", title: "Release 1.2", status: "waiting" })],
      questions: [question],
    });
    state.permitted = false;
    await using _desktop = await desktop();
    await using screen = await render(page());

    await expect.element(screen.getByRole("button", { name: "Ship", exact: true })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Hold", exact: true })).toBeDisabled();
  });

  it("says why a run paused where it paused, and resumes it", async () => {
    setup(
      {
        runs: [
          run({ runId: "sync", title: "Sync labels", status: "paused", detail: "apply: 503" }),
        ],
        questions: [],
      },
      {
        sync: [
          step({ name: "fetch", kind: "step" }),
          step({ name: "apply", kind: "step", status: "failed", attempts: 3, detail: "503" }),
        ],
      },
    );
    await using _desktop = await desktop();
    await using screen = await render(page());

    const why = screen.getByRole("region", { name: "Why it paused" });
    await expect.element(why).toMatchTextContent("apply: 503");
    const happened = screen.getByRole("region", { name: "What happened" });
    await expect.element(happened).toMatchTextContent(/apply.*3 tries.*failed/);
    await why.getByRole("button", { name: "Resume" }).click();

    await vi.waitFor(() =>
      expect(state.commands).toEqual([["workflow resume", { runId: "sync" }]]),
    );
  });

  it("tells a finished run as its beats, with the bookkeeping folded away", async () => {
    setup(
      {
        runs: [
          run({
            runId: "fix",
            title: "#101 Wrong minutes",
            status: "completed",
            result: "merged as ba6ac7",
            endedAt: at(12),
          }),
        ],
        questions: [],
      },
      {
        fix: [
          step({ name: "load", kind: "step" }),
          step({ name: "existing-prs", kind: "step" }),
          step({ name: "triage", kind: "agent", endedAt: at(3), threadId: "thread-1" }),
          step({
            name: "implement",
            kind: "agent",
            startedAt: at(3),
            endedAt: at(10),
            threadId: "thread-2",
            environmentId: "build-box",
          }),
        ],
      },
    );
    await using screen = await render(page("fix"));

    await expect
      .element(screen.getByRole("region", { name: "How it ended" }))
      .toMatchTextContent("merged as ba6ac7");
    const rows = screen.getByRole("region", { name: "What happened" }).getByRole("listitem");
    await expect.element(rows.nth(0)).toMatchTextContent("2 quick steps");
    await expect.element(rows.nth(1)).toMatchTextContent(/triage.*Agent, 3m 0s/);
    await expect
      .element(rows.nth(1).getByRole("link", { name: "Transcript" }))
      .toHaveAttribute("href", "/laptop/thread-1");
    // This client is not connected to the linked environment, so there is nothing to open.
    await expect.element(rows.nth(2)).toMatchTextContent("Thread on build-box");
    await rows
      .nth(0)
      .getByRole("button", { name: /2 quick steps/ })
      .click();
    await expect.element(rows.nth(0)).toMatchTextContent("existing-prs");
    await expect
      .element(screen.getByRole("button", { name: "Cancel run" }))
      .not.toBeInTheDocument();
  });

  it("opens an invoked run from its parent's story", async () => {
    setup(
      {
        runs: [
          run({ runId: "rel", title: "Release 1.3", status: "waiting", detail: "check" }),
          run({ runId: "chk", title: "Check web", parentRunId: "rel", parentStep: "check" }),
        ],
        questions: [],
      },
      {
        rel: [
          step({ name: "check/start", kind: "step" }),
          step({ name: "check", kind: "wait", status: "running", endedAt: null }),
        ],
      },
    );
    const onSelect = vi.fn();
    await using screen = await render(page("rel", onSelect));

    const happened = screen.getByRole("region", { name: "What happened" });
    await expect.element(happened).toMatchTextContent("Runs Check web");
    await happened.getByRole("button", { name: "Open run" }).click();
    expect(onSelect).toHaveBeenCalledWith("chk");
  });

  it("lists each workflow with what starts it, also one that has not run yet", async () => {
    setup({
      workflows: [
        { name: "release", version: 1, triggers: ["webhook tags"] },
        { name: "report", version: 1, triggers: ["daily at 09:00"] },
      ],
      runs: [run({ runId: "rel", title: "Release 1.3" })],
      questions: [],
    });
    await using _desktop = await desktop();
    await using screen = await render(page());

    const release = screen.getByRole("region", { name: "release" });
    await expect.element(release).toMatchTextContent("Starts on webhook tags");
    await expect.element(release.getByRole("button", { name: /Release 1\.3/ })).toBeVisible();
    const report = screen.getByRole("region", { name: "report" });
    await expect.element(report).toMatchTextContent("Starts on daily at 09:00");
    await expect.element(report).toMatchTextContent("Has not run yet.");
  });

  it("shows what an agent returned and what a person answered", async () => {
    setup(
      {
        runs: [run({ runId: "fix", title: "#7 Crash", status: "completed", endedAt: at(9) })],
        questions: [],
      },
      {
        fix: [
          step({
            name: "triage",
            kind: "agent",
            endedAt: at(3),
            threadId: "thread-1",
            result: { kind: "bug", reproduced: true },
          }),
          step({
            name: "approve",
            kind: "ask",
            startedAt: at(3),
            endedAt: at(4),
            result: { choice: "Fix it", reason: "It hits everyone on Windows" },
          }),
        ],
      },
    );
    await using screen = await render(page("fix"));

    const rows = screen.getByRole("region", { name: "What happened" }).getByRole("listitem");
    await expect.element(rows.nth(0)).toMatchTextContent(/kind: bug.*reproduced: true/);
    await expect.element(rows.nth(1)).toMatchTextContent("Answered “Fix it” after 1m 0s");
    await expect.element(rows.nth(1)).toMatchTextContent("Because: It hits everyone on Windows");
  });

  it("says how to turn workflows on when nothing has run", async () => {
    setup({ runs: [], questions: [] });
    await using screen = await render(page());

    await expect.element(screen.getByText("No workflow runs yet")).toBeVisible();
    await expect.element(screen.getByText("T3CODE_WORKFLOWS")).toBeVisible();
  });
});
