// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off - The standalone launcher cannot depend on Effect.
// Shared with the standalone service launcher. Keep imports limited to native modules.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Never unlink this file. SQLite releases its OS lock when the holder exits. */
export async function acquireServerOwnershipLock(
  directory: string,
  options?: { readonly guardLegacyOwner?: boolean },
) {
  await NodeFSP.mkdir(directory, { recursive: true });
  const stateDir = await NodeFSP.realpath(directory);
  const lockPath = NodePath.join(stateDir, "server-owner.sqlite");
  let db: { exec: (sql: string) => unknown; close: () => void };
  if (process.versions.bun) {
    // Keep Bun's runtime-only module out of the Node build's module resolver.
    const moduleName = "bun:sqlite";
    const sqlite: { Database: new (filename: string) => typeof db } = await import(moduleName);
    db = new sqlite.Database(lockPath);
  } else {
    db = new (await import("node:sqlite")).DatabaseSync(lockPath);
  }
  try {
    db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
    if (options?.guardLegacyOwner) {
      let runtimeState: unknown;
      try {
        runtimeState = JSON.parse(
          await NodeFSP.readFile(NodePath.join(stateDir, "server-runtime.json"), "utf8"),
        );
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      }
      if (runtimeState !== undefined) {
        // Unknown descriptors and live legacy PIDs must fail closed before a
        // launcher copies data. PID reuse can cause a conservative refusal;
        // no process is ever stopped based on this record.
        if (
          typeof runtimeState !== "object" ||
          runtimeState === null ||
          !("version" in runtimeState) ||
          runtimeState.version !== 1 ||
          !("pid" in runtimeState) ||
          typeof runtimeState.pid !== "number" ||
          !Number.isInteger(runtimeState.pid) ||
          ("ownerId" in runtimeState && typeof runtimeState.ownerId !== "string")
        ) {
          throw new Error(`Cannot inspect server ownership at ${stateDir}.`);
        }
        if (!("ownerId" in runtimeState) && runtimeState.pid > 0) {
          let alive = true;
          try {
            process.kill(runtimeState.pid, 0);
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") {
              alive = false;
            } else if (!(cause instanceof Error && "code" in cause && cause.code === "EPERM")) {
              throw cause;
            }
          }
          if (alive) {
            throw Object.assign(
              new Error(`A legacy server may still own ${stateDir}. Stop it before updating.`),
              { code: "T3_STATE_DIR_OWNED" },
            );
          }
        }
      }
    }
  } catch (cause) {
    db.close();
    throw cause;
  }
  return { stateDir, close: () => db.close() };
}
