// @effect-diagnostics nodeBuiltinImport:off -- Runs before loading the Effect CLI or server graph.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const UNUSED_VERSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache bundled code under the selected T3 home; leave source dev uncached. */
export function enableCliCompileCache(input: {
  readonly bundled: boolean;
  readonly argv: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly version: string;
}) {
  if (
    !input.bundled ||
    // AppImage mount paths change each launch, so path-keyed entries never hit.
    input.environment.APPIMAGE ||
    input.environment.NODE_DISABLE_COMPILE_CACHE === "1" ||
    input.environment.NODE_COMPILE_CACHE
  )
    return;
  const index = input.argv.indexOf("--base-dir");
  const configured =
    (index >= 0 ? input.argv[index + 1] : undefined) ??
    input.argv
      .find((argument) => argument.startsWith("--base-dir="))
      ?.slice("--base-dir=".length) ??
    input.environment.T3CODE_HOME;
  const home = NodeOS.homedir();
  const base = configured?.trim();
  const directory = !base
    ? NodePath.join(home, ".t3")
    : base === "~"
      ? home
      : base.startsWith("~/") || base.startsWith("~\\")
        ? NodePath.join(home, base.slice(2))
        : NodePath.resolve(base);
  const root = NodePath.join(directory, "compile-cache");
  // Cache failures never prevent CLI or server startup, including a read-only home.
  try {
    const current = NodePath.join(root, input.version);
    const { status } = NodeModule.enableCompileCache(current);
    if (status !== NodeModule.constants.compileCacheStatus.ENABLED) return;
    // Other installed versions share this home; remove only caches unused for a week.
    // @effect-diagnostics-next-line globalDate:off -- Runs before the Effect runtime loads.
    const now = new Date();
    NodeFS.utimes(current, now, now, () => {});
    const cutoff = now.getTime() - UNUSED_VERSION_MAX_AGE_MS;
    for (const entry of NodeFS.readdirSync(root)) {
      if (entry === input.version) continue;
      const path = NodePath.join(root, entry);
      NodeFS.stat(path, (error, stats) => {
        if (error === null && stats.mtimeMs < cutoff) {
          NodeFS.rm(path, { recursive: true, force: true }, () => {});
        }
      });
    }
  } catch {}
}
