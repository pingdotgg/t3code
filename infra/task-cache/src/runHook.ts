// @effect-diagnostics nodeBuiltinImport:off - runs inside Vite+ before project services start.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { remoteCacheUrl } from "./remoteCache.ts";
import { flushTelemetry, observeSummaries } from "./telemetry.ts";

export default function start({ root }: { readonly root: string }) {
  const url = remoteCacheUrl(root);
  if (!url) return;
  const endpoint = new URL(url);
  endpoint.username = "";
  endpoint.password = "";
  const stop =
    process.env.T3_TASK_CACHE_TELEMETRY === "off"
      ? undefined
      : observeSummaries(root, endpoint.href.replace(/\/$/, ""), process.env);
  const finish = async () => {
    if (!stop) return;
    stop();
    // GitHub can terminate detached processes as soon as the final step exits.
    if (process.env.GITHUB_ACTIONS === "true") {
      await flushTelemetry();
      return;
    }
    // A transient flusher drains the durable queue without delaying tasks or Ctrl-C.
    const child = NodeChildProcess.spawn(
      process.execPath,
      [NodeURL.fileURLToPath(new URL("./flush.ts", import.meta.url))],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );
    child.on("error", () => {});
    child.unref();
  };
  return Object.assign(finish, {
    remoteCache: process.env.VP_REMOTE_CACHE || process.env.VP_T3_TASK_CACHE_MODE || "read-write",
  });
}
