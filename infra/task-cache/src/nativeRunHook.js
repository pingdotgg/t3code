import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

async function readJson(file) {
  try {
    return JSON.parse(await NodeFSP.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// Optional repository integration; never changes the task runner's exit status.
export async function startRunHook(command, cwd = process.cwd(), resolveWorkspaceRoot) {
  if (command !== "run") return;
  try {
    const configured = await readJson(
      NodePath.join(NodeOS.homedir(), ".config/vite-plus/run-hook.json"),
    );
    let root = cwd;
    while (true) {
      let hook;
      if (configured?.rootMarker && configured?.module) {
        try {
          await NodeFSP.access(NodePath.join(root, configured.rootMarker));
          hook = configured.module;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (typeof hook === "string") {
        // Use Vite's own workspace resolver so nested standalone projects stay independent.
        if (resolveWorkspaceRoot) {
          const workspace = await resolveWorkspaceRoot();
          if (!workspace || (await NodeFSP.realpath(workspace)) !== (await NodeFSP.realpath(root)))
            break;
        }
        const integration = await import(NodeURL.pathToFileURL(NodePath.resolve(root, hook)).href);
        const finish = await integration.default({ root });
        return Object.assign(
          async () => {
            try {
              await finish?.();
            } catch {
              console.warn("[Vite+] Run hook failed to finish.");
            }
          },
          { remoteCache: finish?.remoteCache },
        );
      }
      const parent = NodePath.dirname(root);
      if (parent === root) break;
      root = parent;
    }
    // Vite forwards our CLI mode to tasks, including agents working in other projects.
    if (
      process.env.VP_T3_TASK_CACHE_MODE &&
      process.env.VP_REMOTE_CACHE === process.env.VP_T3_TASK_CACHE_MODE
    )
      delete process.env.VP_REMOTE_CACHE;
  } catch {
    console.warn("[Vite+] Run hook failed to start.");
  }
}
