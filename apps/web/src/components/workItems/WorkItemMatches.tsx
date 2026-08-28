import type {
  EnvironmentId,
  ProjectId,
  WorkItemMatch,
  WorkItemMatchInput,
  WorkItemMatchRelationship,
} from "@t3tools/contracts";
import { ArrowUpRightIcon, LinkIcon, LoaderIcon, SparklesIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { findWorkItemMatches } from "~/state/workItems";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function WorkItemMatchButton({
  busy,
  disabled = false,
  loaded,
  onClick,
}: {
  busy: boolean;
  disabled?: boolean;
  loaded: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="xs" variant="ghost" disabled={busy || disabled} onClick={onClick}>
      {busy ? (
        <LoaderIcon aria-hidden className="size-3 animate-spin" />
      ) : (
        <SparklesIcon aria-hidden className="size-3" />
      )}
      {busy ? "Finding..." : loaded ? "Refresh with AI" : "Find with AI"}
    </Button>
  );
}

export function WorkItemMatchRows({
  matches,
  emptyText,
  onOpen,
  onLink,
  linking = false,
}: {
  matches: ReadonlyArray<WorkItemMatch>;
  emptyText: string;
  onOpen: (match: WorkItemMatch) => void;
  onLink?: (match: WorkItemMatch) => void;
  linking?: boolean;
}) {
  if (matches.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>;
  }
  return (
    <div className="space-y-1">
      <p className="px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Suggested by AI
      </p>
      {matches.map((match) => (
        <div
          key={`${match.provider}:${match.repository}#${match.number}`}
          className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
        >
          <button
            type="button"
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
            onClick={() => onOpen(match)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium">{match.title}</span>
              <span className="block text-[11px] text-muted-foreground">{match.reason}</span>
            </span>
            <Badge variant="outline" className="shrink-0 text-[9px]">
              {match.confidence === "high" ? "High confidence" : "Medium confidence"}
            </Badge>
            <ArrowUpRightIcon
              aria-hidden
              className="mt-0.5 size-3 shrink-0 text-muted-foreground"
            />
          </button>
          {onLink ? (
            <Button
              size="xs"
              variant="ghost"
              className="h-6 shrink-0 px-2 text-[10px] text-muted-foreground"
              disabled={linking}
              onClick={() => onLink(match)}
            >
              <LinkIcon aria-hidden className="size-3" />
              {linking ? "Preparing..." : "Link with agent"}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

type MatchCache = {
  readonly key: string;
  readonly related?: ReadonlyArray<WorkItemMatch>;
  readonly duplicate?: ReadonlyArray<WorkItemMatch>;
};

type WorkItemMatchCacheInput = {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly source: WorkItemMatchInput["source"];
  readonly version: string;
};

export function workItemMatchCacheKey(input: WorkItemMatchCacheInput): string {
  return JSON.stringify([
    input.environmentId,
    input.projectId,
    input.source.kind,
    input.source.provider ?? null,
    input.source.repository,
    input.source.number,
    input.version,
  ]);
}

export function useWorkItemMatches(input: WorkItemMatchCacheInput) {
  const run = useAtomCommand(findWorkItemMatches, { reportFailure: false });
  const key = workItemMatchCacheKey(input);
  const [cache, setCache] = useState<MatchCache>({ key });
  const [pending, setPending] = useState<WorkItemMatchRelationship | null>(null);
  const find = useCallback(
    async (relationship: WorkItemMatchRelationship) => {
      if (pending !== null) return;
      setPending(relationship);
      const response = await run({
        environmentId: input.environmentId,
        input: { projectId: input.projectId, source: input.source, relationship },
      });
      setPending(null);
      if (response._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not find matches" });
        return;
      }
      setCache((current) => ({
        ...(current.key === key ? current : { key }),
        [relationship]: response.value.matches,
      }));
    },
    [input.environmentId, input.projectId, input.source, key, pending, run],
  );
  const current = cache.key === key ? cache : { key };
  return { find, pending, related: current.related, duplicate: current.duplicate };
}
