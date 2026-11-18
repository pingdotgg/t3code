import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";
import { PERSISTED_STATE_KEY } from "./uiStateStore";
import { initWindowProjectScope, useWindowProjectScopeStore } from "./windowProjectScope";

const SESSION_KEY = "t3code:window-project-scope:v1";
const REMEMBERED_PROJECT_SCOPE_KEY = "t3code:sidebar-project-scope:v1";

function stubWindow(href: string, seed: { local?: object; session?: object } = {}) {
  const localStorage = createMemoryStorage();
  const sessionStorage = createMemoryStorage();
  for (const [key, value] of Object.entries(seed.local ?? {})) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  for (const [key, value] of Object.entries(seed.session ?? {})) {
    sessionStorage.setItem(key, JSON.stringify(value));
  }
  const location = new URL(href);
  vi.stubGlobal("window", {
    localStorage,
    sessionStorage,
    location,
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, next: string) => {
        location.href = new URL(next, location).href;
      },
    },
  });
  const read = (storage: typeof localStorage, key: string): unknown => {
    const raw = storage.getItem(key);
    return typeof raw === "string" ? JSON.parse(raw) : null;
  };
  return {
    location,
    remembered: () => read(localStorage, REMEMBERED_PROJECT_SCOPE_KEY),
    session: () => read(sessionStorage, SESSION_KEY),
  };
}

function scope() {
  const { projectScopeKeys, isSecondary } = useWindowProjectScopeStore.getState();
  return { projectScopeKeys, isSecondary };
}

describe("initWindowProjectScope", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    {
      name: "this window's session scope over a URL handoff",
      href: "https://app.test/?projectScope=from-url",
      seed: {
        session: { [SESSION_KEY]: { keys: ["from-session"], secondary: false } },
        local: { [REMEMBERED_PROJECT_SCOPE_KEY]: ["remembered"] },
      },
      expected: { projectScopeKeys: ["from-session"], isSecondary: false },
    },
    {
      name: "a URL handoff over the remembered default, as a secondary window",
      href: "https://app.test/?projectScope=a&projectScope=b",
      seed: { local: { [REMEMBERED_PROJECT_SCOPE_KEY]: ["remembered"] } },
      expected: { projectScopeKeys: ["a", "b"], isSecondary: true },
    },
    {
      name: "an empty handoff as all projects in a secondary window",
      href: "https://app.test/?projectScope=",
      seed: { local: { [REMEMBERED_PROJECT_SCOPE_KEY]: ["remembered"] } },
      expected: { projectScopeKeys: [], isSecondary: true },
    },
    {
      name: "the remembered default over the legacy ui-state scope",
      href: "https://app.test/",
      seed: {
        local: {
          [REMEMBERED_PROJECT_SCOPE_KEY]: ["remembered"],
          [PERSISTED_STATE_KEY]: { sidebarProjectScopeKeys: ["legacy"] },
        },
      },
      expected: { projectScopeKeys: ["remembered"], isSecondary: false },
    },
    {
      name: "the legacy multi-project scope",
      href: "https://app.test/",
      seed: { local: { [PERSISTED_STATE_KEY]: { sidebarProjectScopeKeys: ["one", "two"] } } },
      expected: { projectScopeKeys: ["one", "two"], isSecondary: false },
    },
    {
      name: "the legacy single-project scope",
      href: "https://app.test/",
      seed: { local: { [PERSISTED_STATE_KEY]: { sidebarProjectScopeKey: "single" } } },
      expected: { projectScopeKeys: ["single"], isSecondary: false },
    },
  ])("takes $name", ({ href, seed, expected }) => {
    stubWindow(href, seed);

    initWindowProjectScope();

    expect(scope()).toEqual(expected);
  });

  it("migrates the legacy scope into the remembered default once", () => {
    const env = stubWindow("https://app.test/", {
      local: { [PERSISTED_STATE_KEY]: { sidebarProjectScopeKey: "single" } },
    });

    initWindowProjectScope();

    expect(env.remembered()).toEqual(["single"]);
  });

  it("saves the session scope and removes only the handoff from the address", () => {
    const env = stubWindow("https://app.test/app?foo=1&projectScope=a&bar=2#/thread/1");

    initWindowProjectScope();

    expect(env.session()).toEqual({ keys: ["a"], secondary: true });
    expect(env.location.href).toBe("https://app.test/app?foo=1&bar=2#/thread/1");
  });

  it("changes the remembered default only from a window not opened for a scope", () => {
    const secondary = stubWindow("https://app.test/?projectScope=a", {
      local: { [REMEMBERED_PROJECT_SCOPE_KEY]: ["remembered"] },
    });
    initWindowProjectScope();
    useWindowProjectScopeStore.getState().setProjectScopeKeys(["b"]);

    expect(secondary.session()).toEqual({ keys: ["b"], secondary: true });
    expect(secondary.remembered()).toEqual(["remembered"]);

    vi.unstubAllGlobals();
    const primary = stubWindow("https://app.test/", {
      local: { [REMEMBERED_PROJECT_SCOPE_KEY]: ["remembered"] },
    });
    initWindowProjectScope();
    useWindowProjectScopeStore.getState().setProjectScopeKeys(["c"]);

    expect(primary.session()).toEqual({ keys: ["c"], secondary: false });
    expect(primary.remembered()).toEqual(["c"]);
  });
});
