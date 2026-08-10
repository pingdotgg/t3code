// @effect-diagnostics nodeBuiltinImport:off - The audit test validates the checked-in manifest from the repository filesystem.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  classifyPaths,
  decodeInventory,
  validateInventory,
} from "./check-legacy-donor-inventory.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const inventoryPath = NodePath.join(repoRoot, "docs/auldric-system/legacy-donor-inventory.json");

describe("legacy donor inventory", () => {
  it("contains a structurally complete record for every ordered selector", () => {
    const report = validateInventory(inventoryPath);

    assert.isTrue(report.ok, report.problems.join("\n"));
    assert.isAbove(report.totalEntries, 40);
    assert.deepStrictEqual(
      Object.values(report.entryCounts).every((count) => count > 0),
      true,
    );
  });

  it("makes the high-risk ownership boundary explicit", () => {
    const value = JSON.parse(NodeFS.readFileSync(inventoryPath, "utf8")) as unknown;
    const decoded = decodeInventory(value);
    assert.isNotNull(decoded.inventory);

    const result = classifyPaths(
      decoded.inventory!,
      [
        "packages/contracts/src/auldric/day0OperatingPacket.ts",
        "apps/server/src/auldric/prompting/promptCompiler.ts",
        "apps/web/src/auldric/auth/auldricCredentialRuntime.ts",
        "apps/server/src/provider/codex.ts",
        "docs/reports/wtx389/day0-decision-dashboard-desktop.png",
        "apps/server/src/auldric/voice/openAIVoiceProvider.ts",
      ],
      false,
    );

    assert.deepStrictEqual(result.problems, []);
    assert.deepStrictEqual(result.fileCounts, {
      "keep-rebuild": 1,
      split: 1,
      "replace-with-t3": 2,
      retire: 0,
      "upstream-dependency": 1,
      "historical-evidence": 1,
    });
  });
});
