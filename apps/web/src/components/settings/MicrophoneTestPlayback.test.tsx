import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

import { MicrophoneTestPlayback } from "./MicrophoneTestPlayback";

vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));

it("plays, seeks, pauses, and reports playback failures", async () => {
  const player = {
    paused: true,
    ended: false,
    currentTime: 0,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
  };
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(
      createElement(MicrophoneTestPlayback, {
        src: "blob:test",
        duration: 10,
        onRetry: vi.fn(),
        onDone: vi.fn(),
      }),
      {
        createNodeMock: (element) => (element.type === "audio" ? player : null),
      },
    );
  });
  try {
    await act(async () => root.root.findAllByType("button")[0]!.props.onClick());
    expect(player.play).toHaveBeenCalledTimes(1);
    await act(async () => {
      player.paused = false;
      root.root.findByType("audio").props.onPlay();
      root.root.findByType("input").props.onChange({ target: { value: "4" } });
    });
    expect(player.currentTime).toBe(4);
    expect(root.root.findAllByType("button")[0]!.props["aria-label"]).toBe("Pause recording");
    await act(async () => root.root.findAllByType("button")[0]!.props.onClick());
    expect(player.pause).toHaveBeenCalledTimes(1);
    player.paused = true;
    player.play.mockRejectedValueOnce(new Error("Playback failed"));
    await act(async () => {
      root.root.findAllByType("button")[0]!.props.onClick();
      await Promise.resolve();
    });
    expect(root.root.findByProps({ role: "alert" }).children.join("")).toContain("Could not play");
  } finally {
    await act(async () => root.unmount());
  }
});
