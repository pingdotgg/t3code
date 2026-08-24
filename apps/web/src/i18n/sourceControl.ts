import type { MessageKey, Translate } from "./messages";

const SOURCE_CONTROL_DISCOVERY_MESSAGE_KEYS: Readonly<Record<string, MessageKey>> = {
  "Install Git from https://git-scm.com/downloads or with your package manager.":
    "sourceControl.discovery.install.git",
  "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.":
    "sourceControl.discovery.install.jujutsu",
  "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).":
    "sourceControl.discovery.install.github",
  "Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`).":
    "sourceControl.discovery.install.gitlab",
  "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.":
    "sourceControl.discovery.install.azureDevOps",
  "Set T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN on the server (use a Bitbucket API token with pull request, repository, and user read scopes).":
    "sourceControl.discovery.install.bitbucket",
  "Hosting integration command was not found on the server PATH.":
    "sourceControl.discovery.auth.commandMissing",
  "Run `gh auth login` to authenticate GitHub CLI with an active account.":
    "sourceControl.discovery.auth.githubSignInActive",
  "GitHub CLI is too old to report sign-in status. Update `gh` to 2.81.0 or newer (for example `brew upgrade gh`) and rescan.":
    "sourceControl.discovery.auth.githubCliTooOld",
  "Run `gh auth login` to authenticate GitHub CLI.": "sourceControl.discovery.auth.githubSignIn",
  "GitHub CLI auth status could not be parsed.": "sourceControl.discovery.auth.githubStatusUnknown",
  "Run `glab auth login` to authenticate GitLab CLI.": "sourceControl.discovery.auth.gitlabSignIn",
  "GitLab CLI auth status could not be parsed.": "sourceControl.discovery.auth.gitlabStatusUnknown",
  "Run `az login` to authenticate Azure CLI.": "sourceControl.discovery.auth.azureSignIn",
  "Azure CLI account status could not be parsed.":
    "sourceControl.discovery.auth.azureStatusUnknown",
  "Bitbucket access token is configured.": "sourceControl.discovery.auth.bitbucketAccessToken",
  "Bitbucket API token is configured.": "sourceControl.discovery.auth.bitbucketApiToken",
  "Set T3CODE_BITBUCKET_EMAIL and T3CODE_BITBUCKET_API_TOKEN, or T3CODE_BITBUCKET_ACCESS_TOKEN.":
    "sourceControl.discovery.auth.bitbucketCredentialsRequired",
};

export function localizedSourceControlDiscoveryText(text: string, t: Translate): string {
  const key = Object.hasOwn(SOURCE_CONTROL_DISCOVERY_MESSAGE_KEYS, text)
    ? SOURCE_CONTROL_DISCOVERY_MESSAGE_KEYS[text]
    : undefined;
  return key === undefined ? text : t(key);
}
