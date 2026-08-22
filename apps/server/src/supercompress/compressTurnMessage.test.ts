import { describe, expect, it } from "vite-plus/test";

import {
  compressTurnMessage,
  isSuperCompressApiKey,
  splitAskAndContext,
  SUPERCOMPRESS_API_URL,
} from "./compressTurnMessage.ts";

describe("isSuperCompressApiKey", () => {
  it("accepts sc_ keys", () => {
    expect(isSuperCompressApiKey("sc_live_abc")).toBe(true);
  });

  it("rejects placeholders and empty values", () => {
    expect(isSuperCompressApiKey("")).toBe(false);
    expect(isSuperCompressApiKey("${SUPERCOMPRESS_API_KEY}")).toBe(false);
    expect(isSuperCompressApiKey("sk-openai")).toBe(false);
  });
});

describe("splitAskAndContext", () => {
  it("keeps short messages as ask-only", () => {
    expect(splitAskAndContext("fix the flaky test", 800)).toEqual({
      ask: "fix the flaky test",
      context: "",
    });
  });

  it("splits paragraph-separated pastes", () => {
    const ask = "Summarize this dump and fix the bug.";
    const context = `${"x".repeat(900)}\nmore context`;
    const split = splitAskAndContext(`${ask}\n\n${context}`, 400);
    expect(split.ask).toBe(ask);
    expect(split.context).toBe(context);
  });

  it("uses a short head as ask for a single blob", () => {
    const blob = `Please review:\n${"line\n".repeat(200)}`;
    const split = splitAskAndContext(blob, 400);
    expect(split.ask.length).toBeGreaterThan(0);
    expect(split.context.length).toBeGreaterThan(split.ask.length);
    expect(`${split.ask}${split.context === "" ? "" : `\n${split.context}`}`).toContain(
      "Please review",
    );
  });
});

describe("compressTurnMessage", () => {
  it("skips when no key is configured", async () => {
    const result = await compressTurnMessage({
      text: `ask\n\n${"context ".repeat(200)}`,
      apiKey: "",
      minChars: 100,
    });
    expect(result).toMatchObject({ compressed: false, skipped: "no_key" });
  });

  it("skips short ask-only messages", async () => {
    const result = await compressTurnMessage({
      text: "ship it",
      apiKey: "sc_test",
      minChars: 800,
    });
    expect(result).toMatchObject({ compressed: false, skipped: "no_context" });
  });

  it("compresses context and keeps the ask, fail-open on no savings", async () => {
    const ask = "Find the race in this log.";
    const context = "a".repeat(1200);
    const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const result = await compressTurnMessage({
      text: `${ask}\n\n${context}`,
      apiKey: "sc_test_key",
      minChars: 400,
      codingAgent: "Codex",
      fetchImpl: async (url, init) => {
        fetchCalls.push({ url, init });
        return Response.json({
          compressed_text: "digest",
          original_tokens: 300,
          kept_tokens: 40,
          tokens_saved_pct: 86.7,
        });
      },
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(SUPERCOMPRESS_API_URL);
    expect(JSON.parse(String(fetchCalls[0]?.init?.body))).toMatchObject({
      query: ask,
      coding_agent: "Codex",
      mode: "compiler",
    });
    expect(result.compressed).toBe(true);
    expect(result.text.startsWith(ask)).toBe(true);
    expect(result.text).toContain("digest");
    expect(result.savingsPct).toBe(87);
  });

  it("returns the original text when the API fails", async () => {
    const text = `ask\n\n${"b".repeat(1000)}`;
    const result = await compressTurnMessage({
      text,
      apiKey: "sc_test",
      minChars: 100,
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(result).toEqual({ text, compressed: false, skipped: "http_500" });
  });
});
