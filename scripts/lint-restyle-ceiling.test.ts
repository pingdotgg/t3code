import { assert, describe, it } from "@effect/vitest";

import { countRestyleFindings, evaluateCeiling } from "./lint-restyle-ceiling.ts";

describe("lint-restyle-ceiling", () => {
  it("counts only no-restyle diagnostics", () => {
    const count = countRestyleFindings({
      diagnostics: [
        { code: "shadcn(no-restyle)" },
        { code: "react(refs)" },
        { code: "shadcn(no-restyle)" },
      ],
    });
    assert.strictEqual(count, 2);
  });

  it("fails above the ceiling and passes at or below it", () => {
    assert.isFalse(evaluateCeiling(11, 10).ok);
    assert.isTrue(evaluateCeiling(10, 10).ok);
    const below = evaluateCeiling(7, 10);
    assert.isTrue(below.ok);
    assert.include(below.message, "Lower RESTYLE_CEILING");
  });
});
