/**
 * A tiny module that lives OUTSIDE the app's Vite root (`app/`), in a sibling
 * directory with its own `package.json`. The app imports it by relative path;
 * the build-output collector must record `lib/` (this file's workspace root)
 * in `dist/build.json`'s `externalWorkspaces`.
 */
export const LIB_VERSION = "1.0.0";

export const greeting = (name: string): string => `hello-from-the-lib-workspace, ${name}!`;
