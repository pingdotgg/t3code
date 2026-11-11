import { expect, it, vi } from "vite-plus/test";

const sink = vi.hoisted(() => ({
  created: vi.fn(),
  written: vi.fn<(line: string, options: unknown) => Promise<void>>(),
  opened: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  Paths: { document: "documents" },
  File: class {
    constructor(...args: unknown[]) {
      sink.opened(...args);
    }
    create(options: unknown) {
      sink.created(options);
    }
    write(line: string, options: unknown) {
      return sink.written(line, options);
    }
  },
}));

it("leaves the filesystem untouched when Release tracing is disabled", async () => {
  vi.resetModules();
  sink.opened.mockClear();
  vi.stubEnv("EXPO_PUBLIC_T3_DIFF_TRACE", "0");
  try {
    const { traceDiffHighlight } = await import("./nativeReviewDiffTrace");
    traceDiffHighlight("viewport-start", { rows: 80 });
    expect(sink.opened).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});

it("keeps object, function, and primitive identities stable without collisions", async () => {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_T3_DIFF_TRACE", "1");
  try {
    const { diffHighlightTraceId } = await import("./nativeReviewDiffTrace");
    const values = [{}, {}, () => {}, () => {}, null, undefined, "file", 1, "1", false];
    const ids = values.map(diffHighlightTraceId);
    expect(ids.every((id) => id > 0)).toBe(true);
    expect(new Set(ids).size).toBe(values.length);
    expect(values.map(diffHighlightTraceId)).toEqual(ids);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("serializes appends to a retrievable file and bounds a process to 1000 events", async () => {
  vi.resetModules();
  sink.opened.mockClear();
  sink.created.mockClear();
  sink.written.mockReset();
  const firstWrite = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  sink.written.mockImplementation(async (line) => {
    const { seq } = JSON.parse(line);
    if (seq === 1) {
      firstWrite.resolve();
      await releaseFirst.promise;
    }
    if (seq === 1000) finished.resolve();
  });
  using warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("EXPO_PUBLIC_T3_DIFF_TRACE", "1");
  try {
    const { diffHighlightTraceId, traceDiffHighlight } = await import("./nativeReviewDiffTrace");
    const request = {};
    expect(diffHighlightTraceId(request)).toBeGreaterThan(0);
    for (let index = 0; index < 1001; index++)
      traceDiffHighlight("viewport-start", { rows: index });
    await firstWrite.promise;
    expect(sink.written).toHaveBeenCalledTimes(1);
    releaseFirst.resolve();
    await finished.promise;
    expect(sink.opened.mock.calls).toEqual([["documents", "t3-diff-highlight-trace.jsonl"]]);
    expect(sink.created.mock.calls).toEqual([[{ overwrite: true, intermediates: true }]]);
    expect(sink.written).toHaveBeenCalledTimes(1000);
    expect(warning).toHaveBeenCalledTimes(1000);
    expect(diffHighlightTraceId(request)).toBe(0);
    expect(diffHighlightTraceId("file")).toBe(0);
    expect(sink.written.mock.calls.map(([line]) => JSON.parse(line).seq)).toEqual(
      Array.from({ length: 1000 }, (_, index) => index + 1),
    );
    expect(
      sink.written.mock.calls.every(
        ([line, options]) => line.endsWith("\n") && JSON.stringify(options) === '{"append":true}',
      ),
    ).toBe(true);
  } finally {
    releaseFirst.resolve();
    vi.unstubAllEnvs();
  }
});
