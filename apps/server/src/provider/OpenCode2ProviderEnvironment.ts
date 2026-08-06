// @effect-diagnostics nodeBuiltinImport:off
import type { OpenCode2Settings } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const OPENCODE2_BACKGROUND_SUBAGENTS_ENV = "OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS";

/**
 * Self-spawned 2.x servers must not share the user's global
 * `~/.local/share/opencode` database with a desktop `opencode2 serve --service`
 * or other installs. Beta `lildax` returns 500 on `session.prompt` when that
 * shared DB is already owned by another process.
 */
export function openCode2ManagedStateRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return NodePath.join(environment.TMPDIR?.trim() || NodeOS.tmpdir(), "t3-opencode2-state");
}

export function applyOpenCode2ProviderEnvironment(
  settings: Pick<OpenCode2Settings, "backgroundSubagents" | "serverUrl">,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (settings.serverUrl.trim().length > 0) {
    return environment;
  }

  const stateRoot = openCode2ManagedStateRoot(environment);
  const xdgStateHome = NodePath.join(stateRoot, "state");
  const xdgDataHome = NodePath.join(stateRoot, "data");
  const xdgConfigHome = NodePath.join(stateRoot, "config");
  for (const dir of [xdgStateHome, xdgDataHome, xdgConfigHome]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }

  return {
    ...environment,
    [OPENCODE2_BACKGROUND_SUBAGENTS_ENV]: settings.backgroundSubagents ? "true" : "false",
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_STATE_HOME: xdgStateHome,
  };
}
