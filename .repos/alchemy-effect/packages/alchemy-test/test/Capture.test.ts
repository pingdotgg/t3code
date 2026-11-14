import { expect, it } from "@alchemy.run/test";
import { makeCapture } from "../src/Capture.ts";

it("bounds previews while persisting every complete original message", () => {
  const capture = makeCapture({ capture: 4096, total: 8192 });
  const persisted: string[] = [];
  const logs = capture.create((entry) => persisted.push(entry.message));
  const messages = Array.from({ length: 100 }, (_, index) => `${index}: ${"🧪".repeat(1000)}`);
  for (const message of messages) logs.push({ message, level: "info", time: new Date(0) });
  expect(persisted).toEqual(messages);
  expect(
    logs.reduce((total, log) => total + Buffer.byteLength(log.message) + 64, 0),
  ).toBeLessThanOrEqual(4096);
  expect(logs.some((log) => log.message.includes("omitted from preview"))).toBe(true);
});

it("bounds combined previews and reuses the same live array across retries", () => {
  const capture = makeCapture({ capture: 4096, total: 8192 });
  const buffers = Array.from({ length: 20 }, () => capture.create(() => {}));
  for (const buffer of buffers) {
    for (let i = 0; i < 10; i++)
      buffer.push({
        message: "x".repeat(500),
        level: "info",
        time: new Date(0),
      });
  }
  expect(
    buffers.flat().reduce((total, log) => total + Buffer.byteLength(log.message) + 64, 0),
  ).toBeLessThanOrEqual(8192);
  const reused = buffers.at(-1)!;
  capture.release(reused);
  expect(reused.length).toBe(0);
  reused.push({ message: "retry", level: "info", time: new Date(0) });
  expect(reused[0]!.message).toBe("retry");
});
