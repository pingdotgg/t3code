// @effect-diagnostics nodeBuiltinImport:off - scans the checked-in source tree.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// PseudoCode strips upstream's analytics, owner hashing and crash reporting. Upstream syncs bring
// them back; this fails CI when shipped code names them again.
const repoRoot = NodePath.resolve(__dirname, "..");
const SHIPPED_ROOTS = ["apps/server", "apps/web", "apps/desktop", "apps/mobile", "packages"];

const BANNED_SOURCE = [
  /posthog/i,
  /ingest\.t3\.codes/,
  /axiom/i,
  /expo-observe/,
  /\b(?:hashTelemetryId|isTelemetryIdHash|AnalyticsService|recordOwners|ProviderTurnAnalytics|AnalyticsDevice)\b/,
  /analytics-device-id/,
];

const BANNED_DEPENDENCY =
  /"(?:posthog[^"]*|@sentry\/[^"]*|expo-observe|@axiomhq\/[^"]*|mixpanel[^"]*|@amplitude\/[^"]*|@segment\/[^"]*|@vercel\/analytics|@datadog\/[^"]*)"\s*:/;

const ALLOWED = new Set([
  // The runtime denylist names the hosts it blocks.
  "packages/shared/src/telemetryBlocklist.ts",
  // Upstream relay's inbound endpoint contract; nothing in the apps calls it.
  "packages/contracts/src/relay.ts",
]);

const trackedFiles = NodeChildProcess.execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SHIPPED_ROOTS],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\n")
  .filter((file) => file !== "" && NodeFS.existsSync(NodePath.join(repoRoot, file)));

const read = (file: string) => NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");

describe("upstream telemetry stays out", () => {
  it("ships no source that names upstream analytics, hashing or crash reporting", () => {
    const sources = trackedFiles.filter(
      (file) =>
        /\.(?:[cm]?[jt]sx?)$/.test(file) &&
        !/\.test\.[cm]?[jt]sx?$/.test(file) &&
        !/(?:^|\/)(?:ios|android)\//.test(file) &&
        !ALLOWED.has(file),
    );
    expect(sources.length).toBeGreaterThan(500);
    const hits = sources.flatMap((file) => {
      const text = read(file);
      return BANNED_SOURCE.filter((pattern) => pattern.test(text)).map(
        (pattern) => `${file}: ${pattern}`,
      );
    });
    expect(hits).toEqual([]);
  });

  it("depends on no analytics or crash reporting SDK", () => {
    const manifests = trackedFiles.filter((file) => file.endsWith("package.json"));
    expect(manifests.length).toBeGreaterThan(5);
    expect(manifests.filter((file) => BANNED_DEPENDENCY.test(read(file)))).toEqual([]);
  });
});
