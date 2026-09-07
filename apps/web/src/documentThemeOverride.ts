/** A host's temporary document palette. Stored client preferences remain untouched. */
export interface DocumentThemeOverride {
  readonly id: string;
  readonly dark: boolean;
  readonly vars: Readonly<Record<string, string>>;
}

let current: DocumentThemeOverride | null = null;
let currentJson = "null";
const listeners = new Set<() => void>();

export function subscribeToDocumentThemeOverride(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replace only host-owned variables; removal leaves the next page application in control. */
export function setDocumentThemeOverride(value: DocumentThemeOverride | null): void {
  const next = value?.id ? value : null;
  const json = JSON.stringify(next);
  if (json === currentJson) return;
  if (typeof document !== "undefined") {
    for (const name of Object.keys(current?.vars ?? {})) {
      if (!(name in (next?.vars ?? {}))) document.documentElement.style.removeProperty(name);
    }
    if (current?.vars["--app-theme-chrome"] && !next?.vars["--app-theme-chrome"]) {
      document.documentElement.style.removeProperty("background-color");
    }
  }
  current = next;
  currentJson = json;
  applyDocumentThemeOverride();
  for (const listener of listeners) listener();
}

/** Last step of palette, preview, and appearance application; no competing DOM observer. */
export function applyDocumentThemeOverride(): void {
  if (!current || typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.themeId = current.id;
  root.dataset.themeSelected = "true";
  root.classList.toggle("dark", current.dark);
  for (const [name, value] of Object.entries(current.vars)) root.style.setProperty(name, value);
  const chrome = current.vars["--app-theme-chrome"];
  if (chrome) root.style.backgroundColor = chrome;
}
