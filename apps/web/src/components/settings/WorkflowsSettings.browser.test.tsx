import { Atom } from "effect/reactivity";
import {
  EnvironmentId,
  type WorkflowRun,
  type WorkflowRunsSnapshot,
  type WorkflowStep,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { WorkflowsSettings } from "./WorkflowsSettings";

const environmentId = EnvironmentId.make("laptop");
const pausedRun: WorkflowRun = {
  runId: "run-1",
  workflow: "release",
  version: 1,
  title: "Release 1.2",
  status: "paused",
  detail: "build failed: exit 1",
  result: null,
  pauses: 1,
  retired: false,
  parentRunId: null,
  startedAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:05:00.000Z",
  endedAt: null,
};
const step = (
  fields: Partial<WorkflowStep> & Pick<WorkflowStep, "name" | "kind">,
): WorkflowStep => ({
  status: "completed",
  attempts: 1,
  detail: null,
  threadId: null,
  environmentId: null,
  startedAt: "2026-11-01T00:00:00.000Z",
  endedAt: "2026-11-01T00:01:30.000Z",
  ...fields,
});

const state = vi.hoisted(() => ({
  live: { query: "live" },
  snapshot: { runs: [], questions: [] } as {
    runs: ReadonlyArray<unknown>;
    questions: ReadonlyArray<unknown>;
  },
  steps: [] as ReadonlyArray<unknown>,
  commands: [] as Array<readonly [label: string | undefined, input: unknown]>,
  permitted: true,
}));
const canOperate = Atom.make(true);
const cannotOperate = Atom.make(false);

function setup(snapshot: WorkflowRunsSnapshot, steps: ReadonlyArray<WorkflowStep> = []) {
  state.snapshot = snapshot;
  state.steps = steps;
  state.commands = [];
  state.permitted = true;
}

const environment = {
  environmentId,
  label: "Laptop",
  connection: { phase: "connected" },
  serverConfig: { environment: { platform: "linux", capabilities: {} } },
};

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
    environments: [environment],
    connectedEnvironments: [environment],
    environment,
    target: null,
    targets: [],
  })) as never,
}));
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
  useEnvironmentQuery: ((request: unknown) => ({
    data:
      request === state.live ? state.snapshot : { run: state.snapshot.runs[0], steps: state.steps },
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

const question = {
  runId: pausedRun.runId,
  name: "approve",
  request: {
    title: "Ship release 1.2?",
    choices: ["yes", "no"],
    data: { body: "The diff touches the installer." },
  },
  askedAt: "2026-11-01T00:04:00.000Z",
};

describe("WorkflowsSettings", () => {
  it("answers a question with the chosen choice and the reason given", async () => {
    setup({
      runs: [{ ...pausedRun, status: "waiting", detail: "approve" }],
      questions: [question],
    });
    await using screen = await render(<WorkflowsSettings />);

    await expect.element(screen.getByText("The diff touches the installer.")).toBeVisible();
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Reason for Ship release 1.2?" }),
      "  Too risky today ",
    );
    await screen.getByRole("button", { name: "no", exact: true }).click();

    await vi.waitFor(() =>
      expect(state.commands).toEqual([
        [
          "workflow answer",
          { runId: "run-1", name: "approve", choice: "no", reason: "Too risky today" },
        ],
      ]),
    );
  });

  it("turns the choices off for a session that may not operate", async () => {
    setup({ runs: [], questions: [question] });
    state.permitted = false;
    await using screen = await render(<WorkflowsSettings />);

    await expect.element(screen.getByRole("button", { name: "yes", exact: true })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "no", exact: true })).toBeDisabled();
  });

  it("shows why a run is paused and resumes it", async () => {
    setup({ runs: [pausedRun], questions: [] });
    await using screen = await render(<WorkflowsSettings />);

    const row = screen.getByRole("button", { name: /Release 1\.2/ });
    await expect.element(row).toMatchTextContent("paused");
    await expect.element(row).toMatchTextContent("build failed: exit 1");
    await row.click();
    await screen.getByRole("button", { name: "Resume" }).click();

    await vi.waitFor(() =>
      expect(state.commands).toEqual([["workflow resume", { runId: "run-1" }]]),
    );
  });

  it("lists a selected run's steps, its agent threads and its result once it ended", async () => {
    setup(
      {
        runs: [
          {
            ...pausedRun,
            status: "completed",
            detail: null,
            result: { released: "1.2.0" },
            endedAt: "2026-11-01T00:06:00.000Z",
          },
        ],
        questions: [],
      },
      [
        step({ name: "build", kind: "step", status: "failed", attempts: 2, detail: "exit 1" }),
        step({ name: "triage", kind: "agent", threadId: "thread-1" }),
        step({ name: "fix", kind: "agent", threadId: "thread-2", environmentId: "build-box" }),
      ],
    );
    await using screen = await render(<WorkflowsSettings />);
    await screen.getByRole("button", { name: /Release 1\.2/ }).click();

    const steps = screen.getByRole("list", { name: "Steps of Release 1.2" }).getByRole("listitem");
    await expect.element(steps.nth(0)).toMatchTextContent(/build.*step.*failed.*2 attempts/);
    await expect.element(steps.nth(0)).toMatchTextContent("took 1m 30s");
    await expect.element(steps.nth(0)).toMatchTextContent("exit 1");
    await expect
      .element(steps.nth(1).getByRole("link", { name: "Open thread" }))
      .toHaveAttribute("href", "/laptop/thread-1");
    // This client is not connected to the linked environment, so there is nothing to open.
    await expect.element(steps.nth(2)).toMatchTextContent("Thread in environment build-box");
    await expect
      .element(screen.getByLabelText("Result of Release 1.2"))
      .toMatchTextContent('"released": "1.2.0"');
    await expect
      .element(screen.getByRole("button", { name: "Cancel run" }))
      .not.toBeInTheDocument();
  });

  it("says workflows may be off when nothing has run", async () => {
    setup({ runs: [], questions: [] });
    await using screen = await render(<WorkflowsSettings />);

    await expect.element(screen.getByText("No workflow runs")).toBeVisible();
    await expect.element(screen.getByText("T3CODE_WORKFLOWS")).toBeVisible();
  });
});
