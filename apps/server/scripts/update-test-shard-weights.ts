// @effect-diagnostics nodeBuiltinImport:off - a one-off maintenance script with no
// Effect runtime; it only spawns vitest and reads and writes two files.
// Run with: node apps/server/scripts/update-test-shard-weights.ts
// Runs the whole server suite once and records how long each test file takes,
// so CI can split the suite into shards of equal duration. See
// src/testUtils/weightedShardSequencer.ts. Rerun it when a shard in CI runs
// much longer than the others.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Files faster than this are all treated alike, which keeps the weights file short.
const MIN_RECORDED_SECONDS = 0.5;

interface VitestJsonReport {
  readonly testResults: ReadonlyArray<{
    readonly name: string;
    readonly startTime: number;
    readonly endTime: number;
  }>;
}

const serverDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const weightsPath = NodePath.join(serverDir, "src/testUtils/shardWeights.json");
const reportDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-server-test-report-"));
const reportPath = NodePath.join(reportDir, "report.json");

// Failing tests still report their duration, so the exit code is not checked.
NodeChildProcess.spawnSync("vp", ["test", "run", "--reporter=json", `--outputFile=${reportPath}`], {
  cwd: serverDir,
  stdio: "inherit",
});

const report: VitestJsonReport = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
NodeFS.rmSync(reportDir, { recursive: true, force: true });

const weights = Object.fromEntries(
  report.testResults
    .map(
      (file) =>
        [
          NodePath.relative(serverDir, file.name).replaceAll("\\", "/"),
          Math.round((file.endTime - file.startTime) / 100) / 10,
        ] as const,
    )
    .filter(([, seconds]) => seconds >= MIN_RECORDED_SECONDS)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
);

NodeFS.writeFileSync(weightsPath, `${JSON.stringify(weights, null, 2)}\n`);
NodeChildProcess.spawnSync("vp", ["fmt", weightsPath], { cwd: serverDir, stdio: "inherit" });
