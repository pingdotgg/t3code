import { useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@t3tools/contracts";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { usePanelHost } from "../panelHost";
import {
  PersistentThreadTerminalPanel,
  type PersistentThreadTerminalPanelProps,
} from "./PersistentThreadTerminalDrawer";

export interface TerminalLaunchContext {
  threadId: ThreadId;
  cwd: string;
  worktreePath: string | null;
}

export default function TerminalSidePanel(
  props: Omit<PersistentThreadTerminalPanelProps, "threadRef" | "visible" | "keybindings">,
) {
  const { threadRef, visible } = usePanelHost();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return (
    <PersistentThreadTerminalPanel
      {...props}
      threadRef={threadRef}
      visible={visible}
      keybindings={keybindings}
    />
  );
}
