// Provides the only cross-panel API for board references, room selection, and highlights.
import { boardRoom } from "./room.mjs";
type Listener = (ref: string) => void;
export type HoverOrigin = { x: number; y: number };
type HoverListener = (ref: string | null, origin?: HoverOrigin) => void;

export type BoardView = { room: string; session: string | null; label: string | null };

let chatListener: Listener | undefined;
let highlightListener: Listener | undefined;
let hoverListener: HoverListener | undefined;
let readyListener: (() => void) | undefined;
let visibleListener: ((visible: boolean) => void) | undefined;
let latestChatRef: string | undefined;
// ?room=<slug> opens that room directly, which is how the wb tools and links to a project board arrive.
// Otherwise the page starts on the room the chat last reported, which is usually the one it reports again.
const initialRoom = new URLSearchParams(location.search).get("room");
let view: BoardView = {
  room: initialRoom ? boardRoom(initialRoom) : (localStorage.getItem("wb-room") ?? "main"),
  session: null,
  label: null,
};
let viewListener: ((view: BoardView) => void) | undefined;

export function setBoardRoom(path: string, activeSession?: string | null): void {
  view = {
    room: boardRoom(path),
    session: activeSession ?? null,
    label: path.split("/").filter(Boolean).pop() ?? null,
  };
  localStorage.setItem("wb-room", view.room);
  viewListener?.(view);
}

export function onBoardView(cb: (view: BoardView) => void): void {
  viewListener = cb;
  cb(view);
}

export function sendRefToChat(ref: string): void {
  if (chatListener) chatListener(ref);
  else latestChatRef = ref;
}

export function onRefToChat(cb: Listener): void {
  chatListener = cb;
  if (latestChatRef) cb(latestChatRef);
  latestChatRef = undefined;
}

export function highlightRegion(ref: string): void {
  highlightListener?.(ref);
}

export function onHighlight(cb: Listener): void {
  highlightListener = cb;
}

export function hoverRegion(ref: string | null, origin?: HoverOrigin): void {
  hoverListener?.(ref, origin);
}

export function onHover(cb: HoverListener): void {
  hoverListener = cb;
}

// Fires when a board's reference handlers are registered and its viewport has a size.
export function boardReady(): void {
  readyListener?.();
}

export function onBoardReady(cb: () => void): void {
  readyListener = cb;
}

// T3 keeps a panel board loaded while its tab is hidden, and says when it is shown or hidden.
export function setBoardVisible(visible: boolean): void {
  visibleListener?.(visible);
}

export function onBoardVisible(cb: (visible: boolean) => void): void {
  visibleListener = cb;
}
