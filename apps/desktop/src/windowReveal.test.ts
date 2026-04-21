import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { bindFirstRevealTrigger } from "./windowReveal.ts";

describe("bindFirstRevealTrigger", () => {
  it("reveals when the first trigger fires", () => {
    const window = new EventEmitter();
    const webContents = new EventEmitter();
    const reveal = vi.fn();

    bindFirstRevealTrigger(
      [
        (fire) => window.once("ready-to-show", fire),
        (fire) => webContents.once("did-finish-load", fire),
      ],
      reveal,
    );

    window.emit("ready-to-show");

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("reveals when only the fallback trigger fires (Wayland deadlock case)", () => {
    const window = new EventEmitter();
    const webContents = new EventEmitter();
    const reveal = vi.fn();

    bindFirstRevealTrigger(
      [
        (fire) => window.once("ready-to-show", fire),
        (fire) => webContents.once("did-finish-load", fire),
      ],
      reveal,
    );

    webContents.emit("did-finish-load");

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("only reveals once when multiple triggers fire", () => {
    const window = new EventEmitter();
    const webContents = new EventEmitter();
    const reveal = vi.fn();

    bindFirstRevealTrigger(
      [
        (fire) => window.once("ready-to-show", fire),
        (fire) => webContents.once("did-finish-load", fire),
      ],
      reveal,
    );

    webContents.emit("did-finish-load");
    window.emit("ready-to-show");

    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("subscribers using `once` ignore re-emitted events after reveal", () => {
    const window = new EventEmitter();
    const reveal = vi.fn();

    bindFirstRevealTrigger([(fire) => window.once("ready-to-show", fire)], reveal);

    window.emit("ready-to-show");
    window.emit("ready-to-show");

    expect(reveal).toHaveBeenCalledTimes(1);
  });
});
