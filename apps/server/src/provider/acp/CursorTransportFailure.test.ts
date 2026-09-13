import { describe, expect, it } from "vite-plus/test";

import { CursorTransportFailure } from "./CursorTransportFailure.ts";

const diagnostic = "Error: RetriableError: WritableIterable is closed";

function failureFor(chunks: string[]) {
  const reply = new CursorTransportFailure();
  for (const chunk of chunks) reply.push(chunk);
  return reply.failure;
}

describe("CursorTransportFailure", () => {
  it.each([
    diagnostic,
    "Error: ConnectError: [unavailable] transport closed",
    "Error: ConnectError: [aborted] aborted",
    "Error: ConnectError: [deadline_exceeded] timed out",
    "Something went wrong communicating with the server. Please try again.",
  ])("recognizes a terminal diagnostic: %s", (message) => {
    expect(failureFor([message])).toBe(message);
    expect(failureFor([...message])).toBe(message);
  });

  it("recognizes a standalone failure with a stack trace", () => {
    expect(failureFor(["\n", diagnostic, "\n    at send (cli.js:1:2)\n\n"])).toBe(diagnostic);
  });

  it.each([
    "The error was " + diagnostic,
    "This is an example of a transport error:\n" + diagnostic,
    "I inspected the files.\n" + diagnostic,
    "> " + diagnostic,
    "    " + diagnostic,
    "```text\n" + diagnostic + "\n```",
    "~~~\n" + diagnostic + "\n~~~",
    diagnostic + "\nThis is an example of a transport error.",
    "Error: ConnectError: [unauthenticated] sign in",
    "Error: ConnectError: [permission_denied] subscription required",
    "Error: HTTP 500 from the application being debugged",
  ])("preserves prose, code and non-transport errors: %s", (message) => {
    expect(failureFor([...message])).toBeUndefined();
  });

  it("tracks fences across long lines without retaining the answer", () => {
    expect(failureFor(["```\n", "x".repeat(100_000), "\n", diagnostic])).toBeUndefined();
    expect(failureFor(["```", "x".repeat(100_000), "\n", diagnostic])).toBeUndefined();
    expect(failureFor(["x".repeat(100_000), "\n", diagnostic])).toBeUndefined();
  });

  it("does not retain a previous failure after new output", () => {
    const reply = new CursorTransportFailure();
    reply.push(diagnostic);
    expect(reply.failure).toBe(diagnostic);
    reply.push("\nRecovered successfully.");
    expect(reply.failure).toBeUndefined();
  });
});
