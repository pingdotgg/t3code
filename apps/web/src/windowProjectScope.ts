import { create } from "zustand";

import { PERSISTED_STATE_KEY, type PersistedUiState } from "./uiStateStore";

const WINDOW_SCOPE_SESSION_KEY = "t3code:window-project-scope:v1";
const REMEMBERED_PROJECT_SCOPE_KEY = "t3code:sidebar-project-scope:v1";
const PROJECT_SCOPE_URL_PARAM = "projectScope";

interface WindowProjectScope {
  /** This window's sidebar project filter; empty means all projects. */
  readonly projectScopeKeys: readonly string[];
  /** Opened for a scope, so its filter changes never become the remembered default. */
  readonly isSecondary: boolean;
}

interface WindowProjectScopeStore extends WindowProjectScope {
  setProjectScopeKeys: (keys: readonly string[]) => void;
}

function sanitizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function readJson(storage: () => Storage, key: string): unknown {
  try {
    const raw = storage().getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeJson(storage: () => Storage, key: string, value: unknown): void {
  try {
    storage().setItem(key, JSON.stringify(value));
  } catch {}
}

const sessionStore = () => window.sessionStorage;
const localStore = () => window.localStorage;

function writeSessionScope(scope: WindowProjectScope): void {
  writeJson(sessionStore, WINDOW_SCOPE_SESSION_KEY, {
    keys: scope.projectScopeKeys,
    secondary: scope.isSecondary,
  });
}

function readSessionScope(): WindowProjectScope | null {
  const stored = readJson(sessionStore, WINDOW_SCOPE_SESSION_KEY);
  if (typeof stored !== "object" || stored === null || !("keys" in stored)) return null;
  return {
    projectScopeKeys: sanitizeKeys(stored.keys),
    isSecondary: "secondary" in stored && stored.secondary === true,
  };
}

function readRememberedScopeKeys(): string[] {
  const remembered = readJson(localStore, REMEMBERED_PROJECT_SCOPE_KEY);
  if (remembered !== undefined) return sanitizeKeys(remembered);
  const legacy = readJson(localStore, PERSISTED_STATE_KEY) as PersistedUiState | undefined;
  const keys = sanitizeKeys(legacy?.sidebarProjectScopeKeys ?? [legacy?.sidebarProjectScopeKey]);
  writeJson(localStore, REMEMBERED_PROJECT_SCOPE_KEY, keys);
  return keys;
}

export const useWindowProjectScopeStore = create<WindowProjectScopeStore>((set, get) => ({
  projectScopeKeys: [],
  isSecondary: false,
  setProjectScopeKeys: (keys) => {
    const projectScopeKeys = sanitizeKeys(keys);
    const current = get();
    if (
      projectScopeKeys.length === current.projectScopeKeys.length &&
      projectScopeKeys.every((key, index) => key === current.projectScopeKeys[index])
    ) {
      return;
    }
    set({ projectScopeKeys });
    writeSessionScope({ projectScopeKeys, isSecondary: current.isSecondary });
    if (!current.isSecondary) {
      writeJson(localStore, REMEMBERED_PROJECT_SCOPE_KEY, projectScopeKeys);
    }
  },
}));

/**
 * Resolves this window's scope before the router reads the address. The session copy wins so a
 * reload or crash recovery, which reloads the opening URL, keeps the filter the window moved to.
 */
export function initWindowProjectScope(): void {
  const params = new URLSearchParams(window.location.search);
  const handoff = params.has(PROJECT_SCOPE_URL_PARAM);
  const scope: WindowProjectScope = readSessionScope() ??
    (handoff
      ? {
          // A present but empty param opens a window on all projects.
          projectScopeKeys: sanitizeKeys(params.getAll(PROJECT_SCOPE_URL_PARAM)),
          isSecondary: true,
        }
      : null) ?? { projectScopeKeys: readRememberedScopeKeys(), isSecondary: false };
  useWindowProjectScopeStore.setState(scope);
  writeSessionScope(scope);
  if (!handoff) return;
  params.delete(PROJECT_SCOPE_URL_PARAM);
  const search = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
  );
}

/** Opens another app window, or a browser tab on the web, scoped to these projects. */
export function openProjectScopeWindow(projectScopeKeys: readonly string[]): void {
  const bridge = window.desktopBridge;
  if (bridge) {
    void bridge
      .openAppWindow({ projectScopeKeys: [...projectScopeKeys] })
      .catch((error: unknown) => console.error("Could not open a new window.", error));
    return;
  }
  const url = new URL(import.meta.env.BASE_URL, window.location.origin);
  if (projectScopeKeys.length === 0) url.searchParams.set(PROJECT_SCOPE_URL_PARAM, "");
  for (const key of projectScopeKeys) url.searchParams.append(PROJECT_SCOPE_URL_PARAM, key);
  window.open(url, "_blank", "noopener");
}
