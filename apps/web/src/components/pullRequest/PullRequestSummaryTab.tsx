import { parsePullRequestAnchor } from "@t3tools/shared/pullRequestAnchor";
import { holdLinkedNodeInView } from "./holdLinkedNodeInView";
import { useAtomValue } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  type EnvironmentId,
  type PullRequestDetailView,
  type PullRequestRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ChevronRightIcon, HammerIcon, TagIcon, UsersIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { m } from "~/i18n/messages";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { cn } from "~/lib/utils";
import { useOpenLink } from "~/browser/useOpenLink";

import { Button } from "../ui/button";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestActorLabel,
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  PullRequestLabelChip,
  pullRequestReviewOutcomeLabel,
  PullRequestReviewOutcomeAvatarBadge,
  pullRequestReviewOutcomeRingClassName,
  pullRequestReviewOutcomeStaleLabel,
} from "./pullRequestPresentation";
import { PullRequestLabelPicker } from "./PullRequestLabelPicker";
import { PullRequestReviewerPicker } from "./PullRequestReviewerPicker";
import {
  latestPullRequestReviewOutcomes,
  pullRequestFindingKey,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";
import {
  canEditPullRequestChangeRequest,
  descriptionDraftInForce,
  settleDescriptionSave,
  startDescriptionSave,
  type DescriptionDraft,
} from "@t3tools/client-runtime/pull-request-editing";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskList";
import { PullRequestMarkdown } from "./PullRequestMarkdown";
import { PullRequestMarkdownEditor } from "./PullRequestMarkdownEditor";
import { pullRequestCompletionScope } from "./PullRequestMarkdownTextarea";
import { PullRequestMetaRow } from "./PullRequestDetailLayout";
import { sectionCollapseAnchorScrollTop } from "./pullRequestSummaryScroll.logic";

import { changeRequestTermKind } from "./changeRequestTerm";

function reviewerKey(login: string): string {
  return login.toLowerCase();
}

export function PullRequestSection({
  title,
  name,
  defaultOpen = true,
  keepMounted = false,
  revealCount = 0,
  actions,
  children,
}: {
  title: string;
  /** Stable key for links that reveal this section, since the title is translated. */
  name?: string;
  defaultOpen?: boolean;
  keepMounted?: boolean;
  /** Reopens the section each time a link reveals it. */
  revealCount?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  // A reveal opens at once: the opening animation would move what was just scrolled to.
  const [open, setOpen] = useState<boolean | "revealed">(
    revealCount > 0 ? "revealed" : defaultOpen,
  );
  const [seenRevealCount, setSeenRevealCount] = useState(revealCount);
  if (revealCount !== seenRevealCount) {
    setSeenRevealCount(revealCount);
    setOpen("revealed");
  }
  const headingRef = useRef<HTMLDivElement>(null);
  const setOpenWithScrollAnchor = (nextOpen: boolean) => {
    if (!nextOpen) {
      const heading = headingRef.current;
      const section = heading?.closest<HTMLElement>("[data-pull-request-summary-section]");
      const scroller = heading?.closest<HTMLElement>("[data-pull-request-summary-scroll]");
      if (heading && section && scroller) {
        const target = sectionCollapseAnchorScrollTop({
          scrollTop: scroller.scrollTop,
          viewportTop: scroller.getBoundingClientRect().top,
          sectionTop: section.getBoundingClientRect().top,
          headingTop: heading.getBoundingClientRect().top,
        });
        // Adjust before paint to keep the collapsed heading in place.
        if (target !== null) scroller.scrollTop = target;
      }
    }
    setOpen(nextOpen);
  };
  return (
    <Collapsible
      open={open !== false}
      onOpenChange={setOpenWithScrollAnchor}
      render={<section aria-label={title} />}
      data-pull-request-summary-section={name ?? ""}
    >
      <div
        ref={headingRef}
        className="sticky top-0 z-10 flex w-full items-center bg-background pr-4"
      >
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 px-4 py-3 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
          <span>{title}</span>
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
        </CollapsibleTrigger>
        {actions}
      </div>
      <CollapsiblePanel keepMounted={keepMounted} animate={open !== "revealed"}>
        <div className="px-4 pb-4">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** The header's Reviewers and Labels rows, with their pickers. */
export function PullRequestPeopleRows({
  environmentId,
  reference,
  detail,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
}) {
  const gt = useGT();
  const resolve = useMessages();
  // Verdicts outside the visible comment window still count.
  const reviewOutcomes = latestPullRequestReviewOutcomes(detail.comments, detail.commits);
  // Host login casing varies; normalize to preserve verdicts and deduplicate reviewers.
  const outcomeByLogin = new Map(
    reviewOutcomes.flatMap((entry) =>
      entry.actor ? [[reviewerKey(entry.actor.login), entry] as const] : [],
    ),
  );
  // Hosts remove reviewed actors from requests; include submitted verdicts.
  const reviewerEntries = [
    ...detail.reviewers.map((actor) => ({
      key: actor.login,
      actor,
      outcome: outcomeByLogin.get(reviewerKey(actor.login))?.outcome ?? null,
      stale: outcomeByLogin.get(reviewerKey(actor.login))?.stale ?? false,
    })),
    ...reviewOutcomes
      .filter(
        (entry) =>
          !detail.reviewers.some(
            (actor) =>
              entry.actor !== null && reviewerKey(actor.login) === reviewerKey(entry.actor.login),
          ),
      )
      .map((entry) => ({
        key: entry.key,
        actor: entry.actor,
        outcome: entry.outcome,
        stale: entry.stale,
      })),
  ];
  return (
    <>
      <PullRequestMetaRow icon={<UsersIcon className="size-3.5" />} label={gt("Reviewers")}>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {reviewerEntries.length === 0 ? (
            <span className="text-muted-foreground">
              <T context="no reviewers">None</T>
            </span>
          ) : (
            <span className="flex items-center -space-x-1">
              {reviewerEntries.map((entry) => {
                const login = entry.actor?.login ?? "ghost";
                const named =
                  entry.actor?.name && entry.actor.name !== login
                    ? `${entry.actor.name} (@${login})`
                    : login;
                return (
                  <Tooltip key={entry.key}>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "relative rounded-full hover:z-10",
                            entry.outcome
                              ? pullRequestReviewOutcomeRingClassName(entry.outcome, entry.stale)
                              : undefined,
                          )}
                        />
                      }
                    >
                      <PullRequestActorLabel actor={entry.actor} tooltip={false} variant="avatar" />
                      {entry.outcome ? (
                        <>
                          <PullRequestReviewOutcomeAvatarBadge
                            outcome={entry.outcome}
                            stale={entry.stale}
                          />
                          <span className="sr-only">
                            {entry.stale
                              ? pullRequestReviewOutcomeStaleLabel(entry.outcome, resolve)
                              : pullRequestReviewOutcomeLabel(entry.outcome, resolve)}
                          </span>
                        </>
                      ) : null}
                    </TooltipTrigger>
                    <TooltipPopup side="bottom">
                      {entry.outcome
                        ? `${named}: ${
                            entry.stale
                              ? pullRequestReviewOutcomeStaleLabel(entry.outcome, resolve)
                              : pullRequestReviewOutcomeLabel(entry.outcome, resolve)
                          }`
                        : named}
                    </TooltipPopup>
                  </Tooltip>
                );
              })}
            </span>
          )}
          {/* Azure DevOps accepts reviewers but cannot list candidates. */}
          {detail.capabilities.reviewers.request && detail.capabilities.reviewers.listCandidates ? (
            <PullRequestReviewerPicker
              searchable={detail.capabilities.reviewers.searchCandidates === true}
              environmentId={environmentId}
              reference={reference}
              allowed={detail.viewerPermissions.requestReviewers}
            />
          ) : null}
        </span>
      </PullRequestMetaRow>
      {detail.labels.length > 0 || detail.capabilities.labels === true ? (
        <PullRequestMetaRow icon={<TagIcon className="size-3.5" />} label={gt("Labels")}>
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {detail.labels.length === 0 ? (
              <span className="text-muted-foreground">
                <T context="no labels">None</T>
              </span>
            ) : (
              detail.labels.map((label) => (
                <PullRequestLabelChip
                  key={label.name}
                  label={label}
                  size="pill"
                  className="max-w-48"
                  focusable
                />
              ))
            )}
            {detail.capabilities.labels === true ? (
              <PullRequestLabelPicker
                environmentId={environmentId}
                reference={reference}
                allowed={detail.viewerPermissions.labels !== false}
              />
            ) : null}
          </span>
        </PullRequestMetaRow>
      ) : null}
    </>
  );
}

/** The Description tab: the pull request's body, editable in place when the host allows it. */
export function PullRequestDescriptionTab({
  revealUrl,
  onRevealSettled,
  scrollerRef,
  environmentId,
  threadRef,
  reference,
  detail,
  onRefresh,
}: {
  /** A clicked link to scroll to, until onRevealSettled reports it shown. */
  revealUrl?: string | undefined;
  onRevealSettled?: ((revealUrl: string) => void) | undefined;
  scrollerRef: (node: HTMLDivElement | null) => void;
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef | null;
  reference: PullRequestRef;
  detail: PullRequestDetailView;
  onRefresh: () => void;
}) {
  const gt = useGT();
  const terminology = sourceControlClients.get(detail.provider).changeRequest;
  const update = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const canUpdate = useAtomValue(pullRequestEnvironment.update.permissionAtom(environmentId));
  const canEditDescription = canUpdate && canEditPullRequestChangeRequest(detail);
  // The editor keeps the body it opened from, so a failed save cannot reset what was typed.
  const [bodyScope, setBodyScope] = useState<{
    readonly url: string;
    readonly body: string;
  } | null>(null);
  const [descriptionDraft, setDescriptionDraft] = useState<DescriptionDraft | null>(null);
  const descriptionDraftKept = descriptionDraftInForce(
    descriptionDraft,
    detail.url,
    detail.observedAt,
  );
  if (descriptionDraftKept !== descriptionDraft) setDescriptionDraft(descriptionDraftKept);
  const description = descriptionDraftKept?.body ?? detail.body;
  const descriptionSaving = (descriptionDraftKept?.saves ?? 0) > 0;
  const descriptionSavesRunning = useRef(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const location = parsePullRequestAnchor(revealUrl);
  const stopHolding = useRef<(() => void) | null>(null);
  const revealSummary = useEffectEvent(() => {
    const root = scrollRef.current;
    // Another tab owns links to anything else; it settles them once it shows them.
    if (revealUrl === undefined || !root || location?.kind !== "summary") return;
    if (location.anchor === "top") {
      stopHolding.current?.();
      root.scrollTop = 0;
      return onRevealSettled?.(revealUrl);
    }
    const target = /^issue-\d+$/.test(location.anchor)
      ? root.querySelector<HTMLElement>("[data-pr-description]")
      : [...root.querySelectorAll<HTMLElement>("[id]")].find(
          (node) => node.id === location.anchor || node.id === `user-content-${location.anchor}`,
        );
    // A heading may still be rendering; the link stays pending until it appears.
    if (!target) return;
    stopHolding.current?.();
    stopHolding.current = holdLinkedNodeInView(target, root, () => 8);
    onRevealSettled?.(revealUrl);
  });
  const editingDescription = bodyScope?.url === detail.url;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls to a linked description heading once it renders
  useEffect(() => {
    revealSummary();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- retries once the description markdown renders, including after its editor closes
  }, [revealUrl, description, editingDescription]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the hold observes DOM outside React and must end with the tab
  useEffect(() => () => stopHolding.current?.(), []);
  // Checkbox ticks and the editor share one draft, so each starts from the other's latest body.
  const saveDescription = async (body: string) => {
    const key = detail.url;
    setDescriptionDraft((draft) => startDescriptionSave(draft, detail, body));
    descriptionSavesRunning.current += 1;
    const result = await update({ environmentId, input: { ...reference, body } });
    descriptionSavesRunning.current -= 1;
    const saved = result._tag === "Success";
    setDescriptionDraft((draft) => settleDescriptionSave(draft, key, saved));
    if (!saved) {
      toastManager.add({ type: "error", title: m(msg("Could not save the description")) });
    }
    if (descriptionSavesRunning.current === 0) onRefresh();
    return saved;
  };
  const saveBody = async (body: string) => {
    if (descriptionSaving) return;
    if (await saveDescription(body)) setBodyScope(null);
  };
  const toggleTask = ({ markerOffset, checked }: { markerOffset: number; checked: boolean }) => {
    const body = setMarkdownTaskChecked(description, markerOffset, checked);
    if (body !== description) void saveDescription(body);
  };

  return (
    <div
      ref={(node) => {
        scrollRef.current = node;
        scrollerRef(node);
      }}
      className="h-full overflow-y-auto"
      data-pull-request-summary-scroll
    >
      <section aria-label={gt("Description")} className="group px-4.5 py-4">
        {editingDescription ? (
          <PullRequestMarkdownEditor
            allowEmpty
            value={bodyScope.body}
            cwd={detail.workspaceRoot}
            environmentId={environmentId}
            completionScope={pullRequestCompletionScope(detail, environmentId, reference)}
            threadRef={threadRef}
            label={gt(
              "{term, select, mr {Merge request} cr {Change request} other {Pull request}} description",
              { term: changeRequestTermKind(terminology) },
            )}
            placeholder={gt(
              "Describe this {term, select, mr {merge request} cr {change request} other {pull request}}",
              { term: changeRequestTermKind(terminology) },
            )}
            saving={descriptionSaving}
            onSave={(body) => void saveBody(body)}
            onCancel={() => setBodyScope(null)}
          />
        ) : (
          <div className="flex items-start gap-1" data-pr-description>
            <PullRequestMarkdown
              className="min-w-0 flex-1"
              text={description.trim().length > 0 ? description : gt("_No description provided._")}
              cwd={detail.workspaceRoot}
              environmentId={environmentId}
              threadRef={threadRef}
              onTaskListChange={canEditDescription ? toggleTask : undefined}
            />
            {canEditDescription ? (
              <PullRequestEditButton
                aria-label={gt("Edit description")}
                onClick={() => setBodyScope({ url: detail.url, body: description })}
              />
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

/** The Checks tab: one row per check, failing ones with a Fix action. */
export function PullRequestChecksTab({
  revealUrl,
  onRevealSettled,
  scrollerRef,
  threadRef,
  detail,
  checksStale = false,
  pendingFinding,
  fixCheckLabel: requestedFixCheckLabel,
  onFixFinding,
  onRefreshChecks,
}: {
  revealUrl?: string | undefined;
  onRevealSettled?: ((revealUrl: string) => void) | undefined;
  scrollerRef: (node: HTMLDivElement | null) => void;
  threadRef: ScopedThreadRef | null;
  detail: PullRequestDetailView;
  checksStale?: boolean;
  pendingFinding?: string | null;
  fixCheckLabel?: string;
  onFixFinding?: (finding: PullRequestFinding) => void;
  onRefreshChecks: () => void;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const fixCheckLabel =
    requestedFixCheckLabel ?? gt("Fix", { $context: "verb, fix a review finding" });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const revealChecks = useEffectEvent(() => {
    if (revealUrl === undefined || !scrollRef.current) return;
    if (parsePullRequestAnchor(revealUrl)?.kind !== "checks") return;
    scrollRef.current.scrollTop = 0;
    onRevealSettled?.(revealUrl);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a clicked checks link settles once the tab shows it
  useEffect(() => {
    revealChecks();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- runs for each clicked link
  }, [revealUrl]);
  const openLink = useOpenLink(threadRef);
  const openCheck = (url: string) => {
    void openLink(url).catch((error: unknown) => {
      console.error(error);
      toastManager.add({ type: "error", title: m(msg("Unable to open check details")) });
    });
  };

  return (
    <div
      ref={(node) => {
        scrollRef.current = node;
        scrollerRef(node);
      }}
      className="h-full overflow-y-auto"
    >
      <section
        aria-label={gt("Checks", { $context: "CI checks section" })}
        className="p-1.75"
        data-pull-request-summary-section="checks"
      >
        {checksStale ? (
          <div className="flex items-center gap-2 px-2.75 py-2 text-xs text-muted-foreground">
            <span>
              <T>Check details are out of date.</T>
            </span>
            <Button size="xs" variant="ghost" onClick={onRefreshChecks}>
              <T context="verb, button">Refresh</T>
            </Button>
          </div>
        ) : detail.checks.length === 0 ? (
          <p className="px-2.75 py-2 text-xs text-muted-foreground">
            <T>No checks reported.</T>
          </p>
        ) : (
          detail.checks.map(
            (
              check,
              index,
            ) => /* oxlint-disable react/no-array-index-key -- Check names and URLs can repeat; these status rows have no local state. */ {
                const finding = { kind: "check", check } as const;
                const failing = check.status === "failure" || check.status === "cancelled";
                return (
                  <div
                    key={`${index}:${check.name}:${check.url ?? ""}`}
                    className="group flex items-center gap-2 rounded-lg hover:bg-accent/60"
                  >
                    <button
                      type="button"
                      disabled={!check.url}
                      onClick={() => check.url && openCheck(check.url)}
                      className={cn(
                        "flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2.75 py-2 text-left text-xs leading-5 [&>svg]:mt-0.75",
                        check.url ? "cursor-pointer" : "cursor-default",
                      )}
                    >
                      <PullRequestCheckStatusIcon status={check.status} />
                      <span className="min-w-0 flex-1 wrap-anywhere">{check.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {pullRequestCheckStatusLabel(check, resolve)}
                      </span>
                    </button>
                    {onFixFinding && failing ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="me-1.5 shrink-0"
                        disabled={pendingFinding !== null && pendingFinding !== undefined}
                        onClick={() => onFixFinding(finding)}
                      >
                        <HammerIcon className="size-3" />
                        {pendingFinding === pullRequestFindingKey(finding)
                          ? gt("Preparing...")
                          : fixCheckLabel}
                      </Button>
                    ) : null}
                  </div>
                );
              } /* oxlint-enable react/no-array-index-key */,
          )
        )}
      </section>
    </div>
  );
}
