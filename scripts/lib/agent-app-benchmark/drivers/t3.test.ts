import { assert, it } from "@effect/vitest";

import { createT3PublicDriver, parseProcessStartTime } from "./t3.ts";

const receipt = {
  endpoint: "correct-content-painted-and-input-ready" as const,
  checks: [
    { id: "content-identity", passed: true },
    { id: "first-fold-painted", passed: true },
    { id: "two-presentations", passed: true },
    { id: "trusted-input", passed: true },
  ],
};

function makeHarness() {
  const activations: string[] = [];
  const launches: Array<{ stateHandle: string; initialSessionId: string }> = [];
  let clock = 10;
  const targets = new Map([
    [
      "control",
      {
        logicalSessionId: "control",
        sessionId: "native-control",
        title: "Control",
        expectedMessageIds: ["control-message"],
      },
    ],
    [
      "within-workspace-warm-1048576",
      {
        logicalSessionId: "within-workspace-warm-1048576",
        sessionId: "native-warm",
        title: "Warm",
        expectedMessageIds: ["warm-message"],
      },
    ],
    [
      "within-workspace-cold-1048576",
      {
        logicalSessionId: "within-workspace-cold-1048576",
        sessionId: "native-cold",
        title: "Cold",
        expectedMessageIds: ["cold-message"],
      },
    ],
  ]);
  const driver = createT3PublicDriver({
    hello: { protocolVersion: 1 },
    prepare: async () => ({
      materialization: {
        corpusDigestSha256: "a".repeat(64),
        eventSchemaDigestSha256: "b".repeat(64),
        mappingDigestSha256: "c".repeat(64),
        sessionMapping: { control: "native-control" },
        readinessTargets: targets,
        messageCount: 6,
        transcriptBytes: 12,
      },
      stateHandles: { P0: "sealed-p0", P1: "sealed-p1" },
    }),
    launch: async (stateHandle, initialSessionId) => {
      launches.push({ stateHandle, initialSessionId });
      return {
        processes: [
          { pid: 12, startTimeMs: 1_000, owner: "application", category: "electron-main" },
        ],
        readiness: receipt,
        clock: { kind: "single-monotonic-clock", clock: "test", start: 1, end: 5 },
      };
    },
    activate: async (target) => {
      activations.push(target.logicalSessionId);
      const start = clock;
      clock += 2;
      return { kind: "single-monotonic-clock", clock: "test-renderer", start, end: clock };
    },
    shutdown: async () => ({ terminated: [], survivors: [] }),
  });
  return { driver, activations, launches };
}

async function prepare(driver: ReturnType<typeof createT3PublicDriver>) {
  return driver.prepare({
    scenarioId: "session-switch-v1",
    scenarioDigestSha256: "1".repeat(64),
    corpusDirectory: "/tmp/corpus",
    corpusManifestPath: "/tmp/corpus/manifest.json",
    corpusDigestSha256: "a".repeat(64),
    corpusDefinitionDigestSha256: "2".repeat(64),
    eventSchemaDigestSha256: "b".repeat(64),
    runDirectory: "/tmp/run",
  });
}

it("attests to translated corpus identity and returns sealed P0/P1 handles", async () => {
  const { driver } = makeHarness();
  const result = await prepare(driver);
  assert.equal(result.materializationMode, "translated");
  assert.deepStrictEqual(result.stateHandles, { P0: "sealed-p0", P1: "sealed-p1" });
  assert.equal(result.corpusDigestSha256, "a".repeat(64));
});

it("enforces cold and warm session-switch preparation around one measured activation", async () => {
  const { driver, activations } = makeHarness();
  await prepare(driver);
  await driver.launch({
    scenarioId: "session-switch-v1",
    stateHandle: "sealed-p1",
    initialSessionId: "control",
    groupId: "group",
  });
  const cold = await driver.execute({
    scenarioId: "session-switch-v1",
    case: {
      caseId: "cold",
      workload: "isolated-latency",
      sessionState: "cold",
      sourceSessionId: "control",
      destinationSessionId: "within-workspace-cold-1048576",
    },
  });
  const warm = await driver.execute({
    scenarioId: "session-switch-v1",
    case: {
      caseId: "warm",
      workload: "isolated-latency",
      sessionState: "warm",
      sourceSessionId: "control",
      destinationSessionId: "within-workspace-warm-1048576",
    },
  });
  assert.deepStrictEqual(activations, [
    "control",
    "within-workspace-cold-1048576",
    "within-workspace-warm-1048576",
    "control",
    "within-workspace-warm-1048576",
  ]);
  assert.equal(cold.durationMs, 2);
  assert.equal(warm.durationMs, 2);
});

it("measures app start from the exact requested sealed state", async () => {
  const { driver, launches } = makeHarness();
  await prepare(driver);
  const result = await driver.execute({
    scenarioId: "app-start-v1",
    stateHandle: "sealed-p0",
    case: { caseId: "new-start", startMode: "new-application-state" },
  });
  assert.deepStrictEqual(launches, [{ stateHandle: "sealed-p0", initialSessionId: "control" }]);
  assert.equal(result.durationMs, 4);
});

it("normalizes the OS process start time to the monitor second bucket", () => {
  assert.equal(
    parseProcessStartTime("Sun Aug  9 13:35:41 2026\n", 200),
    Date.parse("Sun Aug  9 13:35:41 2026"),
  );
  assert.throws(() => parseProcessStartTime("not-a-process-time", 200), /Invalid start time/u);
});
