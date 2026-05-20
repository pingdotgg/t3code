import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it, vi } from "vitest";
import { createServerSettingsWriteQueue } from "./serverSettingsWriteQueue";

describe("serverSettingsWriteQueue", () => {
  it("serializes server settings writes so later calls cannot be overtaken", async () => {
    const applied: Array<number> = [];
    const updateSettings = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ...DEFAULT_SERVER_SETTINGS,
        automaticGitFetchInterval: Duration.seconds(10),
      }))
      .mockImplementationOnce(async () => ({
        ...DEFAULT_SERVER_SETTINGS,
        automaticGitFetchInterval: Duration.seconds(25),
      }));
    const queue = createServerSettingsWriteQueue({
      updateSettings,
      applySettings: (settings) => {
        applied.push(Duration.toMillis(settings.automaticGitFetchInterval));
      },
      onError: vi.fn(),
    });

    queue.enqueue({ automaticGitFetchInterval: Duration.seconds(10) });
    queue.enqueue({ automaticGitFetchInterval: Duration.seconds(25) });
    await queue.drain();

    expect(updateSettings).toHaveBeenNthCalledWith(1, {
      automaticGitFetchInterval: Duration.seconds(10),
    });
    expect(updateSettings).toHaveBeenNthCalledWith(2, {
      automaticGitFetchInterval: Duration.seconds(25),
    });
    expect(applied).toEqual([10_000, 25_000]);
  });
});
