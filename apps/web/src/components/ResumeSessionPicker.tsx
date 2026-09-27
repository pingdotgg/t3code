import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  type ResumableAgentSession,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { HistoryIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { agentSessionAttach, agentSessionList } from "../state/agentSessions";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ComposerControl, ComposerControlChevron } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxStatus,
  ComboboxTrigger,
} from "./ui/combobox";

/** Browsing is read-only; selecting attaches history and opens the native session's T3 thread. */
export function ResumeSessionPicker({ projectRef }: { projectRef: ScopedProjectRef }) {
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [search, setSearch] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachingRef = useRef(false);
  const floatingLayerProps = useComposerMenuProps();
  const navigate = useNavigate();
  const attach = useAtomCommand(agentSessionAttach, { reportFailure: false });
  const queryAtom = useMemo(
    () =>
      open
        ? agentSessionList({
            environmentId: projectRef.environmentId,
            input: { projectId: projectRef.projectId },
          })
        : null,
    [open, projectRef.environmentId, projectRef.projectId],
  );
  const query = useEnvironmentQuery(queryAtom);
  const normalizedSearch = search
    .trim()
    .replace(/^(?:codex\s+resume|claude\s+--resume)\s+/i, "")
    .toLowerCase();
  const sessions = (query.data?.sessions ?? []).filter((session) =>
    [session.title, session.sessionId, session.branch, session.cwd, session.provider].some(
      (value) => value?.toLowerCase().includes(normalizedSearch),
    ),
  );

  const select = async (session: ResumableAgentSession) => {
    if (attachingRef.current) return;
    attachingRef.current = true;
    setAttaching(true);
    setError(null);
    const result = await attach({
      environmentId: projectRef.environmentId,
      input: {
        projectId: projectRef.projectId,
        providerInstanceId: session.providerInstanceId,
        sessionId: session.sessionId,
      },
    });
    attachingRef.current = false;
    if (!mounted.current) return;
    setAttaching(false);
    if (result._tag !== "Success") {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not resume this session.");
      return;
    }
    setOpen(false);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(projectRef.environmentId, result.value.threadId),
      ),
    });
  };

  return (
    <Combobox<ResumableAgentSession>
      items={sessions}
      filter={null}
      value={null}
      open={open}
      onOpenChange={(value) => {
        if (!attachingRef.current) {
          setOpen(value);
          setError(null);
          setSearch("");
        }
      }}
      onValueChange={(value) => {
        if (value) void select(value);
      }}
      itemToStringLabel={(item) => item.title}
    >
      <ComboboxTrigger
        render={<ComposerControl size="xs" />}
        aria-label="Resume a session"
        data-composer-context-control
      >
        <HistoryIcon className="size-3" />
        <span>Resume</span>
        <ComposerControlChevron size="xs" />
      </ComboboxTrigger>
      <ComboboxPopup side="top" align="start" className="w-96" {...floatingLayerProps}>
        <ComboboxSearchInput
          placeholder="Search sessions or paste a resume command…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted-foreground">
          <span>Codex and Claude · All project worktrees</span>
          <Button
            variant="ghost"
            size="xs"
            disabled={query.isPending || attaching}
            onClick={query.refresh}
          >
            Refresh
          </Button>
        </div>
        {error || query.error ? <ComboboxStatus>{error ?? query.error}</ComboboxStatus> : null}
        {attaching ? (
          <ComboboxStatus>Opening session…</ComboboxStatus>
        ) : query.isPending && !query.data ? (
          <ComboboxStatus>Finding sessions…</ComboboxStatus>
        ) : (
          <>
            {!query.error ? <ComboboxEmpty>No external sessions found.</ComboboxEmpty> : null}
            <ComboboxList>
              {(session: ResumableAgentSession) => {
                const Icon = PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make(session.provider)];
                const providerName =
                  PROVIDER_DISPLAY_NAMES[ProviderDriverKind.make(session.provider)] ??
                  session.provider;
                return (
                  <ComboboxItem
                    key={`${session.providerInstanceId}:${session.sessionId}`}
                    value={session}
                    hideIndicator
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-2 py-1">
                      {Icon ? (
                        <Icon className="mt-0.5 size-4 shrink-0" aria-label={providerName} />
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{session.title}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {providerName} · {session.branch ?? session.cwd.split(/[\\/]/).at(-1)}
                        </div>
                      </div>
                      <time
                        className="shrink-0 text-xs text-muted-foreground"
                        dateTime={session.updatedAt}
                      >
                        {formatRelativeTimeLabel(session.updatedAt)}
                      </time>
                    </div>
                  </ComboboxItem>
                );
              }}
            </ComboboxList>
          </>
        )}
        {query.data?.truncated ? (
          <ComboboxStatus>Showing the most recent sessions.</ComboboxStatus>
        ) : null}
      </ComboboxPopup>
    </Combobox>
  );
}
