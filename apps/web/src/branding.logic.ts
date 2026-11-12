const NIGHTLY_SERVER_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (input.stageLabel.trim().toLowerCase() === "latest") {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

export function resolveHostedAppChannelLabel(channel: string | null | undefined): string | null {
  const normalized = channel?.trim().toLowerCase();
  return normalized === "nightly" ? "Nightly" : normalized === "latest" ? "Latest" : null;
}

/** Stage label of a web build. vite.config.ts stamps it into index.html's title too. */
export function resolveWebAppStageLabel(input: {
  readonly hostedAppChannel: string | null | undefined;
  readonly development: boolean;
}): string {
  return (
    resolveHostedAppChannelLabel(input.hostedAppChannel) ?? (input.development ? "Dev" : "Beta")
  );
}

export function resolveServerBackedAppStageLabel(input: {
  readonly primaryServerVersion: string | null | undefined;
  readonly fallbackStageLabel: string;
}): string {
  return input.primaryServerVersion &&
    NIGHTLY_SERVER_VERSION_PATTERN.test(input.primaryServerVersion)
    ? "Nightly"
    : input.fallbackStageLabel;
}

export function resolveServerBackedAppDisplayName(input: {
  readonly baseName: string;
  readonly fallbackDisplayName: string;
  readonly fallbackStageLabel: string;
  readonly primaryServerVersion: string | null | undefined;
}): string {
  const stageLabel = resolveServerBackedAppStageLabel({
    primaryServerVersion: input.primaryServerVersion,
    fallbackStageLabel: input.fallbackStageLabel,
  });

  return stageLabel === input.fallbackStageLabel
    ? input.fallbackDisplayName
    : formatAppDisplayName({ baseName: input.baseName, stageLabel });
}

/**
 * Names the open thread: `project / thread` on desktop, where the OS already
 * shows the app, with the app name appended in browser tabs.
 */
export function resolveWindowTitle(input: {
  readonly appDisplayName: string;
  readonly projectTitle: string | null;
  readonly threadTitle: string | null;
  /** The screen reader title: status, then thread, then project, since a screen reader reads from the start. */
  readonly screenReader?: { readonly threadStatus: string | null };
  readonly desktop: boolean;
}): string {
  const threadTitle = input.threadTitle?.trim() ?? "";
  const status = input.screenReader?.threadStatus;
  if (threadTitle === "") {
    return status ? `${status}: ${input.appDisplayName}` : input.appDisplayName;
  }

  const projectTitle = input.projectTitle?.trim() ?? "";
  const context =
    projectTitle === ""
      ? threadTitle
      : input.screenReader
        ? `${threadTitle} - ${projectTitle}`
        : `${projectTitle} / ${threadTitle}`;
  const title = status ? `${status}: ${context}` : context;
  return input.desktop ? title : `${title} - ${input.appDisplayName}`;
}
