import type { T3HostAppearance, T3HostBridge } from "@t3tools/contracts";

const DEFAULT_HOST_APPEARANCE: T3HostAppearance = {
  themeSource: "default",
  colorScheme: "light",
};

const subscribers = new Set<() => void>();
let subscribedHostBridge: T3HostBridge | null = null;
let unsubscribeHostAppearance: (() => void) | null = null;

function normalizeHostAppearance(
  appearance: Partial<T3HostAppearance> | null | undefined,
): T3HostAppearance {
  return {
    themeSource: appearance?.themeSource === "vscode" ? "vscode" : "default",
    colorScheme: appearance?.colorScheme === "dark" ? "dark" : "light",
  };
}

function areHostAppearancesEqual(left: T3HostAppearance, right: T3HostAppearance): boolean {
  return left.themeSource === right.themeSource && left.colorScheme === right.colorScheme;
}

let currentHostAppearance = normalizeHostAppearance(
  typeof window === "undefined" ? null : window.t3HostBridge?.getHostAppearance?.(),
);

function setHostAppearance(nextAppearance: Partial<T3HostAppearance> | null | undefined): void {
  const normalizedAppearance = normalizeHostAppearance(nextAppearance);
  if (areHostAppearancesEqual(currentHostAppearance, normalizedAppearance)) {
    return;
  }

  currentHostAppearance = normalizedAppearance;
  applyHostAppearanceToDocument(currentHostAppearance);
  for (const subscriber of subscribers) {
    subscriber();
  }
}

function ensureHostAppearanceBridgeSubscription(): void {
  if (typeof window === "undefined") {
    return;
  }

  const bridge = window.t3HostBridge ?? null;
  if (bridge === subscribedHostBridge) {
    return;
  }

  unsubscribeHostAppearance?.();
  subscribedHostBridge = bridge;
  unsubscribeHostAppearance = null;
  setHostAppearance(bridge?.getHostAppearance?.() ?? null);
  if (!bridge) {
    return;
  }

  unsubscribeHostAppearance = bridge.onHostAppearanceChanged?.(emitHostAppearanceChanged) ?? null;
}

function emitHostAppearanceChanged(nextAppearance: T3HostAppearance): void {
  setHostAppearance(nextAppearance);
}

if (typeof window !== "undefined") {
  ensureHostAppearanceBridgeSubscription();
}

export function readHostAppearance(): T3HostAppearance {
  ensureHostAppearanceBridgeSubscription();
  return currentHostAppearance;
}

export function subscribeHostAppearance(callback: () => void): () => void {
  ensureHostAppearanceBridgeSubscription();
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
  };
}

export function resolveHostResolvedTheme(
  appearance: T3HostAppearance | null | undefined,
): "light" | "dark" | null {
  const normalizedAppearance = normalizeHostAppearance(appearance ?? DEFAULT_HOST_APPEARANCE);
  return normalizedAppearance.themeSource === "vscode" ? normalizedAppearance.colorScheme : null;
}

export function applyHostAppearanceToDocument(
  appearance: T3HostAppearance | null | undefined,
): "light" | "dark" | null {
  if (typeof document === "undefined") {
    return resolveHostResolvedTheme(appearance);
  }

  const resolvedTheme = resolveHostResolvedTheme(appearance);
  if (resolvedTheme) {
    setHostThemeAttribute(document.documentElement, "vscode");
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  } else {
    setHostThemeAttribute(document.documentElement, null);
  }
  return resolvedTheme;
}

function setHostThemeAttribute(element: HTMLElement, value: "vscode" | null): void {
  if (value) {
    element.setAttribute("data-t3-host-theme", value);
  } else {
    element.removeAttribute("data-t3-host-theme");
  }
}
