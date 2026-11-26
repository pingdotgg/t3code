// Fork: the sub-agent items Kaluwa adds to a thread's context menu: show or hide its finished
// sub-agents, fold them, and open any one of them.
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  ContextMenuItem,
  ContextMenuSource,
  LocalApi,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { getClientSettings } from "../../hooks/useSettings";
import { m, type MessageResolver } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  isKaluwaSubagentFoldOpen,
  kaluwaSubagentIndexAtom,
  useKaluwaSubagentFolds,
} from "../../state/kaluwaSubagents";
import {
  isKaluwaChildFinished,
  type KaluwaSubagentChild,
  resolveKaluwaShowFinished,
} from "./kaluwaSidebarTree.logic";

const PREFIX = "kaluwa-sub:";
type KaluwaSubagentMenuId = `kaluwa-sub:${string}`;

export function isKaluwaSubagentMenuId(id: string): id is KaluwaSubagentMenuId {
  return id.startsWith(PREFIX);
}

function childStatusText(child: KaluwaSubagentChild, resolve: MessageResolver): string | null {
  if (child.unseenFailure || child.status === "failed") {
    return resolve(msg("Failed", { $context: "thread status" }));
  }
  switch (child.status) {
    case "working":
    case "waiting":
      return child.kind === "native"
        ? resolve(msg("Running", { $context: "sub-agent status" }))
        : resolve(msg("Working", { $context: "thread status" }));
    case "approval":
      return resolve(msg("Approval", { $context: "thread status: needs approval" }));
    case "input":
      return resolve(msg("Input", { $context: "thread status: needs user input" }));
    case "done":
      return resolve(msg("Done", { $context: "thread status" }));
    case "idle":
      return null;
  }
}

/** Empty unless the thread has sub-agents and the tree shows them. */
function buildKaluwaSubagentMenuItems(
  parentKey: string,
  resolve: MessageResolver = m,
): ReadonlyArray<ContextMenuItem<KaluwaSubagentMenuId>> {
  const settings = getClientSettings();
  const mode = settings.kaluwaSidebarSubagents;
  if (mode === "off") return [];
  const children = appAtomRegistry.get(kaluwaSubagentIndexAtom).get(parentKey) ?? [];
  if (children.length === 0) return [];
  const folds = useKaluwaSubagentFolds.getState();
  const showFinished = resolveKaluwaShowFinished(
    folds.showFinished[parentKey],
    settings.kaluwaSidebarFinishedSubagents,
  );
  const finished = children.filter(isKaluwaChildFinished).length;
  const open = isKaluwaSubagentFoldOpen(folds.open, parentKey, mode);
  const items: Array<ContextMenuItem<KaluwaSubagentMenuId>> = [
    ...(finished === 0
      ? []
      : [
          showFinished
            ? {
                id: `${PREFIX}hide-finished` as const,
                label: resolve(msg("Hide finished sub-agents")),
              }
            : {
                id: `${PREFIX}show-finished` as const,
                label: resolve(msg("Show finished sub-agents ({count})", { count: finished })),
              },
        ]),
    open
      ? {
          id: `${PREFIX}collapse` as const,
          label: resolve(msg("Collapse sub-agents")),
        }
      : {
          id: `${PREFIX}expand` as const,
          label: resolve(msg("Expand sub-agents")),
        },
    {
      id: `${PREFIX}list` as const,
      label: resolve(msg("Sub-agents")),
      icon: "git-branch",
      children: children.map((child) => {
        const status = childStatusText(child, resolve);
        return {
          id: `${PREFIX}open:${child.key}` as const,
          label: child.title,
          ...(status === null ? {} : { detail: status }),
        };
      }),
    },
  ];
  return items.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item));
}

/** Shows a thread's menu with Kaluwa's sub-agent items after the usual ones. */
export function kaluwaShowThreadMenu<Id extends string>(
  api: LocalApi,
  parentKey: string,
  items: ReadonlyArray<ContextMenuItem<Id>>,
  position: { x: number; y: number },
  source: ContextMenuSource,
): Promise<Id | KaluwaSubagentMenuId | null> {
  return api.contextMenu.show<Id | KaluwaSubagentMenuId>(
    [...items, ...buildKaluwaSubagentMenuItems(parentKey)],
    position,
    source,
  );
}

export function runKaluwaSubagentMenuAction(
  id: KaluwaSubagentMenuId,
  parentKey: string,
  openThread: (ref: ScopedThreadRef) => void,
): void {
  const folds = useKaluwaSubagentFolds.getState();
  const action = id.slice(PREFIX.length);
  if (action === "show-finished" || action === "hide-finished") {
    folds.setShowFinished(parentKey, action === "show-finished");
    // Showing finished ones is pointless while the fold is closed.
    if (action === "show-finished") folds.setOpen(parentKey, true);
  } else if (action === "collapse" || action === "expand") {
    folds.setOpen(parentKey, action === "expand");
  } else if (action.startsWith("open:")) {
    const ref = parseScopedThreadKey(action.slice("open:".length));
    if (ref !== null) openThread(scopeThreadRef(ref.environmentId, ref.threadId));
  }
}
