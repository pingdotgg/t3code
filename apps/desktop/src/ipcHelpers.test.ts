import { describe, expect, it, vi } from "vitest";

import { withParsedArgs, withParsedPayload } from "./ipcHelpers";

describe("withParsedPayload", () => {
  it("parses payload and passes typed input to handler", async () => {
    const handler = vi.fn(async (_event: unknown, payload: { value: string }) =>
      payload.value.toUpperCase(),
    );
    const wrapped = withParsedPayload(
      {
        parse(payload: unknown): { value: string } {
          if (
            !payload ||
            typeof payload !== "object" ||
            typeof (payload as { value?: unknown }).value !== "string"
          ) {
            throw new Error("Invalid payload");
          }

          return { value: (payload as { value: string }).value };
        },
      },
      handler,
    );

    const result = await wrapped({}, { value: "hello" });
    expect(result).toBe("HELLO");
    expect(handler).toHaveBeenCalledWith({}, { value: "hello" });
  });

  it("throws and does not call handler on invalid payload", async () => {
    const handler = vi.fn(async () => "ok");
    const wrapped = withParsedPayload(
      {
        parse(payload: unknown): { value: string } {
          if (
            !payload ||
            typeof payload !== "object" ||
            typeof (payload as { value?: unknown }).value !== "string"
          ) {
            throw new Error("Invalid payload");
          }

          return { value: (payload as { value: string }).value };
        },
      },
      handler,
    );

    expect(() => wrapped({}, { value: 123 })).toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("withParsedArgs", () => {
  it("parses tuple arguments before invoking handler", () => {
    const handler = vi.fn((_event: unknown, sessionId: string, data: string) => {
      return `${sessionId}:${data}`;
    });
    const wrapped = withParsedArgs(
      {
        parse(args: unknown[]): [string, string] {
          const [sessionId, data] = args;
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            throw new Error("Invalid sessionId");
          }
          if (typeof data !== "string") {
            throw new Error("Invalid data");
          }

          return [sessionId, data];
        },
      },
      handler,
    );

    expect(wrapped({}, "abc", "input")).toBe("abc:input");
    expect(handler).toHaveBeenCalledWith({}, "abc", "input");
  });

  it("throws and does not call handler when args are invalid", () => {
    const handler = vi.fn();
    const wrapped = withParsedArgs(
      {
        parse(args: unknown[]): [string, string] {
          const [sessionId, data] = args;
          if (typeof sessionId !== "string" || sessionId.length === 0) {
            throw new Error("Invalid sessionId");
          }
          if (typeof data !== "string") {
            throw new Error("Invalid data");
          }

          return [sessionId, data];
        },
      },
      handler,
    );

    expect(() => wrapped({}, 123, "input")).toThrow();
    expect(handler).not.toHaveBeenCalled();
  });
});
