import { describe, expect, it } from "vite-plus/test";

import { parseWorkerPairingMaterial } from "./gatewayClient.ts";

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
