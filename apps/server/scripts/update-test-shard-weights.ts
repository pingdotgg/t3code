// @effect-diagnostics nodeBuiltinImport:off - a one-off maintenance script with no
// Effect runtime; it only spawns vitest and reads and writes two files.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

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

// `node --run` finds the package's vp; failed tests still report durations, so ignore exit status.
NodeChildProcess.spawnSync(
  process.execPath,
  ["--run", "test", "--", "--reporter=json", `--outputFile=${reportPath}`],
  { cwd: serverDir, stdio: "inherit" },
);

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
