import { expect, it } from "@effect/vitest";
import { permitsOrdinaryElicitation, withHostElicitation } from "./codexHostElicitation.ts";

it("enables host verification while keeping every execution approval at its original setting", () => {
  expect(withHostElicitation("never", false)).toBe("never");
  expect(withHostElicitation("never", true)).toEqual({
    granular: {
      mcp_elicitations: true,
      rules: false,
      sandbox_approval: false,
      request_permissions: false,
      skill_approval: false,
    },
  });
  expect(withHostElicitation("untrusted", true)).toBe("untrusted");
  expect(
    withHostElicitation(
      { granular: { mcp_elicitations: false, rules: true, sandbox_approval: true } },
      true,
    ),
  ).toEqual({ granular: { mcp_elicitations: true, rules: true, sandbox_approval: true } });
  expect(permitsOrdinaryElicitation("never", false)).toBe(false);
  expect(permitsOrdinaryElicitation(undefined, true)).toBe(false);
  expect(permitsOrdinaryElicitation(undefined, false)).toBe(true);
  expect(permitsOrdinaryElicitation({ granular: { mcp_elicitations: false } }, false)).toBe(false);
});
