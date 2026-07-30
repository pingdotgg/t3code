import { useSyncExternalStore } from "react";

export interface PreviewEnvironmentState {
  pathname: string;
  searchParams: Record<string, string>;
}

const defaultState: PreviewEnvironmentState = {
  pathname: "/",
  searchParams: {},
};

let currentState: PreviewEnvironmentState = defaultState;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

export function setPreviewEnvironment(nextState: Partial<PreviewEnvironmentState>) {
  currentState = {
    pathname: nextState.pathname ?? currentState.pathname,
    searchParams: nextState.searchParams ?? currentState.searchParams,
  };
  notifyListeners();
}

export function getPreviewEnvironment(): PreviewEnvironmentState {
  return currentState;
}

export function resetPreviewEnvironment() {
  currentState = defaultState;
  notifyListeners();
}

export function subscribePreviewEnvironment(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePreviewEnvironment(): PreviewEnvironmentState {
  return useSyncExternalStore(
    subscribePreviewEnvironment,
    getPreviewEnvironment,
    getPreviewEnvironment,
  );
}

export function usePreviewSearchParams(): URLSearchParams {
  const environment = usePreviewEnvironment();
  return new URLSearchParams(environment.searchParams);
}
