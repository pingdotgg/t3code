import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { captureComposerControls } from "./composerControlsTransition";

const rect = {
  bottom: 40,
  height: 20,
  left: 10,
  right: 30,
  top: 20,
  width: 20,
  x: 10,
  y: 20,
  toJSON: () => ({}),
};

describe("captureComposerControls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("captures the group itself when the collapsed host is the action button", () => {
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor: "transparent",
      borderColor: "transparent",
      borderRadius: "0px",
      color: "black",
      fill: "none",
      flexShrink: "1",
      font: "14px sans-serif",
      fontWeight: "400",
      height: "20px",
      margin: "0px",
      opacity: "1",
      stroke: "none",
      visibility: "visible",
      width: "20px",
    }));
    const button = {
      closest: () => null,
      getAttribute: (name: string) => (name === "aria-label" ? "Send" : null),
      getBoundingClientRect: () => rect,
      matches: (selector: string) => selector.includes("button"),
      querySelectorAll: () => [],
    } as unknown as HTMLElement;
    const shell = {
      getBoundingClientRect: () => rect,
    } as unknown as HTMLElement;

    expect([...captureComposerControls(button, shell).keys()]).toEqual(["Send"]);
  });
});
