import type {
  LinearActivityItem,
  LinearComment,
  LinearIssue,
  LinearIssueDetail,
  LinearViewer,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { ButtonGroup } from "../ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { LinearActivityPill } from "./LinearActivityPill";
import {
  LinearAvatar,
  LinearGlyph,
  LinearMilestoneIcon,
  LinearPriorityIcon,
  LinearStateIcon,
  LinearTeamBadge,
} from "./linearIcons";
import {
  activityStatusLabel,
  formatProgressPercent,
  pickActivityPill,
  stepTone,
} from "./linearIssueList.logic";
import { useLinearLaunchActions } from "./linearLaunchTypes";
import {
  useLinearActivity,
  useLinearEnvironmentId,
  useLinearIssueDetail,
  useLinearPipelines,
} from "./useLinearData";
import { buildThreadRouteParams } from "../../threadRoutes";

const COPY_TOASTS = {
  onCopy: (label: string) => toastManager.add({ type: "success", title: `${label} copied` }),
  onError: (_error: Error, label: string) =>
    toastManager.add({ type: "error", title: `Failed to copy ${label.toLowerCase()}` }),
};

const TONE_CLASS = {
  ok: "bg-success",
  running: "bg-info",
  failed: "bg-destructive",
  idle: "bg-border",
} as const;

function SectionHeader({
  children,
  count,
}: {
  children: React.ReactNode;
  count?: number | undefined;
}) {
  return (
    <h3 className="flex h-6 items-center gap-1.5 text-xs font-medium text-muted-foreground">
      {children}
      {count === undefined ? null : <span className="font-normal tabular-nums">{count}</span>}
    </h3>
  );
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="flex h-7 items-center text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 flex min-w-0 items-center gap-1.5 text-xs">{children}</dd>
    </>
  );
}

function ActivityRow({
  item,
  onOpen,
}: {
  item: LinearActivityItem;
  onOpen: (item: LinearActivityItem) => void;
}) {
  const pipeline = item.pipeline;
  const failed = item.status === "failed";
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="flex w-full cursor-pointer items-start gap-2 border-b border-border px-2.5 py-2 text-left last:border-b-0 hover:bg-accent/60"
    >
      <span className="mt-0.5 text-muted-foreground">
        {pipeline ? (
          <WorkflowIcon
            aria-hidden
            className={cn("size-3.5", failed && "text-destructive-foreground")}
          />
        ) : (
          <MessageSquareIcon aria-hidden className="size-3.5" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-sm">{pipeline?.name ?? item.title}</span>
        {pipeline ? (
          <span className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
            <span className="inline-flex shrink-0 items-center gap-0.75">
              {pipeline.steps.map((step, index) => (
                <i
                  key={step.name + String(index)}
                  aria-label={`${step.name}: ${step.status}`}
                  className={cn("block h-1 w-3.5 rounded-full", TONE_CLASS[stepTone(step.status)])}
                />
              ))}
            </span>
            <span className="truncate">
              {pipeline.failedStepName
                ? `${pipeline.failedStepName} failed`
                : (pipeline.currentStepName ?? item.title)}
            </span>
          </span>
        ) : (
          <span className="truncate text-2xs text-muted-foreground">
            {[item.provider, item.messageCount === null ? null : `${item.messageCount} messages`]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end text-2xs text-muted-foreground">
        <span
          className={cn(
            failed && "text-destructive-foreground",
            item.status === "running" && "text-info-foreground",
          )}
        >
          {activityStatusLabel(item.status)}
        </span>
        <span className="tabular-nums">
          <RelativeTime timestamp={item.updatedAt} />
        </span>
      </span>
    </button>
  );
}

function CommentRow({ comment }: { comment: LinearComment }) {
  return (
    <div className="flex gap-2.5">
      <LinearAvatar user={comment.author} />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        <div className="flex items-baseline gap-1.5 text-xs font-medium">
          {comment.author?.name ?? "Linear"}
          <span className="text-2xs font-normal text-muted-foreground">
            <RelativeTime timestamp={comment.createdAt} />
          </span>
        </div>
        <ChatMarkdown text={comment.body} cwd={undefined} lineBreaks className="text-sm" />
      </div>
    </div>
  );
}

function SubIssueRow({
  issue,
  onSelect,
}: {
  issue: LinearIssue;
  onSelect: (issueId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(issue.id)}
      className="flex min-h-8 w-full cursor-pointer items-center gap-2 border-b border-border px-2.5 text-left text-sm last:border-b-0 hover:bg-accent/60"
    >
      <LinearStateIcon type={issue.state.type} color={issue.state.color} />
      <span className="shrink-0 font-mono text-2xs text-muted-foreground">{issue.identifier}</span>
      <span className="min-w-0 flex-1 truncate">{issue.title}</span>
      <LinearAvatar user={issue.assignee} className="size-4" />
    </button>
  );
}

function LaunchControls({ issueId }: { issueId: string }) {
  const launch = useLinearLaunchActions();
  const pipelines = useLinearPipelines();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ButtonGroup>
        <Button
          size="sm"
          disabled={launch === null}
          onClick={() => launch?.startChat(issueId)}
          data-testid="linear-start-chat"
        >
          <MessageSquareIcon aria-hidden />
          Start chat
        </Button>
        <Menu>
          <MenuTrigger
            aria-label="Start chat options"
            disabled={launch === null}
            render={<Button size="icon-sm" />}
          >
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom">
            <MenuItem onClick={() => launch?.startChat(issueId, { workspace: "worktree" })}>
              New worktree
            </MenuItem>
            <MenuItem onClick={() => launch?.startChat(issueId, { workspace: "local" })}>
              Local checkout
            </MenuItem>
          </MenuPopup>
        </Menu>
      </ButtonGroup>
      <Menu>
        <MenuTrigger
          disabled={launch === null}
          render={<Button variant="outline" size="sm" />}
          data-testid="linear-run-pipeline"
        >
          <WorkflowIcon aria-hidden />
          Run pipeline
          <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
        </MenuTrigger>
        <MenuPopup align="start" side="bottom" className="min-w-60">
          <MenuGroup>
            <MenuGroupLabel>Run pipeline</MenuGroupLabel>
            {pipelines.length === 0 ? (
              <MenuItem disabled>No pipelines yet</MenuItem>
            ) : (
              pipelines.map((pipeline) => (
                <MenuItem
                  key={pipeline.id}
                  onClick={() => launch?.openPipelineDialog(issueId, pipeline.id)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{pipeline.name}</span>
                    <span className="truncate text-2xs text-muted-foreground">
                      {pipeline.steps.map((step) => step.name).join(" → ")}
                    </span>
                  </span>
                </MenuItem>
              ))
            )}
          </MenuGroup>
          {pipelines.length > 0 ? <MenuSeparator /> : null}
          <MenuItem
            disabled={pipelines.length === 0}
            onClick={() => launch?.openPipelineDialog(issueId)}
          >
            Choose in dialog…
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function DetailBody({
  detail,
  viewer,
  onSelectIssue,
}: {
  detail: LinearIssueDetail;
  viewer: LinearViewer | null;
  onSelectIssue: (issueId: string) => void;
}) {
  const { issue } = detail;
  const navigate = useNavigate();
  const environmentId = useLinearEnvironmentId();
  const openPullRequest = useOpenPrLink();
  const activityQuery = useLinearActivity();
  const activityLoaded = activityQuery.data !== null;
  const activity = activityQuery.byIssueId.get(issue.id);
  const { copyToClipboard, isCopied } = useCopyToClipboard<string>({
    target: "branch name",
    timeout: 1600,
    onError: COPY_TOASTS.onError,
  });
  const pill = pickActivityPill(issue, activity);
  const items = activity?.items ?? [];
  const openActivity = (item: LinearActivityItem) => {
    if (environmentId === null) return;
    // A pipeline run opens through its parent thread, like every other run entry point.
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId: item.link.threadId }),
    });
  };
  return (
    <div className="flex flex-col gap-4.5 px-4 pt-3.5 pb-10">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 font-mono text-2xs text-muted-foreground">
          <LinearPriorityIcon priority={issue.priority} className="size-3" />
          {issue.identifier}
          <span className="opacity-50">·</span>
          <span className="font-sans">
            updated <RelativeTime timestamp={issue.updatedAt} />
          </span>
          {pill ? <LinearActivityPill pill={pill} /> : null}
        </div>
        <h2 className="m-0 text-lg leading-6 font-semibold tracking-tight">{issue.title}</h2>
        {issue.parent ? (
          <button
            type="button"
            onClick={() => onSelectIssue(issue.parent!.id)}
            className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground"
          >
            Sub-issue of {issue.parent.identifier}
          </button>
        ) : null}
      </div>

      <LaunchControls issueId={issue.id} />

      <div className="flex max-w-full items-center gap-1.5 rounded-md border border-dashed border-border py-0.5 pr-1 pl-2 font-mono text-2xs text-muted-foreground">
        <GitBranchIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{issue.branchName}</span>
        <Button
          variant="ghost-muted"
          size="micro"
          onClick={() => copyToClipboard(issue.branchName, "Branch name")}
        >
          {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {isCopied ? "Copied" : "Copy branch name"}
        </Button>
      </div>

      <dl className="m-0 grid grid-cols-[88px_1fr] gap-x-2 gap-y-0.5">
        <MetaRow label="State">
          <LinearStateIcon type={issue.state.type} color={issue.state.color} />
          {issue.state.name}
        </MetaRow>
        <MetaRow label="Priority">
          <LinearPriorityIcon priority={issue.priority} />
          {issue.priorityLabel}
        </MetaRow>
        <MetaRow label="Assignee">
          <LinearAvatar user={issue.assignee} className="size-4" />
          {issue.assignee?.name ?? "Unassigned"}
          {issue.assignee !== null && issue.assignee.id === viewer?.id ? (
            <span className="text-muted-foreground">(you)</span>
          ) : null}
        </MetaRow>
        {issue.project ? <MetaRow label="Project">{issue.project.name}</MetaRow> : null}
        {issue.milestone ? (
          <MetaRow label="Milestone">
            <LinearMilestoneIcon progress={detail.milestoneProgress ?? 0} />
            {issue.milestone.name}
            {detail.milestoneProgress === null ? null : (
              <span className="text-2xs text-muted-foreground tabular-nums">
                {formatProgressPercent(detail.milestoneProgress)}%
              </span>
            )}
          </MetaRow>
        ) : null}
        {issue.cycle ? <MetaRow label="Cycle">Cycle {issue.cycle.number}</MetaRow> : null}
        {issue.labels.length > 0 ? (
          <MetaRow label="Labels">
            <span className="flex flex-wrap gap-1">
              {issue.labels.map((label) => (
                <span
                  key={label.id}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 text-2xs leading-3.75 text-muted-foreground"
                >
                  <i
                    aria-hidden
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  {label.name}
                </span>
              ))}
            </span>
          </MetaRow>
        ) : null}
      </dl>

      {detail.description.trim() === "" ? null : (
        <section className="flex flex-col gap-1.5">
          <SectionHeader>Description</SectionHeader>
          <ChatMarkdown text={detail.description} cwd={undefined} className="text-sm" />
        </section>
      )}

      {detail.subIssues.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <SectionHeader count={detail.subIssues.length}>Sub-issues</SectionHeader>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {detail.subIssues.map((subIssue) => (
              <SubIssueRow key={subIssue.id} issue={subIssue} onSelect={onSelectIssue} />
            ))}
          </div>
        </section>
      ) : detail.subIssuesFailed ? (
        <section className="flex flex-col gap-1.5">
          <SectionHeader>Sub-issues</SectionHeader>
          <p className="m-0 text-xs text-muted-foreground">Couldn't load sub-issues.</p>
        </section>
      ) : null}

      {issue.linkedPullRequests.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <SectionHeader count={issue.linkedPullRequests.length}>
            Linked pull requests
          </SectionHeader>
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {issue.linkedPullRequests.map((pullRequest) => (
              <a
                key={pullRequest.url}
                href={pullRequest.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  openPullRequest(event, pullRequest.url);
                }}
                className="flex min-h-8 items-center gap-2 border-b border-border px-2.5 text-sm last:border-b-0 hover:bg-accent/60"
              >
                <PullRequestGlyph.pullRequest
                  aria-hidden
                  className={cn(
                    "size-3.5",
                    pullRequest.state?.toLowerCase() === "open"
                      ? "text-success-foreground"
                      : "text-muted-foreground",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">
                  {pullRequest.repository ? `${pullRequest.repository} ` : ""}#{pullRequest.number}
                </span>
                {pullRequest.state ? (
                  <span className="text-2xs text-muted-foreground capitalize">
                    {pullRequest.state.toLowerCase()}
                  </span>
                ) : null}
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-1.5">
        <SectionHeader count={activityLoaded ? items.length : undefined}>
          <span className="rounded border border-border bg-muted px-1 text-3xs font-bold tracking-wide text-foreground/85">
            T3
          </span>
          T3 activity
        </SectionHeader>
        {!activityLoaded ? (
          activityQuery.error === null ? (
            <Skeleton className="h-12 w-full" shape="card" />
          ) : (
            <p className="m-0 text-xs text-muted-foreground">Couldn&apos;t load T3 activity.</p>
          )
        ) : items.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">
            No chats or pipeline runs started from this issue yet.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {items.map((item) => (
              <ActivityRow key={item.link.linkId} item={item} onOpen={openActivity} />
            ))}
          </div>
        )}
      </section>

      {detail.comments.length > 0 ? (
        <section className="flex flex-col gap-2.5">
          <SectionHeader count={detail.comments.length}>Recent comments</SectionHeader>
          {detail.comments.map((comment) => (
            <CommentRow key={comment.id} comment={comment} />
          ))}
        </section>
      ) : null}

      <a
        href={issue.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <LinearGlyph className="size-3" />
        Open in Linear
        <ExternalLinkIcon aria-hidden className="size-3" />
      </a>
    </div>
  );
}

export function LinearIssueDetailPanel({
  issueId,
  viewer,
  teamColors,
  onClose,
  onSelectIssue,
}: {
  issueId: string;
  viewer: LinearViewer | null;
  teamColors: ReadonlyMap<string, string | null>;
  onClose: () => void;
  onSelectIssue: (issueId: string) => void;
}) {
  const query = useLinearIssueDetail(issueId);
  // The issue switched but its answer has not landed: never show the previous issue's body.
  const detail = query.data?.issue.id === issueId ? query.data : null;
  const { copyToClipboard } = useCopyToClipboard<string>({
    target: "issue details",
    timeout: 0,
    ...COPY_TOASTS,
  });
  const issue = detail?.issue;
  return (
    <aside
      aria-label="Issue details"
      data-testid="linear-issue-detail"
      className="flex min-h-0 w-[420px] shrink-0 flex-col border-l border-border bg-background max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-20 max-lg:w-full max-lg:max-w-[420px] max-lg:shadow-xl"
    >
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/60 pr-2 pl-4 text-xs text-muted-foreground">
        {issue ? (
          <>
            <LinearTeamBadge
              teamKey={issue.team.key}
              color={teamColors.get(issue.team.id) ?? null}
            />
            <span className="min-w-0 truncate">
              {issue.team.name}
              {issue.milestone ? ` › ${issue.milestone.name}` : ""}
            </span>
          </>
        ) : null}
        <span className="flex-1" />
        {issue ? (
          <Button
            variant="ghost-muted"
            size="xs"
            render={<a href={issue.url} target="_blank" rel="noopener noreferrer" />}
          >
            <LinearGlyph className="size-3" />
            Open in Linear
            <ExternalLinkIcon aria-hidden className="size-3" />
          </Button>
        ) : null}
        <Menu>
          <MenuTrigger
            aria-label="More"
            disabled={!issue}
            render={<Button variant="ghost-muted" size="icon-xs" />}
          >
            <MoreHorizontalIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end" side="bottom">
            <MenuItem onClick={() => issue && copyToClipboard(issue.url, "Issue link")}>
              Copy issue link
            </MenuItem>
            <MenuItem onClick={() => issue && copyToClipboard(issue.identifier, "Identifier")}>
              Copy identifier
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Button variant="ghost-muted" size="icon-xs" aria-label="Close (Esc)" onClick={onClose}>
          <XIcon aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {detail ? (
          <DetailBody detail={detail} viewer={viewer} onSelectIssue={onSelectIssue} />
        ) : query.error !== null ? (
          <div className="flex flex-col items-start gap-2 p-4 text-sm text-muted-foreground">
            <p className="m-0">Couldn&apos;t load this issue.</p>
            <Button variant="outline" size="sm" onClick={query.refresh}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-4" aria-busy>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-6 w-4/5" />
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-32 w-full" shape="card" />
          </div>
        )}
      </div>
    </aside>
  );
}
