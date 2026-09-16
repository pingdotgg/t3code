import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { DesktopAppConnectionRequest } from "./desktopAppConnection.ts";

const isRequest = Schema.is(DesktopAppConnectionRequest);
const base = { version: 1, requestId: "r", type: "connection", environmentId: "env-1" } as const;

describe("DesktopAppConnectionRequest", () => {
  it("accepts the six operations with their required fields", () => {
    expect(
      isRequest({ version: 1, requestId: "r", type: "connection", operation: "listEnvironments" }),
    ).toBe(true);
    expect(isRequest({ ...base, operation: "shell" })).toBe(true);
    expect(isRequest({ ...base, operation: "archived" })).toBe(true);
    expect(isRequest({ ...base, operation: "providers" })).toBe(true);
    expect(
      isRequest({ ...base, operation: "thread", threadId: "t", turnLimit: 5, beforeCursor: "c" }),
    ).toBe(true);
    expect(
      isRequest({
        ...base,
        operation: "dispatch",
        command: { type: "thread.archive", commandId: "c", threadId: "t" },
      }),
    ).toBe(true);
  });

  it("rejects missing environment ids, bad windows, and unknown operations", () => {
    expect(isRequest({ version: 1, requestId: "r", type: "connection", operation: "shell" })).toBe(
      false,
    );
    expect(isRequest({ ...base, operation: "thread", threadId: "t", turnLimit: 0 })).toBe(false);
    expect(isRequest({ ...base, operation: "thread", threadId: "t", beforeCursor: "" })).toBe(
      false,
    );
    expect(isRequest({ ...base, operation: "subscribe" })).toBe(false);
    expect(isRequest({ ...base, operation: "shell", version: 2 })).toBe(false);
  });

  it("only forwards the allowed command subset", () => {
    for (const type of [
      "thread.checkpoint.revert",
      "thread.conversation.revert",
      "project.delete",
      "thread.runtime-mode.set",
      "thread.session.set",
    ]) {
      expect(
        isRequest({
          ...base,
          operation: "dispatch",
          command: {
            type,
            commandId: "c",
            threadId: "t",
            projectId: "p",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ).toBe(false);
    }
  });
});
