/**
 * A tiny module that lives OUTSIDE the app's Vite root (`app/`), in a
 * sibling directory with its own `package.json`. The app imports it by
 * relative path; the workspace-aware input hash must treat edits here as
 * memo-busting changes even though nothing under `app/` changed.
 */
export const LIB_VERSION = "1.0.0";

export const greeting = (name: string): string =>
  `hello-from-the-lib-workspace, ${name}!`;
