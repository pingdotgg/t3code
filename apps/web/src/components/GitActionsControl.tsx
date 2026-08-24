import { useAtomValue } from "@effect/atom-react";
import { type ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  GitStackedAction,
  SourceControlCloneProtocol,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryVisibility,
  VcsStatusResult,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  ExternalLinkIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
  InfoIcon,
  LockIcon,
  GlobeIcon,
} from "lucide-react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { AzureDevOpsIcon, BitbucketIcon, GitHubIcon, GitLabIcon } from "~/components/Icons";
import { RadioGroup } from "~/components/ui/radio-group";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import {
  buildGitActionProgressStages,
  buildMenuItems,
  type GitActionIconName,
  type GitActionMenuItem,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveLiveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
  resolveQuickAction,
  resolveThreadBranchUpdate,
} from "./GitActionsControl.logic";
import { AnimatedHeight } from "./AnimatedHeight";
import { StartTruncatedPath } from "./StartTruncatedPath";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  localizedPreferredEditorErrorMessage,
  useOpenInPreferredEditor,
} from "~/editorPreferences";
import {
  useGitStackedAction,
  useSourceControlActionRunning,
  useSourceControlPublishRepositoryAction,
  useVcsInitAction,
  useVcsPullAction,
} from "~/lib/sourceControlActions";
import { useThread } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { sourceControlEnvironment } from "~/state/sourceControl";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { readLocalApi } from "~/localApi";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { openPullRequestLink } from "~/lib/openPullRequestLink";
import { localizedSourceControlDiscoveryText, useI18n, type Translate } from "~/i18n";

interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
  /**
   * Opens the thread's own change request beside it. Absent when the thread has no project to
   * place it against, in which case it still opens in the browser.
   */
  onOpenPullRequest?: ((number: number) => void) | undefined;
}

interface PendingDefaultBranchAction {
  action: DefaultBranchConfirmableAction;
  branchName: string;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

type PublishProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "gitlab" | "bitbucket" | "azure-devops"
>;

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  toastData: ThreadToastData | undefined;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
}

const GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS = 250;

type RefreshVcsStatus = (target: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly input: { readonly cwd: string };
}) => Promise<unknown>;

function requestVcsStatusRefresh(
  refresh: RefreshVcsStatus,
  environmentId: ScopedThreadRef["environmentId"] | null,
  cwd: string | null,
): void {
  if (environmentId === null || cwd === null) {
    return;
  }
  void refresh({ environmentId, input: { cwd } });
}
const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull", "publishRepository"] as const;

const PUBLISH_PROVIDER_OPTIONS = [
  {
    value: "github",
    label: "GitHub",
    description: "github.com",
    host: "github.com",
    pathPlaceholder: "owner/repo",
    Icon: GitHubIcon,
  },
  {
    value: "gitlab",
    label: "GitLab",
    description: "gitlab.com",
    host: "gitlab.com",
    pathPlaceholder: "group/project",
    Icon: GitLabIcon,
  },
  {
    value: "bitbucket",
    label: "Bitbucket",
    description: "bitbucket.org",
    host: "bitbucket.org",
    pathPlaceholder: "workspace/repository",
    Icon: BitbucketIcon,
  },
  {
    value: "azure-devops",
    label: "Azure DevOps",
    description: "dev.azure.com",
    host: "dev.azure.com",
    pathPlaceholder: "project/repository",
    Icon: AzureDevOpsIcon,
  },
] as const satisfies ReadonlyArray<{
  readonly value: PublishProviderKind;
  readonly label: string;
  readonly description: string;
  readonly host: string;
  readonly pathPlaceholder: string;
  readonly Icon: typeof GitHubIcon;
}>;

function publishProviderOption(provider: PublishProviderKind) {
  return (
    PUBLISH_PROVIDER_OPTIONS.find((option) => option.value === provider) ??
    PUBLISH_PROVIDER_OPTIONS[0]
  );
}

function isPublishProviderKind(
  provider: SourceControlProviderKind,
): provider is PublishProviderKind {
  return PUBLISH_PROVIDER_OPTIONS.some((option) => option.value === provider);
}

function getPublishProviderReadiness(input: {
  provider: PublishProviderKind;
  sourceControlProviders: ReadonlyArray<SourceControlProviderDiscoveryItem>;
  t: Translate;
}): { readonly ready: boolean; readonly hint: string | null } {
  const discovered = input.sourceControlProviders.find(
    (provider) => provider.kind === input.provider,
  );
  if (!discovered) {
    return {
      ready: false,
      hint: input.t("git.publish.providerUnavailable"),
    };
  }
  if (discovered.status !== "available") {
    return {
      ready: false,
      hint: localizedSourceControlDiscoveryText(discovered.installHint, input.t),
    };
  }
  if (discovered.auth.status === "unauthenticated") {
    const authDetail = Option.getOrNull(discovered.auth.detail);
    return {
      ready: false,
      hint:
        authDetail === null
          ? input.t("git.publish.providerUnauthenticated", { provider: discovered.label })
          : localizedSourceControlDiscoveryText(authDetail, input.t),
    };
  }
  return { ready: true, hint: null };
}

function formatElapsedDescription(startedAtMs: number | null, t: Translate): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return t("git.progress.runningSeconds", { seconds: elapsedSeconds });
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return t("git.progress.runningMinutes", { minutes, seconds });
}

function resolveProgressDescription(
  progress: ActiveGitActionProgress,
  t: Translate,
): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs, t);
}

function getMenuActionDisabledReason({
  item,
  gitStatus,
  isBusy,
  hasPrimaryRemote,
  t,
}: {
  item: GitActionMenuItem;
  gitStatus: VcsStatusResult | null;
  isBusy: boolean;
  hasPrimaryRemote: boolean;
  t: Translate;
}): string | null {
  if (!item.disabled) return null;
  if (isBusy) return t("git.hint.inProgress");
  if (!gitStatus) return t("git.hint.statusUnavailable");

  const hasBranch = gitStatus.refName !== null;
  const hasChanges = gitStatus.hasWorkingTreeChanges;
  const hasOpenPr = gitStatus.pr?.state === "open";
  const isAhead = gitStatus.aheadCount > 0;
  const isBehind = gitStatus.behindCount > 0;
  const terminology = getSourceControlPresentation(gitStatus.sourceControlProvider).terminology;

  if (item.id === "commit") {
    if (!hasChanges) {
      return t("git.hint.cleanWorktree");
    }
    return t("git.hint.commitUnavailable");
  }

  if (item.id === "push") {
    if (!hasBranch) {
      return t("git.hint.detachedPush");
    }
    if (hasChanges) {
      return t("git.hint.commitBeforePush");
    }
    if (isBehind) {
      return t("git.hint.behindBeforePush");
    }
    if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
      return t("git.hint.addOriginBeforePush");
    }
    if (!isAhead) {
      return t("git.hint.noCommitsToPush");
    }
    return t("git.hint.pushUnavailable");
  }

  if (hasOpenPr) {
    return t("git.hint.viewRequestUnavailable", { request: terminology.singular });
  }
  if (!hasBranch) {
    return t("git.hint.detachedCreateRequest", { request: terminology.singular });
  }
  if (hasChanges) {
    return t("git.hint.commitBeforeRequest", { request: terminology.singular });
  }
  if (!gitStatus.hasUpstream && !hasPrimaryRemote) {
    return t("git.hint.addOriginBeforeRequest", { request: terminology.singular });
  }
  if (!isAhead) {
    return t("git.hint.noCommitsForRequest", { request: terminology.singular });
  }
  if (isBehind) {
    return t("git.hint.behindBeforeRequest", { request: terminology.singular });
  }
  return t("git.hint.createRequestUnavailable", { request: terminology.singular });
}

function GitActionItemIcon({
  icon,
  SourceControlIcon,
}: {
  icon: GitActionIconName;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  if (icon === "commit") return <GitCommitIcon />;
  if (icon === "push") return <CloudUploadIcon />;
  return <SourceControlIcon />;
}

function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
}: {
  quickAction: GitQuickAction;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  const iconClassName = "size-3.5";
  if (quickAction.kind === "open_pr") return <SourceControlIcon className={iconClassName} />;
  if (quickAction.kind === "open_publish") return <CloudUploadIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <CloudDownloadIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={iconClassName} />;
    }
    return <SourceControlIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  if (quickAction.label === "Push") return <CloudUploadIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

function localizedMenuItemLabel(item: GitActionMenuItem, t: Translate): string {
  if (item.id === "commit") return t("git.commit");
  if (item.id === "push") return t("git.push");
  return t(item.kind === "open_pr" ? "git.viewChangeRequest" : "git.createChangeRequest");
}

function localizedQuickActionLabel(quickAction: GitQuickAction, t: Translate): string {
  if (quickAction.kind === "open_pr") return t("git.viewChangeRequest");
  if (quickAction.kind === "open_publish") return t("git.publishRepository");
  if (quickAction.kind === "run_pull") return t("git.pull");
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return t("git.commit");
    if (quickAction.action === "push") return t("git.push");
    if (quickAction.action === "commit_push") return t("git.commitPush");
    if (quickAction.action === "commit_push_pr") return t("git.commitPushCreateRequest");
    return t(
      quickAction.label.startsWith("Push &")
        ? "git.pushCreateChangeRequest"
        : "git.createChangeRequest",
    );
  }
  if (quickAction.label === "Push") return t("git.push");
  if (quickAction.label === "Sync ref") return t("git.syncRef");
  return t("git.commit");
}

function localizedQuickActionHint(quickAction: GitQuickAction, t: Translate): string | undefined {
  const detachedRefHint = quickAction.hint?.match(
    /^Create and checkout a ref before pushing or opening a (.+)\.$/,
  );
  if (detachedRefHint?.[1]) {
    return t("git.hint.createRefFirst", { request: detachedRefHint[1] });
  }

  switch (quickAction.hint) {
    case "Git action in progress.":
      return t("git.hint.inProgress");
    case "Git status is unavailable.":
      return t("git.hint.statusUnavailable");
    case "No local commits to push.":
      return t("git.hint.noCommitsToPush");
    case "Branch has diverged from upstream. Rebase/merge first.":
      return t("git.hint.diverged");
    case "Branch is up to date. No action needed.":
      return t("git.hint.upToDate");
    default:
      return quickAction.hint;
  }
}

function localizedDefaultBranchActionCopy(input: PendingDefaultBranchAction, t: Translate) {
  const { action, branchName, includesCommit } = input;
  if (action === "push" || action === "commit_push") {
    return includesCommit
      ? {
          title: t("git.defaultBranch.commitPushTitle"),
          description: t("git.defaultBranch.commitPushDescription", { branch: branchName }),
          continueLabel: t("git.defaultBranch.commitPushContinue", { branch: branchName }),
        }
      : {
          title: t("git.defaultBranch.pushTitle"),
          description: t("git.defaultBranch.pushDescription", { branch: branchName }),
          continueLabel: t("git.defaultBranch.pushContinue", { branch: branchName }),
        };
  }
  return includesCommit
    ? {
        title: t("git.defaultBranch.commitRequestTitle"),
        description: t("git.defaultBranch.commitRequestDescription", { branch: branchName }),
        continueLabel: t("git.commitPushCreateRequest"),
      }
    : {
        title: t("git.defaultBranch.requestTitle"),
        description: t("git.defaultBranch.requestDescription", { branch: branchName }),
        continueLabel: t("git.pushCreateChangeRequest"),
      };
}

function localizedGitProgressLabel(label: string, t: Translate): string {
  if (label === "Preparing feature ref...") return t("git.progress.preparingFeatureRef");
  if (label === "Pushing...") return t("git.progress.pushing");
  if (label === "Committing...") return t("git.progress.committing");
  if (label === "Generating commit message...") return t("git.progress.generatingCommitMessage");
  const pushingTarget = /^Pushing to (.+)\.\.\.$/u.exec(label)?.[1];
  if (pushingTarget) return t("git.progress.pushingTo", { target: pushingTarget });
  const generatingRequest = /^Generating (.+) content\.\.\.$/u.exec(label)?.[1];
  if (generatingRequest) {
    return t("git.progress.generatingRequest", { request: generatingRequest });
  }
  const preparingRequest = /^Preparing (.+)\.\.\.$/u.exec(label)?.[1];
  if (preparingRequest) return t("git.progress.preparingRequest", { request: preparingRequest });
  const creatingRequest = /^Creating (.+)\.\.\.$/u.exec(label)?.[1];
  if (creatingRequest) return t("git.progress.creatingRequest", { request: creatingRequest });
  return label;
}

interface PublishRepositoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: ScopedThreadRef["environmentId"] | null;
  readonly gitCwd: string;
}

function PublishRepositoryDialog(props: PublishRepositoryDialogProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const sourceControlDiscovery = useEnvironmentQuery(
    props.environmentId === null
      ? null
      : sourceControlEnvironment.discovery({
          environmentId: props.environmentId,
          input: {},
        }),
  );
  const [selectedPublishProvider, setSelectedPublishProvider] =
    useState<PublishProviderKind | null>(null);
  const [publishRepositoryOverride, setPublishRepositoryOverride] = useState<string | null>(null);
  const [publishVisibility, setPublishVisibility] =
    useState<SourceControlRepositoryVisibility>("private");
  const [publishRemoteName, setPublishRemoteName] = useState("origin");
  const [publishProtocol, setPublishProtocol] = useState<SourceControlCloneProtocol>("ssh");
  const [publishWizardStep, setPublishWizardStep] = useState(0);
  const [publishAdvancedOpen, setPublishAdvancedOpen] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState<SourceControlPublishRepositoryResult | null>(
    null,
  );
  const sourceControlScope = useMemo(
    () => ({
      environmentId: props.environmentId,
      cwd: props.gitCwd,
    }),
    [props.environmentId, props.gitCwd],
  );
  const publishRepositoryAction = useSourceControlPublishRepositoryAction(sourceControlScope);
  const publishAccountByProvider = useMemo(() => {
    const accounts: Record<PublishProviderKind, string | null> = {
      github: null,
      gitlab: null,
      bitbucket: null,
      "azure-devops": null,
    };
    for (const provider of sourceControlDiscovery.data?.sourceControlProviders ?? []) {
      if (isPublishProviderKind(provider.kind)) {
        accounts[provider.kind] = Option.getOrNull(provider.auth.account);
      }
    }
    return accounts;
  }, [sourceControlDiscovery.data]);
  const publishProviderReadiness = useMemo(() => {
    const sourceControlProviders = sourceControlDiscovery.data?.sourceControlProviders ?? [];
    return Object.fromEntries(
      PUBLISH_PROVIDER_OPTIONS.map((option) => [
        option.value,
        getPublishProviderReadiness({
          provider: option.value,
          sourceControlProviders,
          t,
        }),
      ]),
    ) as Record<PublishProviderKind, { readonly ready: boolean; readonly hint: string | null }>;
  }, [sourceControlDiscovery.data, t]);
  const hasReadyPublishProvider = useMemo(
    () => PUBLISH_PROVIDER_OPTIONS.some((option) => publishProviderReadiness[option.value].ready),
    [publishProviderReadiness],
  );
  const sortedPublishProviderOptions = useMemo(
    () =>
      PUBLISH_PROVIDER_OPTIONS.toSorted((left, right) => {
        const leftReady = publishProviderReadiness[left.value].ready;
        const rightReady = publishProviderReadiness[right.value].ready;
        if (leftReady !== rightReady) {
          return leftReady ? -1 : 1;
        }
        return left.label.localeCompare(right.label);
      }),
    [publishProviderReadiness],
  );
  const firstReadyPublishProvider = sortedPublishProviderOptions.find(
    (option) => publishProviderReadiness[option.value].ready,
  )?.value;
  const publishProvider =
    selectedPublishProvider !== null && publishProviderReadiness[selectedPublishProvider].ready
      ? selectedPublishProvider
      : (firstReadyPublishProvider ?? selectedPublishProvider ?? "github");
  const selectedPublishProviderReadiness = publishProviderReadiness[publishProvider];
  const publishRepositoryPrefill = publishAccountByProvider[publishProvider]
    ? `${publishAccountByProvider[publishProvider]}/`
    : "";
  const publishRepository = publishRepositoryOverride ?? publishRepositoryPrefill;
  const currentPublishProvider = publishProviderOption(publishProvider);
  const publishHost = currentPublishProvider.host;
  const publishPathPlaceholder = currentPublishProvider.pathPlaceholder;
  const publishProviderLabel = currentPublishProvider.label;
  const publishWizardSteps = [
    t("git.publish.provider"),
    t("git.publish.repository"),
    t("git.publish.summary"),
  ] as const;
  const publishWizardStepSummaries = [
    publishProviderLabel,
    publishResult?.repository.nameWithOwner ?? null,
    null,
  ] as const;

  const canSubmitPublishRepository = useMemo(() => {
    if (!selectedPublishProviderReadiness.ready) return false;
    if (publishRepositoryAction.isPending) return false;
    const repositoryParts = publishRepository.trim().split("/");
    const owner = repositoryParts[0]?.trim() ?? "";
    const rest = repositoryParts.slice(1);
    const name = rest.join("/").trim();
    return owner.length > 0 && name.length > 0;
  }, [publishRepository, publishRepositoryAction.isPending, selectedPublishProviderReadiness]);

  const submitPublishRepository = useCallback(() => {
    if (!canSubmitPublishRepository) {
      return;
    }

    setPublishError(null);

    void (async () => {
      const result = await publishRepositoryAction.run({
        provider: publishProvider,
        repository: publishRepository.trim(),
        visibility: publishVisibility,
        remoteName: publishRemoteName.trim() || "origin",
        protocol: publishProtocol,
      });

      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          setPublishError(error instanceof Error ? error.message : t("common.errorGeneric"));
        }
        return;
      }

      flushSync(() => {
        setPublishResult(result.value);
        setPublishWizardStep(2);
      });
    })();
  }, [
    canSubmitPublishRepository,
    props.environmentId,
    props.gitCwd,
    publishProtocol,
    publishProvider,
    publishRemoteName,
    publishRepository,
    publishRepositoryAction,
    publishVisibility,
  ]);

  const resetState = useCallback(() => {
    setPublishRemoteName("origin");
    setPublishRepositoryOverride(null);
    setPublishWizardStep(0);
    setPublishAdvancedOpen(false);
    setPublishError(null);
    setPublishResult(null);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      props.onOpenChange(open);
      if (!open) {
        resetState();
      }
    },
    [props, resetState],
  );

  const openSourceControlSettings = useCallback(() => {
    handleOpenChange(false);
    void navigate({ to: "/settings/source-control" });
  }, [handleOpenChange, navigate]);

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <div className="flex min-h-0 flex-col overflow-hidden border-foreground/10 bg-transparent">
          <DialogHeader className="border-b border-border/70 bg-foreground/[0.025] dark:border-transparent dark:bg-transparent">
            <DialogTitle>{t("git.publishRepository")}</DialogTitle>
            <DialogDescription>{t("git.publish.description")}</DialogDescription>
            <div className="grid grid-cols-3 gap-2">
              {publishWizardSteps.map((label, index) => {
                const isComplete = index < publishWizardStep;
                const isClickable =
                  publishWizardStep !== 2 &&
                  index < publishWizardSteps.length - 1 &&
                  index <= publishWizardStep;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={isClickable ? () => setPublishWizardStep(index) : undefined}
                    disabled={!isClickable}
                    className={cn(
                      "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 rounded-lg border px-3 py-2 text-left",
                      index === publishWizardStep
                        ? "border-primary bg-primary/10 ring-1 ring-primary/25 dark:border-transparent"
                        : isComplete
                          ? "border-border bg-background dark:border-transparent dark:bg-white/[0.05]"
                          : "border-border bg-muted/40 dark:border-transparent dark:bg-white/[0.025]",
                      !isClickable && "cursor-default",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "row-span-2 mt-0.5 grid size-4 place-items-center rounded-full border",
                        isComplete
                          ? "border-primary bg-primary text-primary-foreground"
                          : index === publishWizardStep
                            ? "border-primary bg-background"
                            : "border-muted-foreground/35 bg-background",
                      )}
                    >
                      {isComplete ? <CheckIcon className="size-3" /> : null}
                    </span>
                    <span className="text-[10px] font-medium uppercase text-muted-foreground">
                      {t("git.publish.step", { number: index + 1 })}
                    </span>
                    <span className="truncate text-xs font-semibold text-foreground">
                      {label}
                      {isComplete && publishWizardStepSummaries[index]
                        ? `: ${publishWizardStepSummaries[index]}`
                        : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          </DialogHeader>

          <DialogPanel className="space-y-5 border-b border-border/70 bg-muted/20 px-6 py-5 dark:border-transparent dark:bg-transparent">
            <AnimatedHeight>
              <div className={cn("space-y-2", publishWizardStep !== 0 && "hidden")}>
                <span
                  id="publish-provider-cards-label"
                  className="text-xs font-medium text-foreground"
                >
                  {t("git.publish.provider")}
                </span>
                <RadioGroup
                  value={publishProvider}
                  onValueChange={(value) => {
                    setSelectedPublishProvider(value as PublishProviderKind);
                    setPublishRepositoryOverride(null);
                  }}
                  aria-labelledby="publish-provider-cards-label"
                  className="grid grid-cols-2 gap-2.5"
                >
                  {sortedPublishProviderOptions.map((option) => {
                    const readiness = publishProviderReadiness[option.value];
                    const isSelected = publishProvider === option.value && readiness.ready;
                    if (!readiness.ready) {
                      return (
                        <div
                          key={option.value}
                          className="relative flex cursor-not-allowed items-center gap-3 rounded-lg border border-border bg-background px-3 py-3 text-left opacity-55 dark:border-transparent dark:bg-white/[0.035]"
                        >
                          <option.Icon
                            className="size-5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                            {option.label}
                          </span>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="outline"
                                  size="xs"
                                  className="h-5 rounded-[.25rem] px-1.5 text-[10px] text-warning-foreground"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    openSourceControlSettings();
                                  }}
                                >
                                  {t("git.publish.setupRequired")}
                                </Button>
                              }
                            />
                            <TooltipPopup side="top" align="end" className="max-w-72">
                              {readiness.hint ?? t("git.publish.configureProvider")}
                            </TooltipPopup>
                          </Tooltip>
                        </div>
                      );
                    }

                    return (
                      <RadioPrimitive.Root
                        key={option.value}
                        value={option.value}
                        className={cn(
                          "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-left outline-none transition-[background-color,border-color,box-shadow]",
                          "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                          isSelected
                            ? "border-primary bg-background shadow-sm ring-2 ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
                            : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
                        )}
                      >
                        <option.Icon className="size-5 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                      </RadioPrimitive.Root>
                    );
                  })}
                </RadioGroup>
              </div>

              <div className={cn("space-y-5", publishWizardStep !== 1 && "hidden")}>
                <div className="space-y-2">
                  <label
                    htmlFor="publish-repository-path"
                    className="text-xs font-medium text-foreground"
                  >
                    {t("git.publish.repository")}
                  </label>
                  <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring">
                    <span className="flex shrink-0 items-center gap-1.5 border-r border-input bg-muted/50 px-2.5 font-mono text-xs text-muted-foreground">
                      <currentPublishProvider.Icon className="size-3.5" />
                      {publishHost}/
                    </span>
                    <input
                      id="publish-repository-path"
                      name="publish-repository-path"
                      value={publishRepository}
                      onChange={(event) => {
                        setPublishRepositoryOverride(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          submitPublishRepository();
                        }
                      }}
                      placeholder={publishPathPlaceholder}
                      disabled={publishRepositoryAction.isPending}
                      className="w-full bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/60 focus:outline-none"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <span
                    id="publish-visibility-cards-label"
                    className="text-xs font-medium text-foreground"
                  >
                    {t("git.publish.visibility")}
                  </span>
                  <RadioGroup
                    value={publishVisibility}
                    onValueChange={(value) =>
                      setPublishVisibility(value as SourceControlRepositoryVisibility)
                    }
                    aria-labelledby="publish-visibility-cards-label"
                    disabled={publishRepositoryAction.isPending}
                    className="grid grid-cols-2 gap-2.5"
                  >
                    {[
                      {
                        value: "private" as const,
                        label: t("git.publish.private"),
                        description: t("git.publish.privateDescription"),
                        Icon: LockIcon,
                      },
                      {
                        value: "public" as const,
                        label: t("git.publish.public"),
                        description: t("git.publish.publicDescription"),
                        Icon: GlobeIcon,
                      },
                    ].map((option) => {
                      const isSelected = publishVisibility === option.value;
                      return (
                        <RadioPrimitive.Root
                          key={option.value}
                          value={option.value}
                          className={cn(
                            "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
                            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                            isSelected
                              ? "border-primary bg-background shadow-sm ring-2 ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
                              : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
                          )}
                        >
                          <option.Icon
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-foreground">
                              {option.label}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {option.description}
                            </span>
                          </span>
                        </RadioPrimitive.Root>
                      );
                    })}
                  </RadioGroup>
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => setPublishAdvancedOpen((prev) => !prev)}
                    aria-expanded={publishAdvancedOpen}
                    className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDownIcon
                      className={cn(
                        "size-3.5 transition-transform",
                        publishAdvancedOpen ? "" : "-rotate-90",
                      )}
                    />
                    {t("git.publish.advanced")}
                  </button>
                  {publishAdvancedOpen ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <label className="space-y-1.5" htmlFor="publish-remote-name">
                        <span className="text-xs font-medium text-foreground">
                          {t("git.remote")}
                        </span>
                        <Input
                          id="publish-remote-name"
                          value={publishRemoteName}
                          onChange={(event) => setPublishRemoteName(event.target.value)}
                          placeholder="origin"
                          disabled={publishRepositoryAction.isPending}
                        />
                      </label>
                      <div className="space-y-1.5">
                        <span
                          id="publish-protocol-label"
                          className="text-xs font-medium text-foreground"
                        >
                          {t("git.publish.protocol")}
                        </span>
                        <RadioGroup
                          value={publishProtocol}
                          onValueChange={(value) =>
                            setPublishProtocol(value as SourceControlCloneProtocol)
                          }
                          aria-labelledby="publish-protocol-label"
                          disabled={publishRepositoryAction.isPending}
                          className="grid grid-cols-2 gap-2"
                        >
                          {(["ssh", "https"] as const).map((value) => {
                            const isSelected = publishProtocol === value;
                            return (
                              <RadioPrimitive.Root
                                key={value}
                                value={value}
                                className={cn(
                                  "rounded-md border px-3 py-1.5 text-center text-sm font-medium outline-none transition",
                                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                                  isSelected
                                    ? "border-primary bg-background ring-2 ring-primary/35 text-foreground dark:border-transparent dark:bg-primary/10 dark:ring-1 dark:ring-primary/30"
                                    : "border-border bg-background text-muted-foreground hover:border-foreground/20 hover:text-foreground dark:border-transparent dark:bg-white/[0.035]",
                                )}
                              >
                                {value === "ssh" ? "SSH" : "HTTPS"}
                              </RadioPrimitive.Root>
                            );
                          })}
                        </RadioGroup>
                      </div>
                    </div>
                  ) : null}
                </div>

                {publishRepositoryAction.isPending ? (
                  <div
                    role="status"
                    aria-live="polite"
                    className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]"
                  >
                    <Spinner className="size-3.5" aria-hidden />
                    {t("git.publish.publishingTo", { provider: publishProviderLabel })}
                  </div>
                ) : null}
                {publishError && !publishRepositoryAction.isPending ? (
                  <div
                    role="alert"
                    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  >
                    <p className="font-medium">{t("git.publish.failed")}</p>
                    <p className="mt-0.5 text-destructive/90">{publishError}</p>
                  </div>
                ) : null}
              </div>

              <div className={cn("space-y-4", publishWizardStep !== 2 && "hidden")}>
                {publishResult ? (
                  <>
                    <div className="flex flex-col items-center gap-2 py-1 text-center">
                      <span className="grid size-8 place-items-center rounded-full bg-success/15 text-success">
                        <CheckIcon className="size-4" aria-hidden />
                      </span>
                      <h3 className="text-sm font-semibold text-foreground">
                        {publishResult.status === "pushed"
                          ? t("git.publish.published")
                          : t("git.publish.created")}
                      </h3>
                      <p className="max-w-xs text-pretty text-xs text-muted-foreground">
                        {publishResult.status === "pushed"
                          ? t("git.publish.branchLive", {
                              branch: publishResult.branch,
                              provider: publishProviderLabel,
                            })
                          : t("git.publish.remoteReady", {
                              remote: publishResult.remoteName,
                            })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/40 px-3 py-2 dark:border-transparent dark:bg-white/[0.035]">
                      <currentPublishProvider.Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {publishResult.repository.nameWithOwner}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => {
                        const api = readLocalApi();
                        if (!api) return;
                        void api.shell.openExternal(publishResult.repository.url);
                      }}
                    >
                      <ExternalLinkIcon className="size-3.5" aria-hidden />
                      {t("git.publish.openOn", { provider: publishProviderLabel })}
                    </Button>
                  </>
                ) : (
                  <div className="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]">
                    {t("git.publish.resultUnavailable")}
                  </div>
                )}
              </div>
            </AnimatedHeight>
          </DialogPanel>

          <DialogFooter className="dark:border-transparent dark:bg-transparent">
            {publishWizardStep === 2 ? (
              <Button size="sm" onClick={() => handleOpenChange(false)}>
                {t("git.done")}
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={publishRepositoryAction.isPending}
                  onClick={() => {
                    if (publishWizardStep === 0) {
                      handleOpenChange(false);
                      return;
                    }
                    setPublishWizardStep((step) => Math.max(0, step - 1));
                  }}
                >
                  {t(publishWizardStep === 0 ? "common.cancel" : "common.back")}
                </Button>
                {publishWizardStep < 1 ? (
                  <Button
                    size="sm"
                    disabled={!hasReadyPublishProvider || !selectedPublishProviderReadiness.ready}
                    onClick={() => setPublishWizardStep((step) => Math.min(1, step + 1))}
                  >
                    {t("common.next")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!canSubmitPublishRepository}
                    onClick={submitPublishRepository}
                  >
                    {publishRepositoryAction.isPending ? (
                      <>
                        <Spinner className="size-3.5" aria-hidden />
                        {t("git.publish.publishing")}
                      </>
                    ) : (
                      t("git.publish.action")
                    )}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export default function GitActionsControl({
  gitCwd,
  activeThreadRef,
  draftId,
  onOpenPullRequest,
}: GitActionsControlProps) {
  const { t } = useI18n();
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread branch metadata update",
  );
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(activeEnvironmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const activeDraftThread = useComposerDraftStore((store) =>
    draftId
      ? store.getDraftSession(draftId)
      : activeThreadRef
        ? store.getDraftThreadByRef(activeThreadRef)
        : null,
  );
  const activeServerThread = useThread(activeThreadRef, {
    waitForShell: activeDraftThread !== null,
  });
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);
  const sourceControlScope = useMemo(
    () => ({ environmentId: activeEnvironmentId, cwd: gitCwd }),
    [activeEnvironmentId, gitCwd],
  );
  let runGitActionWithToast: (input: RunGitActionWithToastInput) => Promise<void>;

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress, t),
      timeout: 0,
      data: progress.toastData,
    });
  }, [t]);

  const persistThreadBranchSync = useCallback(
    (branch: string | null) => {
      if (!activeThreadRef) {
        return;
      }

      if (activeServerThread) {
        if (activeServerThread.branch === branch) {
          return;
        }

        void updateThreadMetadata({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            ...resolveThreadBranchMetadataPatch(branch, activeServerThread.branch),
          },
        });

        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(draftId ?? activeThreadRef, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
      });
    },
    [
      activeDraftThread,
      activeServerThread,
      activeThreadRef,
      draftId,
      setDraftThreadContext,
      updateThreadMetadata,
    ],
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch);
    },
    [persistThreadBranchSync],
  );

  const gitStatusQuery = useEnvironmentQuery(
    activeEnvironmentId !== null && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: activeEnvironmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const refreshVcsStatus = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const { data: gitStatus, error: gitStatusError } = gitStatusQuery;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const changeRequestTerminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const gitStatusForActions = gitStatus;

  const allFiles = gitStatusForActions?.workingTree.files ?? [];
  const selectedFiles = allFiles.filter((f) => !excludedFiles.has(f.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;

  const initAction = useVcsInitAction(sourceControlScope);
  const runImmediateGitAction = useGitStackedAction(sourceControlScope);
  const pullAction = useVcsPullAction(sourceControlScope);
  const isGitActionRunning = useSourceControlActionRunning(
    sourceControlScope,
    RUNNING_SOURCE_CONTROL_ACTIONS,
  );
  const isSelectingWorktreeBase =
    !activeServerThread &&
    activeDraftThread?.envMode === "worktree" &&
    activeDraftThread.worktreePath === null;

  useEffect(() => {
    if (isGitActionRunning || isSelectingWorktreeBase || activeServerThread) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeDraftThread?.branch ?? null,
      gitStatus: gitStatusForActions,
    });
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeServerThread,
    activeDraftThread?.branch,
    gitStatusForActions,
    isGitActionRunning,
    isSelectingWorktreeBase,
    persistThreadBranchSync,
  ]);

  const isDefaultRef = useMemo(() => {
    return gitStatusForActions?.isDefaultRef ?? false;
  }, [gitStatusForActions?.isDefaultRef]);

  const gitActionMenuItems = useMemo(
    () => buildMenuItems(gitStatusForActions, isGitActionRunning, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isGitActionRunning],
  );
  const quickAction = useMemo(
    () =>
      resolveQuickAction(gitStatusForActions, isGitActionRunning, isDefaultRef, hasPrimaryRemote),
    [gitStatusForActions, hasPrimaryRemote, isDefaultRef, isGitActionRunning],
  );
  const quickActionLabel = localizedQuickActionLabel(quickAction, t);
  const quickActionDisabledReason = quickAction.disabled
    ? (localizedQuickActionHint(quickAction, t) ?? t("git.actionUnavailable"))
    : null;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? localizedDefaultBranchActionCopy(pendingDefaultBranchAction, t)
    : null;

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  useEffect(() => {
    if (gitCwd === null) {
      return;
    }

    let refreshTimeout: number | null = null;
    const scheduleRefreshCurrentGitStatus = () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
      }, GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleRefreshCurrentGitStatus();
      }
    };

    window.addEventListener("focus", scheduleRefreshCurrentGitStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      window.removeEventListener("focus", scheduleRefreshCurrentGitStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeEnvironmentId, gitCwd, refreshVcsStatus]);

  const openExistingPr = useCallback(async () => {
    const openPr = gitStatusForActions?.pr?.state === "open" ? gitStatusForActions.pr : null;
    // Beside the thread where it was made, the way the browser opens beside it. Checked before
    // the shell, which opening in the app does not need.
    if (openPr && onOpenPullRequest) {
      onOpenPullRequest(openPr.number);
      return;
    }
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: t("git.linkUnavailable"),
        data: threadToastData,
      });
      return;
    }
    const prUrl = openPr?.url ?? null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: t("git.noOpenChangeRequest"),
        data: threadToastData,
      });
      return;
    }
    void openPullRequestLink(api.shell, prUrl).catch((err: unknown) => {
      console.error(err);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("git.openChangeRequestFailed"),
          description: err instanceof Error ? err.message : t("common.errorGeneric"),
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    });
  }, [gitStatusForActions, onOpenPullRequest, t, threadToastData]);

  runGitActionWithToast = useEffectEvent(
    async ({
      action,
      commitMessage,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      statusOverride,
      featureBranch = false,
      progressToastId,
      filePaths,
    }: RunGitActionWithToastInput) => {
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionBranch = actionStatus?.refName ?? null;
      const actionIsDefaultBranch = featureBranch ? false : isDefaultRef;
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      const includesCommit =
        actionCanCommit &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (
          action !== "push" &&
          action !== "create_pr" &&
          action !== "commit_push" &&
          action !== "commit_push_pr"
        ) {
          return;
        }
        setPendingDefaultBranchAction({
          action,
          branchName: actionBranch,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
        terminology: changeRequestTerminology,
        shouldPushBeforePr:
          action === "create_pr" &&
          (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
      }).map((label) => localizedGitProgressLabel(label, t));
      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      const actionId = randomUUID();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? t("git.progress.runningAction"),
          description: t("git.progress.waiting"),
          timeout: 0,
          data: scopedToastData,
        });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        toastData: scopedToastData,
        actionId,
        title: progressStages[0] ?? t("git.progress.runningAction"),
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? t("git.progress.runningAction"),
      };

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? t("git.progress.runningAction"),
          description: t("git.progress.waiting"),
          timeout: 0,
          data: scopedToastData,
        });
      }

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        const progress = activeGitActionProgressRef.current;
        if (!progress) {
          return;
        }
        if (gitCwd && event.cwd !== gitCwd) {
          return;
        }
        if (progress.actionId !== event.actionId) {
          return;
        }

        const now = Date.now();
        switch (event.kind) {
          case "action_started":
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "phase_started":
            progress.title = localizedGitProgressLabel(event.label, t);
            progress.currentPhaseLabel = localizedGitProgressLabel(event.label, t);
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "hook_started":
            progress.title = t("git.progress.runningHook", { hook: event.hookName });
            progress.hookName = event.hookName;
            progress.hookStartedAtMs = now;
            progress.lastOutputLine = null;
            break;
          case "hook_output":
            progress.lastOutputLine = event.text;
            break;
          case "hook_finished":
            progress.title = progress.currentPhaseLabel ?? t("git.progress.committing");
            progress.hookName = null;
            progress.hookStartedAtMs = null;
            progress.lastOutputLine = null;
            break;
          case "action_finished":
            // Let the resolved mutation update the toast so we keep the
            // elapsed description visible until the final success state renders.
            return;
          case "action_failed":
            // Let the settled mutation publish the error toast to avoid a
            // transient intermediate state before the final failure message.
            return;
        }

        updateActiveProgressToast();
      };

      const result = await runImmediateGitAction.run({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        onProgress: applyProgressEvent,
      });

      activeGitActionProgressRef.current = null;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          toastManager.close(resolvedProgressToastId);
          return;
        }

        const error = squashAtomCommandFailure(result);
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "error",
            title: t("git.actionFailed"),
            description: error instanceof Error ? error.message : t("common.errorGeneric"),
            ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
          }),
        );
        return;
      }

      const actionResult = result.value;
      syncThreadBranchAfterGitAction(actionResult);
      const closeResultToast = () => {
        toastManager.close(resolvedProgressToastId);
      };

      const toastCta = actionResult.toast.cta;
      let toastActionProps: {
        children: string;
        onClick: () => void;
      } | null = null;
      if (toastCta.kind === "run_action") {
        toastActionProps = {
          children: toastCta.label,
          onClick: () => {
            closeResultToast();
            void runGitActionWithToast({
              action: toastCta.action.kind,
            });
          },
        };
      } else if (toastCta.kind === "open_pr") {
        toastActionProps = {
          children: toastCta.label,
          onClick: () => {
            const api = readLocalApi();
            if (!api) return;
            closeResultToast();
            void api.shell.openExternal(toastCta.url);
          },
        };
      }

      const successToastData = {
        ...scopedToastData,
        dismissAfterVisibleMs: 10_000,
      };

      if (toastActionProps) {
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "success",
            title: actionResult.toast.title,
            description: actionResult.toast.description,
            timeout: 0,
            actionProps: toastActionProps,
            data: successToastData,
          }),
        );
      } else {
        toastManager.update(resolvedProgressToastId, {
          type: "success",
          title: actionResult.toast.title,
          description: actionResult.toast.description,
          timeout: 0,
          data: successToastData,
        });
      }
    },
  );

  const continuePendingDefaultBranchAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
    });
  };

  const checkoutFeatureBranchAndContinuePendingAction = () => {
    if (!pendingDefaultBranchAction) return;
    const { action, commitMessage, onConfirmed, filePaths } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runDialogActionOnNewBranch = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);

    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runQuickAction = () => {
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "open_publish") {
      setIsPublishDialogOpen(true);
      return;
    }
    if (quickAction.kind === "run_pull") {
      const toastId = toastManager.add({
        type: "loading",
        title: t("git.pulling"),
        timeout: 0,
        data: threadToastData,
      });
      void (async () => {
        const result = await pullAction.run();
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            toastManager.close(toastId);
            return;
          }
          const error = squashAtomCommandFailure(result);
          toastManager.update(
            toastId,
            stackedThreadToast({
              type: "error",
              title: t("git.pullFailed"),
              description: error instanceof Error ? error.message : t("common.errorGeneric"),
              ...(threadToastData !== undefined ? { data: threadToastData } : {}),
            }),
          );
          return;
        }

        const pullResult = result.value;
        toastManager.update(toastId, {
          type: "success",
          title: t(pullResult.status === "pulled" ? "git.pulled" : "git.upToDate"),
          description:
            pullResult.status === "pulled"
              ? t("git.updatedFrom", {
                  ref: pullResult.refName,
                  upstream: pullResult.upstreamRef ?? t("git.upstream"),
                })
              : t("git.alreadySynchronized", { ref: pullResult.refName }),
          data: threadToastData,
        });
      })();
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickActionLabel,
        description: localizedQuickActionHint(quickAction, t),
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      void runGitActionWithToast({ action: quickAction.action });
    }
  };

  const openDialogForMenuItem = (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (item.dialogAction === "push") {
      void runGitActionWithToast({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      void runGitActionWithToast({ action: "create_pr" });
      return;
    }
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    setIsCommitDialogOpen(true);
  };

  const runDialogAction = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setExcludedFiles(new Set());
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((f) => f.path) } : {}),
    });
  };

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      if (!gitCwd) {
        toastManager.add({
          type: "error",
          title: t("git.editorUnavailable"),
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void (async () => {
        const result = await openInPreferredEditor(target);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("git.openFileFailed"),
            description: localizedPreferredEditorErrorMessage(error, t),
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      })();
    },
    [gitCwd, openInPreferredEditor, t, threadToastData],
  );

  const canPublishRepository = isRepo && gitStatusForActions !== null && !hasPrimaryRemote;

  if (!gitCwd) return null;

  return (
    <>
      {!isRepo ? (
        <Button
          variant="outline"
          size="xs"
          disabled={initAction.isPending}
          onClick={() => {
            void (async () => {
              const result = await initAction.run();
              if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
                return;
              }
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: t("git.initFailed"),
                  description: error instanceof Error ? error.message : t("common.errorGeneric"),
                  ...(threadToastData !== undefined ? { data: threadToastData } : {}),
                }),
              );
            })();
          }}
        >
          <GitBranchPlusIcon className="size-3.5" aria-hidden />
          <span className="ml-0.5">
            {t(initAction.isPending ? "git.initializing" : "git.initialize")}
          </span>
        </Button>
      ) : (
        <Group aria-label={t("git.actions")} className="shrink-0">
          {quickActionDisabledReason ? (
            <Popover>
              <PopoverTrigger
                openOnHover
                render={
                  <Button
                    aria-disabled="true"
                    className="cursor-not-allowed rounded-e-none border-e-0 ps-[8.5px] opacity-64 before:rounded-e-none"
                    size="xs"
                    variant="outline"
                  />
                }
              >
                <GitQuickActionIcon
                  quickAction={quickAction}
                  SourceControlIcon={SourceControlIcon}
                />
                <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                  {quickActionLabel}
                </span>
              </PopoverTrigger>
              <PopoverPopup tooltipStyle side="bottom" align="start">
                {quickActionDisabledReason}
              </PopoverPopup>
            </Popover>
          ) : (
            <Button
              variant="outline"
              size="xs"
              className="ps-[8.5px]"
              disabled={isGitActionRunning || quickAction.disabled}
              onClick={runQuickAction}
            >
              <GitQuickActionIcon quickAction={quickAction} SourceControlIcon={SourceControlIcon} />
              <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                {quickActionLabel}
              </span>
            </Button>
          )}
          <GroupSeparator className="hidden @3xl/header-actions:block" />
          <Menu
            onOpenChange={(open) => {
              if (open) {
                requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
              }
            }}
          >
            <MenuTrigger
              render={
                <Button aria-label={t("git.actionOptions")} size="icon-xs" variant="outline" />
              }
              disabled={isGitActionRunning}
            >
              <ChevronDownIcon aria-hidden="true" className="size-4" />
            </MenuTrigger>
            <MenuPopup align="end" className="w-full">
              {gitActionMenuItems.map((item) => {
                const disabledReason = getMenuActionDisabledReason({
                  item,
                  gitStatus: gitStatusForActions,
                  isBusy: isGitActionRunning,
                  hasPrimaryRemote,
                  t,
                });
                if (item.disabled && disabledReason) {
                  return (
                    <Popover key={`${item.id}-${item.label}`}>
                      <PopoverTrigger
                        openOnHover
                        nativeButton={false}
                        render={<span className="block w-max cursor-not-allowed" />}
                      >
                        <MenuItem className="w-full" disabled>
                          <GitActionItemIcon
                            icon={item.icon}
                            SourceControlIcon={SourceControlIcon}
                          />
                          {localizedMenuItemLabel(item, t)}
                        </MenuItem>
                      </PopoverTrigger>
                      <PopoverPopup tooltipStyle side="left" align="center">
                        {disabledReason}
                      </PopoverPopup>
                    </Popover>
                  );
                }

                return (
                  <MenuItem
                    key={`${item.id}-${item.label}`}
                    disabled={item.disabled}
                    onClick={() => {
                      openDialogForMenuItem(item);
                    }}
                  >
                    <GitActionItemIcon icon={item.icon} SourceControlIcon={SourceControlIcon} />
                    {localizedMenuItemLabel(item, t)}
                  </MenuItem>
                );
              })}
              {canPublishRepository ? (
                <MenuItem
                  disabled={isGitActionRunning}
                  onClick={() => {
                    setIsPublishDialogOpen(true);
                  }}
                >
                  <CloudUploadIcon />
                  {t("git.publishRepository")}
                </MenuItem>
              ) : null}
              {gitStatusForActions?.refName === null && (
                <p className="px-2 py-1.5 text-xs text-warning">{t("git.detachedWarning")}</p>
              )}
              {gitStatusForActions &&
                gitStatusForActions.refName !== null &&
                !gitStatusForActions.hasWorkingTreeChanges &&
                gitStatusForActions.behindCount > 0 &&
                gitStatusForActions.aheadCount === 0 && (
                  <p className="px-2 py-1.5 text-xs text-warning">{t("git.behindUpstream")}</p>
                )}
              {gitStatusError && (
                <p className="px-2 py-1.5 text-xs text-destructive">{gitStatusError}</p>
              )}
            </MenuPopup>
          </Menu>
        </Group>
      )}

      <Dialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCommitDialogOpen(false);
            setDialogCommitMessage("");
            setExcludedFiles(new Set());
            setIsEditingFiles(false);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("git.commitDialog.title")}</DialogTitle>
            <DialogDescription>{t("git.commitDialog.description")}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-3 rounded-xl bg-zinc-25 p-3 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">{t("git.branch")}</span>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">
                    {gitStatusForActions?.refName ?? "(detached HEAD)"}
                  </span>
                  {isDefaultRef && (
                    <span className="text-right text-warning">{t("git.defaultRefWarning")}</span>
                  )}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isEditingFiles && allFiles.length > 0 && (
                      <Checkbox
                        checked={allSelected}
                        indeterminate={!allSelected && !noneSelected}
                        onCheckedChange={() => {
                          setExcludedFiles(
                            allSelected ? new Set(allFiles.map((f) => f.path)) : new Set(),
                          );
                        }}
                      />
                    )}
                    <span className="text-muted-foreground">{t("git.files")}</span>
                    {!allSelected && !isEditingFiles && (
                      <span className="text-muted-foreground">
                        ({selectedFiles.length} of {allFiles.length})
                      </span>
                    )}
                  </div>
                  {allFiles.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setIsEditingFiles((prev) => !prev)}
                    >
                      {t(isEditingFiles ? "git.done" : "git.edit")}
                    </Button>
                  )}
                </div>
                {!gitStatusForActions || allFiles.length === 0 ? (
                  <p className="font-medium">{t("git.none")}</p>
                ) : (
                  <div className="space-y-2">
                    <ScrollArea className="h-44 rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
                      <div className="space-y-1 p-1">
                        {allFiles.map((file) => {
                          const isExcluded = excludedFiles.has(file.path);
                          return (
                            <div
                              key={file.path}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/50"
                            >
                              {isEditingFiles && (
                                <Checkbox
                                  checked={!excludedFiles.has(file.path)}
                                  onCheckedChange={() => {
                                    setExcludedFiles((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(file.path)) {
                                        next.delete(file.path);
                                      } else {
                                        next.add(file.path);
                                      }
                                      return next;
                                    });
                                  }}
                                />
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                                onClick={() => openChangedFileInEditor(file.path)}
                              >
                                <StartTruncatedPath
                                  path={file.path}
                                  className={`flex-1${isExcluded ? " text-muted-foreground" : ""}`}
                                />
                                <span className="shrink-0">
                                  {isExcluded ? (
                                    <span className="text-muted-foreground">
                                      {t("git.excluded")}
                                    </span>
                                  ) : (
                                    <>
                                      <span className="text-success">+{file.insertions}</span>
                                      <span className="text-muted-foreground"> / </span>
                                      <span className="text-destructive">-{file.deletions}</span>
                                    </>
                                  )}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                    <div className="flex justify-end font-mono">
                      <span className="text-success">
                        +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-destructive">
                        -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">{t("git.commitMessageOptional")}</p>
              <Textarea
                value={dialogCommitMessage}
                onChange={(event) => setDialogCommitMessage(event.target.value)}
                placeholder={t("git.commitMessagePlaceholder")}
                size="sm"
              />
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsCommitDialogOpen(false);
                setDialogCommitMessage("");
                setExcludedFiles(new Set());
                setIsEditingFiles(false);
              }}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={noneSelected}
              onClick={runDialogActionOnNewBranch}
            >
              {t("git.commitOnNewRef")}
            </Button>
            <Button size="sm" disabled={noneSelected} onClick={runDialogAction}>
              {t("git.commit")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <PublishRepositoryDialog
        open={isPublishDialogOpen}
        onOpenChange={setIsPublishDialogOpen}
        environmentId={activeEnvironmentId}
        gitCwd={gitCwd}
      />

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefaultBranchAction(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? t("git.defaultRefAction")}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="dark:border-transparent dark:bg-transparent sm:flex-wrap sm:items-center">
            <Button
              className="w-full sm:mr-auto sm:w-auto"
              variant="outline"
              size="sm"
              onClick={() => setPendingDefaultBranchAction(null)}
            >
              {t("git.abort")}
            </Button>
            <Button
              className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
              variant="outline"
              size="sm"
              onClick={continuePendingDefaultBranchAction}
            >
              {pendingDefaultBranchActionCopy?.continueLabel ?? t("git.continue")}
            </Button>
            <Button
              className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
              size="sm"
              onClick={checkoutFeatureBranchAndContinuePendingAction}
            >
              {t("git.checkoutFeatureContinue")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
