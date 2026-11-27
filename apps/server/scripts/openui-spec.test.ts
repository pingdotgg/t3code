import { describe, expect, it } from "@effect/vitest";

import committed from "../src/htmlRender/openUiSpec.generated.json" with { type: "json" };
import { buildOpenUiSpec } from "./openui-spec.ts";

describe("OpenUI spec", () => {
  it("matches the installed browser bundle; run node scripts/openui-spec.ts after upgrading", () => {
    expect(buildOpenUiSpec()).toEqual(committed);
  });
});
