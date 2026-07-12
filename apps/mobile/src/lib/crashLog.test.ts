import { describe, expect, it } from "vite-plus/test";

import { addBreadcrumb, clearBreadcrumbs } from "./breadcrumbs";
import { buildCrashRecord, buildMinimalCrashRecord, shouldPersistNonFatal } from "./crashLogRecord";

describe("crashLog records", () => {
  it("captures message, stack, and breadcrumbs for fatals", () => {
    clearBreadcrumbs();
    addBreadcrumb("nav", { path: "Thread" });
    addBreadcrumb("outbox.dispatch", { messageId: "m1" });

    const error = new Error("boom");
    const record = buildCrashRecord(error, true, 7);

    expect(record.isFatal).toBe(true);
    expect(record.message).toBe("boom");
    expect(record.name).toBe("Error");
    expect(record.handlerInvocation).toBe(7);
    expect(record.source).toBe("error-utils");
    expect(record.stack).toContain("boom");
    expect(record.breadcrumbs.map((entry) => entry.type)).toEqual(["nav", "outbox.dispatch"]);
  });

  it("builds a minimal record without breadcrumbs for the first write", () => {
    clearBreadcrumbs();
    addBreadcrumb("nav", { path: "Thread" });

    const record = buildMinimalCrashRecord(new Error("early"), true, 1);
    expect(record.breadcrumbs).toEqual([]);
    expect(record.message).toBe("early");
    expect(record.source).toBe("error-utils");
    expect(record.isFatal).toBe(true);
  });

  it("stringifies non-Error values", () => {
    clearBreadcrumbs();
    const record = buildCrashRecord("string-throw", false, 1);
    expect(record.message).toBe("string-throw");
    expect(record.name).toBeNull();
    expect(record.stack).toBeNull();
    expect(record.isFatal).toBe(false);
  });

  it("truncates huge messages and stacks", () => {
    const huge = "x".repeat(20_000);
    const error = new Error(huge);
    error.stack = "y".repeat(60_000);
    const record = buildMinimalCrashRecord(error, true, 1);
    expect(record.message.length).toBeLessThanOrEqual(8_001);
    expect(record.stack?.length).toBeLessThanOrEqual(48_001);
  });

  it("only persists non-fatals that look like real Errors with stacks", () => {
    expect(shouldPersistNonFatal(new Error("x"))).toBe(true);
    expect(shouldPersistNonFatal("x")).toBe(false);
    expect(shouldPersistNonFatal({ message: "x" })).toBe(false);
  });
});
