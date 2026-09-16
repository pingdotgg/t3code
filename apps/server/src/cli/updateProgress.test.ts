import { afterEach, expect, it, vi } from "vite-plus/test";

import { createUpdateProgress } from "./updateProgress.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function terminal(isTTY = true, columns = 80) {
  vi.stubEnv("TERM", "xterm");
  vi.stubEnv("NO_COLOR", "1");
  let text = "";
  const progress = createUpdateProgress({
    isTTY,
    columns,
    write(chunk: string | Uint8Array) {
      text += chunk;
      return true;
    },
  });
  return { ...progress, text: () => text };
}

it("keeps redirected output readable without per-chunk updates or escapes", () => {
  const output = terminal(false);
  for (let received = 0; received <= 100; received++) {
    output.report({ stage: "download", received, total: 100 });
  }
  output.report({ stage: "verify" });
  output.report({ stage: "extract" });
  output.report({ stage: "validate" });
  output.finish();
  expect(output.text()).toBe(
    "  Downloading...\n  Verifying the download...\n  Extracting T3 Code...\n  Checking the new executable...\n",
  );
});

it("throttles redraws, shows the final byte count, and closes the line once", () => {
  const now = vi.spyOn(performance, "now").mockReturnValue(0);
  const output = terminal();
  output.report({ stage: "download", received: 0, total: 1024 ** 2 });
  const initial = output.text();
  for (let received = 1; received < 100; received++) {
    output.report({ stage: "download", received, total: 1024 ** 2 });
  }
  expect(output.text()).toBe(initial);
  now.mockReturnValue(100);
  output.report({ stage: "download", received: 524288, total: 1024 ** 2 });
  output.report({ stage: "download", received: 1024 ** 2, total: 1024 ** 2 });
  output.finish();
  output.finish();
  expect(output.text().match(/100%/g)).toHaveLength(1);
  expect(output.text()).toContain("50%  0.5 / 1.0 MB");
  expect(output.text()).toMatch(/100%  1.0 \/ 1.0 MB\n$/);
});

it("shows bytes for an unknown size and leaves a clean line on interruption", () => {
  const output = terminal();
  output.report({ stage: "download", received: 524288, total: undefined });
  output.finish();
  expect(output.text()).toMatch(/0.5 MB\n$/);
  expect(output.text()).not.toContain("%");
});

it.each([1, 2, 7, 8, 9, 30])("fits a %i-column terminal without wrapping", (columns) => {
  const output = terminal(true, columns);
  output.report({ stage: "download", received: 50, total: 100 });
  for (const line of output.text().split("\r\x1b[2K")) {
    expect(line.length).toBeLessThan(columns);
  }
});

it("draws the final size of a fast chunked download even inside the throttle window", () => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  const output = terminal();
  output.report({ stage: "download", received: 0, total: undefined });
  output.report({ stage: "download", received: 524288, total: undefined });
  output.report({ stage: "download", received: 524288, total: 524288 });
  output.report({ stage: "verify" });
  expect(output.text()).toContain("100%  0.5 / 0.5 MB\n\r\x1b[2K  Verifying");
});

it("uses color only in capable terminals that have not requested NO_COLOR", () => {
  const output = terminal();
  // Create a new renderer after changing the color preference.
  vi.stubEnv("NO_COLOR", undefined);
  const chunks: string[] = [];
  const progress = createUpdateProgress({
    isTTY: true,
    columns: 80,
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  });
  progress.report({ stage: "download", received: 50, total: 100 });
  expect(chunks.join("")).toContain("\x1b[94m");
  output.report({ stage: "download", received: 50, total: 100 });
  expect(output.text()).not.toContain("\x1b[94m");
});
