import type { ComputerAction, ComputerVerdict } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import * as ComputerPolicy from "./ComputerPolicy.ts";
import golden from "./policy_golden.json" with { type: "json" };

interface Golden {
  readonly control: ReadonlyArray<{ readonly kind: string; readonly verdict: ComputerVerdict }>;
  readonly screen: ReadonlyArray<{
    readonly action: ComputerAction;
    readonly verdict: ComputerVerdict;
  }>;
}

const cases = golden as Golden;

it.each(cases.control.map(({ kind, verdict }) => [kind, verdict] as const))(
  "control %s is %s",
  (kind, verdict) => {
    assert.strictEqual(ComputerPolicy.control(kind).verdict, verdict);
  },
);

const screenRows = cases.screen.map(({ action, verdict }) => {
  const target = action.label ?? action.key ?? action.direction ?? action.name ?? action.url ?? "";
  return [
    `${action.kind} ${action.role ?? ""} ${JSON.stringify(target)}`,
    action,
    verdict,
  ] as const;
});

it.each(screenRows)("%s is %s", (_name, action, verdict) => {
  assert.strictEqual(ComputerPolicy.screen(action).verdict, verdict);
});

it("an over-long label is refused rather than clipped past its consequential word", () => {
  assert.strictEqual(
    ComputerPolicy.screen({ kind: "click", role: "button", label: `${" ".repeat(600)}Send` })
      .verdict,
    "refused",
  );
});

it("a pointer step is the person's to allow", () => {
  assert.deepStrictEqual(ComputerPolicy.screen({ kind: "pointer" }), {
    verdict: "tap",
    why: "it needs your mouse for a moment",
  });
});

it("limits count UTF-8 bytes, not characters", () => {
  // 201 × "é" is 201 characters but 402 bytes, past the label limit.
  assert.strictEqual(
    ComputerPolicy.screen({ kind: "click", role: "button", label: "é".repeat(201) }).verdict,
    "refused",
  );
  assert.strictEqual(
    ComputerPolicy.screen({
      kind: "type",
      role: "textbox",
      label: "Search",
      text: "é".repeat(2_001),
    }).verdict,
    "refused",
  );
});
