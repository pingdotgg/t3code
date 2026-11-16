import { expect, it, vi } from "vite-plus/test";

import { makeClient } from "./client.ts";

it("times out when response headers arrive but the body stalls", async () => {
  vi.useFakeTimers();
  vi.stubEnv("OPENAI_API_KEY", "eval-test-key");
  const reading = Promise.withResolvers<void>();
  const body = Promise.withResolvers<ArrayBuffer>();
  const response = new Response(null, { status: 200 });
  using _body = vi.spyOn(response, "arrayBuffer").mockImplementation(() => {
    reading.resolve();
    return body.promise;
  });
  using _fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const completed = new TextEncoder().encode(
    JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  ).buffer;
  try {
    const client = makeClient({ proxy: false, effort: "low" });
    const result = client.call("gpt-test", "Answer", [], [], "timeout regression").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await reading.promise;
    await vi.advanceTimersByTimeAsync(120_001);
    body.resolve(completed);
    expect(await result).toMatchObject({ error: { _tag: "TimeoutError" } });
    expect(client.attempts).toEqual([
      { model: "gpt-test", purpose: "timeout regression", completed: false },
    ]);
    expect(client.ledger).toEqual([]);
  } finally {
    body.resolve(completed);
    vi.unstubAllEnvs();
    vi.useRealTimers();
  }
});
