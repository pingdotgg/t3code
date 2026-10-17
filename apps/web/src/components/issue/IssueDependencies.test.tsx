// @vitest-environment jsdom

import {
  EnvironmentId,
  IssueOperationError,
  IssueTrackerKind,
  ProjectId,
  type IssueDetail,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  permission: true,
  write: vi.fn<(value: unknown) => Promise<unknown>>(),
  refresh: vi.fn(),
}));
vi.mock("~/state/issues", async () => {
  const { Atom } = await import("effect/reactivity");
  const granted = Atom.make(true);
  const denied = Atom.make(false);
  return {
    issueEnvironment: {
      setDependency: { permissionAtom: () => (state.permission ? granted : denied) },
    },
    useIssueDependencies: () => ({
      items: [
        {
          scope: "native/repo",
          key: "2",
          displayKey: "#2",
          title: "Native dependency",
          kind: "issue",
          url: "https://native.example/issues/2",
          state: { category: "open", name: "open" },
        },
      ],
      error: null,
      isPending: false,
      truncated: false,
      hasMore: false,
      loadMore: () => {},
      refresh: state.refresh,
    }),
  };
});
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.write }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { IssueDependencies } from "./IssueDependencies";

const environmentId = EnvironmentId.make("environment");
const reference = {
  projectId: ProjectId.make("project"),
  tracker: IssueTrackerKind.make("github"),
  host: "github.com",
  scope: "org/repo",
  key: "1",
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.permission = true;
  state.write.mockReset();
  state.refresh.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (viewerPermissions: Partial<IssueDetail["viewerPermissions"]>, writable = true) =>
  act(async () =>
    root.render(
      <IssueDependencies
        environmentId={environmentId}
        reference={reference}
        detail={
          {
            writable,
            viewerPermissions,
            capabilities: { dependencies: true },
          } as unknown as IssueDetail
        }
        onSelectIssue={() => {}}
      />,
    ),
  );
const blocks = () => container.querySelector('[aria-label="Blocks"]')!;
const sectionButton = (label: string) =>
  [...blocks().querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  );
const remove = () =>
  blocks().querySelector<HTMLButtonElement>('[aria-label="Remove dependency #2"]');
const dialogButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (node) => node.textContent === label,
  )!;
const key = () => document.querySelector<HTMLInputElement>("#dependency-key-blocks")!;
const openAndType = async () => {
  await act(async () => sectionButton("Add dependency")!.click());
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(key(), "7");
    key().dispatchEvent(new Event("input", { bubbles: true }));
  });
};

it.each([
  ["updateDependencies grants without edit", { edit: false, updateDependencies: true }],
  ["absent updateDependencies falls back to edit", { edit: true }],
])("adds and removes dependencies when %s", async (_name, permissions) => {
  state.write.mockResolvedValue(AsyncResult.success(undefined));
  await render(permissions);
  await openAndType();
  await act(async () => dialogButton("Add dependency").click());
  await act(async () => remove()!.click());
  expect(state.write.mock.calls).toEqual([
    [
      {
        environmentId,
        input: {
          ...reference,
          direction: "blocks",
          targetScope: "org/repo",
          targetKey: "7",
          linked: true,
        },
      },
    ],
    [
      {
        environmentId,
        input: {
          ...reference,
          direction: "blocks",
          targetScope: "native/repo",
          targetKey: "2",
          linked: false,
        },
      },
    ],
  ]);
  expect(state.refresh).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it.each([
  [
    "explicit updateDependencies false overrides edit",
    { edit: true, updateDependencies: false },
    true,
    true,
  ],
  ["absent updateDependencies with edit false", { edit: false }, true, true],
  ["read-only issue", { edit: true, updateDependencies: true }, false, true],
  ["environment denies the command", { edit: true, updateDependencies: true }, true, false],
])("hides dependency writes for %s", async (_name, permissions, writable, env) => {
  state.permission = env;
  await render(permissions, writable);
  expect(blocks().textContent).toContain("Native dependency");
  expect(sectionButton("Add dependency")).toBeUndefined();
  expect(remove()).toBeNull();
  expect(state.write).not.toHaveBeenCalled();
});

it("blocks duplicate writes while pending and keeps the dialog after a native failure", async () => {
  let settle!: (result: unknown) => void;
  state.write.mockReturnValue(new Promise((resolve) => (settle = resolve)));
  await render({ edit: false, updateDependencies: true });
  await openAndType();
  await act(async () => dialogButton("Add dependency").click());
  expect(dialogButton("Saving…").disabled).toBe(true);
  expect(remove()!.disabled).toBe(true);
  await act(async () => dialogButton("Saving…").click());
  expect(state.write).toHaveBeenCalledTimes(1);
  await act(async () =>
    settle(
      AsyncResult.failure(
        Cause.fail(new IssueOperationError({ operation: "setDependency", detail: "Refused" })),
      ),
    ),
  );
  expect(key().value).toBe("7");
  expect(key().disabled).toBe(false);
  expect(dialogButton("Add dependency").disabled).toBe(false);
  expect(remove()!.disabled).toBe(false);
  expect(state.refresh).not.toHaveBeenCalled();
});
