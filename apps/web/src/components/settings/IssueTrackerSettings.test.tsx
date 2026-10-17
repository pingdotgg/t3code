// @vitest-environment jsdom

import {
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  type IssueTrackerConnection,
  type IssueTrackerConnectionList,
  type IssueTrackerScopePage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  data: null as IssueTrackerConnectionList | null,
  canConnect: true,
  canBind: true,
  permissionListeners: new Set<() => void>(),
  connect: vi.fn(),
  bind: vi.fn(),
  scopes: vi.fn(),
}));

vi.mock("@effect/atom-react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAtomValue: (permission: string) =>
      useSyncExternalStore(
        (listener) => {
          state.permissionListeners.add(listener);
          return () => {
            state.permissionListeners.delete(listener);
          };
        },
        () => (permission === "connect" ? state.canConnect : state.canBind),
      ),
  };
});
vi.mock("../../state/issueTrackers", () => ({
  issueTrackerEnvironment: {
    connections: () => null,
    connect: { permissionAtom: () => "connect" },
    bindProject: { permissionAtom: () => "bind" },
    scopes: () => null,
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.data, isPending: false, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { permissionAtom: () => string }) =>
    command.permissionAtom() === "connect" ? state.connect : state.bind,
}));
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.scopes }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "project", title: "Project", environmentId: "local" },
    { id: "second", title: "Second project", environmentId: "local" },
    { id: "project", title: "Project", environmentId: "remote" },
  ],
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
}));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({ id: "issue-trackers" }) }));
vi.mock("../Icons", () => ({ LinearIcon: () => null }));

import { IssueTrackerSettings } from "./IssueTrackerSettings";

const local = EnvironmentId.make("local");
const project = ProjectId.make("project");
const linear = IssueTrackerKind.make("linear");
const jira = IssueTrackerKind.make("jira");
const success = { _tag: "Success", value: undefined };
const failure = (message: string) => ({ _tag: "Failure", cause: Cause.fail(new Error(message)) });
const account = (
  connectionId?: string,
  overrides: Partial<IssueTrackerConnection> = {},
): IssueTrackerConnection => ({
  tracker: linear,
  displayName: "Linear",
  host: "linear.app",
  scopeNoun: "team",
  credential: { label: "API key", helpUrl: null },
  connected: true,
  account: "Same name",
  detail: null,
  scopes: [{ key: "ENG", name: "Engineering" }],
  ...(connectionId === undefined ? {} : { connectionId }),
  ...overrides,
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  state.canConnect = true;
  state.canBind = true;
  state.connect.mockReset().mockResolvedValue(success);
  state.bind.mockReset().mockResolvedValue(success);
  state.scopes
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { items: [], nextCursor: null } });
  state.data = {
    trackers: [account(undefined, { connected: false, account: null, scopes: [] })],
    accounts: [],
    projectBindings: {},
    bindings: {},
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function render(environmentId = local) {
  await act(async () => {
    state.permissionListeners.forEach((listener) => listener());
    root.render(<IssueTrackerSettings environmentId={environmentId} />);
  });
}
function button(text: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === text,
  );
  expect(found, `button ${text}`).toBeDefined();
  return found!;
}
function input(label: string) {
  const found =
    container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`) ??
    [...container.querySelectorAll("label")]
      .filter((item) => item.textContent === label)
      .map((item) => document.getElementById(item.htmlFor))[0];
  expect(found, `input ${label}`).toBeInstanceOf(HTMLInputElement);
  return found as HTMLInputElement;
}
async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersToNextFrame();
  });
}
async function choose(label: string, text: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    `[role="combobox"][aria-label="${label}"]`,
  );
  expect(trigger, label).not.toBeNull();
  await click(trigger!);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes(text),
  );
  expect(option, text).toBeDefined();
  await click(option!);
}
function connected(...accounts: IssueTrackerConnection[]) {
  state.data = {
    trackers: [account(undefined, { connected: false, account: null, scopes: [] })],
    accounts,
    projectBindings: {},
    bindings: {},
  };
}

function loadMore(label = "Linear teams", projectTitle = "Project") {
  const found = container.querySelector<HTMLButtonElement>(
    `button[aria-label="Load more ${label} for ${projectTitle}"]`,
  );
  expect(found).not.toBeNull();
  return found!;
}

async function options(label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(
    `[role="combobox"][aria-label="${label}"]`,
  )!;
  await click(trigger);
  const values = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map(
    (item) => item.textContent,
  );
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  return values;
}

describe("issue tracker scope pages", () => {
  it.each(["linear", "jira"] as const)(
    "loads bounded %s pages for one account and shares scopes across project pickers",
    async (kind) => {
      const tracker = IssueTrackerKind.make(kind);
      const displayName = kind === "linear" ? "Linear" : "Jira";
      const noun = kind === "linear" ? "team" : "project";
      connected(
        account("B", {
          tracker,
          displayName,
          scopeNoun: noun,
          scopesCursor: "page-2",
          scopesTruncated: true,
        }),
      );
      state.data = { ...state.data!, trackers: [state.data!.accounts![0]!] };
      state.scopes.mockResolvedValueOnce({
        _tag: "Success",
        value: {
          items: [
            { key: "ENG", name: "Engineering" },
            { key: "OPS", name: "Operations" },
          ],
          nextCursor: "page-3",
        },
      });
      state.scopes.mockResolvedValueOnce({
        _tag: "Success",
        value: { items: [{ key: "FIN", name: "Finance" }], nextCursor: null },
      });
      await render();
      await click(loadMore(`${displayName} ${noun}s`));
      expect(state.scopes).toHaveBeenLastCalledWith({
        environmentId: local,
        input: { tracker, connectionId: "B", cursor: "page-2", limit: 100 },
      });
      expect(await options(`${displayName} ${noun} for Second project`)).toEqual([
        "Not bound",
        "Engineering (ENG)",
        "Operations (OPS)",
      ]);
      await click(loadMore(`${displayName} ${noun}s`, "Second project"));
      expect(state.scopes).toHaveBeenLastCalledWith({
        environmentId: local,
        input: { tracker, connectionId: "B", cursor: "page-3", limit: 100 },
      });
      expect(state.scopes).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector(
          `button[aria-label="Load more ${displayName} ${noun}s for Project"]`,
        ),
      ).toBeNull();
      await choose(`${displayName} ${noun} for Project`, "Finance");
      expect(state.bind).toHaveBeenLastCalledWith({
        environmentId: local,
        input: {
          projectId: project,
          binding: { value: { tracker, connectionId: "B", scope: "FIN" } },
        },
      });
    },
  );

  it("keeps loaded scopes, the next cursor, and manual keys after a failed page and retries that page", async () => {
    connected(account("B", { scopesCursor: "page-2", scopesTruncated: true }));
    state.scopes.mockResolvedValueOnce({
      _tag: "Success",
      value: { items: [{ key: "OPS", name: "Operations" }], nextCursor: "page-3" },
    });
    state.scopes.mockResolvedValueOnce(failure("Page could not be loaded"));
    await render();
    await type(input("Linear team key for Project"), "MANUAL");
    await click(loadMore());
    await click(loadMore());
    expect(container.textContent).toContain("Page could not be loaded");
    expect(input("Linear team key for Project").value).toBe("MANUAL");
    expect(await options("Linear team for Project")).toContain("Operations (OPS)");
    await click(loadMore());
    expect(state.scopes).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, connectionId: "B", cursor: "page-3", limit: 100 },
    });
    expect(state.scopes).toHaveBeenCalledTimes(3);
    expect(input("Linear team key for Project").value).toBe("MANUAL");
    expect(await options("Linear team for Project")).toContain("Operations (OPS)");
  });

  it("keeps pending pages and scopes on their account when the picker switches", async () => {
    connected(account("A", { scopesCursor: "A-2" }), account("B", { scopesCursor: "B-2" }));
    let resolve!: (page: { _tag: "Success"; value: IssueTrackerScopePage }) => void;
    state.scopes.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    await click(loadMore());
    expect(loadMore().disabled).toBe(true);
    await click(loadMore());
    expect(state.scopes).toHaveBeenCalledOnce();
    await choose("Linear account for Project", "linear.app · B");
    await click(loadMore());
    expect(state.scopes).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, connectionId: "B", cursor: "B-2", limit: 100 },
    });
    await act(async () => {
      resolve({
        _tag: "Success",
        value: { items: [{ key: "A-ONLY", name: "A only" }], nextCursor: null },
      });
    });
    expect(await options("Linear team for Project")).not.toContain("A only (A-ONLY)");
    await choose("Linear account for Project", "linear.app · A");
    expect(await options("Linear team for Project")).toContain("A only (A-ONLY)");
  });

  it.each(["refresh", "remove", "environment", "replace"] as const)(
    "ignores a late scope result after %s without moving account B's draft",
    async (change) => {
      const a = account("A", { scopesCursor: "A-2", scopesTruncated: true });
      const b = account("B", { scopesCursor: "B-2", scopesTruncated: true });
      connected(a, b);
      let resolve!: (page: { _tag: "Success"; value: IssueTrackerScopePage }) => void;
      state.scopes.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await render();
      await choose("Linear account", "linear.app · B");
      await choose("Linear account for Project", "linear.app · B");
      await type(input("Linear team key for Project"), "B-MANUAL");
      await click(loadMore());
      if (change === "replace") {
        await type(input("API key"), "fake-new-B-token");
        await click(button("Replace"));
      } else if (change === "environment") await render(EnvironmentId.make("remote"));
      else {
        connected(...(change === "remove" ? [a] : [a, b]));
        await render();
      }
      if (change === "refresh" || change === "replace") {
        expect(loadMore().disabled).toBe(true);
        await click(loadMore());
        expect(state.scopes).toHaveBeenCalledOnce();
      }
      await act(async () => {
        resolve({
          _tag: "Success",
          value: { items: [{ key: "STALE", name: "Stale scope" }], nextCursor: null },
        });
      });
      if (change === "remove") {
        expect(container.querySelector('[aria-label="Linear account"]')?.textContent).toContain(
          "Account unavailable",
        );
        connected(a, b);
        await render();
      }
      expect(await options("Linear team for Project")).not.toContain("Stale scope (STALE)");
      expect(input("Linear team key for Project").value).toBe(
        change === "environment" ? "" : "B-MANUAL",
      );
      expect(state.scopes).toHaveBeenCalledOnce();
      expect(state.bind).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null])(
    "keeps manual keys without paging when the initial cursor is %s",
    async (scopesCursor) => {
      connected(account("B", { scopesTruncated: true, scopesCursor }));
      await render();
      expect(container.textContent).not.toContain("Load more");
      await type(input("Linear team key for Project"), "MANUAL");
      await click(button("Bind"));
      expect(state.scopes).not.toHaveBeenCalled();
      expect(state.bind).toHaveBeenLastCalledWith({
        environmentId: local,
        input: {
          projectId: project,
          binding: { value: { tracker: linear, connectionId: "B", scope: "MANUAL" } },
        },
      });
    },
  );

  it("keeps the default account selector absent on the read request and reports read denial without any write", async () => {
    connected(account(undefined, { scopesTruncated: true, scopesCursor: "default-2" }));
    state.canConnect = false;
    state.canBind = false;
    state.scopes.mockResolvedValueOnce(failure("This connection requires orchestration:read."));
    await render();
    await click(loadMore());
    expect(state.scopes).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, cursor: "default-2", limit: 100 },
    });
    expect(container.textContent).toContain("requires orchestration:read");
    expect(state.bind).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
  });
});

describe("issue tracker accounts", () => {
  it.each([true, false])(
    "keeps a removed selected account unavailable when another account remains: %s",
    async (retainA) => {
      connected(account("A"), account("B"));
      await render();
      expect(container.querySelector('[aria-label="Linear account"]')?.textContent).toContain("A");
      await choose("Linear account", "B");
      await type(input("API key"), "draft-B");
      connected(...(retainA ? [account("A")] : []));
      await render();
      if (retainA) {
        await click(button("Disconnect"));
        expect(state.connect).not.toHaveBeenCalled();
      }
      expect(container.querySelector('[aria-label="Linear account"]')?.textContent).toContain(
        "Account unavailable",
      );
      expect(input("API key").value).toBe("draft-B");
      expect(input("API key").closest("fieldset")?.disabled).toBe(true);
      expect(button("Replace").disabled).toBe(true);
      expect(button("Disconnect").disabled).toBe(true);
      await click(button("Replace"));
      await click(button("Disconnect"));
      await act(async () => {
        container
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(state.connect).not.toHaveBeenCalled();
      if (retainA) {
        await choose("Linear account", "linear.app · A");
        expect(input("API key").value).toBe("");
        await type(input("API key"), "rotated-A");
        await click(button("Replace"));
        expect(state.connect).toHaveBeenLastCalledWith({
          environmentId: local,
          input: { tracker: linear, connectionId: "A", token: { value: "rotated-A" } },
        });
        await click(button("Disconnect"));
        expect(state.connect).toHaveBeenLastCalledWith({
          environmentId: local,
          input: { tracker: linear, connectionId: "A", token: { value: null } },
        });
      }
    },
  );

  it("adds two accounts and rotates or disconnects only the selected account despite matching names", async () => {
    await render();
    await click(button("Add account"));
    await type(input("API key"), "token-A");
    await click(button("Connect"));
    expect(state.connect).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, token: { value: "token-A" }, addAccount: true },
    });
    connected(account("A"));
    await render();
    await click(button("Add account"));
    expect(input("API key").value).toBe("");
    await type(input("API key"), "token-B");
    await click(button("Connect"));
    expect(state.connect).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, token: { value: "token-B" }, addAccount: true },
    });
    connected(account("A"), account("B"));
    await render();
    await choose("Linear account", "B");
    await type(input("API key"), "rotated-B");
    await click(button("Replace"));
    expect(state.connect).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, connectionId: "B", token: { value: "rotated-B" } },
    });
    await click(button("Disconnect"));
    expect(state.connect).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, connectionId: "B", token: { value: null } },
    });
  });

  it("selects an account and scope per tracker and targets unbinding without removing another tracker", async () => {
    connected(account("A"), account("B", { scopes: [{ key: "OPS", name: "Operations" }] }));
    state.data = {
      ...state.data!,
      projectBindings: {
        [project]: [
          { tracker: linear, connectionId: "A", scope: "ENG" },
          { tracker: jira, scope: "APP" },
        ],
      },
    };
    await render();
    await choose("Linear account for Project", "B");
    expect(state.bind).not.toHaveBeenCalled();
    await choose("Linear team for Project", "Operations");
    expect(state.bind).toHaveBeenLastCalledWith({
      environmentId: local,
      input: {
        projectId: project,
        binding: { value: { tracker: linear, connectionId: "B", scope: "OPS" } },
      },
    });
    state.data = {
      ...state.data!,
      projectBindings: {
        [project]: [
          { tracker: linear, connectionId: "B", scope: "OPS" },
          { tracker: jira, scope: "APP" },
        ],
      },
    };
    await render();
    await choose("Linear team for Project", "Not bound");
    expect(state.bind).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { projectId: project, tracker: linear, connectionId: "B", binding: { value: null } },
    });
  });

  it("keeps legacy default requests and a single account view when the server omits accounts", async () => {
    state.data = {
      trackers: [account()],
      bindings: { [project]: { tracker: linear, scope: "ENG" } },
    };
    await render();
    expect(container.textContent).not.toContain("Add account");
    await type(input("API key"), "default-token");
    await click(button("Replace"));
    expect(state.connect).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, token: "default-token" },
    });
    await click(button("Disconnect"));
    expect(state.connect).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, token: null },
    });
  });

  it("does not mutate with denied permissions, including a submitted disabled form", async () => {
    connected(account("A", { scopesTruncated: true }));
    await render();
    await type(input("API key"), "draft-before-permission-change");
    await type(input("Linear team key for Project"), "draft-scope");
    state.canConnect = false;
    state.canBind = false;
    await render();
    await act(() =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await click(button("Disconnect"));
    await act(async () => {
      container
        .querySelector("li form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(state.connect).not.toHaveBeenCalled();
    expect(state.bind).not.toHaveBeenCalled();
    expect(
      container.querySelector('[aria-label="Linear team for Project"]')?.hasAttribute("disabled"),
    ).toBe(true);
  });

  it("uses binding permission independently of settings write permission", async () => {
    connected(account("A"));
    state.canConnect = false;
    await render();
    await choose("Linear team for Project", "Engineering");
    expect(state.bind).toHaveBeenCalledOnce();
  });

  it("retains failed credential drafts, locks pending edits, and isolates account and environment drafts", async () => {
    connected(account("A"), account("B"));
    state.connect.mockResolvedValueOnce(failure("Credential refused"));
    await render();
    await type(input("API key"), "draft-A");
    await click(button("Replace"));
    expect(container.textContent).toContain("Credential refused");
    expect(input("API key").value).toBe("draft-A");
    await choose("Linear account", "B");
    expect(input("API key").value).toBe("");
    await type(input("API key"), "draft-B");
    await choose("Linear account", "A");
    expect(input("API key").value).toBe("draft-A");
    let resolve!: (value: typeof success) => void;
    state.connect.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await click(button("Replace"));
    expect(input("API key").closest("fieldset")?.disabled).toBe(true);
    expect(button("Add account").disabled).toBe(true);
    await act(() =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(state.connect).toHaveBeenCalledTimes(2);
    await act(() => {
      resolve(success);
    });
    expect(input("API key").value).toBe("");
    await choose("Linear account", "B");
    expect(input("API key").value).toBe("draft-B");
    await render(EnvironmentId.make("remote"));
    expect(input("API key").value).toBe("");
    await type(input("API key"), "remote-draft");
    await click(button("Replace"));
    expect(state.connect).toHaveBeenLastCalledWith({
      environmentId: EnvironmentId.make("remote"),
      input: { tracker: linear, connectionId: "A", token: { value: "remote-draft" } },
    });
  });
  it("keeps Linear and Jira bindings visible when only one tracker is unbound", async () => {
    const jiraAccount = account("J", {
      tracker: jira,
      displayName: "Jira",
      host: "company.atlassian.net",
      scopeNoun: "project",
      scopes: [{ key: "APP", name: "App" }],
    });
    connected(account("A"), account("B"), jiraAccount);
    state.data = {
      ...state.data!,
      trackers: [...state.data!.trackers, jiraAccount],
      projectBindings: {
        [project]: [
          { tracker: linear, connectionId: "A", scope: "ENG" },
          { tracker: jira, connectionId: "J", scope: "APP" },
        ],
        [ProjectId.make("second")]: [{ tracker: linear, connectionId: "B", scope: "ENG" }],
      },
    };
    await render();
    expect(
      container.querySelector('[aria-label="Jira project for Project"]')?.textContent,
    ).toContain("App");
    await choose("Linear team for Project", "Not bound");
    expect(state.bind).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { projectId: project, tracker: linear, connectionId: "A", binding: { value: null } },
    });
    expect(
      container.querySelector('[aria-label="Jira project for Project"]')?.textContent,
    ).toContain("App");
    expect(container.querySelector('[aria-label="Linear account"]')?.textContent).toContain("A");
    expect(
      container.querySelector('[aria-label="Linear account for Second project"]')?.textContent,
    ).toContain("B");
  });

  it("keeps manual scope drafts per account, shows errors, and locks every binding control during a save", async () => {
    connected(account("A", { scopesTruncated: true }), account("B", { scopesTruncated: true }));
    state.bind.mockResolvedValueOnce(failure("Scope unavailable"));
    await render();
    await type(input("Linear team key for Project"), " HIDDEN-A ");
    await click(button("Bind"));
    expect(state.bind).toHaveBeenLastCalledWith({
      environmentId: local,
      input: {
        projectId: project,
        binding: { value: { tracker: linear, connectionId: "A", scope: "HIDDEN-A" } },
      },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Scope unavailable");
    expect(input("Linear team key for Project").value).toBe(" HIDDEN-A ");
    await choose("Linear account for Project", "B");
    expect(input("Linear team key for Project").value).toBe("");
    await type(input("Linear team key for Project"), "HIDDEN-B");
    await choose("Linear account for Project", "A");
    expect(input("Linear team key for Project").value).toBe(" HIDDEN-A ");
    let resolve!: (value: typeof success) => void;
    state.bind.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await click(button("Bind"));
    expect(input("Linear team key for Project").closest("fieldset")?.disabled).toBe(true);
    expect(
      container
        .querySelector('[aria-label="Linear account for Project"]')
        ?.hasAttribute("disabled"),
    ).toBe(true);
    expect(
      container.querySelector('[aria-label="Linear team for Project"]')?.hasAttribute("disabled"),
    ).toBe(true);
    await act(() =>
      container
        .querySelector("li form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(state.bind).toHaveBeenCalledTimes(2);
    await act(() => {
      resolve(success);
    });
    expect(input("Linear team key for Project").value).toBe("");
    await choose("Linear account for Project", "B");
    expect(input("Linear team key for Project").value).toBe("HIDDEN-B");
    await render(EnvironmentId.make("remote"));
    expect(input("Linear team key for Project").value).toBe("");
  });

  it("retains the bound scope when a targeted unbind fails", async () => {
    connected(account("A"));
    state.data = {
      ...state.data!,
      projectBindings: { [project]: [{ tracker: linear, connectionId: "A", scope: "ENG" }] },
    };
    state.bind.mockResolvedValueOnce(failure("Account changed. Refresh and retry."));
    await render();
    await choose("Linear team for Project", "Not bound");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Account changed");
    expect(
      container.querySelector('[aria-label="Linear team for Project"]')?.textContent,
    ).toContain("Engineering");
  });

  it("packs Jira credentials for the selected account without carrying another account draft", async () => {
    const jiraAccount = account("J", {
      tracker: jira,
      displayName: "Jira",
      host: "company.atlassian.net",
      scopeNoun: "project",
      credential: {
        label: "Jira credentials",
        helpUrl: null,
        fields: [
          { key: "site", label: "Site", secret: false },
          { key: "email", label: "Email", secret: false },
          { key: "token", label: "Token", secret: true },
        ],
      },
    });
    state.data = {
      trackers: [jiraAccount],
      accounts: [jiraAccount],
      projectBindings: {},
      bindings: {},
    };
    await render();
    await type(input("Site"), "company.atlassian.net");
    await type(input("Email"), "fake@example.test");
    await type(input("Token"), "fake-token");
    await click(button("Replace"));
    expect(state.connect).toHaveBeenLastCalledWith({
      environmentId: local,
      input: {
        tracker: jira,
        connectionId: "J",
        token: {
          value: JSON.stringify({
            site: "company.atlassian.net",
            email: "fake@example.test",
            token: "fake-token",
          }),
        },
      },
    });
    await click(button("Add account"));
    expect(input("Site").value).toBe("");
    expect(input("Email").value).toBe("");
    expect(input("Token").value).toBe("");
  });

  it("keeps default account IDs absent on the wire and guards a switch from an explicit account", async () => {
    connected(account(), account("A"));
    state.data = {
      ...state.data!,
      projectBindings: { [project]: [{ tracker: linear, connectionId: "A", scope: "ENG" }] },
    };
    await render();
    await choose("Linear account for Project", "Default account");
    await choose("Linear team for Project", "Engineering");
    expect(state.bind).toHaveBeenLastCalledWith({
      environmentId: local,
      input: {
        projectId: project,
        connectionId: "A",
        binding: { value: { tracker: linear, scope: "ENG" } },
      },
    });
    await click(button("Disconnect"));
    expect(state.connect).toHaveBeenLastCalledWith({
      environmentId: local,
      input: { tracker: linear, token: { value: null } },
    });
  });

  it.each(["accounts", "projectBindings"] as const)(
    "requires both new response fields when only %s is present",
    async (field) => {
      state.data = {
        trackers: [account()],
        bindings: { [project]: { tracker: linear, scope: "LEGACY" } },
        ...(field === "accounts"
          ? { accounts: [account("A")] }
          : {
              projectBindings: {
                [project]: [{ tracker: linear, connectionId: "A", scope: "EXPLICIT" }],
              },
            }),
      };
      await render();
      expect(container.textContent).not.toContain("Add account");
      expect(container.querySelector('[aria-label="Linear account"]')).toBeNull();
      expect(
        container.querySelector('[aria-label="Linear team for Project"]')?.textContent,
      ).toContain("LEGACY");
      await type(input("API key"), "legacy");
      await click(button("Replace"));
      expect(state.connect).toHaveBeenLastCalledWith({
        environmentId: local,
        input: { tracker: linear, token: "legacy" },
      });
    },
  );
  it.each(["add", "replace", "disconnect"] as const)(
    "does not retry %s as a default mutation after a stale supported view reaches an old server",
    async (action) => {
      connected(account(), account("A"));
      const before = state.data;
      state.connect.mockResolvedValueOnce(
        failure("This server does not support account requests."),
      );
      await render();
      await choose("Linear account", "A");
      if (action === "add") await click(button("Add account"));
      if (action !== "disconnect") await type(input("API key"), "fake-new-token");
      await click(
        button(
          action === "disconnect" ? "Disconnect" : action === "replace" ? "Replace" : "Connect",
        ),
      );
      expect(state.connect).toHaveBeenCalledOnce();
      expect(state.connect.mock.calls[0]![0].input.token).toEqual({
        value: action === "disconnect" ? null : "fake-new-token",
      });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("does not support");
      expect(state.data).toBe(before);
      state.data = { trackers: [account()], bindings: {} };
      await render();
      expect(container.textContent).not.toContain("Add account");
      expect(input("API key").value).toBe("");
      expect(state.connect).toHaveBeenCalledOnce();
    },
  );

  it("does not retry a selected unbind as a default unbind after reconnect to an old server", async () => {
    connected(account(), account("A"));
    state.data = {
      ...state.data!,
      projectBindings: { [project]: [{ tracker: linear, connectionId: "A", scope: "ENG" }] },
    };
    const before = state.data;
    state.bind.mockResolvedValueOnce(failure("This server does not support account bindings."));
    await render();
    await choose("Linear team for Project", "Not bound");
    expect(state.bind).toHaveBeenCalledOnce();
    expect(state.bind.mock.calls[0]![0].input).toEqual({
      projectId: project,
      tracker: linear,
      connectionId: "A",
      binding: { value: null },
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("does not support");
    expect(state.data).toBe(before);
    expect(
      container.querySelector('[aria-label="Linear team for Project"]')?.textContent,
    ).toContain("Engineering");
    state.data = {
      trackers: [account()],
      bindings: { [project]: { tracker: linear, scope: "DEFAULT" } },
    };
    await render();
    expect(
      container.querySelector('[aria-label="Linear team for Project"]')?.textContent,
    ).toContain("DEFAULT");
    expect(container.querySelector('[aria-label="Linear account for Project"]')).toBeNull();
    expect(state.bind).toHaveBeenCalledOnce();
  });
});

it("connects a Data Center account without optional deployment or email", async () => {
  const fields = [
    { key: "site", label: "Site", secret: false },
    { key: "deployment", label: "Deployment", secret: false, optional: true },
    { key: "email", label: "Email", secret: false, optional: true },
    { key: "token", label: "Token", secret: true },
  ];
  state.data = {
    trackers: [
      account(undefined, {
        tracker: jira,
        displayName: "Jira",
        credential: { label: "Credentials", helpUrl: null, fields },
        connected: false,
        account: null,
        scopes: [],
      }),
    ],
    accounts: [],
    projectBindings: {},
    bindings: {},
  };
  await render();
  expect(input("Site").required).toBe(true);
  expect(input("Token").required).toBe(true);
  expect(input("Deployment").required).toBe(false);
  expect(input("Email").required).toBe(false);
  await type(input("Site"), "https://tracker.example/Jira");
  await type(input("Token"), "fake-token");
  expect(button("Connect").disabled).toBe(false);
  await click(button("Connect"));
  expect(JSON.parse(state.connect.mock.calls[0]![0].input.token.value)).toEqual({
    site: "https://tracker.example/Jira",
    token: "fake-token",
  });
});
