import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildContextLimitBannerItem } from "./ContextLimitBanner";

describe("buildContextLimitBannerItem", () => {
  it("keeps token-limit settings with the limit and reserves actions for handover", () => {
    const item = buildContextLimitBannerItem({
      threadId: "thread-1",
      tokenLimit: 250_000,
      canChangeTokenLimit: true,
      supportsGeneration: true,
      isGeneratingHandover: false,
      hasSavedHandover: false,
      onChangeTokenLimit: vi.fn(),
      onGenerateHandover: vi.fn(),
    });

    const title = renderToStaticMarkup(<>{item.title}</>);
    const actions = renderToStaticMarkup(<>{item.actions}</>);

    expect(title).toContain("This thread has reached 250,000 tokens");
    expect(title).toContain("Change thread token limit");
    expect(actions).toContain("Handover to new thread");
    expect(actions).not.toContain("Change thread token limit");
  });

  it("does not strand a settings control in the action area on an older server", () => {
    const item = buildContextLimitBannerItem({
      threadId: "thread-1",
      tokenLimit: 250_000,
      canChangeTokenLimit: true,
      supportsGeneration: false,
      isGeneratingHandover: false,
      hasSavedHandover: false,
      onChangeTokenLimit: vi.fn(),
      onGenerateHandover: vi.fn(),
    });

    expect(renderToStaticMarkup(<>{item.title}</>)).toContain("Change thread token limit");
    expect(item.actions).toBeUndefined();
  });
});
