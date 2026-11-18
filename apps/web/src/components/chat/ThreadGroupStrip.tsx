import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { boardHasUpdates } from "@t3tools/client-runtime/state/thread-board";
import { resolveThreadGroupFor } from "@t3tools/client-runtime/state/thread-groups";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LayoutListIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useQuietThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { resolveThreadStatusPill } from "../Sidebar.logic";

export function ThreadGroupStrip(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const { environmentId, threadId } = props;
  const navigate = useNavigate();
  const shells = useQuietThreadShells();
  const group = resolveThreadGroupFor(shells, environmentId, threadId);
  if (!group) return null;

  const members = [
    { shell: group.parent, suffix: "lead" },
    ...group.workers.map((shell) => ({ shell, suffix: null })),
  ];

  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 sm:px-5">
      <nav
        aria-label="Thread group"
        className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [-webkit-mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] [mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {members.map(({ shell, suffix }) => {
          const current = shell.id === threadId;
          const status = resolveThreadStatusPill({ thread: shell });
          return (
            <button
              key={scopedThreadKey(scopeThreadRef(shell.environmentId, shell.id))}
              type="button"
              aria-current={current ? "page" : undefined}
              onClick={() => {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(shell.environmentId, shell.id)),
                });
              }}
              className={cn(
                "inline-flex max-w-56 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                current
                  ? "border-foreground/40 text-foreground"
                  : "border-border text-foreground/80",
              )}
            >
              <span
                role="img"
                aria-label={status?.label ?? "Idle"}
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  status?.dotClass ?? "bg-muted-foreground/40",
                  status?.pulse ? "motion-safe:animate-status-pulse" : "",
                )}
              />
              <span className="truncate">{shell.title}</span>
              {suffix ? <span className="shrink-0 text-muted-foreground">{suffix}</span> : null}
              {current ? <span className="shrink-0 text-muted-foreground">you</span> : null}
            </button>
          );
        })}
      </nav>
      <button
        type="button"
        onClick={() => {
          useRightPanelStore.getState().open(scopeThreadRef(environmentId, threadId), "board");
        }}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs text-foreground/80 transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <LayoutListIcon className="size-3" aria-hidden />
        <span>Board</span>
        {boardHasUpdates(group.parent) ? (
          <span
            role="img"
            aria-label="New board updates"
            className="size-1.5 shrink-0 rounded-full bg-info"
          />
        ) : null}
      </button>
    </div>
  );
}
