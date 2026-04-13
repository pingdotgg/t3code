import { describe, expect, it } from "vitest";

import { ServerListeningDetector } from "./serverListeningDetector";

describe("ServerListeningDetector", () => {
  it("resolves when the server logs the listening line", async () => {
    const detector = new ServerListeningDetector();

    detector.push("[01:23:30.571] INFO (#148): Listening on http://0.0.0.0:7011\n");

    await expect(detector.promise).resolves.toBeUndefined();
  });

  it("resolves when the listening line arrives across multiple chunks", async () => {
    const detector = new ServerListeningDetector();

    detector.push("[01:23:30.571] INFO (#148): Listen");
    detector.push("ing on http://0.0.0.0:7011\n");

    await expect(detector.promise).resolves.toBeUndefined();
  });

  it("rejects when the server exits before logging readiness", async () => {
    const detector = new ServerListeningDetector();
    const error = new Error("server exited");

    detector.fail(error);

    await expect(detector.promise).rejects.toBe(error);
  });
});
