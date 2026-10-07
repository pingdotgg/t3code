import { describe, expect, it } from "vite-plus/test";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";

describe("chat canvas layout", () => {
  it("centers chat in the whole container", () => {
    expect(resolveChatCanvasLayout({ container: { width: 1344, height: 900 } }).chat).toEqual({
      left: 288,
      width: 768,
      insetStart: 0,
      insetEnd: 0,
    });
    expect(resolveChatCanvasLayout({ container: { width: 390, height: 900 } }).chat).toEqual({
      left: 20,
      width: 350,
      insetStart: 0,
      insetEnd: 0,
    });
  });
});

describe("workspace card beside chat", () => {
  const withCard = (width: number, maxChatWidth = 736) =>
    resolveChatCanvasLayout({
      container: { width, height: 900 },
      maxChatWidth,
      detailsCard: { left: width - 292, right: width - 12, bottom: 400 },
    });
  it("keeps chat centered while the card fits beside it", () => {
    expect(withCard(1384).chat).toEqual({ left: 324, width: 736, insetStart: 0, insetEnd: 0 });
  });
  it("moves chat left only as far as the card requires", () => {
    expect(withCard(1383).chat).toEqual({ left: 323, width: 736, insetStart: 0, insetEnd: 1 });
    expect(withCard(1147).chat).toEqual({ left: 87, width: 736, insetStart: 0, insetEnd: 237 });
  });
  it("narrows chat only after it reaches the left padding", () => {
    expect(withCard(1080).chat).toMatchObject({ left: 20, width: 736 });
    expect(withCard(1000).chat).toEqual({ left: 20, width: 656, insetStart: 0, insetEnd: 304 });
    expect(withCard(984).chat).toMatchObject({ left: 20, width: 640 });
  });
  it("keeps a full-width chat clear of the card", () => {
    expect(withCard(1147, 10_000).chat).toEqual({
      left: 20,
      width: 803,
      insetStart: 0,
      insetEnd: 304,
    });
  });
});
