// Runtime tab ids to pop out as soon as their hosted webview registers with the desktop bridge.
// ponytail: an id whose tab never gets a hosted webview (server-rendered tab) stays here until reload.
const pending = new Set<string>();

export const requestTabWindow = (runtimeTabId: string): void => {
  pending.add(runtimeTabId);
};

export const takeTabWindowRequest = (runtimeTabId: string): boolean => pending.delete(runtimeTabId);
