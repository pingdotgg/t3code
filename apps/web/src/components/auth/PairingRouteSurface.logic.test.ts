import { describe, expect, it } from "vite-plus/test";

import { claimPairingToken, createPairingSubmissionQueue } from "./PairingRouteSurface.logic";

describe("claimPairingToken", () => {
  it("claims each pairing token once", () => {
    const attemptedTokens = new Set<string>();

    expect(claimPairingToken("first-token", attemptedTokens)).toBe("first-token");
    expect(claimPairingToken("first-token", attemptedTokens)).toBeNull();
    expect(claimPairingToken("second-token", attemptedTokens)).toBe("second-token");
  });

  it("ignores a URL without a pairing token", () => {
    expect(claimPairingToken(null, new Set<string>())).toBeNull();
  });

  it("serializes pairing submissions", async () => {
    const queue = createPairingSubmissionQueue();
    const events: Array<string> = [];
    let finishFirst: (() => void) | undefined;

    const first = queue.run(
      () =>
        new Promise<void>((resolve) => {
          events.push("first:start");
          finishFirst = () => {
            events.push("first:finish");
            resolve();
          };
        }),
    );
    const second = queue.run(async () => {
      events.push("second:start");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    finishFirst?.();
    await first;
    await second;
    expect(events).toEqual(["first:start", "first:finish", "second:start"]);
  });

  it("continues the queue after a rejected pairing submission", async () => {
    const queue = createPairingSubmissionQueue();
    const expectedError = new Error("pairing failed");
    const first = queue.run(async () => {
      throw expectedError;
    });
    const second = queue.run(async () => "paired");

    await expect(first).rejects.toBe(expectedError);
    await expect(second).resolves.toBe("paired");
  });
});
