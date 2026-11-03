import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// The caller supplies the harness's T3 preview tool dispatcher, not Playwright.
export async function createDriver(
  callPreview,
  { tabId, outputDir, repoDir, run, phase, sourceTreeSha },
) {
  await NodeFSP.mkdir(outputDir, { recursive: true });
  await NodeFSP.mkdir("/tmp/t3-terminal-evidence", { recursive: true });
  const events = [];
  const captures = [];
  const started = Date.now();
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
  const provenance = {
    headSha: git("rev-parse", "HEAD"),
    sourceTreeSha,
    terminalBlob: git("hash-object", "apps/web/src/components/ThreadTerminalDrawer.tsx"),
    workingTreeStatus: git("status", "--short"),
    phase,
  };
  let milestones;
  let pendingMilestones;
  const decode = (result) =>
    result.structuredContent ??
    JSON.parse(result.content.find((item) => item.type === "text").text);
  // Watch before the action that starts a shell, so fast prompts cannot race the watcher.
  const arm = async () => {
    await milestones?.return();
    milestones = NodeFSP.watch("/tmp/t3-terminal-evidence");
    pendingMilestones = milestones.next();
  };
  const call = async (name, args = {}) => {
    if (name === "press" && args.key === "Enter") await arm();
    const result = await callPreview(name, { ...args, tabId });
    events.push({ run, ms: Date.now() - started, op: name, args, isError: !!result.isError });
    if (result.isError) throw new Error(JSON.stringify(result));
    return decode(result);
  };
  const evaluate = async (expression) => (await call("evaluate", { expression })).value;
  const driver = {
    call,
    evaluate,
    arm,
    ready: async (pane) => {
      if (!milestones) throw new Error(`Terminal readiness for ${pane} was not armed`);
      for (;;) {
        const event = await pendingMilestones;
        if (event.done) throw new Error("Terminal readiness watcher ended");
        if (event.value.filename === `ready-${pane}`) break;
        pendingMilestones = milestones.next();
      }
      await milestones.return();
      milestones = undefined;
      pendingMilestones = undefined;
    },
    columns: async () =>
      Number(
        (await NodeFSP.readFile("/tmp/t3-terminal-evidence/input-size", "utf8"))
          .trim()
          .split(/\s+/)[1],
      ),
    note: async (note, data) => events.push({ run, ms: Date.now() - started, note, data }),
    checkpoint: async (checkpoint) => {
      const meta = await evaluate(
        `(async()=>{const m=await import('/test/fixtures/terminal-layout/capture.mjs');return m.metadata(${JSON.stringify(provenance)})})()`,
      );
      const snapshot = await call("snapshot", { save: true });
      const target = NodePath.join(outputDir, `${run}-${checkpoint}.png`);
      await NodeFSP.copyFile(snapshot.screenshotPath, target);
      captures.push({ run, checkpoint, path: target, meta });
      events.push({ run, ms: Date.now() - started, checkpoint, path: target });
    },
    finish: async () => {
      await milestones?.return();
      await NodeFSP.writeFile(
        NodePath.join(outputDir, `${run}.json`),
        JSON.stringify({ provenance, events, captures }, null, 2),
      );
    },
  };
  return driver;
}
