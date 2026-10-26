import { describe, expect, it } from "vite-plus/test";
import { resolveChatCanvasLayout, type ChatCanvasPreview } from "./chatCanvasLayout";
import { resizePreviewMiniPlayer } from "../preview/previewMiniPlayerLayout";
import {
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";

const preview: ChatCanvasPreview = {
  key: "browser:one",
  width: 320,
  position: null,
  source: { width: 1600, height: 1000 },
};
const resolve = (width: number, player: ChatCanvasPreview | null = preview, height = 900) =>
  resolveChatCanvasLayout({ container: { width, height }, preview: player, composerHeight: 180 });
const expectClear = (result: ReturnType<typeof resolve>) => {
  const frame = result.frame!;
  const chat = result.chat;
  expect(frame.x + frame.width <= chat.left - 12 || frame.x >= chat.left + chat.width + 12).toBe(
    true,
  );
};

describe("chat canvas layout", () => {
  it("lifts a growing preview above the composer without snapping at the chat boundary", () => {
    let previous: ReturnType<typeof resolve> | undefined;
    for (let width = 480; width <= 1100; width++) {
      const result = resolve(1344, {
        ...preview,
        width,
        lastInteraction: "resize",
        position: { x: 1332 - width, y: 888 - Math.round(width / 1.6) },
      });
      const frame = result.frame!;
      if (frame.x < result.chat.left + result.chat.width + 12) {
        expect(frame.y + frame.height).toBeLessThanOrEqual(708);
      }
      expect(result.chat.left).toBeLessThanOrEqual(288);
      expect(result.chat.width).toBeGreaterThanOrEqual(640);
      if (previous) {
        expect(Math.abs(frame.y - previous.frame!.y)).toBeLessThanOrEqual(3);
        expect(Math.abs(frame.width - previous.frame!.width)).toBeLessThanOrEqual(2);
        expect(Math.abs(result.chat.width - previous.chat.width)).toBeLessThanOrEqual(1);
      }
      previous = result;
    }
    expect(previous!.overlapsChat).toBe(true);
    expect(previous!.frame!.width).toBe(1100);
  });
  it.each([900, 1000, 1004])("allows dragging across a %spx chat canvas", (width) => {
    const start = resolve(width, { ...preview, position: { x: width - 332, y: 200 } }).frame!;
    const moved = resolve(width, {
      ...preview,
      position: { x: start.x - 300, y: start.y },
      lastInteraction: "drag",
    });
    expect(moved.frame).toEqual({ ...start, x: start.x - 300 });
    const returned = resolve(width, {
      ...preview,
      position: { x: start.x, y: start.y },
      lastInteraction: "drag",
    });
    expect(returned.frame).toEqual(start);
  });
  it("stops leftward dragging before the player can push chat to the right", () => {
    const centered = resolve(1344, null).chat;
    for (const x of [1100, 800, 700, 600, 400, 12, -100]) {
      const result = resolve(1344, { ...preview, position: { x, y: 500 } });
      expect(result.frame!.x).toBeGreaterThanOrEqual(700);
      expect(result.chat.left).toBeLessThanOrEqual(centered.left);
      expect(result.chat.insetStart).toBe(0);
      expect(result.chat.width).toBeGreaterThanOrEqual(640);
      expectClear(result);
    }
    expect(resolve(1344, { ...preview, position: { x: 12, y: 500 } }).frame!.x).toBe(700);
  });
  it("keeps a dragged player above the composer when no readable lane fits beside it", () => {
    const result = resolve(1000, { ...preview, position: { x: 12, y: 700 } });
    expect(result.chat).toEqual(resolve(1000, null).chat);
    expect(result.frame!.x).toBe(12);
    expect(result.frame!.y + result.frame!.height).toBeLessThanOrEqual(708);
  });
  it("restores the preferred width when the container grows again", () => {
    const player = { ...preview, width: 480 };
    expect(resolve(1200, player).chat.width).toBeLessThan(768);
    expect(resolve(1800, player).chat.width).toBe(768);
    expect(player.width).toBe(480);
  });
  it("constrains a dragged preview below the full top-right card instead of folding it", () => {
    const result = resolveChatCanvasLayout({
      container: { width: 1584, height: 988 },
      maxChatWidth: 736,
      composerHeight: 180,
      detailsCard: { left: 1260, right: 1572, bottom: 339 },
      preview: {
        ...preview,
        width: 240,
        source: { width: 240, height: 365 },
        position: { x: 1260, y: 240 },
      },
    });
    expect(result.frame).toEqual({ x: 1260, y: 351, width: 240, height: 365 });
    expect(result.overlapsDetailsCard).toBe(false);
    expect(result.chat).toEqual({ left: 424, width: 736, insetStart: 0, insetEnd: 0 });
  });
  it("centers the chat beside a details card it would crowd, when asked", () => {
    const layout = (centerBesideDetails: boolean) =>
      resolveChatCanvasLayout({
        container: { width: 1344, height: 988 },
        maxChatWidth: 736,
        detailsCard: { left: 1052, right: 1332, bottom: 339 },
        preview: null,
        centerBesideDetails,
      }).chat;
    // Pushed left just enough to clear the card.
    expect(layout(false).left).toBe(1052 - 32 - 736);
    // Equal space on both sides of the chat.
    expect(layout(true)).toMatchObject({ left: (1052 - 736) / 2, width: 736 });
  });
  it("keeps the chat canvas-centered when it clears the details card", () => {
    const result = resolveChatCanvasLayout({
      container: { width: 2200, height: 988 },
      maxChatWidth: 736,
      detailsCard: { left: 1876, right: 2188, bottom: 339 },
      preview: null,
      centerBesideDetails: true,
    });
    expect(result.chat.left).toBe((2200 - 736) / 2);
  });
  it("moves the chat smoothly as a window with a details card grows", () => {
    const leftAt = (width: number) =>
      resolveChatCanvasLayout({
        container: { width, height: 988 },
        maxChatWidth: 736,
        detailsCard: { left: width - 292, right: width - 12, bottom: 339 },
        preview: null,
        centerBesideDetails: true,
      }).chat.left;
    for (let width = 1300; width < 1800; width += 1) {
      expect(Math.abs(leftAt(width + 1) - leftAt(width))).toBeLessThanOrEqual(1);
    }
  });
  it("keeps a dragged or resized preview below the open find bar", () => {
    const findBar = { left: 1292, right: 1572, bottom: 48 };
    const layout = (lastInteraction: "drag" | "resize") =>
      resolveChatCanvasLayout({
        container: { width: 1584, height: 988 },
        maxChatWidth: 736,
        composerHeight: 180,
        findBar,
        preview: {
          ...preview,
          width: 240,
          source: { width: 240, height: 365 },
          position: { x: 1332, y: 12 },
          lastInteraction,
        },
      });
    for (const lastInteraction of ["drag", "resize"] as const) {
      const result = layout(lastInteraction);
      expect(result.frame).toEqual({ x: 1332, y: 60, width: 240, height: 365 });
      expect(result.overlapsDetailsCard).toBe(false);
      expect(result.chat).toEqual({ left: 424, width: 736, insetStart: 0, insetEnd: 0 });
    }
  });
  it("uses space beside the full card if a tall preview cannot fit below it", () => {
    const result = resolveChatCanvasLayout({
      container: { width: 1584, height: 988 },
      maxChatWidth: 736,
      composerHeight: 180,
      detailsCard: { left: 1260, right: 1572, bottom: 339 },
      preview: {
        ...preview,
        width: 240,
        source: { width: 240, height: 700 },
        position: { x: 1260, y: 100 },
      },
    });
    expect(result.frame).toEqual({ x: 1008, y: 100, width: 240, height: 700 });
    expect(result.overlapsDetailsCard).toBe(false);
    expectClear(result);
  });
  it("keeps a large player when clearing the full card would leave no readable chat", () => {
    const container = { width: 1584, height: 988 };
    const source = { width: 1000, height: 1523 };
    const layout = (width: number) => {
      const resized = resizePreviewMiniPlayer({
        start: { x: 1332, y: 610, width: 240, height: 366 },
        direction: "northwest",
        delta: { x: 240 - width, y: ((240 - width) * source.height) / source.width },
        container,
        source,
      });
      return resolveChatCanvasLayout({
        container,
        maxChatWidth: 736,
        composerHeight: 206,
        detailsCard: { left: 1260, right: 1572, bottom: 339 },
        preview: { ...preview, width: resized.width, position: resized, source },
      });
    };
    const shifted = layout(460);
    expect(shifted.frame!.width).toBe(460);
    expect(shifted.chat.left).toBeLessThan(424);
    expect(shifted.overlapsDetailsCard).toBe(false);
    expectClear(shifted);

    const narrowed = layout(532);
    expect(narrowed.frame!.width).toBe(532);
    expect(narrowed.chat.width).toBe(656);
    expect(narrowed.overlapsDetailsCard).toBe(false);
    expectClear(narrowed);

    const grown = layout(600);
    expect(grown.frame!.width).toBe(600);
    expect(grown.overlapsDetailsCard).toBe(true);
    expect(grown.overlapsChat).toBe(false);
    expectClear(grown);
    expect(layout(532)).toEqual(narrowed);
  });
  it.each(["west", "north"] as const)(
    "folds the card before moving a %s resize beside it",
    (direction) => {
      const container = { width: 1584, height: 988 };
      const source = { width: 1000, height: 1523 };
      const layout = (width: number) => {
        const resized = resizePreviewMiniPlayer({
          start: { x: 1332, y: 611, width: 240, height: 365 },
          direction,
          delta: { x: 240 - width, y: ((240 - width) * source.height) / source.width },
          container,
          source,
        });
        return resolveChatCanvasLayout({
          container,
          maxChatWidth: 736,
          composerHeight: 206,
          detailsCard: { left: 1260, right: 1572, bottom: 339 },
          preview: {
            ...preview,
            width: resized.width,
            position: resized,
            source,
            lastInteraction: "resize",
          },
        });
      };
      const density = (result: ReturnType<typeof layout>) => {
        const card = resolveThreadDetailsCardLayout({
          container,
          lane: { padding: 48, minChatWidth: 640 },
          frame: result.frame,
          overlapsDetailsCard: result.overlapsDetailsCard,
        });
        return card
          ? resolveThreadDetailsCardDensity(card.height, { full: 327, compact: 182 })
          : "hidden";
      };
      expect(density(layout(400))).toBe("full");
      const compact = layout(460);
      expect(compact.frame!.x + compact.frame!.width).toBe(1572);
      expect(compact.frame!.width).toBe(460);
      expect(compact.chat.left).toBe(364);
      expect(compact.overlapsDetailsCard).toBe(true);
      expect(density(compact)).toBe("compact");
      expectClear(compact);
      expect(density(layout(500))).toBe("compact");
      expect(density(layout(520))).toBe("essential");
      expect(density(layout(540))).toBe("hidden");
      expect(layout(600).frame!.width).toBe(600);
      expect(layout(460)).toEqual(compact);
      expect(density(layout(400))).toBe("full");
    },
  );
  it("requests card folding only when no full-card slot fits and keeps the composer clear", () => {
    const result = resolveChatCanvasLayout({
      container: { width: 1584, height: 988 },
      maxChatWidth: 736,
      composerHeight: 180,
      detailsCard: { left: 1260, right: 1572, bottom: 600 },
      preview: {
        ...preview,
        width: 1300,
        source: { width: 1300, height: 400 },
        position: { x: 12, y: 12 },
      },
    });
    expect(result.overlapsDetailsCard).toBe(true);
    expect(result.overlapsChat).toBe(true);
    expect(result.frame).toEqual({ x: 12, y: 396, width: 1300, height: 400 });
  });
});

describe("workspace card beside chat", () => {
  const withCard = (width: number, player: ChatCanvasPreview | null = null, maxChatWidth = 736) =>
    resolveChatCanvasLayout({
      container: { width, height: 900 },
      maxChatWidth,
      composerHeight: 180,
      detailsCard: { left: width - 292, right: width - 12, bottom: 400 },
      preview: player,
    });
  it("narrows chat only after it reaches the left padding", () => {
    expect(withCard(1108).chat).toMatchObject({ left: 48, width: 736 });
    expect(withCard(1028).chat).toEqual({ left: 48, width: 656, insetStart: 0, insetEnd: 276 });
    expect(withCard(1012).chat).toMatchObject({ left: 48, width: 640 });
  });
  it("reserves the marker gutter across widths where the details card fits", () => {
    for (let width = 1012; width <= 1440; width++) {
      const container = { width, height: 900 };
      const card = resolveThreadDetailsCardLayout({
        container,
        lane: { padding: 48, minChatWidth: 640 },
        frame: null,
      })!;
      const chat = withCard(width).chat;
      expect(chat.left).toBeGreaterThanOrEqual(48);
      expect(chat.width).toBeGreaterThanOrEqual(640);
      expect(card.x - chat.left - chat.width).toBeGreaterThanOrEqual(32);
    }
  });
});
