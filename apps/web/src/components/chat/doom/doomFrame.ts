import { create } from "zustand";

import { getClientSettings } from "../../../hooks/useSettings";
import { resolveShortcutCommand } from "../../../keybindings";
import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { registerCommands } from "../../../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { toastManager } from "../../ui/toast";

interface DoomPageApi {
  readonly pause: () => void;
  readonly save: () => boolean;
  readonly stats: () => { readonly kills: number; readonly playMs: number };
}

interface DoomState {
  /** The player wants the game shown in the working row. */
  readonly open: boolean;
  /** Mounted working rows that can host the game. */
  readonly slots: number;
  /** A game is loaded in memory (shown or parked). */
  readonly live: boolean;
  /** Kills in this browser's quick save, or null without one. */
  readonly savedKills: number | null;
}

// Written by public/doom/index.html, which shares this origin.
const SAVE_KEY = "t3code:doom:save";

function readSavedKills(): number | null {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? "null") as {
      kills?: unknown;
    } | null;
    return typeof saved?.kills === "number" ? saved.kills : null;
  } catch {
    return null;
  }
}

export const useDoomStore = create<DoomState>(() => ({
  open: false,
  slots: 0,
  live: false,
  savedKills: readSavedKills(),
}));

// One game per window. It moves between working rows and an offscreen parking spot with
// moveBefore, which keeps an iframe's document alive. Without moveBefore (older Safari) a move
// reloads the page, so it reloads in continue mode from the save taken when it was parked.
let frame: HTMLIFrameElement | null = null;
let parking: HTMLDivElement | null = null;
let playMsAtAttach = 0;

const pageUrl = (resume: boolean) =>
  `${import.meta.env.BASE_URL}doom/index.html${resume ? "?continue" : ""}`;

const pageApi = (): DoomPageApi | undefined =>
  (frame?.contentWindow as (Window & { t3doom?: DoomPageApi }) | null | undefined)?.t3doom;

function moveInto(parent: Element, node: HTMLIFrameElement): void {
  if (node.parentElement === parent) return;
  const moveBefore = (parent as Element & { moveBefore?: (node: Node, child: Node | null) => void })
    .moveBefore;
  if (moveBefore) {
    moveBefore.call(parent, node, null);
    return;
  }
  parent.append(node);
  node.src = pageUrl(readSavedKills() !== null);
}

const readKeybindings = () => appAtomRegistry.get(primaryServerKeybindingsAtom);

// Keys typed into the game never reach the app's listeners, so the toggle is heard here too.
function onGameKeyDown(event: KeyboardEvent): void {
  if (resolveShortcutCommand(event, readKeybindings()) !== "doom.toggle") return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) toggleDoom();
}

function onPageMessage(event: MessageEvent): void {
  if (frame === null || event.source !== frame.contentWindow) return;
  const data = event.data as { type?: unknown; event?: unknown } | null;
  if (data?.type !== "t3doom") return;
  if (data.event === "exit") destroyFrame();
  else if (data.event === "ready" && frame.parentElement !== parking) frame.contentWindow?.focus();
}

function ensureFrame(resume: boolean): HTMLIFrameElement {
  if (frame !== null) return frame;
  if (parking === null) {
    parking = document.createElement("div");
    parking.setAttribute("aria-hidden", "true");
    parking.style.cssText =
      "position:fixed;left:-10000px;top:0;width:640px;height:400px;pointer-events:none";
    document.body.append(parking);
    window.addEventListener("message", onPageMessage);
  }
  const created = document.createElement("iframe");
  created.src = pageUrl(resume);
  created.title = "Doom";
  created.style.cssText = "display:block;width:100%;height:100%;border:0";
  created.addEventListener("load", () => {
    created.contentWindow?.addEventListener("keydown", onGameKeyDown, true);
  });
  parking.append(created);
  frame = created;
  useDoomStore.setState({ live: true });
  return created;
}

function destroyFrame(): void {
  frame?.remove();
  frame = null;
  useDoomStore.setState({ open: false, live: false });
}

function saveGame(): void {
  if (pageApi()?.save()) useDoomStore.setState({ savedKills: readSavedKills() });
}

export function attachDoom(slot: HTMLElement): void {
  const node = ensureFrame(useDoomStore.getState().savedKills !== null);
  moveInto(slot, node);
  playMsAtAttach = pageApi()?.stats().playMs ?? 0;
  node.contentWindow?.focus();
}

export function detachDoom(slot: HTMLElement): void {
  if (frame === null || parking === null || frame.parentElement !== slot) return;
  const api = pageApi();
  api?.pause();
  saveGame();
  moveInto(parking, frame);
  const stats = api?.stats();
  if (stats && stats.playMs - playMsAtAttach > 1000) {
    toastManager.add({
      id: "doom-paused",
      title: "Back to work.",
      description: `Doom saved at ${stats.kills} ${stats.kills === 1 ? "kill" : "kills"}.`,
      timeout: 4000,
    });
  }
}

/** Shows the game in the working row: the loaded one, else the quick save, else a new one. */
export function openDoom(): void {
  useDoomStore.setState({ open: true });
}

export function hideDoom(): void {
  useDoomStore.setState({ open: false });
}

/** Throws away the current game and its save, and starts over at E1M1. */
export function newDoomGame(): void {
  const slot = frame?.parentElement !== parking ? frame?.parentElement : null;
  localStorage.removeItem(SAVE_KEY);
  useDoomStore.setState({ savedKills: null });
  frame?.remove();
  frame = null;
  if (slot) attachDoom(slot);
  else openDoom();
}

/** Saves and frees the game's memory. "Continue" picks it back up. */
export function quitDoom(): void {
  saveGame();
  destroyFrame();
}

/** When the last working row goes (the turn ended), the game closes and waits. */
export function registerDoomSlot(): () => void {
  useDoomStore.setState((state) => ({ slots: state.slots + 1 }));
  return () =>
    useDoomStore.setState((state) => ({
      slots: state.slots - 1,
      open: state.slots > 1 && state.open,
    }));
}

function toggleDoom(): void {
  const { open, slots } = useDoomStore.getState();
  if (open) {
    hideDoom();
    return;
  }
  if (slots === 0) {
    toastManager.add({
      id: "doom-unavailable",
      title: "Doom only runs while an agent works.",
      description: "Send a prompt first. Productivity matters.",
      timeout: 3000,
    });
    return;
  }
  openDoom();
}

export function registerDoomCommands(): () => void {
  return registerCommands({
    "doom.toggle": (event) => {
      if (!getClientSettings().doomEnabled) return false;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleDoom();
    },
  });
}
