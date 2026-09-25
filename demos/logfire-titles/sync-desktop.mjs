import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";

// The recording host displays the actual titles produced by the editable evaluator.
const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const recording = await NodeFSP.readFile(`${root}.t3/recording-desktop/recording.json`, "utf8")
  .then(JSON.parse)
  .catch(() => null);
if (recording) {
  const results = JSON.parse(await NodeFSP.readFile(process.argv[2], "utf8"));
  const { token } = JSON.parse(
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        "apps/server/src/bin.ts",
        "auth",
        "session",
        "issue",
        "--base-dir",
        recording.home,
        "--ttl",
        "2h",
        "--label",
        "Recording title results",
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  for (const result of results.cases) {
    const response = await fetch(`${recording.origin}/api/orchestration/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "thread.meta.update",
        commandId: NodeCrypto.randomUUID(),
        threadId: result.thread_id,
        title: result.title,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Recording title update failed: ${response.status}`);
  }
  console.log(`Recording desktop: displayed ${results.cases.length} evaluated titles.`);
}
