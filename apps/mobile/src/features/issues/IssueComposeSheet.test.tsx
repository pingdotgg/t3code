// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { IssueTrackerKind, ProjectId, type IssueDetail } from "@t3tools/contracts";

type Props = Record<string, unknown> & { readonly children?: ReactNode };

const harness = vi.hoisted(() => {
  const controls = new Map<string, Record<string, unknown>>();
  return {
    controls,
    issue: null as unknown,
    updates: [] as unknown[],
    answers: [] as Array<"fail" | "ok">,
    back: 0,
    opened: [] as string[],
    connected: true,
    capture:
      (key: string) =>
      ({ children, ...props }: Props) => {
        controls.set(String(props[key]), props);
        return children ?? null;
      },
  };
});

vi.mock("@effect/atom-react", async () => ({
  RegistryContext: (await import("react")).createContext({}),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => harness.back++ }),
}));
vi.mock("react-native", () => ({
  Linking: { openURL: (url: string) => harness.opened.push(url) },
  Platform: { OS: "ios" },
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: Props) => children,
  AppTextInput: harness.capture("accessibilityLabel"),
}));
vi.mock("../../components/MaterialButton", () => ({ MaterialButton: harness.capture("label") }));
vi.mock("../pull-requests/PullRequestSheetContent", () => ({
  PullRequestSheetContent: ({ children, footer }: Props & { footer: ReactNode }) => (
    <>
      {footer}
      {children}
    </>
  ),
}));
vi.mock("../../state/issues", () => ({ issueEnvironment: { detail: () => null } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: harness.issue, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: unknown) => {
    harness.updates.push(input);
    return harness.answers.shift() === "fail"
      ? { _tag: "Failure", cause: new Error("Jira refused the update") }
      : { _tag: "Success", value: undefined };
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { cause: Error }) => failure.cause,
}));
vi.mock("./useIssueAccess", async () => {
  const { issueAccess } = await import("./issueDetail");
  const grants = { comment: true, update: true, setState: true, react: true };
  return {
    issueTarget: ({ environmentId, ...input }: Record<string, string>) => ({
      environmentId,
      input,
    }),
    markIssueTargetWritten: () => {},
    useIssueAccess: (_params: unknown, detail: IssueDetail | null) => ({
      connected: harness.connected,
      ...issueAccess(detail, { ...grants, connected: harness.connected }),
    }),
  };
});

import { IssueComposeSheet } from "./IssueComposeSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function detail(bodyEditable?: boolean): IssueDetail {
  return {
    tracker: IssueTrackerKind.make("jira"),
    host: "acme.atlassian.net",
    scope: "ENG",
    key: "ENG-1",
    displayKey: "ENG-1",
    projectId: ProjectId.make("project"),
    projectTitle: "Project",
    title: "Old title",
    url: "https://acme.atlassian.net/browse/ENG-1",
    author: null,
    state: { category: "open", name: "To Do" },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    writable: true,
    viewer: "viewer",
    body: "Rich *body*",
    ...(bodyEditable === undefined ? {} : { bodyEditable }),
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
    capabilities: {
      create: true,
      edit: true,
      comment: true,
      labels: true,
      assignees: true,
      reactions: false,
      templates: false,
      linkedPullRequests: false,
      events: false,
      search: true,
      states: [],
      closeReasons: [],
    },
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
  };
}

let root: Root;
const control = (key: string) => harness.controls.get(key);
const type = (key: string, text: string) =>
  act(() => (control(key)!.onChangeText as (text: string) => void)(text));
const save = () => act(async () => (control("Save")!.onPress as () => void)());
const render = () =>
  act(() =>
    root.render(
      <IssueComposeSheet
        route={{
          params: {
            environmentId: "environment",
            projectId: "project",
            tracker: "jira",
            host: "acme.atlassian.net",
            scope: "ENG",
            key: "ENG-1",
            mode: "edit",
          },
        }}
      />,
    ),
  );
const sent = () =>
  harness.updates.map((update) => {
    const { title, body } = (update as { input: { title?: string; body?: string } }).input;
    return { title, body };
  });

beforeEach(() => {
  root = createRoot(document.createElement("div"));
  harness.controls.clear();
  harness.updates.length = 0;
  harness.answers = [];
  harness.back = 0;
  harness.opened.length = 0;
  harness.connected = true;
});

afterEach(() => act(async () => root.unmount()));

it("saves only the title when the description cannot round-trip, and keeps the draft on failure", async () => {
  harness.issue = detail(false);
  harness.answers = ["fail", "ok"];
  await render();
  expect(control("Description")!.editable).toBe(false);
  await act(() => (control("Edit description in browser")!.onPress as () => void)());
  expect(harness.opened).toEqual(["https://acme.atlassian.net/browse/ENG-1"]);

  await type("Title", "New title");
  await save();
  expect(harness.back).toBe(0);
  expect(control("Title")!.value).toBe("New title");

  await save();
  expect(sent()).toEqual([
    { title: "New title", body: undefined },
    { title: "New title", body: undefined },
  ]);
  expect(harness.back).toBe(1);
});

it.each([undefined, true])("edits a plain description when bodyEditable is %s", async (flag) => {
  harness.issue = detail(flag);
  await render();
  expect(control("Description")!.editable).toBe(true);
  expect(control("Edit description in browser")).toBeUndefined();
  await type("Description", "Plain body");
  await save();
  expect(sent()).toEqual([{ title: undefined, body: "Plain body" }]);
});

it("says the environment is offline instead of blaming access when it disconnects", async () => {
  harness.issue = detail();
  harness.connected = false;
  const container = document.createElement("div");
  root = createRoot(container);
  await render();
  expect(control("Save")!.disabled).toBe(true);
  expect(container.textContent).toContain(
    "This environment is offline. Reconnect to edit this issue.",
  );
  expect(container.textContent).not.toContain("with your access");
});

it.each([
  ["Title", "New title", { body: "Teammate body" }, { title: "New title", body: undefined }],
  ["Description", "My body", { title: "Teammate title" }, { title: undefined, body: "My body" }],
] as const)(
  "keeps the refreshed issue's other field after editing %s",
  async (field, text, refreshed, expected) => {
    harness.issue = detail(true);
    await render();
    await type(field, text);
    harness.issue = { ...detail(true), ...refreshed };
    await render();
    expect(control(field === "Title" ? "Description" : "Title")!.value).toBe(
      Object.values(refreshed)[0],
    );
    await save();
    expect(sent()).toEqual([expected]);
  },
);
