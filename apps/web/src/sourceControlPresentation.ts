import type { SourceControlProviderKind } from "@forma/contracts";

export interface SourceControlProviderPresentation {
  readonly label: string;
  readonly repositoryPlaceholder: string;
  readonly installHint: string;
}

export function getSourceControlProviderPresentation(
  kind: SourceControlProviderKind,
): SourceControlProviderPresentation {
  switch (kind) {
    case "github":
      return {
        label: "GitHub",
        repositoryPlaceholder: "owner/repo",
        installHint: "Install `gh` and run `gh auth login`.",
      };
    case "gitlab":
      return {
        label: "GitLab",
        repositoryPlaceholder: "group/project",
        installHint: "Install `glab` and run `glab auth login`.",
      };
    case "bitbucket":
      return {
        label: "Bitbucket",
        repositoryPlaceholder: "workspace/repo",
        installHint: "Bitbucket support is not enabled yet.",
      };
    case "azure-devops":
      return {
        label: "Azure DevOps",
        repositoryPlaceholder: "organization/project/repository",
        installHint: "Azure DevOps support is not enabled yet.",
      };
    case "unknown":
      return {
        label: "Git URL",
        repositoryPlaceholder: "https://example.com/owner/repo.git",
        installHint: "Use a raw Git remote URL.",
      };
  }
}
