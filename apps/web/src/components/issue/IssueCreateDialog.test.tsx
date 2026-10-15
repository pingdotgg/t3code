import { EnvironmentId, IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  create: vi.fn(),
  reads: new Set<string>(),
  reply: (_input: Record<string, unknown>): unknown => null,
  refresh: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("~/state/issues", () => ({
  issueEnvironment: {
    create: { permissionAtom: () => null },
    templates: (target: { input: Record<string, unknown> }) => target.input,
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (input: Record<string, unknown> | null) => {
    if (input !== null) state.reads.add(JSON.stringify(input));
    const reply = input === null ? null : state.reply(input);
    return {
      data: reply instanceof Error || reply === "pending" ? null : reply,
      isPending: reply === "pending",
      isSuccess: reply !== null && !(reply instanceof Error) && reply !== "pending",
      error: reply instanceof Error ? reply.message : null,
      refresh: state.refresh,
    };
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.create }));
vi.mock("../ui/dialog", () => ({
  Dialog: "div",
  DialogDescription: "div",
  DialogFooter: "div",
  DialogHeader: "div",
  DialogPanel: "div",
  DialogPopup: "div",
  DialogTitle: "div",
}));
vi.mock("../ui/button", () => ({ Button: "button", InlineButton: "a" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/label", () => ({ Label: "label" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "option",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { IssueCreateDialog, type IssueCreateScope } from "./IssueCreateDialog";

const scope = (projectId: string): IssueCreateScope => ({
  environmentId: EnvironmentId.make("env"),
  projectTitle: projectId,
  templates: false,
  scope: {
    projectId: ProjectId.make(projectId),
    tracker: IssueTrackerKind.make("github"),
    host: "github.com",
    scope: "acme/web",
  },
});
const [a, b, c] = [scope("a"), scope("b"), scope("c")];
let renderer: ReactTestRenderer;

const render = (scopes: ReadonlyArray<IssueCreateScope>) =>
  act(async () => {
    const dialog = (
      <IssueCreateDialog open scopes={scopes} onOpenChange={vi.fn()} onCreated={vi.fn()} />
    );
    if (renderer === undefined) renderer = create(dialog);
    else renderer.update(dialog);
  });
const choose = (project: IssueCreateScope) =>
  act(async () => {
    const item = renderer.root
      .findAllByType("option")
      .find((option) => option.props.children[0] === project.projectTitle)!;
    renderer.root
      .findByProps({ id: "issue-create-scope" })
      .parent!.props.onValueChange(item.props.value);
  });
const createButton = () =>
  renderer.root.findAllByType("button").find((button) => button.props.children === "Create issue")!;
const submit = () => act(async () => createButton().props.onClick());

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.create.mockResolvedValue({ _tag: "Success", value: { displayKey: "#1" } });
  state.reads.clear();
  state.reply = () => null;
  renderer = undefined!;
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});

it("keeps the chosen project when the list reorders", async () => {
  await render([a, b]);
  await choose(b);
  await act(async () => {
    renderer.root.findByProps({ id: "issue-create-title" }).props.onChange({
      target: { value: "Bug" },
    });
  });
  await render([b, a]);
  await submit();
  expect(state.create.mock.calls[0]?.[0].input.projectId).toBe("b");
});

it("holds the draft without a destination until a removed project is replaced by choice", async () => {
  await render([a, b]);
  await act(async () => {
    renderer.root.findByProps({ id: "issue-create-title" }).props.onChange({
      target: { value: "Draft" },
    });
  });
  await render([b, c]);
  expect(createButton().props.disabled).toBe(true);
  await submit();
  expect(state.create).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ id: "issue-create-title" }).props.value).toBe("Draft");
  await render([c]);
  expect(createButton().props.disabled).toBe(true);
  await choose(c);
  expect(createButton().props.disabled).toBe(false);
  await submit();
  expect(state.create).toHaveBeenCalledOnce();
  expect(state.create.mock.calls[0]?.[0].input).toMatchObject({ projectId: "c", title: "Draft" });
});

const template = (key: string, body: string, contentDeferred?: true) => ({
  key,
  name: key,
  about: "",
  title: `${key} title`,
  body,
  labels: [`${key}-label`],
  assignees: [],
  ...(contentDeferred ? { contentDeferred } : {}),
});
const catalog = (...templates: ReadonlyArray<ReturnType<typeof template>>) => ({
  templates,
  blankIssuesEnabled: true,
});
const lazy = { ...a, templates: true };
const lazyB = { ...b, templates: true };
const field = (id: string) => renderer.root.findByProps({ id });
const type = (id: string, value: string) =>
  act(async () => field(id).props.onChange({ target: { value } }));
const pick = (key: string) =>
  act(async () => field("issue-create-template").parent!.props.onValueChange(key));
const blockedText = () =>
  renderer.root.findAllByType("p").map((node) => node.props.children as unknown);

it("reads the catalog once, then only the chosen deferred body", async () => {
  const hundred = Array.from({ length: 100 }, (_, index) => template(`t${index + 1}`, "", true));
  state.reply = (input) =>
    input.metadataOnly
      ? catalog(...hundred)
      : catalog(template(String(input.templateKey), "Steps for t100"));
  await render([lazy]);
  await pick("t100");
  await submit();
  expect([...state.reads].map((read) => JSON.parse(read))).toEqual([
    { ...lazy.scope, metadataOnly: true },
    { ...lazy.scope, templateKey: "t100" },
  ]);
  expect(state.create.mock.calls[0]?.[0].input).toMatchObject({
    title: "t100 title",
    body: "Steps for t100",
    labels: ["t100-label"],
  });
});

it("fills from an inline catalog without a second read", async () => {
  state.reply = (input) => (input.metadataOnly ? catalog(template("Bug", "")) : "pending");
  await render([lazy]);
  await pick("Bug");
  expect(state.reads.size).toBe(1);
  expect(field("issue-create-title").props.value).toBe("Bug title");
  expect(createButton().props.disabled).toBe(false);
});

it("blocks create while the chosen body loads or fails, and retries the body read", async () => {
  let body: unknown = "pending";
  state.reply = (input) => (input.metadataOnly ? catalog(template("Bug", "", true)) : body);
  await render([lazy]);
  await pick("Bug");
  expect(createButton().props.disabled).toBe(true);
  expect(blockedText()).toContain("Loading template…");
  body = new Error("Not found");
  await render([lazy]);
  expect(createButton().props.disabled).toBe(true);
  expect(blockedText()).toContain("The template could not be read: Not found");
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Retry")!
      .props.onClick(),
  );
  expect(state.refresh).toHaveBeenCalledOnce();
  body = catalog(template("Bug", "Steps"));
  await render([lazy]);
  expect(field("issue-create-body").props.value).toBe("Steps");
  expect(createButton().props.disabled).toBe(false);
});

it("keeps what the writer typed or cleared while the body loads", async () => {
  let body: unknown = "pending";
  state.reply = (input) => (input.metadataOnly ? catalog(template("Bug", "", true)) : body);
  await render([lazy]);
  await pick("Bug");
  await type("issue-create-title", "Mine");
  await type("issue-create-title", "");
  await type("issue-create-body", "My notes");
  body = catalog(template("Bug", "Steps"));
  await render([lazy]);
  expect(field("issue-create-title").props.value).toBe("");
  expect(field("issue-create-body").props.value).toBe("My notes");
});

it("ignores a body that arrives after the template or project changed", async () => {
  const bodies: Record<string, unknown> = { A: "pending", B: "pending" };
  state.reply = (input) =>
    input.metadataOnly
      ? catalog(template("A", "", true), template("B", "", true))
      : input.projectId === "a"
        ? bodies[String(input.templateKey)]
        : "pending";
  await render([lazy, lazyB]);
  await pick("A");
  await pick("B");
  bodies.A = catalog(template("A", "A steps"));
  await render([lazy, lazyB]);
  expect(field("issue-create-body").props.value).toBe("");
  await choose(lazyB);
  bodies.B = catalog(template("B", "B steps"));
  await render([lazy, lazyB]);
  expect(field("issue-create-body").props.value).toBe("");
});

it.each([false, true])(
  "swaps untouched template text from A to B (deferred: %s)",
  async (lazyBody) => {
    const deferred = lazyBody ? (true as const) : undefined;
    state.reply = (input) =>
      input.metadataOnly
        ? catalog(
            template("A", lazyBody ? "" : "A steps", deferred),
            template("B", lazyBody ? "" : "B steps", deferred),
          )
        : catalog(template(String(input.templateKey), `${String(input.templateKey)} steps`));
    await render([lazy]);
    await pick("A");
    expect(field("issue-create-body").props.value).toBe("A steps");
    await pick("B");
    expect(field("issue-create-title").props.value).toBe("B title");
    expect(field("issue-create-body").props.value).toBe("B steps");
    await type("issue-create-title", "Mine");
    await type("issue-create-body", "");
    await pick("A");
    expect(field("issue-create-title").props.value).toBe("Mine");
    expect(field("issue-create-body").props.value).toBe("");
  },
);

it("keeps a typed draft when the project changes, then the next template", async () => {
  state.reply = (input) => (input.metadataOnly ? catalog(template("A", "A steps")) : "pending");
  await render([lazy, lazyB]);
  await type("issue-create-title", "Mine");
  await choose(lazyB);
  await pick("A");
  expect(field("issue-create-title").props.value).toBe("Mine");
  expect(field("issue-create-body").props.value).toBe("A steps");
});

it("keeps one choice per tracker of a project bound to two, across a reorder", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const linear = {
    ...a,
    scope: {
      ...a.scope,
      tracker: IssueTrackerKind.make("linear"),
      host: "linear.app",
      scope: "ENG",
    },
  };
  await render([a, linear]);
  await render([linear, a]);
  const options = renderer.root
    .findAllByType("option")
    .map((option) => [option.props.value, option.props.children[2]]);
  expect(options).toEqual([
    ["0", "ENG"],
    ["1", "acme/web"],
  ]);
  await act(async () =>
    renderer.root.findByProps({ id: "issue-create-scope" }).parent!.props.onValueChange("0"),
  );
  await type("issue-create-title", "Bug");
  await submit();
  expect(state.create.mock.calls[0]?.[0].input).toMatchObject({
    projectId: "a",
    tracker: "linear",
  });
  expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
  error.mockRestore();
});
