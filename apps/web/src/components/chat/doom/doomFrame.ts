import { create } from "zustand";

import { resolveShortcutCommand } from "../../../keybindings";
import { appAtomRegistry } from "../../../rpc/atomRegistry";
import { registerCommands } from "../../../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../../../state/server";
import { toastManager } from "../../ui/toast";

interface DoomPageApi {
  readonly pause: () => void;
  readonly focus: () => void;
  readonly stats: () => { readonly kills: number; readonly playMs: number };
}

interface DoomState {
  /** The player wants the game shown in the working row. */
  readonly open: boolean;
  /** Mounted working rows that can host the game. */
  readonly slots: number;
}

export const useDoomStore = create<DoomState>(() => ({ open: false, slots: 0 }));

// One game per window. It moves between working rows and an offscreen parking spot with
// moveBefore, which keeps an iframe's document alive; a plain append would reload it.
let frame: HTMLIFrameElement | null = null;
let parking: HTMLDivElement | null = null;
let playMsAtAttach = 0;

const pageApi = (): DoomPageApi | undefined =>
  (frame?.contentWindow as (Window & { t3doom?: DoomPageApi }) | null | undefined)?.t3doom;

function moveInto(parent: Element, node: Element): void {
  if (node.parentElement === parent) return;
  const moveBefore = (parent as Element & { moveBefore?: (node: Node, child: Node | null) => void })
    .moveBefore;
  if (moveBefore) moveBefore.call(parent, node, null);
  else parent.append(node);
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
  if (data.event === "exit") quitDoom();
  else if (data.event === "ready" && frame.parentElement !== parking) frame.contentWindow?.focus();
}

function ensureFrame(): HTMLIFrameElement {
  if (frame !== null) return frame;
  parking = document.createElement("div");
  parking.setAttribute("aria-hidden", "true");
  parking.style.cssText =
    "position:fixed;left:-10000px;top:0;width:640px;height:400px;pointer-events:none";
  document.body.append(parking);
  const created = document.createElement("iframe");
  created.src = `${import.meta.env.BASE_URL}doom/index.html`;
  created.title = "Doom";
  created.style.cssText = "display:block;width:100%;height:100%;border:0";
  created.addEventListener("load", () => {
    created.contentWindow?.addEventListener("keydown", onGameKeyDown, true);
  });
  window.addEventListener("message", onPageMessage);
  parking.append(created);
  frame = created;
  return created;
}

export function attachDoom(slot: HTMLElement): void {
  const node = ensureFrame();
  moveInto(slot, node);
  playMsAtAttach = pageApi()?.stats().playMs ?? 0;
  node.contentWindow?.focus();
}

export function detachDoom(slot: HTMLElement): void {
  if (frame === null || parking === null || frame.parentElement !== slot) return;
  const api = pageApi();
  api?.pause();
  moveInto(parking, frame);
  const stats = api?.stats();
  if (stats && stats.playMs - playMsAtAttach > 1000) {
    toastManager.add({
      id: "doom-paused",
      title: "Back to work.",
      description: `Doom paused at ${stats.kills} ${stats.kills === 1 ? "kill" : "kills"}.`,
      timeout: 4000,
    });
  }
}

/** Frees the game entirely. The next toggle boots a fresh one. */
export function quitDoom(): void {
  window.removeEventListener("message", onPageMessage);
  frame?.remove();
  parking?.remove();
  frame = null;
  parking = null;
  useDoomStore.setState({ open: false });
}

/** When the last working row goes (the turn ended), the game closes and waits for the hotkey. */
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
    useDoomStore.setState({ open: false });
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
  useDoomStore.setState({ open: true });
}

export function registerDoomCommands(): () => void {
  return registerCommands({
    "doom.toggle": (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleDoom();
    },
  });
}
