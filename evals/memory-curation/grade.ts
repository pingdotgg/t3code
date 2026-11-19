import type { ProjectMemoryCurationResult } from "@t3tools/provider-core/server/textGeneration";
import type { CurationCase } from "./cases.ts";

export const grade = (fixture: CurationCase, result: ProjectMemoryCurationResult) =>
  fixture.expected.every((expected) => {
    const decision = result.decisions.find((entry) => entry.factId === expected.factId);
    return (
      (decision?.action ?? "keep") === expected.action &&
      (expected.replacementFactId === undefined ||
        (decision?.action === "supersede" &&
          decision.replacementFactId === expected.replacementFactId))
    );
  });
