// @vitest-environment jsdom

import type {
  EnvironmentRegistry as EnvironmentRegistryTypes,
  EnvironmentSupervisor as EnvironmentSupervisorTypes,
} from "@t3tools/client-runtime/connection";
import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
  type IssueTemplateList,
  type IssueCandidates,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  toast: vi.fn(),
  nativeCreate: vi.fn(),
  metadata: null as (IssueTemplateList & Pick<IssueCandidates, "issueTypes" | "fields">) | null,
}));
vi.mock("../../../../../packages/client-runtime/src/rpc/client.ts", async (importOriginal) => {
  const Effect = await import("effect/Effect");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    requestGuarded: (tag: string, input: unknown) => {
      expect(tag).toBe(WS_METHODS.issuesCreate);
      return Effect.sync(() => state.nativeCreate(input));
    },
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : state.metadata,
    error: null,
    isPending: false,
  }),
}));
vi.mock("~/state/issues", async () => {
  const { createIssueEnvironmentAtoms } = await import("@t3tools/client-runtime/state/issues");
  const { EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  const Session = await import("@t3tools/client-runtime/state/session");
  const Layer = await import("effect/Layer");
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const supervisor = {} as EnvironmentSupervisorTypes.EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(
      EnvironmentRegistry.EnvironmentRegistry,
      EnvironmentRegistry.EnvironmentRegistry.of({
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistryTypes.EnvironmentRegistry["Service"]),
    ),
  );
  const sessions = Session.createEnvironmentSessionAtoms(runtime);
  const sessionFactory = vi.spyOn(Session, "createEnvironmentSessionAtoms").mockReturnValue({
    ...sessions,
    sessionStateAtom: () => session,
  });
  const issueEnvironment = createIssueEnvironmentAtoms(runtime);
  sessionFactory.mockRestore();
  return { issueEnvironment };
});

import { issueEnvironment } from "~/state/issues";
import { IssueCreateDialog, type IssueCreateScope } from "./IssueCreateDialog";

const sessionState: AuthSessionState = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
  permissions: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
};
const session = Atom.make(AsyncResult.success(sessionState));
const sourceA: IssueCreateScope = {
  environmentId: EnvironmentId.make("environment-a"),
  projectTitle: "Project A",
  scope: {
    projectId: ProjectId.make("project-a"),
    tracker: IssueTrackerKind.make("github"),
    host: "github.example",
    scope: "org/A",
  },
  templates: false,
};
const sourceB: IssueCreateScope = {
  ...sourceA,
  projectTitle: "Project B",
  scope: { ...sourceA.scope, projectId: ProjectId.make("project-b"), scope: "org/B" },
};
let registry: AtomRegistry.AtomRegistry;
let root: Root;
let container: HTMLDivElement;
const created = vi.fn();
const closed = vi.fn();
const nativeCreate = state.nativeCreate;
const render = (
  scopes: ReadonlyArray<IssueCreateScope>,
  parent?: { key: string; displayKey: string },
) =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <IssueCreateDialog
          open
          parent={parent ?? null}
          scopes={scopes}
          onCreated={created}
          onOpenChange={closed}
        />
      </RegistryContext.Provider>,
    ),
  );
const createButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Create issue",
  )!;
async function draft() {
  const input = document.querySelector<HTMLInputElement>("#issue-create-title")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Draft meant for A",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it.each(["B", undefined])(
  "does not send a removed account draft to another account on the same native scope (%s)",
  async (connectionId) => {
    const a = { ...sourceA, scope: { ...sourceA.scope, connectionId: "A" } };
    const b = {
      ...a,
      scope: { ...sourceA.scope, ...(connectionId === undefined ? {} : { connectionId }) },
    };
    await render([a, b]);
    await draft();
    await render([b]);
    expect(createButton().disabled).toBe(true);
    await act(async () => createButton().click());
    expect(nativeCreate).not.toHaveBeenCalled();
    await choose("Project", connectionId === undefined ? "Project A" : " · B");
    expect(document.querySelector<HTMLInputElement>("#issue-create-title")!.value).toBe("");
    await draft();
    await act(async () => createButton().click());
    expect(nativeCreate).toHaveBeenCalledExactlyOnceWith({
      ...b.scope,
      title: "Draft meant for A",
      body: "",
      labels: [],
      assignees: [],
    });
  },
);
async function choose(label: string, title: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  expect(trigger).not.toBeNull();
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) =>
    entry.textContent?.includes(title),
  )!;
  expect(option).toBeDefined();
  await act(async () => option.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.metadata = null;
  registry = AtomRegistry.make();
  registry.set(session, AsyncResult.success(sessionState));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  created.mockReset();
  closed.mockReset();
  nativeCreate.mockReset().mockReturnValue({
    key: "7",
    displayKey: "#7",
    url: "https://github.example/org/A/issues/7",
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { name: "repository", replacement: sourceB },
  {
    name: "environment",
    replacement: { ...sourceA, environmentId: (sourceB.environmentId + "-other") as EnvironmentId },
  },
  { name: "host", replacement: { ...sourceA, scope: { ...sourceA.scope, host: "other.example" } } },
  {
    name: "tracker",
    replacement: {
      ...sourceA,
      scope: { ...sourceA.scope, tracker: IssueTrackerKind.make("gitlab") },
    },
  },
])(
  "blocks a removed $name until the writer chooses the remaining source",
  async ({ replacement }) => {
    await render([sourceA, replacement]);
    await draft();
    await render([replacement]);
    await act(async () => createButton().click());
    expect(nativeCreate).not.toHaveBeenCalled();
    expect(createButton().disabled).toBe(true);
    expect(document.querySelector<HTMLInputElement>("#issue-create-title")!.value).toBe(
      "Draft meant for A",
    );
    await choose("Project", replacement.projectTitle);
    await act(async () => createButton().click());
    expect(nativeCreate).toHaveBeenCalledExactlyOnceWith({
      ...replacement.scope,
      title: "Draft meant for A",
      body: "",
      labels: [],
      assignees: [],
    });
    expect(created).toHaveBeenCalledWith(replacement, expect.objectContaining({ key: "7" }));
  },
);

it("keeps the selected native scope after reorder and project representative replacement", async () => {
  await render([sourceA, sourceB]);
  await draft();
  const rebound = {
    ...sourceA,
    projectTitle: "Another local project for A",
    scope: {
      ...sourceA.scope,
      projectId: ProjectId.make("project-a-representative"),
      host: "GITHUB.EXAMPLE",
    },
  };
  await render([sourceB, rebound]);
  await act(async () => createButton().click());
  expect(nativeCreate).toHaveBeenCalledExactlyOnceWith({
    ...rebound.scope,
    title: "Draft meant for A",
    body: "",
    labels: [],
    assignees: [],
  });
  expect(created).toHaveBeenCalledWith(rebound, expect.objectContaining({ key: "7" }));
});

it("keeps the write permission guard after source selection", async () => {
  await render([sourceA, sourceB]);
  await draft();
  await choose("Project", sourceB.projectTitle);
  await act(async () =>
    registry.set(session, AsyncResult.success({ ...sessionState, permissions: [], scopes: [] })),
  );
  await act(async () => createButton().click());
  expect(createButton().disabled).toBe(true);
  expect(nativeCreate).not.toHaveBeenCalled();
});

it("preselects the first source when sources arrive after the dialog mounts", async () => {
  await render([]);
  await render([sourceA]);
  await draft();
  await act(async () => createButton().click());
  expect(nativeCreate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(sourceA.scope));
});

it("keeps native template, parent and issue-type metadata through source reorder", async () => {
  state.metadata = {
    blankIssuesEnabled: false,
    templates: [
      {
        key: "bug",
        name: "Bug",
        about: "",
        title: "Template title",
        body: "Template body",
        labels: ["bug"],
        assignees: ["native-user"],
      },
    ],
    issueTypes: [{ id: "native-bug-type", name: "Bug" }],
  };
  const nativeSource = { ...sourceA, templates: true, createIssueTypes: true };
  const parent = { key: "native-parent", displayKey: "#5" };
  await render([nativeSource, sourceB], parent);
  await draft();
  await choose("Template", "Bug");
  await render([sourceB, nativeSource], parent);
  await act(async () => createButton().click());
  expect(nativeCreate).toHaveBeenCalledExactlyOnceWith({
    ...nativeSource.scope,
    title: "Draft meant for A",
    body: "Template body",
    templateKey: "bug",
    parentKey: parent.key,
    issueType: "native-bug-type",
    labels: ["bug"],
    assignees: ["native-user"],
  });
});

it("validates native fields, retains a failed draft, and drops stale type fields", async () => {
  const required = { id: "custom", label: "Native value", required: true, kind: "text" as const };
  state.metadata = {
    blankIssuesEnabled: true,
    templates: [],
    fields: [required],
    issueTypes: [
      { id: "bug", name: "Bug" },
      { id: "task", name: "Task" },
    ],
  };
  const source = { ...sourceA, createIssueTypes: true, createFields: true };
  await render([source]);
  await draft();
  expect(createButton().disabled).toBe(true);
  const field = document.querySelector<HTMLInputElement>("#issue-native-field-custom")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "Keep native draft",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  nativeCreate.mockImplementationOnce(() => {
    throw new Error("Native validation failed");
  });
  await act(async () => createButton().click());
  expect(document.querySelector<HTMLInputElement>("#issue-create-title")!.value).toBe(
    "Draft meant for A",
  );
  expect(field.value).toBe("Keep native draft");
  expect(closed).not.toHaveBeenCalled();
  state.metadata = { ...state.metadata, fields: [] };
  await choose("Issue type", "Task");
  await act(async () => createButton().click());
  expect(nativeCreate.mock.calls.at(-1)![0]).toMatchObject({
    ...source.scope,
    issueType: "task",
    fieldValues: {},
    title: "Draft meant for A",
  });
});

it("sends datetime in the browser timezone as ISO and keeps date-only calendar values", async () => {
  state.metadata = {
    blankIssuesEnabled: true,
    templates: [],
    fields: [
      { id: "starts", label: "Starts at", required: true, kind: "datetime" },
      { id: "due", label: "Due date", required: true, kind: "date" },
    ],
  };
  const source = { ...sourceA, createFields: true };
  await render([source]);
  await draft();
  const time = document.querySelector<HTMLInputElement>("#issue-native-field-starts")!;
  const date = document.querySelector<HTMLInputElement>("#issue-native-field-due")!;
  expect(time.type).toBe("datetime-local");
  expect(date.type).toBe("date");
  const set = (field: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await act(async () => {
    set(time, "2026-06-01T09:30");
    set(date, "2026-06-02");
  });
  await act(async () => createButton().click());
  expect(nativeCreate.mock.calls[0]![0].fieldValues).toEqual({
    starts: new Date(2026, 5, 1, 9, 30).toISOString(),
    due: "2026-06-02",
  });
  expect(nativeCreate.mock.calls[0]![0].fieldValues.starts).toMatch(/Z$/);
});

it("omits cleared optional number, date, JSON and choice controls before the native create RPC", async () => {
  state.metadata = {
    blankIssuesEnabled: true,
    templates: [],
    fields: [
      { id: "number", label: "Number", required: false, kind: "number" },
      { id: "date", label: "Date", required: false, kind: "date" },
      { id: "json", label: "JSON", required: false, kind: "json" },
      { id: "text", label: "Text", required: false, kind: "text" },
      {
        id: "choice",
        label: "Choice",
        required: false,
        kind: "select",
        options: [{ value: "native-id", label: "Native choice" }],
      },
    ],
  };
  await render([{ ...sourceA, createFields: true }]);
  await draft();
  const set = async (id: string, value: string) =>
    act(async () => {
      const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "#issue-native-field-" + id,
      )!;
      Object.getOwnPropertyDescriptor(
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  for (const [id, value] of [
    ["number", "4"],
    ["date", "2026-06-01"],
    ["text", "Clear this text"],
  ]) {
    await set(id!, value!);
    await set(id!, "");
  }
  await choose("JSON type", "Object");
  expect(createButton().disabled).toBe(false);
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Clear")!
      .click(),
  );
  await choose("Choice", "Native choice");
  await choose("Choice", "None");
  await act(async () => createButton().click());
  expect(nativeCreate.mock.calls[0]![0].fieldValues).toEqual({ text: "" });
});

it("selects one native type and loads its required fields without a manual type choice", async () => {
  state.metadata = {
    blankIssuesEnabled: true,
    templates: [],
    issueTypes: [{ id: "only-native-type", name: "Task" }],
    fields: [
      { id: "required-native", label: "Required native input", kind: "text", required: true },
    ],
  };
  const metadata = state.metadata;
  const readCandidates = issueEnvironment.candidates;
  const candidates = vi.spyOn(issueEnvironment, "candidates").mockImplementation((target) => {
    state.metadata =
      target.input.issueType === "only-native-type" ? metadata : { ...metadata, fields: [] };
    return readCandidates(target);
  });
  const source = { ...sourceA, createFields: true, createIssueTypes: true };
  await render([source]);
  await draft();
  expect(document.querySelector('[aria-label="Issue type"]')).toBeNull();
  expect(candidates).toHaveBeenCalledWith({
    environmentId: source.environmentId,
    input: { ...source.scope, issueType: "only-native-type" },
  });
  expect(createButton().disabled).toBe(true);
  await act(async () => createButton().click());
  expect(nativeCreate).not.toHaveBeenCalled();
  const field = document.querySelector<HTMLInputElement>("#issue-native-field-required-native")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "Native value",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => createButton().click());
  expect(nativeCreate).toHaveBeenCalledExactlyOnceWith({
    ...source.scope,
    title: "Draft meant for A",
    body: "",
    labels: [],
    assignees: [],
    issueType: "only-native-type",
    fieldValues: { "required-native": "Native value" },
  });
});
