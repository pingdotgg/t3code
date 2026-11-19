const DEFAULT_REPOSITORY = "pingdotgg/t3code";
const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

/** The repository this build is released from: its update feed, releases, and issues. */
export function repositoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const releaseRepository =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? configuredRepository
      : DEFAULT_REPOSITORY;
  return `https://github.com/${releaseRepository}`;
}

/** A fork build that sends no one to services T3 operates. `loadRepoEnv` validates its config. */
export const IS_STANDALONE_BUILD = import.meta.env.VITE_T3CODE_STANDALONE === "1";

export const DESKTOP_DOWNLOAD_URL = IS_STANDALONE_BUILD
  ? `${repositoryUrl()}/releases`
  : "https://t3.codes/download";
// Redirects to the App Store or Google Play to match the phone that opens it.
export const MOBILE_APP_URL = IS_STANDALONE_BUILD ? null : "https://t3.codes/mobile";
// T3's policy describes T3's telemetry; a standalone build has none of its own to link.
export const PRIVACY_POLICY_URL = IS_STANDALONE_BUILD ? null : "https://t3.codes/privacy-policy";
export const NEW_ISSUE_URL = `${repositoryUrl()}/issues/new`;
