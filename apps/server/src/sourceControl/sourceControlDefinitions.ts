import * as AzureDevOpsDriver from "@t3tools/source-control-azure-devops/server/driver";
import * as BitbucketDriver from "@t3tools/source-control-bitbucket/server/driver";
import * as CursorOriginDriver from "@t3tools/source-control-cursor-origin/server/driver";
import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import * as ForgejoDriver from "@t3tools/source-control-forgejo/server/driver";
import * as GitCafeDriver from "@t3tools/source-control-gitcafe/server/driver";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";

/** In the shared registry's order, which is the order hosts are listed and probed in. */
export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST = [
  GitHubDriver.driver,
  CursorOriginDriver.driver,
  GitLabDriver.driver,
  GitCafeDriver.driver,
  ForgejoDriver.driver,
  BitbucketDriver.driver,
  AzureDevOpsDriver.driver,
] as const;

export const sourceControlDefinitions = builtInSourceControlDefinitions;

/** A host CLI command that merges or closes a change request, such as `gh pr merge`. */
export const isChangeRequestCloseCommand = (command: string) =>
  sourceControlDefinitions.definitions.some(
    (definition) => definition.changeRequestCloseCommand?.test(command) === true,
  );

const NAMED_CHANGE_REQUEST = /(?:^|[\s=])#?(\d+)(?=\s|$)|\/(?:pulls?|merge_requests)\/(\d+)/gu;

/**
 * The change request numbers a merge or close command names, or "any" when one names none, as a
 * bare `gh pr merge` on the checked-out branch or `gh stack merge` does.
 */
export function changeRequestsClosedBy(command: string): ReadonlySet<number> | "any" {
  const named = new Set<number>();
  for (const { changeRequestCloseCommand: close } of sourceControlDefinitions.definitions) {
    if (close === undefined) continue;
    for (const match of command.matchAll(new RegExp(close.source, `${close.flags}g`))) {
      // From the match's start, since Azure's match runs through `--id` to `--status`.
      const args = command.slice(match.index).split(/[;&|\n]/u, 1)[0] ?? "";
      const numbers = [...args.matchAll(NAMED_CHANGE_REQUEST)].map(([, bare, url]) =>
        Number(bare ?? url),
      );
      if (numbers.length === 0) return "any";
      for (const number of numbers) named.add(number);
    }
  }
  return named.size === 0 ? "any" : named;
}
