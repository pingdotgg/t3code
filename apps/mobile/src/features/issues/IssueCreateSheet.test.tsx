// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueTemplate,
  type IssueTemplatesInput,
} from "@t3tools/contracts";

type Props = Record<string, unknown> & { readonly children?: ReactNode };

const harness = vi.hoisted(() => {
  const controls = new Map<string, Record<string, unknown>>();
  const template = (key: string) => ({
    key,
    name: key,
    about: "",
    title: `${key} title`,
    body: `${key} body`,
    labels: [`${key}-label`],
    assignees: [],
  });
  return {
    template,
    catalog: [
      template("A"),
      { ...template("B"), title: "", body: "", labels: [], contentDeferred: true },
    ],
    bodies: new Map<string, IssueTemplate>(),
    controls,
    created: [] as unknown[],
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
  useAtomValue: () => true,
}));
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Platform: { OS: "ios" },
  Pressable: ({ children }: Props) => children,
  View: ({ children }: Props) => children,
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: Props) => children,
  AppTextInput: harness.capture("accessibilityLabel"),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/MaterialButton", () => ({ MaterialButton: harness.capture("label") }));
vi.mock("../workspace/ListFilterMenu", () => ({
  ListFilterMenu: harness.capture("accessibilityLabel"),
}));
vi.mock("../pull-requests/PullRequestSheetContent", () => ({
  PullRequestSheetContent: ({ children, footer }: Props & { footer: ReactNode }) => (
    <>
      {footer}
      {children}
    </>
  ),
}));
vi.mock("./useOpenIssue", () => ({ useOpenIssue: () => () => {} }));
vi.mock("./issueList", () => ({ markIssueWritten: () => {} }));
vi.mock("../../state/issues", () => ({
  issueEnvironment: {
    templates: (target: unknown) => target,
    create: { permissionAtom: () => null },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: unknown) => {
    harness.created.push(input);
    return { _tag: "Success", value: { key: "1", displayKey: "#1" } };
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (target: { input: IssueTemplatesInput } | null) => {
    const body = target?.input.templateKey && harness.bodies.get(target.input.templateKey);
    const data = target?.input.metadataOnly
      ? { templates: harness.catalog, blankIssuesEnabled: true }
      : body
        ? { templates: [body], blankIssuesEnabled: true }
        : null;
    return { data, error: null, isPending: target !== null && data === null, refresh: () => {} };
  },
}));

import { IssueCreateSheet } from "./IssueCreateSheet";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
const scopes = [
  {
    environmentId: EnvironmentId.make("environment"),
    projectTitle: "Project",
    templates: true,
    scope: {
      projectId: ProjectId.make("project"),
      tracker: IssueTrackerKind.make("gitlab"),
      host: "gitlab.example",
      scope: "group/app",
    },
  },
];
const render = () => act(() => root.render(<IssueCreateSheet route={{ params: { scopes } }} />));
const control = (key: string) => harness.controls.get(key)!;
const value = (key: string) => control(key).value;
const choose = (key: string) =>
  act(() =>
    (control("Template").onSelect as (id: string) => void)(JSON.stringify(["template", key])),
  );
const type = (key: string, text: string) =>
  act(() => (control(key).onChangeText as (text: string) => void)(text));

beforeEach(() => {
  root = createRoot(document.createElement("div"));
  harness.bodies.clear();
  harness.created.length = 0;
});

describe("IssueCreateSheet templates", () => {
  it("replaces an untouched template's text with the next one, but keeps typed and cleared text", async () => {
    await render();
    await choose("A");
    expect([value("Title"), value("Description")]).toEqual(["A title", "A body"]);

    await choose("B");
    expect(control("Create issue").disabled).toBe(true);
    expect(value("Title")).toBe("A title");
    harness.bodies.set("B", harness.template("B"));
    await render();
    expect([value("Title"), value("Description")]).toEqual(["B title", "B body"]);

    await type("Title", "Mine");
    await type("Description", "");
    await choose("A");
    expect([value("Title"), value("Description")]).toEqual(["Mine", ""]);

    await act(() => (control("Create issue").onPress as () => void)());
    expect(harness.created).toMatchObject([
      { input: { title: "Mine", body: "", labels: ["A-label"] } },
    ]);
  });

  it("keeps text typed while a chosen template's body is still loading", async () => {
    await render();
    await choose("B");
    await type("Title", "Typed first");
    harness.bodies.set("B", harness.template("B"));
    await render();
    expect([value("Title"), value("Description")]).toEqual(["Typed first", "B body"]);
  });
});
