import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface SavedToast {
  title: string;
  actionProps: { children: string; onClick: () => void };
  data: {
    secondaryActionProps: { children: string; disabled?: boolean; onClick: () => void };
    secondaryActionVariant: string;
  };
}
const { add, update, reveal, writeText } = vi.hoisted(() => ({
  add: vi.fn((_options: SavedToast) => "saved-toast"),
  update: vi.fn((_toastId: string, _options: SavedToast) => {}),
  reveal: vi.fn(async (_path: string) => {}),
  writeText: vi.fn(async (_path: string) => {}),
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add, update },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { revealArtifact: reveal },
}));
import { showBrowserRecordingSavedToast } from "./browserRecordingToast";

describe("native saved recording toast", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { platform: "MacIntel", clipboard: { writeText } });
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps Reveal primary and Copy path outlined with native copied feedback", async () => {
    const artifact = {
      id: "saved",
      tabId: "tab",
      path: "/private/saved.webm",
      mimeType: "video/webm",
      sizeBytes: 51 * 1024 * 1024,
      createdAt: "2026-09-30T00:00:00Z",
    };
    showBrowserRecordingSavedToast(artifact);
    const initial = add.mock.calls[0]![0];
    expect(initial).toMatchObject({
      title: "Recording saved",
      actionProps: { children: "Reveal in Finder" },
      data: { secondaryActionProps: { children: "Copy path" }, secondaryActionVariant: "outline" },
    });
    initial.actionProps.onClick();
    expect(reveal).toHaveBeenCalledWith(artifact.path);
    initial.data.secondaryActionProps.onClick();
    await writeText.mock.results[0]!.value;
    expect(writeText).toHaveBeenCalledWith(artifact.path);
    expect(update.mock.calls.at(-1)![1]).toMatchObject({
      title: "Recording saved",
      data: { secondaryActionProps: { children: "Copied!", disabled: true } },
    });
    vi.advanceTimersByTime(2_000);
    expect(update.mock.calls.at(-1)![1]).toMatchObject({
      data: { secondaryActionProps: { children: "Copy path", disabled: false } },
    });
  });
});
