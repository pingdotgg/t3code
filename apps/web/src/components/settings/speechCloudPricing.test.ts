import { describe, expect, it } from "vite-plus/test";

import { formatSpeechCloudPrice } from "./speechCloudPricing";

describe("formatSpeechCloudPrice", () => {
  it.each([
    ["per-second audio", { prompt: "0.0001", completion: "0" }, "$0.36/hr"],
    ["per-hour audio", { prompt: "0.1", completion: "0" }, "$0.10/hr"],
    ["tokens", { prompt: "0.000002", completion: "0.000012" }, "$2/M in, $12/M out"],
    ["free", { prompt: "0", completion: "0" }, "Free"],
    ["unparseable", { prompt: "-1", completion: "0" }, null],
  ])("formats %s", (_name, pricing, expected) => {
    expect(formatSpeechCloudPrice(pricing)).toBe(expected);
  });
});
