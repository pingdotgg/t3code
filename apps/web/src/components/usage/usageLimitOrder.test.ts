import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { usageLimitOrder } from "./usageLimitOrder";

const drivers = (...values: string[]) => values.map((value) => ProviderDriverKind.make(value));

describe("usageLimitOrder", () => {
  it("keeps the existing order until a preference is saved", () => {
    const available = drivers("codex", "cursor", "claudeAgent");
    expect(usageLimitOrder([], available)).toEqual(available);
  });

  it("keeps hidden and disconnected providers in the saved order and appends new ones", () => {
    const saved = drivers("claudeAgent", "codex", "cursor");
    const available = drivers("codex", "grok");
    const order = usageLimitOrder(saved, available);
    expect(order).toEqual(drivers("claudeAgent", "codex", "cursor", "grok"));
    expect(usageLimitOrder(order, drivers("cursor", "claudeAgent", "codex", "grok"))).toEqual(
      order,
    );
  });

  it("deduplicates saved providers", () => {
    expect(usageLimitOrder(drivers("claudeAgent", "claudeAgent"), drivers("codex"))).toEqual(
      drivers("claudeAgent", "codex"),
    );
  });
});
