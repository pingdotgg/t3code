/**
 * Translatable copies of the English labels in `@t3tools/contracts` helpers. Same ids, same
 * English; apps call these instead of the contracts helpers so the text follows the UI language.
 */
import {
  type BrowserImportFailureReason,
  isRuntimeModeAbove,
  managedCapabilityDenial as contractsManagedCapabilityDenial,
  managedUpdatesDenial as contractsManagedUpdatesDenial,
  type ManagedPolicySummary,
  type ProjectCloneSnapshot,
  type ProjectCloneStage,
  type RuntimeMode,
  type WorktreeSetupStageId,
  worktreeSetupStageLabel as contractsWorktreeSetupStageLabel,
} from "@t3tools/contracts";
import type { IdleCompactionMode } from "@t3tools/contracts/settings";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

// Contracts decides each stage's English label; this table only makes that text translatable.
const WORKTREE_SETUP_STAGE_LABELS: Readonly<Record<string, string>> = {
  "Fetch base branch": msg("Fetch base branch"),
  "Check out files": msg("Check out files"),
  "Init submodules": msg("Init submodules"),
  "Run setup script": msg("Run setup script"),
  "Start agent": msg("Start agent"),
};

/** @public */
export function worktreeSetupStageLabel(
  id: WorktreeSetupStageId,
  resolve: MFunctionType = mFallback,
): string {
  const english = contractsWorktreeSetupStageLabel(id);
  return resolve(WORKTREE_SETUP_STAGE_LABELS[english] ?? english);
}

const PROJECT_CLONE_STAGE_LABELS: Record<ProjectCloneStage, string> = {
  connecting: msg("Connecting", { $context: "git clone stage" }),
  counting: msg("Counting objects"),
  receiving: msg("Receiving objects"),
  resolving: msg("Resolving deltas"),
  checkout: msg("Checking out files"),
};

/** @public */
export function projectCloneStageLabel(
  stage: ProjectCloneStage,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(PROJECT_CLONE_STAGE_LABELS[stage]);
}

/** @public */
export function projectCloneProgressSummary(
  snapshot: Pick<ProjectCloneSnapshot, "stage" | "percent" | "detail" | "stalled">,
  resolve: MFunctionType = mFallback,
): string {
  const parts = [projectCloneStageLabel(snapshot.stage, resolve)];
  if (snapshot.percent !== null) parts.push(`${snapshot.percent}%`);
  // The detail carries git's last transfer speed, which a stall makes a lie.
  if (snapshot.stalled) parts.push(resolve(msg("Stalled", { $context: "git clone progress" })));
  else if (snapshot.detail) parts.push(snapshot.detail);
  return parts.join(" · ");
}

/** @public */
export function managedUpdatesMessage(
  organization: string,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(msg("{organization} manages T3 Code updates.", { organization }));
}

/** @public */
export function managedNightlyDeniedMessage(
  organization: string,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(
    msg("{organization} manages T3 Code updates. Only stable releases can be installed.", {
      organization,
    }),
  );
}

/** @public */
export function managedUpdatesDenial(
  summary: ManagedPolicySummary | undefined,
  resolve: MFunctionType = mFallback,
): string | undefined {
  return summary !== undefined && contractsManagedUpdatesDenial(summary) !== undefined
    ? managedUpdatesMessage(summary.organization, resolve)
    : undefined;
}

/** @public */
export function managedRuntimeModeCeilingMessage(
  organization: string,
  ceiling: RuntimeMode,
  resolve: MFunctionType = mFallback,
): string {
  switch (ceiling) {
    case "approval-required":
      return resolve(msg("{organization} limits threads to Supervised.", { organization }));
    case "auto-accept-edits":
      return resolve(msg("{organization} limits threads to Auto-accept edits.", { organization }));
    case "auto":
      return resolve(msg("{organization} limits threads to Auto.", { organization }));
    case "full-access":
      return resolve(msg("{organization} limits threads to Full access.", { organization }));
  }
}

/** @public */
export function managedRuntimeModeDenial(
  summary: ManagedPolicySummary | undefined,
  mode: RuntimeMode,
  resolve: MFunctionType = mFallback,
): string | undefined {
  const ceiling = summary?.limits?.maxRuntimeMode;
  return summary !== undefined && ceiling !== undefined && isRuntimeModeAbove(mode, ceiling)
    ? managedRuntimeModeCeilingMessage(summary.organization, ceiling, resolve)
    : undefined;
}

export type ManagedCapability =
  | "remoteClients"
  | "connect"
  | "webhookTasks"
  | "browserCookieImport";

function managedCapabilityDeniedMessage(
  organization: string,
  capability: ManagedCapability,
  resolve: MFunctionType,
): string {
  switch (capability) {
    case "remoteClients":
      return resolve(
        msg("{organization}'s policy does not allow connecting from other devices.", {
          organization,
        }),
      );
    case "connect":
      return resolve(msg("{organization}'s policy does not allow T3 Connect.", { organization }));
    case "webhookTasks":
      return resolve(
        msg("{organization}'s policy does not allow webhook tasks.", { organization }),
      );
    case "browserCookieImport":
      return resolve(
        msg("{organization}'s policy does not allow importing browser cookies.", {
          organization,
        }),
      );
  }
}

/** @public */
export function managedCapabilityDenial(
  summary: ManagedPolicySummary | undefined,
  capability: ManagedCapability,
  resolve: MFunctionType = mFallback,
): string | undefined {
  return summary !== undefined &&
    contractsManagedCapabilityDenial(summary, capability) !== undefined
    ? managedCapabilityDeniedMessage(summary.organization, capability, resolve)
    : undefined;
}

const IDLE_COMPACTION_MODE_LABELS: Record<IdleCompactionMode | "default", string> = {
  default: msg("Use default"),
  onReturn: msg("When you return"),
  beforeCacheExpires: msg("Before the cache expires (beta)"),
  off: msg("Never", { $context: "idle compaction mode" }),
};

/** @public Labels for `IDLE_COMPACTION_MODES` values, plus the per-instance "default". */
export function idleCompactionModeLabel(
  mode: IdleCompactionMode | "default",
  resolve: MFunctionType = mFallback,
): string {
  return resolve(IDLE_COMPACTION_MODE_LABELS[mode]);
}

const BROWSER_IMPORT_FAILURE_MESSAGES: Record<BrowserImportFailureReason, string> = {
  notInstalled: msg("Not installed on this machine."),
  needsKeychainApproval: msg("Needs Keychain access to read its cookies."),
  keychainItemMissing: msg(
    "No encryption key in your Keychain. Sign in to that browser once, then retry.",
  ),
  needsFullDiskAccess: msg(
    "Give T3 Code Full Disk Access in System Settings → Privacy & Security, then retry.",
  ),
  browserRunning: msg("Quit the browser first so its cookie database can be read."),
  unsupportedPlatform: msg("Importing from this browser isn't possible on this platform."),
  keychainUnavailable: msg(
    "The system keyring could not be accessed. Make sure your desktop keyring is running and unlocked, then retry.",
  ),
  unknownSource: msg("That browser is no longer available to import from."),
  unknownSourceProfile: msg("That browser profile no longer exists."),
  sessionUnavailable: msg("The target profile could not be opened."),
  profileNotSaved: msg(
    "The cookies were imported, but the new profile couldn't be saved. Try again.",
  ),
  profileLimitReached: msg(
    "You've reached the profile limit. Delete a profile or import into an existing one.",
  ),
  readFailed: msg("The browser's cookie database could not be read."),
};

/** @public `BROWSER_IMPORT_FAILURE_COPY[reason]`, translated. */
export function browserImportFailureMessage(
  reason: BrowserImportFailureReason,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(BROWSER_IMPORT_FAILURE_MESSAGES[reason]);
}

// The server's source-control discovery hints, in the same English; commands and URLs stay as is.
const INSTALL_HINTS = [
  msg("Install Git from {url} or with your package manager.", {
    url: "https://git-scm.com/downloads",
  }),
  msg("Install Jujutsu with {command} or from {url}.", {
    command: "`brew install jj`",
    url: "https://github.com/jj-vcs/jj",
  }),
  msg(
    "Install the GitHub command-line tool ({cli}) via {url} or your package manager (for example {command}).",
    {
      cli: "`gh`",
      url: "https://cli.github.com/",
      command: "`brew install gh`",
    },
  ),
  msg(
    "Install the GitLab command-line tool ({cli}) from {url} or your package manager (for example {command}).",
    {
      cli: "`glab`",
      url: "https://gitlab.com/gitlab-org/cli",
      command: "`brew install glab`",
    },
  ),
  msg(
    "Install the Azure command-line tools ({cli}), then enable Azure DevOps support with {command}.",
    {
      cli: "`az`",
      command: "`az extension add --name azure-devops`",
    },
  ),
  msg("Add a Bitbucket token in Settings → Source control & issues."),
  msg("Install the Origin CLI with {install}, then run {login}.", {
    install: "`curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`",
    login: "`origin auth login`",
  }),
  msg(
    "Install {fj} 0.6 or later from {fjUrl} and run {fjLogin}, or install {tea} 0.16 or later from {teaUrl} and run {teaLogin} for each Forgejo or Gitea server.",
    {
      fj: "`fj`",
      fjUrl: "https://codeberg.org/forgejo-contrib/forgejo-cli",
      fjLogin: "`fj --host <server-url> auth add-token`",
      tea: "`tea`",
      teaUrl: "https://gitea.com/gitea/tea",
      teaLogin: "`tea login add`",
    },
  ),
  msg(
    "Install the GitCafe CLI with {install}, then run {login}, save a token in Settings, or set {variable} on the server.",
    {
      install: "`bun install -g @gitcafe/cli`",
      login: "`cafe auth login --host https://git.cafe/api`",
      variable: "CAFE_TOKEN",
    },
  ),
];

/** @public A source-control `installHint`, translated when it is one of the server's fixed hints. */
export function sourceControlInstallHintText(
  hint: string,
  resolve: MFunctionType = mFallback,
): string {
  const known = INSTALL_HINTS.find((entry) => mFallback(entry) === hint);
  return known === undefined ? hint : resolve(known);
}
