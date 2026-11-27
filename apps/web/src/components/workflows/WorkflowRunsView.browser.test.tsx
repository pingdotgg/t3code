import { Atom } from "effect/reactivity";
import {
  EnvironmentId,
  type WorkflowQuestion,
  type WorkflowRun,
  type WorkflowRunReference,
  type WorkflowRunsSnapshot,
  type WorkflowStep,
} from "@t3tools/contracts";
import { getTranslationsSnapshot, GTProvider } from "gt-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as browserPage, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { initializeI18n } from "~/i18n/initializeI18n";
import { render } from "../../../test/render";
import type { WorkflowPaneTab } from "./workflowPane.logic";
import { WorkflowRunsView } from "./WorkflowRunsView";

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
  resumesAt: null,
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
  said: null,
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
  references: {} as Record<string, ReadonlyArray<unknown>>,
  commands: [] as Array<readonly [label: string | undefined, input: unknown]>,
  permitted: true,
  detailError: null as string | null,
  linked: [] as ReadonlyArray<string>,
  sessionId: null as string | null,
}));
const canOperate = Atom.make(true);
const cannotOperate = Atom.make(false);

function setup(
  given: Omit<WorkflowRunsSnapshot, "workflows"> & Partial<Pick<WorkflowRunsSnapshot, "workflows">>,
  steps: Record<string, ReadonlyArray<WorkflowStep>> = {},
  references: Record<string, ReadonlyArray<WorkflowRunReference>> = {},
) {
  state.snapshot = { workflows: [], ...given };
  state.steps = steps;
  state.references = references;
  state.commands = [];
  state.permitted = true;
  state.detailError = null;
  state.linked = [];
  state.sessionId = null;
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
        : state.detailError !== null
          ? null
          : {
              run: null,
              steps: state.steps[request.runId ?? ""] ?? [],
              references: state.references[request.runId ?? ""] ?? [],
            },
    error: request === state.live ? null : state.detailError,
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
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentSessionId: () => state.sessionId,
}));
vi.mock(import("../../state/peerLinks"), async (original) => ({
  ...(await original()),
  useLinkedEnvironments: ((id: EnvironmentId | null) =>
    new Map(
      id === environmentId
        ? state.linked.map((link) => [EnvironmentId.make(link), "Build box"])
        : [],
    )) as never,
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

const issue101: WorkflowRunReference = {
  kind: "issue",
  key: "i101",
  address: { projectId: "p1", tracker: "github", scope: "me/app", key: "101" },
  title: "Wrong minutes",
  url: "https://github.com/me/app/issues/101",
  state: "open",
  steps: ["triage"],
  origin: "trigger",
};

/** Wide enough for the list and the run side by side; put back when the test ends. */
async function desktop() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  await browserPage.viewport(1280, 800);
  return { [Symbol.asyncDispose]: () => browserPage.viewport(width, height) };
}

const page = (
  selectedRunId: string | null = null,
  on: {
    readonly select?: (runId: string | null) => void;
    readonly thread?: () => void;
    readonly reference?: () => void;
  } = {},
  shownTab: WorkflowPaneTab | null = null,
) => (
  <WorkflowRunsView
    environmentId={environmentId}
    selectedRunId={selectedRunId}
    paneOpen={shownTab !== null}
    shownTab={shownTab}
    onSelect={on.select ?? vi.fn()}
    onOpenThread={on.thread ?? vi.fn()}
    onOpenReference={on.reference ?? vi.fn()}
    onOpenDefinitions={vi.fn()}
  />
);

describe("WorkflowRunsView", () => {
  it("opens on the question that waits, and answers it with the reason given", async () => {
    setup(
      {
        runs: [
          run({ runId: "busy", title: "Nightly sync" }),
          run({ runId: "ship", title: "Release 1.2", status: "waiting", detail: "approve" }),
        ],
        questions: [question],
      },
      { ship: [step({ name: "approve", kind: "ask", status: "running", endedAt: null })] },
    );
    const thread = vi.fn();
    await using _desktop = await desktop();
    await using screen = await render(page(null, { thread }));

    // The list opens on what waits on a person, and the run that asks is the one shown.
    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await expect.element(runs.getByRole("button", { name: /Release 1\.2/ })).toBeVisible();
    await expect
      .element(runs.getByRole("button", { name: /Nightly sync/ }))
      .not.toBeInTheDocument();
    await expect.element(runs).toMatchTextContent("Asks: Ship release 1.2?");
    await expect.element(screen.getByText("The diff touches the installer.")).toBeVisible();

    await screen.getByRole("button", { name: "Ask the agent first" }).click();
    expect(thread).toHaveBeenCalledWith("ship", { threadId: "thread-9", environmentId: null });

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

  it("shows what choices do and the links, and sends a choice that needs a reason only with one", async () => {
    setup(
      {
        runs: [run({ runId: "ship", title: "Release 1.2", status: "waiting", detail: "approve" })],
        questions: [
          {
            ...question,
            request: {
              title: "Ship release 1.2?",
              choices: ["Ship", "Hold", "Close as a duplicate of the earlier request"],
              choiceDetails: [
                { value: "Hold", description: "It waits a week", requireReason: true },
              ],
              links: [{ label: "The diff", url: "https://example.com/diff" }],
            },
          },
        ],
      },
      { ship: [step({ name: "approve", kind: "ask", status: "running", endedAt: null })] },
    );
    await using _desktop = await desktop();
    await using screen = await render(page());

    await expect.element(screen.getByText("It waits a week")).toBeVisible();
    // A long label keeps a button as wide as itself, as before choices could say more.
    const long = screen
      .getByRole("button", { name: "Close as a duplicate of the earlier request" })
      .element();
    expect(long.scrollWidth).toBeLessThanOrEqual(long.clientWidth);
    await expect
      .element(screen.getByRole("link", { name: "The diff" }))
      .toHaveAttribute("href", "https://example.com/diff");
    await screen.getByRole("button", { name: "Hold", exact: true }).click();
    await expect.element(screen.getByText("Hold needs a reason.")).toBeVisible();
    expect(state.commands).toEqual([]);

    await userEvent.fill(
      screen.getByRole("textbox", { name: "Reason for Ship release 1.2?" }),
      "Not this week",
    );
    await screen.getByRole("button", { name: "Hold", exact: true }).click();
    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        [
          "workflow answer",
          { runId: "ship", name: "approve", choice: "Hold", reason: "Not this week" },
        ],
      ]),
    );
  });

  it("answers a question whose steps did not load, and says a linked run is not here", async () => {
    setup({
      runs: [run({ runId: "ship", title: "Release 1.2", status: "waiting", detail: "approve" })],
      questions: [question],
    });
    state.detailError = "The server did not answer.";
    await using _desktop = await desktop();
    {
      await using screen = await render(page("ship"));
      await expect.element(screen.getByText("The server did not answer.")).toBeVisible();
      await screen.getByRole("button", { name: "Ship", exact: true }).click();
      await vi.waitFor(() =>
        expect(state.commands).toEqual([
          ["workflow answer", { runId: "ship", name: "approve", choice: "Ship" }],
        ]),
      );
    }

    // A link to a run this environment does not have never shows another run in its place.
    const select = vi.fn();
    await using screen = await render(page("gone", { select }));
    await expect.element(screen.getByText("This run is not here")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Ship", exact: true }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Back to the runs" }).click();
    expect(select).toHaveBeenCalledWith(null);
  });

  it("says a linked run is not here where nothing has run yet", async () => {
    setup({ runs: [], questions: [] });
    const select = vi.fn();
    await using screen = await render(page("gone", { select }));
    await expect.element(screen.getByText("This run is not here")).toBeVisible();
    await screen.getByRole("button", { name: "Back to the runs" }).click();
    expect(select).toHaveBeenCalledWith(null);
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

  it("shows what a run is about in its row, and opens it from there", async () => {
    const { steps: _steps, origin: _origin, state: _state, ...subject } = issue101;
    setup({ runs: [run({ runId: "fix", title: "Fix the minutes", subject })], questions: [] });
    const reference = vi.fn();
    await using _desktop = await desktop();
    await using screen = await render(page(null, { reference }));

    const row = screen
      .getByRole("navigation", { name: "Workflow runs" })
      .getByRole("button", { name: "#101 Wrong minutes" });
    await row.click();

    expect(reference).toHaveBeenCalledWith("fix", subject);
  });

  it("marks a thread subject as open beside its run, and a subject's state as unknown", async () => {
    setup({
      runs: [
        run({
          runId: "talk",
          title: "Talk it through",
          subject: { kind: "thread", key: "t1", address: { threadId: "t1" }, title: "", url: null },
        }),
        run({
          runId: "land",
          title: "Land the fix",
          subject: {
            kind: "pullRequest",
            key: "pr7",
            address: { projectId: "p1", host: "github.com", repository: "acme/app", number: 7 },
            title: "Fix the minutes",
            url: "https://github.com/acme/app/pull/7",
          },
        }),
      ],
      questions: [],
    });
    await using _desktop = await desktop();
    await using screen = await render(page("talk", {}, { thread: "t1" }));

    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await expect
      .element(runs.getByRole("button", { name: "thread", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
    // A subject does not say where its pull request stands, so it wears no state's ink.
    const mark = runs
      .getByRole("button", { name: "#7 Fix the minutes" })
      .element()
      .querySelector("svg");
    expect(mark?.getAttribute("class")).toContain("text-muted-foreground");
  });

  it("says why a run paused at the step that failed, and resumes it", async () => {
    setup(
      {
        runs: [
          run({
            runId: "sync",
            title: "Sync labels",
            status: "paused",
            detail: "apply: 503",
            pauses: 1,
          }),
        ],
        questions: [],
      },
      {
        sync: [
          // A failure the workflow caught and went on from is not where it paused.
          step({ name: "lint", kind: "step", status: "failed", endedAt: at(1), detail: "lint" }),
          step({ name: "fetch", kind: "step", startedAt: at(1), endedAt: at(1) }),
          step({
            name: "apply",
            kind: "agent",
            status: "failed",
            attempts: 3,
            detail: "503",
            threadId: "thread-apply",
            startedAt: at(2),
            endedAt: at(3),
          }),
        ],
      },
    );
    await using _desktop = await desktop();
    await using screen = await render(page());

    const why = screen.getByRole("region", { name: "Why it paused" });
    await expect.element(why).toMatchTextContent(/Paused at apply.*3rd try.*waits for you/);
    await expect.element(why).toMatchTextContent("503");
    // The failed agent's transcript is there to read before choosing.
    await expect.element(screen.getByRole("button", { name: "Transcript" })).toBeVisible();
    await expect.element(screen.getByText("Paused at lint")).not.toBeInTheDocument();
    await why.getByRole("button", { name: "Resume" }).click();

    await vi.waitFor(() =>
      expect(state.commands).toEqual([["workflow resume", { runId: "sync" }]]),
    );
  });

  it("draws a finished run as a flow, and shows the step that is picked", async () => {
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
          step({
            name: "triage",
            kind: "agent",
            endedAt: at(3),
            threadId: "thread-1",
            said: "Reproduced on main.",
            result: { kind: "bug", reproduced: true },
          }),
          step({
            name: "implement",
            kind: "agent",
            startedAt: at(3),
            endedAt: at(10),
            threadId: "thread-2",
            environmentId: "build-box",
          }),
          step({
            name: "approve",
            kind: "ask",
            startedAt: at(10),
            endedAt: at(11),
            result: { choice: "Fix it", reason: "It hits everyone on Windows" },
          }),
        ],
      },
      { fix: [issue101] },
    );
    const thread = vi.fn();
    const reference = vi.fn();
    await using screen = await render(page("fix", { thread, reference }, { thread: "thread-1" }));

    // A finished run opens on how it ended; the flow has a node for each step that mattered.
    const happened = screen.getByRole("region", { name: "What happened" });
    await expect.element(happened).toMatchTextContent(/Finished.*merged as ba6ac7/);
    const flow = screen.getByRole("navigation", { name: "Steps so far" });
    await expect
      .element(flow)
      .toMatchTextContent(/load · existing-prs.*triage.*Reproduced on main\..*implement.*approve/);

    await flow.getByRole("button", { name: /triage/ }).click();
    const triage = screen.getByRole("region", { name: "triage" });
    await expect.element(triage).toMatchTextContent(/3m 0s.*Reproduced on main\..*kind.*bug/);
    // Its thread is the one open beside the run, and the button says so.
    const transcript = triage.getByRole("button", { name: "Transcript" });
    await expect.element(transcript).toHaveAttribute("aria-pressed", "true");
    await transcript.click();
    expect(thread).toHaveBeenCalledWith("fix", { threadId: "thread-1", environmentId: null });
    // What the run touched is under its title, by number alone when the title already says it.
    // It opens beside the run.
    const touched = screen.getByRole("list", { name: "What the run touched" });
    const onRun = touched.getByRole("button", { name: "#101 Wrong minutes" });
    await expect.element(onRun).toMatchTextContent(/^#101$/);
    await onRun.click();
    expect(reference).toHaveBeenCalledWith("fix", issue101);
    // This client is not connected to the linked environment, so there is nothing to open.
    await flow.getByRole("button", { name: /implement/ }).click();
    await expect
      .element(screen.getByRole("region", { name: "implement" }))
      .toMatchTextContent("Thread on build-box");
    await flow.getByRole("button", { name: /approve/ }).click();
    await expect
      .element(screen.getByRole("region", { name: "approve" }))
      .toMatchTextContent("You said Fix it: It hits everyone on Windows");
    await flow.getByRole("button", { name: /load · existing-prs/ }).click();
    await expect
      .element(screen.getByRole("region", { name: "Quick steps" }))
      .toMatchTextContent("loadexisting-prs");
    await expect
      .element(screen.getByRole("button", { name: "Cancel run" }))
      .not.toBeInTheDocument();
  });

  it("says You for this client's own answer, and names any other client that answered", async () => {
    const answered = (name: string, minute: number, result: WorkflowStep["result"]) =>
      step({ name, kind: "ask", startedAt: at(minute), endedAt: at(minute + 1), result });
    const chrome = { answeredBy: "Chrome on Linux", answeredAt: at(2) };
    setup(
      {
        runs: [run({ runId: "fix", title: "Fix", status: "completed", endedAt: at(12) })],
        questions: [],
      },
      {
        fix: [
          answered("mine", 1, { choice: "Yes", ...chrome, answeredBySession: "this-browser" }),
          // Another browser the server gives the same name.
          answered("theirs", 3, { choice: "No", ...chrome, answeredBySession: "other-browser" }),
          answered("agent", 5, {
            choice: "Yes",
            answeredBy: "Fix the login bug",
            answeredAt: at(6),
          }),
          // Kept before answers recorded a session: named, as it was.
          answered("old", 7, { choice: "Yes", reason: "Fine", ...chrome }),
        ],
      },
    );
    state.sessionId = "this-browser";
    await using screen = await render(page("fix"));

    const flow = screen.getByRole("navigation", { name: "Steps so far" });
    await expect
      .element(flow)
      .toMatchTextContent(
        /mine.*You said Yes.*theirs.*Chrome on Linux said No.*agent.*Fix the login bug said Yes.*old.*Chrome on Linux said Yes/,
      );
    const card = async (name: string) => {
      await flow.getByRole("button", { name: new RegExp(name) }).click();
      return screen.getByRole("region", { name });
    };
    await expect.element(await card("mine")).toMatchTextContent("You said Yes.");
    await expect.element(await card("theirs")).toMatchTextContent("Chrome on Linux said No.");
    await expect.element(await card("agent")).toMatchTextContent("Fix the login bug said Yes.");
    await expect.element(await card("old")).toMatchTextContent("Chrome on Linux said Yes: Fine");
  });

  it("says who withdrew a question that ended unanswered, and why", async () => {
    setup(
      {
        runs: [run({ runId: "ship", title: "Ship", status: "completed", endedAt: at(2) })],
        questions: [],
      },
      {
        ship: [
          step({
            name: "wanted",
            kind: "ask",
            endedAt: at(1),
            detail: "withdrawn by t3 CLI: settled elsewhere",
            result: { withdrawn: { by: "t3 CLI", reason: "settled elsewhere" } },
          }),
        ],
      },
    );
    await using screen = await render(page("ship"));

    const flow = screen.getByRole("navigation", { name: "Steps so far" });
    await expect.element(flow).toMatchTextContent(/wanted.*withdrawn by t3 CLI/);
    await flow.getByRole("button", { name: /wanted/ }).click();
    await expect
      .element(screen.getByRole("region", { name: "wanted" }))
      .toMatchTextContent(/withdrawn · 1m 0s.*Withdrawn by t3 CLI: settled elsewhere/);
  });

  it("opens an agent's thread on an environment this server links to", async () => {
    setup(
      {
        runs: [run({ runId: "fix", title: "Fix", status: "completed", endedAt: at(12) })],
        questions: [],
      },
      {
        fix: [
          step({
            name: "implement",
            kind: "agent",
            threadId: "thread-2",
            environmentId: "build-box",
          }),
        ],
      },
    );
    state.linked = ["build-box"];
    const thread = vi.fn();
    await using screen = await render(page("fix", { thread }));

    await screen
      .getByRole("navigation", { name: "Steps so far" })
      .getByRole("button", { name: /implement/ })
      .click();
    const implement = screen.getByRole("region", { name: "implement" });
    await expect.element(implement).toMatchTextContent(/on Build box/);
    await expect.element(implement).not.toMatchTextContent(/Thread on build-box/);
    await implement.getByRole("button", { name: "Transcript" }).click();
    expect(thread).toHaveBeenCalledWith("fix", {
      threadId: "thread-2",
      environmentId: "build-box",
    });
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
    const select = vi.fn();
    await using screen = await render(page("rel", { select }));

    const invoked = screen.getByRole("region", { name: "Check web" });
    await invoked.getByRole("button", { name: "Open run" }).click();
    expect(select).toHaveBeenCalledWith("chk");
  });

  it("switches between what is under way and everything, one workflow at a time", async () => {
    setup({
      workflows: [
        { name: "release", version: 1, triggers: ["webhook tags"] },
        { name: "report", version: 1, triggers: ["daily at 09:00"] },
      ],
      runs: [
        run({ runId: "rel", title: "Release 1.3" }),
        run({ runId: "old", title: "Release 1.2", status: "completed", endedAt: at(3) }),
      ],
      questions: [],
    });
    await using _desktop = await desktop();
    await using screen = await render(page());

    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await expect.element(runs.getByRole("button", { name: /Release 1\.3/ })).toBeVisible();
    await expect
      .element(runs.getByRole("button", { name: /Release 1\.2/ }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "All", exact: true }).click();
    await expect.element(runs.getByRole("button", { name: /Release 1\.2/ })).toBeVisible();

    // A workflow that has not run is still there to be picked, with what starts it.
    await screen.getByRole("combobox", { name: "Workflow" }).click();
    await screen.getByRole("option", { name: "report" }).click();
    await expect.element(screen.getByText("Starts on daily at 09:00")).toBeVisible();
    await expect.element(runs).toMatchTextContent("Has not run yet.");
  });

  it("counts the skipped runs of the workflow picked, not of every workflow", async () => {
    setup({
      workflows: [
        { name: "release", version: 1, triggers: [] },
        { name: "report", version: 1, triggers: ["webhook pings"] },
      ],
      runs: [
        run({ runId: "rel", title: "Release 1.3", status: "completed", endedAt: at(3) }),
        run({
          runId: "s1",
          workflow: "report",
          title: "Ping 1",
          status: "skipped",
          endedAt: at(1),
        }),
        run({
          runId: "s2",
          workflow: "report",
          title: "Ping 2",
          status: "skipped",
          endedAt: at(2),
        }),
      ],
      questions: [],
    });
    await using _desktop = await desktop();
    await using screen = await render(page());

    await screen.getByRole("button", { name: "All", exact: true }).click();
    await expect.element(screen.getByRole("button", { name: "Show 2 skipped" })).toBeVisible();
    await screen.getByRole("combobox", { name: "Workflow" }).click();
    await screen.getByRole("option", { name: "release" }).click();
    await expect
      .element(screen.getByRole("navigation", { name: "Workflow runs" }))
      .not.toMatchTextContent(/skipped/);
  });

  it("shows a run of the workflow picked, not one of another workflow", async () => {
    setup({
      workflows: [
        { name: "release", version: 1, triggers: [] },
        { name: "report", version: 1, triggers: ["daily at 09:00"] },
      ],
      runs: [
        run({ runId: "rep", workflow: "report", title: "Nightly report" }),
        run({ runId: "rel", title: "Release 1.3", status: "completed", endedAt: at(3) }),
      ],
      questions: [],
    });
    await using _desktop = await desktop();
    await using screen = await render(page());

    await expect.element(screen.getByRole("article", { name: "Nightly report" })).toBeVisible();
    await screen.getByRole("button", { name: "All", exact: true }).click();
    await screen.getByRole("combobox", { name: "Workflow" }).click();
    await screen.getByRole("option", { name: "release" }).click();
    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await expect.element(runs.getByRole("button", { name: /Release 1\.3/ })).toBeVisible();
    await expect
      .element(screen.getByRole("article", { name: "Nightly report" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("article", { name: "Release 1.3" })).toBeVisible();
  });

  const KIND_KEY = "t3code:workflows:question-kind";
  const asked = (runId: string, kind?: string): WorkflowQuestion => ({
    ...question,
    runId,
    ...(kind === undefined ? {} : { kind }),
  });
  const kindWorkflows = [
    {
      name: "release",
      version: 1,
      triggers: [],
      asks: [
        { kind: "feature", label: "Feature wanted?" },
        { kind: "intended", label: "Bug or intended?" },
      ],
    },
  ];
  const otherKinds = [
    run({ runId: "sticky", title: "Sticky header", status: "waiting" }),
    run({ runId: "plain", title: "Release 1.4", status: "waiting" }),
  ];
  const kindsAsked = () =>
    setup({
      workflows: kindWorkflows,
      runs: [...otherKinds, run({ runId: "dark", title: "Dark mode", status: "waiting" })],
      questions: [asked("sticky", "intended"), asked("plain"), asked("dark", "feature")],
    });
  const featureAnswered = () =>
    setup({
      workflows: kindWorkflows,
      runs: [
        ...otherKinds,
        run({ runId: "dark", title: "Dark mode", status: "completed", endedAt: at(6) }),
      ],
      questions: [asked("sticky", "intended"), asked("plain")],
    });

  it("narrows what needs you to one kind of question, and stays there once it is answered", async () => {
    localStorage.removeItem(KIND_KEY);
    kindsAsked();
    await using _desktop = await desktop();
    // Opened by its link, as a run picked from the list is.
    await using screen = await render(page("dark"));

    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await expect
      .element(screen.getByText("Feature wanted? 1 · Bug or intended? 1 · Other 1"))
      .toBeVisible();
    await expect.element(runs.getByRole("button", { name: /Sticky header/ })).toBeVisible();

    await screen.getByRole("combobox", { name: "Kind of question" }).click();
    await screen.getByRole("option", { name: "Feature wanted? 1" }).click();
    await expect.element(runs.getByRole("button", { name: /Dark mode/ })).toBeVisible();
    await expect
      .element(runs.getByRole("button", { name: /Sticky header/ }))
      .not.toBeInTheDocument();
    await expect
      .element(runs.getByRole("button", { name: /Release 1\.4/ }))
      .not.toBeInTheDocument();

    // Answering the last question of the kind keeps the filter: the other kinds stay out.
    await screen.getByRole("button", { name: "Ship", exact: true }).click();
    await vi.waitFor(() => expect(state.commands).toHaveLength(1));
    featureAnswered();
    await screen.rerender(page("dark"));
    await expect.element(runs).toMatchTextContent("No questions of this kind wait on you.");
    await expect
      .element(runs.getByRole("button", { name: /Sticky header/ }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("combobox", { name: "Kind of question" }))
      .toMatchTextContent("Feature wanted? 0");
    localStorage.removeItem(KIND_KEY);
  });

  it("lists a question of a kind its workflow does not declare under Other, with those of no kind", async () => {
    localStorage.removeItem(KIND_KEY);
    setup({
      workflows: kindWorkflows,
      runs: [...otherKinds, run({ runId: "typo", title: "Typo fix", status: "waiting" })],
      questions: [asked("sticky", "intended"), asked("plain"), asked("typo", "feture")],
    });
    await using _desktop = await desktop();
    await using screen = await render(page());

    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await expect.element(screen.getByText("Bug or intended? 1 · Other 2")).toBeVisible();
    await screen.getByRole("combobox", { name: "Kind of question" }).click();
    await expect.element(screen.getByRole("option", { name: /feture/ })).not.toBeInTheDocument();
    await screen.getByRole("option", { name: "Other 2" }).click();
    await expect.element(runs.getByRole("button", { name: /Typo fix/ })).toBeVisible();
    await expect.element(runs.getByRole("button", { name: /Release 1\.4/ })).toBeVisible();
    await expect
      .element(runs.getByRole("button", { name: /Sticky header/ }))
      .not.toBeInTheDocument();
    localStorage.removeItem(KIND_KEY);
  });

  it("shows by itself only a run that asks the picked kind, and none once it is answered", async () => {
    localStorage.removeItem(KIND_KEY);
    kindsAsked();
    await using _desktop = await desktop();
    await using screen = await render(page());

    // With no kind picked, the first run that waits is shown: one of another kind.
    await expect.element(screen.getByRole("heading", { name: "Sticky header" })).toBeVisible();
    await screen.getByRole("combobox", { name: "Kind of question" }).click();
    await screen.getByRole("option", { name: "Feature wanted? 1" }).click();
    await expect.element(screen.getByRole("heading", { name: "Dark mode" })).toBeVisible();

    await screen.getByRole("button", { name: "Ship", exact: true }).click();
    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        ["workflow answer", { runId: "dark", name: "approve", choice: "Ship" }],
      ]),
    );
    featureAnswered();
    await screen.rerender(page());
    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await expect.element(runs).toMatchTextContent("No questions of this kind wait on you.");
    // No other kind's question, with its answers, takes the place beside the empty list.
    await expect.element(screen.getByRole("article")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Ship", exact: true }))
      .not.toBeInTheDocument();
    localStorage.removeItem(KIND_KEY);
  });

  it("moves from an open run that asks another kind to one that asks the picked kind", async () => {
    localStorage.removeItem(KIND_KEY);
    kindsAsked();
    const select = vi.fn();
    await using _desktop = await desktop();
    await using screen = await render(page("sticky", { select }));

    await screen.getByRole("combobox", { name: "Kind of question" }).click();
    await screen.getByRole("option", { name: "Feature wanted? 1" }).click();
    await vi.waitFor(() => expect(select).toHaveBeenCalledWith("dark"));
    // Until the address follows, the open run is still in the list, so nothing shown is unlisted.
    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await expect
      .element(runs.getByRole("button", { name: /Sticky header/ }))
      .toHaveAttribute("aria-current", "true");
    await expect
      .element(runs.getByRole("button", { name: /Release 1\.4/ }))
      .not.toBeInTheDocument();

    await screen.rerender(page("dark", { select }));
    await expect.element(screen.getByRole("heading", { name: "Dark mode" })).toBeVisible();
    await expect
      .element(runs.getByRole("button", { name: /Sticky header/ }))
      .not.toBeInTheDocument();
    localStorage.removeItem(KIND_KEY);
  });

  it("keeps a kind remembered from before through answering a run picked from the list", async () => {
    localStorage.setItem(KIND_KEY, JSON.stringify("feature"));
    kindsAsked();
    await using _desktop = await desktop();
    await using screen = await render(page());

    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await runs.getByRole("button", { name: /Dark mode/ }).click();
    featureAnswered();
    await screen.rerender(page("dark"));
    // The answered run is in no list that waits, and the list does not move on to All for it.
    await expect.element(runs).toMatchTextContent("No questions of this kind wait on you.");
    await expect
      .element(screen.getByRole("combobox", { name: "Kind of question" }))
      .toMatchTextContent("Feature wanted? 0");
    localStorage.removeItem(KIND_KEY);
  });

  it("opens the run that asks the picked kind, from the row of the run that invoked it", async () => {
    localStorage.setItem(KIND_KEY, JSON.stringify("feature"));
    setup({
      workflows: kindWorkflows,
      runs: [
        run({ runId: "epic", title: "Epic", status: "waiting" }),
        run({ runId: "dark", title: "Dark mode", status: "waiting", parentRunId: "epic" }),
      ],
      questions: [asked("epic", "intended"), asked("dark", "feature")],
    });
    const select = vi.fn();
    await using _desktop = await desktop();
    await using screen = await render(page(null, { select }));

    // Listed for the question the run it invoked asks; its own is of another kind.
    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await runs.getByRole("button", { name: /Epic/ }).click();
    expect(select.mock.calls).toEqual([["dark"]]);
    localStorage.removeItem(KIND_KEY);
  });

  it("still shows a run opened by its link in a list that has it, whatever kind was picked before", async () => {
    localStorage.setItem(KIND_KEY, JSON.stringify("feature"));
    setup({
      workflows: kindWorkflows,
      runs: [
        run({ runId: "busy", title: "Nightly sync" }),
        run({ runId: "sticky", title: "Sticky header", status: "waiting" }),
      ],
      questions: [asked("sticky", "intended")],
    });
    await using _desktop = await desktop();
    await using screen = await render(page("busy"));

    const runs = screen.getByRole("navigation", { name: "Workflow runs" });
    await expect
      .element(runs.getByRole("button", { name: /Nightly sync/ }))
      .toHaveAttribute("aria-current", "true");
    await expect
      .element(screen.getByRole("combobox", { name: "Kind of question" }))
      .not.toBeInTheDocument();
    localStorage.removeItem(KIND_KEY);
  });

  it("says how long a finished run and its steps took in the UI language", async () => {
    // GTProvider leaves its locale in a cookie; this sets it back to English.
    initializeI18n(() => {});
    setup(
      {
        runs: [run({ runId: "fix", title: "Fix", status: "completed", endedAt: at(2) })],
        questions: [],
      },
      { fix: [step({ name: "build", kind: "step", endedAt: at(2) })] },
    );
    const translations = await getTranslationsSnapshot("ja");
    await using screen = await render(
      <GTProvider locale="ja" translations={translations}>
        {page("fix")}
      </GTProvider>,
    );

    await expect.element(screen.getByText("所要時間 2分0秒")).toBeVisible();
    await expect.element(screen.getByText("2分0秒", { exact: true })).toBeVisible();
    initializeI18n(() => {});
  });
});
