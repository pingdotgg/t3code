import { useAtomValue } from "@effect/atom-react";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type ProjectCodeEdge,
  type ProjectCodeQueryResult,
  type PullRequestDetailView,
  type PullRequestRef,
} from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { msg, T, useMessages } from "gt-react";

import { resolveFileDiffPath } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { useThreadShellsForProjectRefs } from "~/state/entities";
import { projectCode } from "~/state/projectCode";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { CodeIndexBadge } from "../files/CodeIndexBadge";
import { CoverageNote, EmptyNote, GRADE_LABEL, QueryState } from "../files/codeRelationshipRows";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

// The server analyzes at most 20 changed declarations per file; asking for more only truncates.
const SYMBOLS_PER_FILE = 20;
const MAX_FILES = 50;

const GRADE_VARIANT = {
  "compiler-indexed": "success",
  "static-candidate": "secondary",
  "heuristic-candidate": "warning",
} as const satisfies Record<ProjectCodeEdge["evidenceGrade"], string>;

/**
 * The thread whose checkout is on the pull request's head branch, preferring a dedicated
 * worktree. Matching is by branch name, so the panel names the checkout it analyzed.
 */
function pullRequestCheckoutThread(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
  headBranch: string,
): EnvironmentThreadShell | null {
  const candidates = shells.filter(
    (shell) =>
      shell.environmentId === environmentId &&
      shell.branch === headBranch &&
      shell.archivedAt === null,
  );
  return candidates.find((shell) => shell.worktreePath !== null) ?? candidates[0] ?? null;
}

/** New-side line spans of a file's hunks; a deleted file has none to analyze. */
function changedLineRanges(fileDiff: FileDiffMetadata) {
  return fileDiff.hunks
    .filter((hunk) => hunk.additionCount > 0)
    .slice(0, 200)
    .map((hunk) => ({
      start: Math.max(1, hunk.additionStart),
      end: Math.max(1, hunk.additionStart + hunk.additionCount - 1),
    }));
}

function AffectedSymbols(props: { readonly result: ProjectCodeQueryResult }) {
  const m = useMessages();
  const nodes = new Map(props.result.nodes.map((node) => [node.id, node]));
  const gradeOf = (callerId: string, symbolId: string) =>
    props.result.edges.find((edge) => edge.source === callerId && edge.target === symbolId)
      ?.evidenceGrade;
  const groups = props.result.symbolGroups ?? [];
  if (groups.length === 0) {
    return (
      <EmptyNote>{m(msg("No indexed declarations overlap this file's changed hunks."))}</EmptyNote>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {groups.map((group) => {
        const symbol = nodes.get(group.symbol);
        if (symbol === undefined) return null;
        return (
          <li key={group.symbol} className="flex flex-col gap-0.5">
            <span className="px-2 font-mono text-xs text-foreground">
              {symbol.name}
              <span className="ms-2 font-sans text-2xs text-muted-foreground">
                {m(msg("{kind} · line {line}"), { kind: symbol.kind, line: symbol.startLine })}
              </span>
            </span>
            {group.callers.length === 0 && group.tests.length === 0 ? (
              <EmptyNote>{m(msg("No static callers or reaching tests found."))}</EmptyNote>
            ) : null}
            {group.callers.map((id) => {
              const caller = nodes.get(id);
              if (caller === undefined) return null;
              const grade = gradeOf(id, group.symbol);
              return (
                <span key={id} className="flex min-w-0 items-baseline gap-2 ps-5 pe-2 text-xs">
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    <T>caller</T>
                  </span>
                  <span className="min-w-0 truncate font-mono">{caller.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {caller.path}:{caller.startLine}
                  </span>
                  {grade ? (
                    <Badge variant={GRADE_VARIANT[grade]} size="sm">
                      {m(GRADE_LABEL[grade])}
                    </Badge>
                  ) : null}
                </span>
              );
            })}
            {group.tests.map((id) => {
              const test = nodes.get(id);
              if (test === undefined) return null;
              return (
                <span key={id} className="flex min-w-0 items-baseline gap-2 ps-5 pe-2 text-xs">
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    <T>likely test</T>
                  </span>
                  <span className="min-w-0 truncate font-mono">{test.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {test.path}:{test.startLine}
                  </span>
                  <Badge variant="secondary" size="sm">
                    <T>static reachability</T>
                  </Badge>
                </span>
              );
            })}
          </li>
        );
      })}
    </ul>
  );
}

function AffectedFile(props: {
  readonly environmentId: EnvironmentId;
  readonly checkout: EnvironmentThreadShell;
  readonly fileDiff: FileDiffMetadata;
}) {
  const [open, setOpen] = useState(false);
  const path = resolveFileDiffPath(props.fileDiff);
  const deleted = props.fileDiff.type === "deleted";
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        disabled={deleted}
        className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left text-xs disabled:cursor-default"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            deleted && "invisible",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{path}</span>
        {deleted ? (
          <span className="shrink-0 text-2xs text-muted-foreground">
            <T>deleted</T>
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        {open ? (
          <AffectedFileResult
            environmentId={props.environmentId}
            checkout={props.checkout}
            path={path}
            fileDiff={props.fileDiff}
          />
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function AffectedFileResult(props: {
  readonly environmentId: EnvironmentId;
  readonly checkout: EnvironmentThreadShell;
  readonly path: string;
  readonly fileDiff: FileDiffMetadata;
}) {
  const m = useMessages();
  const ranges = changedLineRanges(props.fileDiff);
  const affected = useEnvironmentQuery(
    projectCode.query({
      environmentId: props.environmentId,
      input: {
        projectId: props.checkout.projectId,
        threadId: props.checkout.id,
        query: {
          operation: "affected",
          filePath: props.path,
          ...(ranges.length > 0 ? { lineRanges: ranges } : {}),
          limit: SYMBOLS_PER_FILE,
        },
      },
    }),
    m,
  );
  if (affected.data === null) {
    return <QueryState pending error={affected.error} onRetry={affected.refresh} />;
  }
  return (
    <div className="flex flex-col gap-1 pb-2">
      <CoverageNote coverage={affected.data.coverage} />
      <AffectedSymbols result={affected.data} />
    </div>
  );
}

function ImpactBody(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetailView;
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
}) {
  const m = useMessages();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canReadFreshness = config?.environment.capabilities.projectCodeFreshness === true;
  const shells = useThreadShellsForProjectRefs([
    { environmentId: props.environmentId, projectId: props.reference.projectId },
  ]);
  const checkout = pullRequestCheckoutThread(shells, props.environmentId, props.detail.headBranch);
  // Shares the badge's cached freshness read; it names the commit the checkout is at.
  const freshness = useEnvironmentQuery(
    checkout === null || !canReadFreshness
      ? null
      : projectCode.freshness({
          environmentId: props.environmentId,
          input: {
            projectId: checkout.projectId,
            threadId: checkout.id,
            query: { operation: "freshness" },
          },
        }),
    m,
  );
  const checkoutHead = freshness.data?.index?.headCommit ?? null;
  const headSha = props.detail.headSha ?? null;
  const behind =
    checkoutHead !== null &&
    headSha !== null &&
    !checkoutHead.startsWith(headSha) &&
    !headSha.startsWith(checkoutHead);
  if (checkout === null) {
    return (
      <EmptyNote>
        {m(
          msg(
            "No thread here has {branch} checked out, so there is no checkout to analyze. Check out this pull request in a thread to see callers and likely tests.",
          ),
          { branch: props.detail.headBranch },
        )}
      </EmptyNote>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 px-2 text-2xs text-muted-foreground">
        <span className="min-w-0 flex-1">
          {m(
            msg(
              "Static candidates from the {branch} checkout in “{title}”. Callers and tests are graph reachability, not proof of impact or coverage.",
            ),
            { branch: props.detail.headBranch, title: checkout.title },
          )}
        </span>
        <CodeIndexBadge
          environmentId={props.environmentId}
          projectId={checkout.projectId}
          threadId={checkout.id}
        />
      </div>
      {behind ? (
        <p className="px-2 text-2xs text-warning-foreground">
          {m(
            msg(
              "This checkout is at {checkout}, but the pull request head is {head}. Results describe the checkout, not the latest push.",
            ),
            { checkout: checkoutHead.slice(0, 7), head: headSha.slice(0, 7) },
          )}
        </p>
      ) : null}
      {props.fileDiffs.slice(0, MAX_FILES).map((fileDiff) => (
        <AffectedFile
          key={resolveFileDiffPath(fileDiff)}
          environmentId={props.environmentId}
          checkout={checkout}
          fileDiff={fileDiff}
        />
      ))}
      {props.fileDiffs.length > MAX_FILES ? (
        <EmptyNote>
          {m(msg("Showing the first {count} changed files."), { count: MAX_FILES })}
        </EmptyNote>
      ) : null}
    </div>
  );
}

/**
 * Callers and likely tests for the declarations a pull request changes, read from T3's own
 * checkout of its head branch. Nothing is analyzed until a file is expanded.
 */
export function PullRequestImpactPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly detail: PullRequestDetailView;
  readonly fileDiffs: ReadonlyArray<FileDiffMetadata>;
}) {
  const m = useMessages();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canQuery = useAtomValue(projectCode.query.permissionAtom(props.environmentId));
  const [open, setOpen] = useState(false);
  if (config?.environment.capabilities.projectCode !== true || !canQuery) return null;
  if (props.fileDiffs.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-border/60">
      <Collapsible open={open} onOpenChange={setOpen}>
        <h2>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground">
            <span>
              <T>Potentially affected</T>
            </span>
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
          </CollapsibleTrigger>
        </h2>
        <CollapsiblePanel>
          {open ? (
            <div className="max-h-80 overflow-auto px-2 pb-3">
              {config.environment.capabilities.projectCodeAffected === true ? (
                <ImpactBody
                  environmentId={props.environmentId}
                  reference={props.reference}
                  detail={props.detail}
                  fileDiffs={props.fileDiffs}
                />
              ) : (
                <EmptyNote>
                  {m(msg("Update the server to use potentially affected symbols."))}
                </EmptyNote>
              )}
            </div>
          ) : null}
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
