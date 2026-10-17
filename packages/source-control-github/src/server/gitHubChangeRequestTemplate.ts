import * as ChangeRequestTemplate from "@t3tools/source-control-core/server/changeRequestTemplate";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
] as const;

const TEMPLATE_DIRECTORIES = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
] as const;

export const detect = (
  cwd: string,
  treeish: string,
  executeGit: SourceControlHost.SourceControlHost["Service"]["git"]["execute"],
) =>
  ChangeRequestTemplate.detect(cwd, treeish, executeGit, {
    paths: TEMPLATE_PATHS,
    directories: TEMPLATE_DIRECTORIES,
    caseInsensitive: false,
  });
