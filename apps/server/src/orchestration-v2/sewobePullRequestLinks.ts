import type { OrchestrationV2ServerCommand } from "@t3tools/contracts";

const localUrl = (url: string) =>
  url.replace(
    /^https?:\/\/git\.staging\.sewobe\.de(?::8443)?(?=\/[^?#]+\/-\/merge_requests\/[1-9]\d*(?:[/?#]|$))/iu,
    "http://git.sewobe.local",
  );

/** Apply the local GitLab override once, before any linking command is handled. */
export function rewriteSewobePullRequestLinks(command: OrchestrationV2ServerCommand) {
  if ("host" in command) {
    command = {
      ...command,
      host: command.host.replace(/^git\.staging\.sewobe\.de(?::8443)?$/iu, "git.sewobe.local"),
    };
  }
  if ("url" in command) command = { ...command, url: localUrl(command.url) };
  if ("link" in command && command.link) {
    command = { ...command, link: { ...command.link, url: localUrl(command.link.url) } };
  }
  if ("linkedPullRequest" in command && command.linkedPullRequest) {
    command = {
      ...command,
      linkedPullRequest: {
        ...command.linkedPullRequest,
        url: localUrl(command.linkedPullRequest.url),
      },
    };
  }
  if ("branchPullRequest" in command && command.branchPullRequest) {
    command = {
      ...command,
      branchPullRequest: {
        ...command.branchPullRequest,
        url: localUrl(command.branchPullRequest.url),
      },
    };
  }
  return command;
}
