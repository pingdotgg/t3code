export interface SidebarOpenStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getSidebarOpenStateStorage(): SidebarOpenStateStorage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function parseStoredSidebarOpenState(value: string | null): boolean | null {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return null;
}

export function resolveSidebarOpenState(options: {
  defaultOpen: boolean;
  storage?: SidebarOpenStateStorage | null;
  storageKey?: string | null;
}): boolean {
  const { defaultOpen, storage = null, storageKey = null } = options;
  if (!storageKey || !storage) {
    return defaultOpen;
  }

  try {
    return parseStoredSidebarOpenState(storage.getItem(storageKey)) ?? defaultOpen;
  } catch {
    return defaultOpen;
  }
}

export function persistSidebarOpenState(options: {
  open: boolean;
  storage?: SidebarOpenStateStorage | null;
  storageKey?: string | null;
}): void {
  const { open, storage = null, storageKey = null } = options;
  if (!storageKey || !storage) {
    return;
  }

  try {
    storage.setItem(storageKey, String(open));
  } catch {
    // Ignore storage errors to avoid breaking chat UX.
  }
}
