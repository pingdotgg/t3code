import {
  clampPreviewMiniPlayerPosition,
  resolvePreviewMiniPlayerFrame,
  type PreviewMiniPlayerFrame,
  type PreviewMiniPlayerObstacles,
} from "../preview/previewMiniPlayerLayout";
import type {
  PreviewMiniPlayerPosition,
  PreviewMiniPlayerSize,
  PreviewMiniPlayerState,
} from "~/previewMiniPlayerStore";

export interface ChatCanvasPreview {
  readonly key: string;
  readonly width: number | null;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly source: PreviewMiniPlayerSize;
  readonly lastInteraction?: PreviewMiniPlayerState["lastInteraction"];
}

const GAP = 12;

/** Pure geometry shared by the conversation, composer, and floating preview. */
export function resolveChatCanvasLayout({
  container,
  preview,
  padding = 20,
  maxChatWidth = 768,
  minChatWidth = 640,
  composerHeight = 0,
  detailsCard = null,
}: {
  container: PreviewMiniPlayerSize;
  preview: ChatCanvasPreview | null;
  padding?: number;
  maxChatWidth?: number;
  minChatWidth?: number;
  composerHeight?: number;
  detailsCard?: PreviewMiniPlayerObstacles["detailsCard"];
}) {
  const normalWidth = Math.max(0, Math.min(maxChatWidth, container.width - padding * 2));
  const normalLeft = (container.width - normalWidth) / 2;
  let chat = { left: normalLeft, width: normalWidth, insetStart: 0, insetEnd: 0 };
  let frame: PreviewMiniPlayerFrame | null = null;
  let overlapsChat = false;
  if (preview && container.width > 0 && container.height > 0) {
    frame = resolvePreviewMiniPlayerFrame({ ...preview, container });
    // Dragging stops at a readable chat lane on the left. Resizing can still
    // consume that space when the container requires message overlap.
    const minimumPreviewX =
      preview.lastInteraction === "resize" ? GAP : padding + minChatWidth + GAP;
    // New players start beside the composer, with the workspace card above them.
    if (preview.position === null) frame = { ...frame, y: container.height - frame.height - GAP };
    if (preview.lastInteraction === "resize" && composerHeight > 0) {
      // Lift the preview while chat uses its remaining shrink room, reaching
      // the composer's top before the preview enters the readable chat lane.
      const laneWidth = Math.min(normalWidth, minChatWidth);
      const transitionWidth = Math.max(GAP, normalWidth - laneWidth);
      const lift = Math.min(
        1,
        Math.max(0, (padding + normalWidth + GAP - frame.x) / transitionWidth),
      );
      if (lift > 0) {
        frame = resolvePreviewMiniPlayerFrame({
          width: frame.width,
          position: frame,
          source: preview.source,
          container: {
            ...container,
            height: Math.max(GAP * 2 + 1, container.height - composerHeight * lift),
          },
        });
      }
    }
    const preferredFrame = {
      ...frame,
      ...clampPreviewMiniPlayerPosition(frame, container, frame, undefined, minimumPreviewX),
    };
    // A resize keeps its anchored edge and consumes card height first. A drag
    // clears the full card whenever it can, so moving alone never folds it.
    const cardObstacle = preview.lastInteraction === "resize" ? null : detailsCard;
    frame = {
      ...frame,
      ...clampPreviewMiniPlayerPosition(
        frame,
        container,
        frame,
        { detailsCard: cardObstacle, composer: null },
        minimumPreviewX,
      ),
    };
    const chatBeside = (player: PreviewMiniPlayerFrame) => {
      const normalRight = normalLeft + normalWidth;
      if (player.x >= normalRight + GAP) return chat;
      const width = Math.min(maxChatWidth, player.x - GAP - padding);
      if (width < minChatWidth) return null;
      const left = Math.min(normalLeft, player.x - GAP - width);
      return {
        left,
        width,
        insetStart: 0,
        insetEnd: Math.max(0, container.width - left * 2 - width),
      };
    };
    let nextChat = chatBeside(frame);
    // Clearing the full card must also leave a readable chat. If only the
    // preferred position does, keep the resized player and let the card fold.
    if (!nextChat && detailsCard) {
      nextChat = chatBeside(preferredFrame);
      if (nextChat) frame = preferredFrame;
    }
    if (nextChat) chat = nextChat;
    else overlapsChat = true;
    if (overlapsChat && preview.lastInteraction === "resize") {
      const width = Math.min(normalWidth, minChatWidth);
      chat = {
        left: padding,
        width,
        insetStart: 0,
        insetEnd: Math.max(0, container.width - padding * 2 - width),
      };
    } else if (overlapsChat) {
      const obstacles = {
        detailsCard: cardObstacle,
        composer: { left: chat.left, right: chat.left + chat.width, height: composerHeight },
      };
      frame = resolvePreviewMiniPlayerFrame({ ...preview, container, obstacles });
      frame = {
        ...frame,
        ...clampPreviewMiniPlayerPosition(
          preview.position ?? { x: frame.x, y: container.height - frame.height - GAP },
          container,
          frame,
          obstacles,
          minimumPreviewX,
        ),
      };
      // If the full card and composer leave no slot, keep typing usable while
      // the card folds to the remaining height above this fallback frame.
      if (
        frame.x < obstacles.composer.right &&
        frame.x + frame.width > obstacles.composer.left &&
        frame.y + frame.height > container.height - composerHeight
      ) {
        frame = {
          ...frame,
          ...clampPreviewMiniPlayerPosition(
            frame,
            container,
            frame,
            { composer: obstacles.composer, detailsCard: null },
            minimumPreviewX,
          ),
        };
      }
    }
  }
  const overlapsDetailsCard = Boolean(
    frame &&
    detailsCard &&
    frame.x < detailsCard.right &&
    frame.x + frame.width > detailsCard.left &&
    frame.y < detailsCard.bottom,
  );
  return { chat, frame, overlapsChat, overlapsDetailsCard };
}
