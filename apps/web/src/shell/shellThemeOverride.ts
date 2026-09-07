import { setDocumentThemeOverride, type DocumentThemeOverride } from "../documentThemeOverride";

/** Shared only with the native document-creation script, not the shell action protocol. */
export interface ShellThemeBootstrap {
  observer?: { disconnect: () => void } | null;
  override?: DocumentThemeOverride;
  applyOverride?: (value: DocumentThemeOverride) => void;
}

/** The page takes ownership once; native reinjections subsequently deliver input, not DOM writes. */
export function claimShellThemeOverride(): void {
  const bootstrap = (window.__t3ShellTheme ??= {});
  if (bootstrap.applyOverride) return;
  // Older shells do not supply the override payload, so keep their DOM owner.
  if (bootstrap.observer && !bootstrap.override) return;
  bootstrap.observer?.disconnect();
  bootstrap.observer = null;
  bootstrap.applyOverride = setDocumentThemeOverride;
  if (bootstrap.override) setDocumentThemeOverride(bootstrap.override);
}
