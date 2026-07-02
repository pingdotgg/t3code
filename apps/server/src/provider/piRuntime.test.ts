import { describe, expect, it } from "@effect/vitest";

import {
  parsePiApprovalTitle,
  parsePiModelList,
  parsePiModelSlug,
  PI_APPROVAL_TITLE_PREFIX,
  toPiApprovalSelection,
} from "./piRuntime.ts";

describe("parsePiModelSlug", () => {
  it("splits provider and model id on the first slash", () => {
    expect(parsePiModelSlug("anthropic/claude-sonnet-5")).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
  });

  it("keeps slashes inside the model id (openrouter-style ids)", () => {
    expect(parsePiModelSlug("openrouter/qwen/qwen3-coder")).toEqual({
      provider: "openrouter",
      modelId: "qwen/qwen3-coder",
    });
  });

  it("rejects slugs without a provider segment", () => {
    expect(parsePiModelSlug("claude-sonnet-5")).toBeNull();
    expect(parsePiModelSlug("/model")).toBeNull();
    expect(parsePiModelSlug("provider/")).toBeNull();
    expect(parsePiModelSlug(undefined)).toBeNull();
  });
});

describe("parsePiModelList", () => {
  const OUTPUT = [
    "provider    model                       context  max-out  thinking  images",
    "anthropic   claude-sonnet-5             1M       128K     yes       yes   ",
    "anthropic   claude-3-haiku-20240307     200K     4.1K     no        yes   ",
    "local       GLM-4.7-Flash               128K     16.4K    no        no    ",
    "",
    "some startup noise that is not a table row",
  ].join("\n");

  it("parses rows and token counts, skipping the header and noise", () => {
    const models = parsePiModelList(OUTPUT);
    expect(models).toHaveLength(3);
    expect(models[0]).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinking: true,
      images: true,
    });
    expect(models[1]?.maxTokens).toBe(4100);
    expect(models[2]).toMatchObject({ provider: "local", thinking: false, images: false });
  });

  it("returns an empty list for unparseable output", () => {
    expect(parsePiModelList("pi exploded\nno table here")).toEqual([]);
  });
});

describe("parsePiApprovalTitle", () => {
  it("extracts the tool and detail from a marker title", () => {
    const title = `${PI_APPROVAL_TITLE_PREFIX}{"tool":"bash","detail":"rm -rf /tmp/x"}`;
    expect(parsePiApprovalTitle(title)).toEqual({ tool: "bash", detail: "rm -rf /tmp/x" });
  });

  it("returns null for regular dialog titles and malformed markers", () => {
    expect(parsePiApprovalTitle("Allow dangerous command?")).toBeNull();
    expect(parsePiApprovalTitle(`${PI_APPROVAL_TITLE_PREFIX}not-json`)).toBeNull();
    expect(parsePiApprovalTitle(undefined)).toBeNull();
  });
});

describe("toPiApprovalSelection", () => {
  it("maps decisions onto the extension's select options", () => {
    expect(toPiApprovalSelection("accept")).toBe("allow");
    expect(toPiApprovalSelection("acceptForSession")).toBe("allow-always");
    expect(toPiApprovalSelection("decline")).toBe("deny");
    expect(toPiApprovalSelection("cancel")).toBeNull();
  });
});
