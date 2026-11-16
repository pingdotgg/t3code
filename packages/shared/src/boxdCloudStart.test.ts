import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";

import {
  NOT_HOSTED_MARKER,
  PAIRING_MARKER,
  checkoutScript,
  prepareSnapshotScript,
  startServerScript,
} from "./boatCloudVm.ts";
import {
  boxdMachineStateOf,
  onBoxd,
  parseBoxdRepository,
  parseServerStart,
  startingSnapshot,
} from "./boxdCloudStart.ts";

const descriptor = JSON.stringify({ environmentId: "env-1", label: "T3" });
const pairing = JSON.stringify({ credential: "code-1", expiresAt: "2026-11-16T12:00:00.000Z" });

describe("boxd cloud start", () => {
  it("runs Boat's VM scripts in boxd's home directory", () => {
    const repository = parseBoxdRepository("git@github.com:acme/app.git")!;
    assert.strictEqual(repository.workspaceRoot, "/home/boxd/projects/github.com/acme/app");
    for (const script of [
      startServerScript("boxd cloud"),
      prepareSnapshotScript,
      checkoutScript(repository, "main", {
        path: "/home/boxd/.t3/worktrees/app/t3code-1",
        branch: "t3code-1",
        baseBranch: "main",
      }),
    ]) {
      assert.notInclude(onBoxd(script), "/home/user");
    }
  });

  it("reads the descriptor and pairing code past Boat's hosting marker", () => {
    const output = `${NOT_HOSTED_MARKER}\n${descriptor}\n${PAIRING_MARKER}\n${pairing}\n`;
    assert.deepStrictEqual(parseServerStart(output, true), {
      environmentId: EnvironmentId.make("env-1"),
      pairing: { code: "code-1", expiresAt: Date.parse("2026-11-16T12:00:00.000Z") },
    });
    assert.deepStrictEqual(parseServerStart(`${descriptor}\n`, false), {
      environmentId: EnvironmentId.make("env-1"),
      pairing: null,
    });
    // A start that asked for a code and got none is a failure, not a reconnect.
    assert.isNull(parseServerStart(`${descriptor}\n`, true));
    assert.isNull(parseServerStart("T3 Code is not installed on this VM.", false));
  });

  it("treats a sleeping machine as one a connection wakes", () => {
    assert.strictEqual(boxdMachineStateOf("running"), "running");
    assert.strictEqual(boxdMachineStateOf("hibernated"), "asleep");
    assert.strictEqual(boxdMachineStateOf("suspended"), "asleep");
    assert.strictEqual(boxdMachineStateOf("stopped"), "stopped");
  });

  it("starts machines from the newest ready T3 snapshot", () => {
    assert.strictEqual(
      startingSnapshot([
        { name: "t3-code-0-1-8", status: "ready", updatedAt: 1 },
        { name: "t3-code-0-1-9", status: "pending", updatedAt: 3 },
        { name: "someone-elses", status: "ready", updatedAt: 4 },
        { name: "t3-code-0-1-9-boat-2", status: "ready", updatedAt: 2 },
      ]),
      "t3-code-0-1-9-boat-2",
    );
    assert.isNull(startingSnapshot([]));
  });
});
