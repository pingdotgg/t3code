// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentSupervisor as TestSupervisor,
  type EnvironmentRegistry as RegistryTypes,
  type EnvironmentSupervisor as SupervisorTypes,
} from "@t3tools/client-runtime/connection";
import {
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  IssueTrackerKind,
  IssueOperationError,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
  type IssueTemplate,
  type IssueTemplateList,
  type IssueTemplatesInput,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn(), bytes: 0 }));
vi.mock("../../../../../packages/client-runtime/src/rpc/client.ts", async (importOriginal) => {
  const Effect = await import("effect/Effect");
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    request: (tag: string, input: IssueTemplatesInput) =>
      Effect.gen(function* () {
        expect(tag).toBe(WS_METHODS.issuesTemplates);
        const supervisor = yield* TestSupervisor.EnvironmentSupervisor;
        const environmentId = supervisor.target.environmentId;
        return yield* Effect.tryPromise({
          try: async () => {
            const result = await state.read({
              environmentId,
              input,
            });
            state.bytes += JSON.stringify(result).length;
            return result;
          },
          catch: (cause) =>
            new IssueOperationError({
              operation: "templates",
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }),
    requestGuarded: (tag: string, input: unknown) =>
      Effect.gen(function* () {
        expect(tag).toBe(WS_METHODS.issuesCreate);
        const supervisor = yield* TestSupervisor.EnvironmentSupervisor;
        const environmentId = supervisor.target.environmentId;
        return state.create({ environmentId, input });
      }),
  };
});
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/state/issues", async () => {
  const { createIssueEnvironmentAtoms } = await import("@t3tools/client-runtime/state/issues");
  const { EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@t3tools/client-runtime/connection");
  const Session = await import("@t3tools/client-runtime/state/session");
  const Layer = await import("effect/Layer");
  const Effect = await import("effect/Effect");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const Option = await import("effect/Option");
  const { Atom } = await import("effect/reactivity");
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const connection = yield* SubscriptionRef.make({ phase: "connected" });
        const session = yield* SubscriptionRef.make(Option.some({}));
        const supervisor = (environmentId: EnvironmentId) =>
          ({
            target: { environmentId },
            state: connection,
            session,
          }) as unknown as SupervisorTypes.EnvironmentSupervisor["Service"];
        return EnvironmentRegistry.EnvironmentRegistry.of({
          run: (environmentId, effect) =>
            Effect.provideService(
              effect,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(environmentId),
            ),
          followStream: (environmentId, stream) =>
            Stream.provideService(
              stream,
              EnvironmentSupervisor.EnvironmentSupervisor,
              supervisor(environmentId),
            ),
        } as RegistryTypes.EnvironmentRegistry["Service"]);
      }),
    ),
  );
  const sessions = Session.createEnvironmentSessionAtoms(runtime);
  const factory = vi
    .spyOn(Session, "createEnvironmentSessionAtoms")
    .mockReturnValue({ ...sessions, sessionStateAtom: () => session });
  const issueEnvironment = createIssueEnvironmentAtoms(runtime);
  factory.mockRestore();
  const page = {
    hasMore: false,
    isPending: false,
    error: null,
    truncated: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  };
  return {
    issueEnvironment,
    useIssueLabelCandidates: () => ({
      ...page,
      items: [{ id: "manual-label-id", name: "Manual label", color: null, description: null }],
    }),
    useIssueAssigneeCandidates: () => ({
      ...page,
      items: [{ id: "manual-user-id", login: "manual-user", name: null, avatarUrl: null }],
    }),
  };
});

import { IssueCreateDialog, type IssueCreateScope } from "./IssueCreateDialog";
import { issueEnvironment } from "~/state/issues";

const session = Atom.make(
  AsyncResult.success({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
    permissions: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
  } satisfies AuthSessionState),
);
const source: IssueCreateScope = {
  environmentId: EnvironmentId.make("environment-a"),
  projectTitle: "Project A",
  scope: {
    projectId: ProjectId.make("project-a"),
    tracker: IssueTrackerKind.make("gitlab"),
    host: "gitlab.example",
    scope: "org/repo",
  },
  templates: true,
};
const template = (key: string, extra: Partial<IssueTemplate> = {}): IssueTemplate => ({
  key,
  name: `Template ${key}`,
  about: "",
  title: `Title ${key}`,
  body: `Body ${key}`,
  labels: [],
  assignees: [],
  ...extra,
});
const catalog: IssueTemplateList = {
  blankIssuesEnabled: false,
  templates: Array.from({ length: 100 }, (_, index) =>
    template(String(index), { title: "", body: "", contentDeferred: true }),
  ),
  contactLinks: [{ name: "Help", about: "Support", url: "https://gitlab.example/help" }],
};
const loaded = (key: string, extra: Partial<IssueTemplate> = {}): IssueTemplateList => ({
  blankIssuesEnabled: true,
  templates: [template(key, extra)],
});
function deferred() {
  let resolve!: (value: IssueTemplateList) => void;
  const promise = new Promise<IssueTemplateList>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;
const created = vi.fn();
const render = (scopes: ReadonlyArray<IssueCreateScope> = [source], open = true) =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <IssueCreateDialog open={open} scopes={scopes} onOpenChange={vi.fn()} onCreated={created} />
      </RegistryContext.Provider>,
    ),
  );
const field = (kind: "title" | "body") =>
  document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#issue-create-${kind}`)!;
const createButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Create issue",
  )!;
async function type(kind: "title" | "body", value: string) {
  const input = field(kind);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      kind === "title" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function openSelect(label: string) {
  const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  expect(trigger).not.toBeNull();
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
  );
  return [...document.querySelectorAll<HTMLElement>('[role="option"]')];
}
async function choose(label: string, text: string) {
  const options = await openSelect(label);
  const option = options.find((entry) => entry.textContent === text)!;
  expect(option).toBeDefined();
  await act(async () => option.click());
}
async function attemptCreate() {
  await act(async () => {
    createButton().click();
    field("body")?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
    );
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.bytes = 0;
  state.create.mockReset().mockReturnValue({
    key: "1",
    displayKey: "#1",
    url: "https://gitlab.example/org/repo/-/issues/1",
  });
  state.read.mockReset().mockImplementation(async ({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly
      ? catalog
      : input.templateKey
        ? loaded(input.templateKey)
        : {
            ...catalog,
            templates: catalog.templates.slice(0, 20).map((entry) => template(entry.key)),
          },
  );
  created.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});

it("reads one small catalog on open and only selected bodies while keeping all 100 choices", async () => {
  await render([source], false);
  expect(state.read).not.toHaveBeenCalled();
  await render();
  expect(state.read).toHaveBeenNthCalledWith(1, {
    environmentId: source.environmentId,
    input: { ...source.scope, metadataOnly: true },
  });
  expect(state.read).toHaveBeenCalledTimes(2);
  expect(state.read).toHaveBeenLastCalledWith({
    environmentId: source.environmentId,
    input: { ...source.scope, templateKey: "0" },
  });
  const options = await openSelect("Template");
  expect(options).toHaveLength(100);
  expect(options[99]!.textContent).toBe("Template 99");
  await act(async () => options[99]!.click());
  expect(state.read).toHaveBeenCalledTimes(3);
  expect(state.read).toHaveBeenLastCalledWith({
    environmentId: source.environmentId,
    input: { ...source.scope, templateKey: "99" },
  });
  expect(field("body").value).toBe("Body 99");
  expect(document.body.textContent).toContain("Help");
  expect(state.bytes).toBeLessThan(25000);
  expect(await openSelect("Template")).toHaveLength(100);
});

it("keeps a late body from a previous template out of the selected draft", async () => {
  const first = deferred();
  const second = deferred();
  state.read.mockImplementation(({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly
      ? Promise.resolve(catalog)
      : input.templateKey === "0"
        ? first.promise
        : second.promise,
  );
  await render();
  await choose("Template", "Template 0");
  await attemptCreate();
  expect(createButton().disabled).toBe(true);
  expect(state.create).not.toHaveBeenCalled();
  await choose("Template", "Template 1");
  await act(async () => second.resolve(loaded("1")));
  expect(field("body").value).toBe("Body 1");
  await act(async () => first.resolve(loaded("0", { body: "Late secret for A" })));
  expect(field("body").value).toBe("Body 1");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "Title 1",
      body: "Body 1",
      templateKey: "1",
      labels: [],
      assignees: [],
    },
  });
});

it.each(["environment", "host", "account"])(
  "isolates a delayed body across a %s switch with the same template key",
  async (change) => {
    const first = deferred();
    const second = deferred();
    const alternative: IssueCreateScope = {
      ...source,
      projectTitle: "Project B",
      ...(change === "environment"
        ? { environmentId: EnvironmentId.make("environment-b") }
        : {
            scope: {
              ...source.scope,
              ...(change === "host"
                ? { host: "second.gitlab.example" }
                : { connectionId: "account-b" }),
            },
          }),
    };
    state.read.mockImplementation(
      ({ environmentId, input }: { environmentId: EnvironmentId; input: IssueTemplatesInput }) =>
        input.metadataOnly
          ? Promise.resolve(catalog)
          : environmentId === alternative.environmentId &&
              input.host === alternative.scope.host &&
              input.connectionId === alternative.scope.connectionId
            ? second.promise
            : first.promise,
    );
    await render([source, alternative]);
    await choose("Template", "Template 0");
    await choose(
      "Project",
      `${alternative.projectTitle} · ${alternative.scope.scope}${alternative.scope.connectionId ? ` · ${alternative.scope.connectionId}` : ""}`,
    );
    await choose("Template", "Template 0");
    await act(async () => first.resolve(loaded("0", { body: "Late secret for A" })));
    expect(field("body").value).toBe("");
    await attemptCreate();
    expect(state.create).not.toHaveBeenCalled();
    await act(async () => second.resolve(loaded("0", { title: "B", body: "B content" })));
    await act(async () => createButton().click());
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId: alternative.environmentId,
      input: {
        ...alternative.scope,
        title: "B",
        body: "B content",
        templateKey: "0",
        labels: [],
        assignees: [],
      },
    });
  },
);

it.each(["failure", "missing", "deferred"])(
  "blocks a %s body response, keeps blank restrictions, and retries only that read",
  async (kind) => {
    let attempts = 0;
    state.read.mockImplementation(async ({ input }: { input: IssueTemplatesInput }) => {
      if (input.metadataOnly) return catalog;
      attempts += 1;
      if (attempts > 1) return loaded("0");
      if (kind === "failure") throw new Error("Body unavailable");
      return kind === "missing" ? loaded("wrong-key") : loaded("0", { contentDeferred: true });
    });
    await render();
    await type("title", "My draft");
    await choose("Template", "Template 0");
    await attemptCreate();
    expect(state.create).not.toHaveBeenCalled();
    expect(createButton().disabled).toBe(true);
    const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    expect(document.body.textContent).toContain(
      kind === "failure" ? "Body unavailable" : "template",
    );
    await render();
    expect(state.read).toHaveBeenCalledTimes(2);
    await act(async () => retry!.click());
    expect(state.read).toHaveBeenCalledTimes(3);
    expect(state.read).toHaveBeenLastCalledWith({
      environmentId: source.environmentId,
      input: { ...source.scope, templateKey: "0" },
    });
    expect(field("body").value).toBe("Body 0");
    const options = await openSelect("Template");
    expect(options.some((option) => option.textContent === "Blank issue")).toBe(false);
  },
);

it("preserves newer text edits during a delayed read and applies the starting point only once", async () => {
  const body = deferred();
  state.read.mockImplementation(({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly ? Promise.resolve(catalog) : body.promise,
  );
  await render();
  await choose("Template", "Template 0");
  await type("title", "Typed while loading");
  await type("body", "Typed while loading");
  await type("body", "");
  await act(async () =>
    body.resolve(loaded("0", { labels: ["native-label"], assignees: ["native-user"] })),
  );
  expect(field("title").value).toBe("Typed while loading");
  expect(field("body").value).toBe("");
  await type("body", "My final body");
  await render();
  expect(field("body").value).toBe("My final body");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "Typed while loading",
      body: "My final body",
      templateKey: "0",
      labels: ["native-label"],
      assignees: ["native-user"],
    },
  });
});

it("uses older inline templates without a selected read and preserves typed text", async () => {
  state.read.mockResolvedValue(
    loaded("inline", { labels: ["native-label"], assignees: ["native-user"] }),
  );
  await render();
  await type("title", "My title");
  await type("body", "My body");
  await choose("Template", "Template inline");
  expect(field("title").value).toBe("My title");
  expect(field("body").value).toBe("My body");
  expect(state.read).toHaveBeenCalledTimes(1);
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "My title",
      body: "My body",
      templateKey: "inline",
      labels: ["native-label"],
      assignees: ["native-user"],
    },
  });
});

it("reuses the existing query retention when a deferred template is selected again", async () => {
  await render();
  await choose("Template", "Template 0");
  await choose("Template", "Template 1");
  await choose("Template", "Template 0");
  expect(state.read).toHaveBeenCalledTimes(3);
  expect(state.read.mock.calls.map(([target]) => target.input.templateKey)).toEqual([
    undefined,
    "0",
    "1",
  ]);
});

it("keeps required form fields and their edits from the loaded template", async () => {
  state.read.mockImplementation(async ({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly
      ? catalog
      : loaded("0", {
          fields: [
            {
              kind: "input",
              id: "required",
              label: "Required",
              description: null,
              required: true,
              placeholder: null,
              value: null,
            },
          ],
        }),
  );
  await render();
  await choose("Template", "Template 0");
  expect(createButton().disabled).toBe(true);
  expect(document.body.textContent).toContain("Fill in Required.");
  const input = document.querySelector<HTMLInputElement>("#issue-field-required")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "User value",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await render();
  expect(input.value).toBe("User value");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "Title 0",
      body: "### Required\n\nUser value",
      templateKey: "0",
      labels: [],
      assignees: [],
    },
  });
});

it("shows a catalog read failure and retries its existing query", async () => {
  state.read
    .mockRejectedValueOnce(new Error("Catalog unavailable"))
    .mockImplementation(async ({ input }: { input: IssueTemplatesInput }) =>
      input.metadataOnly ? catalog : loaded("0"),
    );
  await render();
  await type("title", "My draft");
  await attemptCreate();
  expect(state.create).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Catalog unavailable");
  const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Retry",
  )!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  expect(state.read).toHaveBeenCalledTimes(3);
  expect(state.read).toHaveBeenNthCalledWith(2, {
    environmentId: source.environmentId,
    input: { ...source.scope, metadataOnly: true },
  });
  expect(state.read).toHaveBeenLastCalledWith({
    environmentId: source.environmentId,
    input: { ...source.scope, templateKey: "0" },
  });
  expect(document.body.textContent).not.toContain("Catalog unavailable");
  expect(createButton().disabled).toBe(false);
  expect(field("title").value).toBe("My draft");
  expect(field("body").value).toBe("Body 0");
  expect(await openSelect("Template")).toHaveLength(100);
});

it.each(["labels", "assignees"])(
  "preserves newer %s choices while a template body loads",
  async (kind) => {
    const body = deferred();
    state.read.mockImplementation(({ input }: { input: IssueTemplatesInput }) =>
      input.metadataOnly ? Promise.resolve(catalog) : body.promise,
    );
    await render([{ ...source, labels: true, assignees: true }]);
    await choose("Template", "Template 0");
    const options = await openSelect(kind === "labels" ? "Change labels" : "Change assignees");
    const option = options.find((entry) =>
      entry.textContent?.includes(kind === "labels" ? "Manual label" : "manual-user"),
    );
    expect(option).toBeDefined();
    await act(async () => option!.click());
    await act(async () =>
      body.resolve(loaded("0", { labels: ["template-label"], assignees: ["template-user"] })),
    );
    await act(async () => createButton().click());
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: {
        ...source.scope,
        title: "Title 0",
        body: "Body 0",
        templateKey: "0",
        labels: kind === "labels" ? ["manual-label-id"] : ["template-label"],
        assignees: kind === "assignees" ? ["manual-user-id"] : ["template-user"],
      },
    });
  },
);

it.each(["deferred", "inline"])(
  "replaces untouched text after switching fully loaded %s templates",
  async (mode) => {
    if (mode === "inline")
      state.read.mockResolvedValue({
        blankIssuesEnabled: false,
        templates: [template("0"), template("1")],
      });
    await render();
    await choose("Template", "Template 0");
    expect(field("title").value).toBe("Title 0");
    expect(field("body").value).toBe("Body 0");
    await choose("Template", "Template 1");
    await act(async () => createButton().click());
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: {
        ...source.scope,
        title: "Title 1",
        body: "Body 1",
        templateKey: "1",
        labels: [],
        assignees: [],
      },
    });
    expect(state.read.mock.calls.map(([target]) => target.input.templateKey)).toEqual(
      mode === "inline" ? [undefined] : [undefined, "0", "1"],
    );
  },
);

it.each([
  { kind: "title" as const, value: "My title" },
  { kind: "title" as const, value: "" },
  { kind: "body" as const, value: "My body" },
  { kind: "body" as const, value: "" },
])(
  "keeps a manually changed $kind after switching templates (value=$value)",
  async ({ kind, value }) => {
    await render();
    await choose("Template", "Template 0");
    await type(kind, "Edited text");
    await type(kind, value);
    await choose("Template", "Template 1");
    expect(field(kind).value).toBe(value);
    expect(field(kind === "title" ? "body" : "title").value).toBe(
      kind === "title" ? "Body 1" : "Title 1",
    );
    if (kind === "title" && value === "") {
      await attemptCreate();
      expect(state.create).not.toHaveBeenCalled();
      await type("title", "Final title");
    }
    await act(async () => createButton().click());
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: {
        ...source.scope,
        title: kind === "title" ? value || "Final title" : "Title 1",
        body: kind === "body" ? value : "Body 1",
        templateKey: "1",
        labels: [],
        assignees: [],
      },
    });
    expect(state.read).toHaveBeenCalledTimes(3);
  },
);

it.each([1, 3])(
  "automatically selects the first of %s usable templates in native order",
  async (count) => {
    const templates = [
      template("z-last-alphabetically"),
      template("a-first-alphabetically"),
      template("middle"),
    ].slice(0, count);
    state.read.mockResolvedValue({ blankIssuesEnabled: true, templates });
    await render();
    expect(document.querySelector('[aria-label="Template"]')?.textContent).toBe(templates[0]!.name);
    expect(field("title").value).toBe(templates[0]!.title);
    expect(field("body").value).toBe(templates[0]!.body);
    expect(state.read).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: { ...source.scope, metadataOnly: true },
    });
    expect(state.create).not.toHaveBeenCalled();
    await act(async () => createButton().click());
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: {
        ...source.scope,
        title: templates[0]!.title,
        body: templates[0]!.body,
        templateKey: templates[0]!.key,
        labels: [],
        assignees: [],
      },
    });
  },
);

it("keeps text and extra choices made before the catalog arrives", async () => {
  const pending = deferred();
  state.read.mockReturnValue(pending.promise);
  await render([{ ...source, labels: true, assignees: true }]);
  await type("title", "My title before templates");
  await type("body", "My body before templates");
  for (const [label, text] of [
    ["Change labels", "Manual label"],
    ["Change assignees", "manual-user"],
  ]) {
    const option = (await openSelect(label!)).find((entry) => entry.textContent?.includes(text!));
    expect(option).toBeDefined();
    await act(async () => option!.click());
  }
  expect(createButton().disabled).toBe(true);
  await act(async () =>
    pending.resolve(loaded("inline", { labels: ["template-label"], assignees: ["template-user"] })),
  );
  expect(document.querySelector('[aria-label="Template"]')?.textContent).toBe("Template inline");
  expect(field("title").value).toBe("My title before templates");
  expect(field("body").value).toBe("My body before templates");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "My title before templates",
      body: "My body before templates",
      templateKey: "inline",
      labels: ["manual-label-id"],
      assignees: ["manual-user-id"],
    },
  });
});

it("loads the automatic deferred template once and preserves text changed during that read", async () => {
  const pending = deferred();
  state.read.mockImplementation(({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly ? Promise.resolve(catalog) : pending.promise,
  );
  await render();
  expect(document.querySelector('[aria-label="Template"]')?.textContent).toBe("Template 0");
  expect(state.read).toHaveBeenLastCalledWith({
    environmentId: source.environmentId,
    input: { ...source.scope, templateKey: "0" },
  });
  await type("title", "My title during template load");
  await type("body", "Typed and cleared");
  await type("body", "");
  await attemptCreate();
  expect(state.create).not.toHaveBeenCalled();
  await act(async () => pending.resolve(loaded("0")));
  await render();
  expect(field("title").value).toBe("My title during template load");
  expect(field("body").value).toBe("");
  expect(state.read).toHaveBeenCalledTimes(2);
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "My title during template load",
      body: "",
      templateKey: "0",
      labels: [],
      assignees: [],
    },
  });
});

it("keeps an explicit Blank choice through rerenders and a late template body", async () => {
  const pending = deferred();
  state.read.mockImplementation(({ input }: { input: IssueTemplatesInput }) =>
    input.metadataOnly
      ? Promise.resolve({ ...catalog, blankIssuesEnabled: true })
      : pending.promise,
  );
  await render();
  expect(document.querySelector('[aria-label="Template"]')?.textContent).toBe("Template 0");
  await choose("Template", "Blank issue");
  await type("title", "My blank issue");
  await type("body", "No template please");
  await act(async () => pending.resolve(loaded("0")));
  await render();
  expect(document.querySelector('[aria-label="Template"]')?.textContent).toBe("Blank issue");
  expect(field("title").value).toBe("My blank issue");
  expect(field("body").value).toBe("No template please");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "My blank issue",
      body: "No template please",
      labels: [],
      assignees: [],
    },
  });
});

it.each([true, false])(
  "keeps an empty external-only catalog explicit with blank allowed=%s",
  async (blankIssuesEnabled) => {
    state.read.mockResolvedValue({
      blankIssuesEnabled,
      templates: [],
      externalTemplates: [
        { name: "Native form", about: "", url: "https://gitlab.example/native-form" },
      ],
    });
    await render();
    expect(document.querySelector('[aria-label="Template"]')).toBeNull();
    expect(
      document.querySelector<HTMLAnchorElement>('a[href="https://gitlab.example/native-form"]')
        ?.textContent,
    ).toBe("Native form");
    expect(field("title").value).toBe("");
    expect(state.create).not.toHaveBeenCalled();
    await type("title", "My issue");
    expect(createButton().disabled).toBe(!blankIssuesEnabled);
    if (blankIssuesEnabled) {
      await act(async () => createButton().click());
      expect(state.create).toHaveBeenCalledExactlyOnceWith({
        environmentId: source.environmentId,
        input: { ...source.scope, title: "My issue", body: "", labels: [], assignees: [] },
      });
    } else {
      await attemptCreate();
      expect(state.create).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "This tracker requires a template, and none can be filled in here.",
      );
    }
  },
);

it("selects the new scope's default and keeps a typed draft on a same-account scope switch", async () => {
  const next = {
    ...source,
    projectTitle: "Project B",
    scope: { ...source.scope, scope: "org/second" },
  };
  state.read.mockImplementation(async ({ input }: { input: IssueTemplatesInput }) =>
    loaded("inline", { body: input.scope }),
  );
  await render([source, next]);
  expect(field("body").value).toBe(source.scope.scope);
  await type("title", "My title");
  await type("body", "My draft");
  await choose("Project", `${next.projectTitle} · ${next.scope.scope}`);
  expect(document.querySelector('[aria-label="Template"]')?.textContent).toBe("Template inline");
  expect(field("title").value).toBe("My title");
  expect(field("body").value).toBe("My draft");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: next.environmentId,
    input: {
      ...next.scope,
      title: "My title",
      body: "My draft",
      templateKey: "inline",
      labels: [],
      assignees: [],
    },
  });
});

it("blocks a selected template that disappears from a refreshed catalog", async () => {
  state.read.mockResolvedValue({
    blankIssuesEnabled: true,
    templates: [template("0"), template("1")],
  });
  await render();
  await choose("Template", "Template 1");
  state.read.mockResolvedValue(loaded("0"));
  await act(async () =>
    registry.refresh(
      issueEnvironment.templates({
        environmentId: source.environmentId,
        input: { ...source.scope, metadataOnly: true },
      }),
    ),
  );
  await render();
  expect(field("title").value).toBe("Title 1");
  expect(field("body").value).toBe("Body 1");
  expect(document.body.textContent).toContain(
    "The selected template is no longer available. Choose a template.",
  );
  expect(createButton().disabled).toBe(true);
  await attemptCreate();
  expect(state.create).not.toHaveBeenCalled();
  await choose("Template", "Template 0");
  expect(field("title").value).toBe("Title 0");
  expect(field("body").value).toBe("Body 0");
  expect(createButton().disabled).toBe(false);
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "Title 0",
      body: "Body 0",
      templateKey: "0",
      labels: [],
      assignees: [],
    },
  });
});

it("keeps a typed description when the automatic template has form fields", async () => {
  const pending = deferred();
  state.read.mockReturnValue(pending.promise);
  await render();
  await type("title", "My title");
  await type("body", "Keep this draft");
  await act(async () =>
    pending.resolve(
      loaded("form", {
        fields: [
          {
            kind: "input",
            id: "details",
            label: "Details",
            description: null,
            required: true,
            placeholder: null,
            value: "Native default",
          },
        ],
      }),
    ),
  );
  expect(field("body")?.value).toBe("Keep this draft");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "My title",
      body: "Keep this draft\n\n### Details\n\nNative default",
      templateKey: "form",
      labels: [],
      assignees: [],
    },
  });
});

it("keeps native keyboard typeahead for explicit template choices", async () => {
  state.read.mockResolvedValue({
    blankIssuesEnabled: true,
    templates: [template("0", { name: "Bug" }), template("1", { name: "Task" })],
  });
  await render();
  expect(document.querySelector('[aria-label="Template"]')?.textContent).toBe("Bug");
  await act(async () =>
    document
      .querySelector('[aria-label="Template"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true })),
  );
  expect(document.querySelector('[aria-label="Template"]')?.textContent).toBe("Task");
  expect(field("title").value).toBe("Title 1");
  expect(field("body").value).toBe("Body 1");
  await act(async () => createButton().click());
  expect(state.create).toHaveBeenCalledExactlyOnceWith({
    environmentId: source.environmentId,
    input: {
      ...source.scope,
      title: "Title 1",
      body: "Body 1",
      templateKey: "1",
      labels: [],
      assignees: [],
    },
  });
});

it.each([false, true])(
  "keeps explicit Blank recovery and the full draft after the sole template disappears (retry and reopen=%s)",
  async (retryAndReopen) => {
    const writable = { ...source, labels: true, assignees: true };
    state.read.mockResolvedValue({ blankIssuesEnabled: true, templates: [template("0")] });
    await render([writable]);
    expect(document.querySelector('[aria-label="Template"]')?.textContent).toBe("Template 0");
    await type("title", "Keep title after removal");
    await type("body", "Keep body after removal");
    for (const [label, text] of [
      ["Change labels", "Manual label"],
      ["Change assignees", "manual-user"],
    ] as const) {
      const option = (await openSelect(label)).find((entry) => entry.textContent?.includes(text));
      expect(option).toBeDefined();
      await act(async () => option!.click());
    }
    state.read.mockResolvedValue({ blankIssuesEnabled: true, templates: [] });
    await act(async () =>
      registry.refresh(
        issueEnvironment.templates({
          environmentId: source.environmentId,
          input: { ...source.scope, metadataOnly: true },
        }),
      ),
    );
    await render([writable]);
    if (retryAndReopen) {
      const retry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === "Retry",
      );
      expect(retry).toBeDefined();
      await act(async () => retry!.click());
      expect(state.read).toHaveBeenCalledTimes(3);
      await render([writable], false);
      await render([writable], true);
    }
    expect(field("title").value).toBe("Keep title after removal");
    expect(field("body").value).toBe("Keep body after removal");
    expect(document.body.textContent).toContain("Labels: Manual label");
    expect(document.body.textContent).toContain("Assignees: manual-user-id");
    expect(document.body.textContent).toContain(
      "The selected template is no longer available. Choose a template.",
    );
    expect(createButton().disabled).toBe(true);
    await attemptCreate();
    expect(state.create).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Template"]')).not.toBeNull();
    await choose("Template", "Blank issue");
    expect(document.body.textContent).not.toContain(
      "The selected template is no longer available.",
    );
    expect(field("title").value).toBe("Keep title after removal");
    expect(field("body").value).toBe("Keep body after removal");
    expect(document.body.textContent).toContain("Labels: Manual label");
    expect(document.body.textContent).toContain("Assignees: manual-user-id");
    expect(createButton().disabled).toBe(false);
    expect(state.create).not.toHaveBeenCalled();
    await act(async () => createButton().click());
    expect(state.create).toHaveBeenCalledExactlyOnceWith({
      environmentId: source.environmentId,
      input: {
        ...source.scope,
        title: "Keep title after removal",
        body: "Keep body after removal",
        labels: ["manual-label-id"],
        assignees: ["manual-user-id"],
      },
    });
  },
);
