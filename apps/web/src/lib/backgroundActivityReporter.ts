import type { BackgroundScope, ClientActivityReportInput } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { EnvironmentConnection } from "../environments/runtime/connection";

const CLIENT_ID_STORAGE_KEY = "t3.backgroundActivity.clientId";
const REPORT_INTERVAL_MS = 25_000;
const LEASE_TTL_MS = 45_000;
const BASELINE_SCOPES: ReadonlyArray<BackgroundScope> = [{ type: "provider-status" }];

interface RetainedScope {
  readonly scope: BackgroundScope;
  refCount: number;
}

interface BackgroundActivityReporterOptions {
  readonly getConnections: () => ReadonlyArray<EnvironmentConnection>;
  readonly subscribeConnections: (listener: () => void) => () => void;
}

const retainedScopes = new Map<string, RetainedScope>();
const retainedScopeListeners = new Set<() => void>();

function notifyRetainedScopesChanged(): void {
  for (const listener of retainedScopeListeners) {
    listener();
  }
}

function stableScopeKey(scope: BackgroundScope): string {
  switch (scope.type) {
    case "server-config":
    case "diagnostics":
      return scope.type;
    case "provider-status":
      return scope.instanceId ? `${scope.type}:${scope.instanceId}` : scope.type;
    case "vcs-status":
    case "git-refs":
      return `${scope.type}:${scope.cwd}`;
    case "thread":
      return `${scope.type}:${scope.threadId}`;
  }
}

function getClientId(): string {
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (existing) return existing;
    const next = crypto.randomUUID();
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return "ephemeral-browser-client";
  }
}

function resolveClientKind(): ClientActivityReportInput["clientKind"] {
  return window.desktopBridge ? "desktop-renderer" : "web";
}

function createActivityReport(): ClientActivityReportInput {
  return {
    clientId: getClientId(),
    clientKind: resolveClientKind(),
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    recentlyInteracted: document.hasFocus(),
    appState: document.visibilityState === "visible" ? "active" : "background",
    scopes: [...BASELINE_SCOPES, ...[...retainedScopes.values()].map((entry) => entry.scope)],
    ttlMs: LEASE_TTL_MS,
    observedAt: DateTime.makeUnsafe(new Date().toISOString()),
  };
}

async function reportToConnections(
  connections: ReadonlyArray<EnvironmentConnection>,
): Promise<void> {
  if (connections.length === 0) return;
  const report = createActivityReport();
  await Promise.allSettled(
    connections.map((connection) => connection.client.server.reportClientActivity(report)),
  );
}

export function startBackgroundActivityReporter(
  options: BackgroundActivityReporterOptions,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof document === "undefined" ||
    typeof window.setInterval !== "function"
  ) {
    return () => {};
  }

  let disposed = false;
  let reportTimer: number | null = null;

  const report = () => {
    if (disposed) return;
    void reportToConnections(options.getConnections());
  };

  const scheduleReport = () => {
    if (disposed) return;
    if (reportTimer !== null) {
      window.clearTimeout(reportTimer);
    }
    reportTimer = window.setTimeout(() => {
      reportTimer = null;
      report();
    }, 250);
  };

  const interval = window.setInterval(report, REPORT_INTERVAL_MS);
  const unsubscribeConnections = options.subscribeConnections(scheduleReport);
  retainedScopeListeners.add(scheduleReport);
  document.addEventListener("visibilitychange", scheduleReport);
  window.addEventListener("focus", scheduleReport);
  window.addEventListener("blur", scheduleReport);
  window.addEventListener("online", scheduleReport);

  scheduleReport();

  return () => {
    disposed = true;
    if (reportTimer !== null) {
      window.clearTimeout(reportTimer);
    }
    window.clearInterval(interval);
    unsubscribeConnections();
    retainedScopeListeners.delete(scheduleReport);
    document.removeEventListener("visibilitychange", scheduleReport);
    window.removeEventListener("focus", scheduleReport);
    window.removeEventListener("blur", scheduleReport);
    window.removeEventListener("online", scheduleReport);
  };
}

export function retainBackgroundScope(scope: BackgroundScope): () => void {
  const key = stableScopeKey(scope);
  const existing = retainedScopes.get(key);
  if (existing) {
    existing.refCount += 1;
  } else {
    retainedScopes.set(key, { scope, refCount: 1 });
    notifyRetainedScopesChanged();
  }

  return () => {
    const current = retainedScopes.get(key);
    if (!current) return;
    current.refCount -= 1;
    if (current.refCount <= 0) {
      retainedScopes.delete(key);
      notifyRetainedScopesChanged();
    }
  };
}
