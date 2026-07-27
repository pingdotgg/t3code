import { toConsumerSettings } from "@/Cloudflare/Queues/EventSource.ts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "alchemy-test";

describe("toConsumerSettings", () => {
  it("passes scalar fields through unchanged", () => {
    expect(
      toConsumerSettings({
        batchSize: 25,
        maxConcurrency: 4,
        maxRetries: 3,
      }),
    ).toEqual({
      batchSize: 25,
      maxConcurrency: 4,
      maxRetries: 3,
      maxWaitTimeMs: undefined,
      retryDelay: undefined,
    });
  });

  it("converts maxWaitTime to whole milliseconds", () => {
    expect(
      toConsumerSettings({ maxWaitTime: Duration.seconds(5) }).maxWaitTimeMs,
    ).toBe(5_000);
    expect(
      toConsumerSettings({ maxWaitTime: "250 millis" }).maxWaitTimeMs,
    ).toBe(250);
    expect(toConsumerSettings({ maxWaitTime: 1500 }).maxWaitTimeMs).toBe(1500);
  });

  it("rounds sub-millisecond maxWaitTime up", () => {
    expect(
      toConsumerSettings({ maxWaitTime: Duration.nanos(1n) }).maxWaitTimeMs,
    ).toBe(1);
  });

  it("converts retryDelay to whole seconds", () => {
    expect(
      toConsumerSettings({ retryDelay: Duration.minutes(2) }).retryDelay,
    ).toBe(120);
    expect(toConsumerSettings({ retryDelay: "30 seconds" }).retryDelay).toBe(
      30,
    );
  });

  it("rounds partial-second retryDelay up", () => {
    expect(
      toConsumerSettings({ retryDelay: Duration.millis(1500) }).retryDelay,
    ).toBe(2);
  });

  it("leaves missing time fields undefined", () => {
    const result = toConsumerSettings({ batchSize: 10 });
    expect(result.maxWaitTimeMs).toBeUndefined();
    expect(result.retryDelay).toBeUndefined();
  });
});
