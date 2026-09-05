import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { environmentPresentationSettlingKey } from "./presentation.ts";

function presentation(phase: "connected" | "connecting" | "reconnecting", hasConfig: boolean) {
  return {
    connection: { phase },
    serverConfig: hasConfig ? {} : null,
  };
}

describe("environmentPresentationSettlingKey", () => {
  it("identifies and sorts only environments whose presentation is incomplete", () => {
    const presentations = new Map([
      [EnvironmentId.make("ready"), presentation("connected", true)],
      [EnvironmentId.make("z-reconnecting"), presentation("reconnecting", true)],
      [EnvironmentId.make("a-connecting"), presentation("connecting", false)],
      [EnvironmentId.make("m-awaiting-config"), presentation("connected", false)],
    ]);

    expect(environmentPresentationSettlingKey(presentations as never)).toBe(
      '["a-connecting","m-awaiting-config","z-reconnecting"]',
    );
    expect(
      environmentPresentationSettlingKey(
        new Map([[EnvironmentId.make("ready"), presentation("connected", true)]]) as never,
      ),
    ).toBeNull();
  });

  it("keeps distinct environment sets collision-free when IDs contain delimiters", () => {
    const left = new Map([
      [EnvironmentId.make("a"), presentation("connecting", false)],
      [EnvironmentId.make("b|c"), presentation("connecting", false)],
    ]);
    const right = new Map([
      [EnvironmentId.make("a|b"), presentation("connecting", false)],
      [EnvironmentId.make("c"), presentation("connecting", false)],
    ]);

    expect(environmentPresentationSettlingKey(left as never)).toBe('["a","b|c"]');
    expect(environmentPresentationSettlingKey(right as never)).toBe('["a|b","c"]');
    expect(environmentPresentationSettlingKey(left as never)).not.toBe(
      environmentPresentationSettlingKey(right as never),
    );
  });
});
