import { assert, describe, expect, it } from "@effect/vitest";

import {
  resolveDriverCommand,
  runBenchmarkCli,
  scenariosForProfiles,
} from "./agent-app-benchmark.ts";

describe("agent app benchmark CLI", () => {
  it("runs TypeScript and JavaScript drivers through the current Node executable", () => {
    assert.deepStrictEqual(resolveDriverCommand("/tmp/driver.ts", "/usr/bin/node"), {
      command: "/usr/bin/node",
      args: ["/tmp/driver.ts"],
    });
    assert.deepStrictEqual(resolveDriverCommand("/tmp/driver", "/usr/bin/node"), {
      command: "/tmp/driver",
      args: [],
    });
  });

  it("derives only the scenarios belonging to selected capability profiles", () => {
    assert.deepStrictEqual(scenariosForProfiles(["resource-core-v1"]), [
      "resource-sweep-v1",
      "resource-quiescence-v1",
    ]);
    assert.deepStrictEqual(scenariosForProfiles(["workspace-core-v1", "resource-core-v1"]), [
      "app-cold-ready-v1",
      "work-item-cold-open-v1",
      "work-item-warm-switch-v1",
      "resource-sweep-v1",
      "resource-quiescence-v1",
    ]);
  });

  it("requires an explicit environment disclosure for publication output", async () => {
    await expect(
      runBenchmarkCli({
        appDriver: "driver",
        corpus: "corpus",
        profiles: "workspace-core-v1",
        runProfile: "publication",
        seed: 1,
        output: "artifacts",
        environment: undefined,
        diagnostic: false,
        resourceMonitor: "resource-monitor",
        shareableReport: false,
      }),
    ).rejects.toThrow(/explicit --environment disclosure/u);
  });
});
