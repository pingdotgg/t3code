import { describe, expect, it } from "vite-plus/test";

import {
  isSandboxNotFoundError,
  parseDeleteOutcome,
  parseWorkerPairingMaterial,
} from "./gatewayClient.ts";

const valid = JSON.stringify({
  environmentId: "environment-worker-1",
  url: "https://worker.example.com/mcp",
  bootstrapCredential: "pair-one-time-1",
});

describe("parseWorkerPairingMaterial", () => {
  it("parses what a ready worker prints over gateway exec", () => {
    expect(parseWorkerPairingMaterial(valid)).toEqual({
      environmentId: "environment-worker-1",
      url: "https://worker.example.com/mcp",
      bootstrapCredential: "pair-one-time-1",
    });
  });

  it("refuses empty fields", () => {
    const blank = JSON.stringify({
      environmentId: "environment-worker-1",
      url: "",
      bootstrapCredential: "pair-one-time-1",
    });
    expect(() => parseWorkerPairingMaterial(blank)).toThrow();
  });

  it("refuses non-JSON output", () => {
    expect(() => parseWorkerPairingMaterial("t3 serve is starting…")).toThrow();
  });
});

describe("parseDeleteOutcome", () => {
  it("reads the SDK 0.1.7 object shape", () => {
    expect(parseDeleteOutcome({ outcome: "completed" })).toBe("completed");
    expect(parseDeleteOutcome({ outcome: "Accepted" })).toBe("accepted");
    expect(parseDeleteOutcome({ outcome: "already_absent" })).toBe("already_absent");
  });

  it("reads the older plain-string shape", () => {
    expect(parseDeleteOutcome("accepted")).toBe("accepted");
    expect(parseDeleteOutcome("Completed")).toBe("completed");
  });

  it("throws on an unknown outcome value", () => {
    expect(() => parseDeleteOutcome({ outcome: "banana" })).toThrow();
  });

  it("throws on an unreadable shape", () => {
    expect(() => parseDeleteOutcome(42)).toThrow();
    expect(() => parseDeleteOutcome({})).toThrow();
  });
});

describe("isSandboxNotFoundError", () => {
  it("counts only confirmed absence answers", () => {
    expect(isSandboxNotFoundError(Object.assign(new Error("no sandbox"), { status: 404 }))).toBe(
      true,
    );
    expect(isSandboxNotFoundError({ statusCode: 404 })).toBe(true);
    expect(isSandboxNotFoundError({ code: "not_found" })).toBe(true);
    expect(isSandboxNotFoundError(new Error("GET /sandbox/x answered 404"))).toBe(true);
    expect(isSandboxNotFoundError(new Error("sandbox not found"))).toBe(true);
  });

  it("treats transport and other failures as presence unknown", () => {
    expect(isSandboxNotFoundError(new Error("network unreachable"))).toBe(false);
    expect(isSandboxNotFoundError({ status: 500 })).toBe(false);
    expect(isSandboxNotFoundError({ status: 403 })).toBe(false);
    expect(isSandboxNotFoundError(undefined)).toBe(false);
  });
});
