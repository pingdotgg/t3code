/**
 * Integration test for AugmentACPManager against actual Auggie CLI.
 *
 * Run with: bun run vitest run src/augmentACPManager.integration.test.ts
 *
 * Prerequisites:
 * - Auggie CLI installed and available on PATH
 * - Auggie authenticated (run `auggie login` first)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import { AugmentACPManager } from "./augmentACPManager.ts";

describe("AugmentACPManager Integration", () => {
  let manager: AugmentACPManager;

  beforeAll(() => {
    manager = new AugmentACPManager();
  });

  afterEach(() => {
    manager.stopAll();
  });

  afterAll(() => {
    manager.stopAll();
  });

  it("should start a session with auggie --acp", async () => {
    const threadId = ThreadId.makeUnsafe("test-thread-1");

    const events: string[] = [];
    manager.on("event", (event) => {
      events.push(event.method);
      console.log("Event:", event.method, event.message ?? "");
    });

    const session = await manager.startSession({
      threadId,
      runtimeMode: "full-access",
      cwd: process.cwd(),
    });

    expect(session.provider).toBe("augment");
    expect(session.status).toBe("ready");
    expect(session.threadId).toBe(threadId);

    // Check we got lifecycle events
    expect(events).toContain("session/connecting");
    expect(events).toContain("session/ready");

    // Check available models were fetched
    const models = manager.getAvailableModels(threadId);
    expect(models.length).toBeGreaterThan(0);
    console.log(
      "Available models:",
      models.map((m) => m.modelId),
    );
  }, 30_000);

  it("should send a turn and receive streaming responses", async () => {
    const threadId = ThreadId.makeUnsafe("test-thread-2");

    const events: Array<{ method: string; textDelta?: string | undefined }> = [];
    manager.on("event", (event) => {
      events.push({ method: event.method, textDelta: event.textDelta ?? undefined });
      if (event.textDelta) {
        process.stdout.write(event.textDelta);
      }
    });

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
      cwd: process.cwd(),
    });

    const turnResult = await manager.sendTurn({
      threadId,
      input: "What is 2+2? Reply with just the number, nothing else.",
    });

    expect(turnResult.threadId).toBe(threadId);
    expect(turnResult.turnId).toBeDefined();

    // Wait for the turn to complete (streaming events will come in)
    await new Promise<void>((resolve) => {
      const checkComplete = () => {
        const hasCompleted = events.some((e) => e.method === "turn/completed");
        if (hasCompleted) {
          resolve();
        } else {
          setTimeout(checkComplete, 100);
        }
      };
      checkComplete();
    });

    // Check we got streaming content
    const deltas = events.filter((e) => e.method === "item/agentMessage/delta");
    expect(deltas.length).toBeGreaterThan(0);

    console.log("\n\nTotal events:", events.length);
    console.log(
      "Event types:",
      [...new Set(events.map((e) => e.method))].join(", "),
    );
  }, 60_000);

  it("should interrupt a turn", async () => {
    const threadId = ThreadId.makeUnsafe("test-thread-3");

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
      cwd: process.cwd(),
    });

    const turnPromise = manager.sendTurn({
      threadId,
      input: "Write a very long essay about the history of computing. Make it at least 1000 words.",
    });

    // Wait a bit then interrupt
    await new Promise((r) => setTimeout(r, 2000));
    await manager.interruptTurn(threadId);

    const turnResult = await turnPromise;
    expect(turnResult.turnId).toBeDefined();
  }, 30_000);

  it("should stop a session cleanly", async () => {
    const threadId = ThreadId.makeUnsafe("test-thread-4");

    await manager.startSession({
      threadId,
      runtimeMode: "full-access",
      cwd: process.cwd(),
    });

    expect(manager.hasSession(threadId)).toBe(true);

    manager.stopSession(threadId);

    expect(manager.hasSession(threadId)).toBe(false);
  }, 30_000);
});

