// @effect-diagnostics nodeBuiltinImport:off - shared by the plain Node launcher and e2e tests, outside any Effect runtime.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);

export const SERVER_BIN = NodePath.join(REPO_ROOT, "apps/server/src/bin.ts");

export const WEB_DIST_INDEX = NodePath.join(REPO_ROOT, "apps/web/dist/index.html");

/** The scripted provider CLIs; see e2e/fixtures/scenario.ts for what they do with prompts. */
export const FIXTURES_DIR = NodePath.join(REPO_ROOT, "e2e/fixtures");

export const FAKE_CODEX_DIR = NodePath.join(FIXTURES_DIR, "fake-codex");

export const FIXTURE_PROJECT_NAME = "demo-app";

/** Parent of every instance directory; the launcher prunes ones whose server is gone. */
export const INSTANCES_ROOT = NodePath.join(NodeOS.tmpdir(), "t3code-e2e");

export type InstancePaths = ReturnType<typeof instancePaths>;

/**
 * Directories owned by the isolated server on `port`. The launcher creates them and
 * tests find them again from `app.baseUrl`, so every run on a free port gets its own.
 */
export function instancePaths(port: string) {
  const root = NodePath.join(INSTANCES_ROOT, port);
  return {
    root,
    t3Home: NodePath.join(root, "t3"),
    userHome: NodePath.join(root, "home"),
    workspaces: NodePath.join(root, "workspace"),
    project: NodePath.join(root, "workspace", FIXTURE_PROJECT_NAME),
  };
}

/** Resolves the instance directories from the URL the e2e runner allocated. */
export function instancePathsForBaseUrl(baseUrl: string | undefined) {
  if (baseUrl === undefined) {
    throw new Error("The web target declares no app.url.");
  }
  return instancePaths(new URL(baseUrl).port);
}

/** Host variables a server and its shells need that carry no identity or credentials. */
const INHERITED_VARIABLES = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "SHELL",
  "USER",
  "TMPDIR",
];

/**
 * The only environment the isolated server and the T3 CLI run with. Nothing else is
 * inherited, so provider keys, `GH_TOKEN`, `T3CODE_*` settings, and the developer's git
 * and gh config (XDG and system included) never reach the instance or its terminals.
 */
export function isolatedEnv(paths: InstancePaths): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    INHERITED_VARIABLES.flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return {
    ...inherited,
    PATH: `${FAKE_CODEX_DIR}${NodePath.delimiter}${process.env.PATH ?? ""}`,
    HOME: paths.userHome,
    XDG_CONFIG_HOME: NodePath.join(paths.userHome, ".config"),
    XDG_DATA_HOME: NodePath.join(paths.userHome, ".local/share"),
    XDG_STATE_HOME: NodePath.join(paths.userHome, ".local/state"),
    XDG_CACHE_HOME: NodePath.join(paths.userHome, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    T3CODE_TELEMETRY_ENABLED: "0",
  };
}
