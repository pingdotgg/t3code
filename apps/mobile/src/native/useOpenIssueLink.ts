import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  pullRequestHostOf,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { parseIssueUrl } from "@t3tools/shared/issueUrl";
import { use, useCallback } from "react";
import { useOpenIssue } from "../features/issues/useOpenIssue";
import { useProjects, useServerConfigs } from "../state/entities";
import { issueEnvironment } from "../state/issues";
import { useNativeLinkContext, useOpenPullRequest } from "./useOpenPullRequest";

export function useOpenIssueLink(options?: {
  readonly context?: { readonly environmentId: string; readonly projectId: string };
}) {
  const registry = use(RegistryContext);
  const openPullRequest = useOpenPullRequest(options);
  const openIssue = useOpenIssue();
  const { environmentId, projectId } = useNativeLinkContext(options?.context);
  const target = environmentId ? EnvironmentId.make(environmentId) : null;
  const configs = useServerConfigs();
  const issues = target !== null && configs.get(target)?.environment.capabilities.issues === true;
  const allowed = useAtomValue(issueEnvironment.resolveUrl.permissionAtom(target));
  const projects = useProjects();
  return useCallback(
    async (url: string) => {
      const candidate =
        target !== null &&
        issues &&
        allowed &&
        (parseIssueUrl(url) !== null ||
          projects.some((project) => {
            const identity = project.repositoryIdentity;
            const tracker = identity?.provider;
            if (project.environmentId !== target || tracker === undefined || tracker === "unknown")
              return false;
            const kind = SourceControlProviderKind.make(tracker);
            let host = pullRequestHostOf(identity, kind);
            if (tracker === "forgejo" && identity?.webUrl !== undefined) {
              host = pullRequestHostOf(
                { canonicalKey: host, locator: { remoteUrl: identity.webUrl } },
                kind,
              );
            }
            return parseIssueUrl(url, { tracker, host }) !== null;
          }));
      if (candidate) {
        const resolved = await issueEnvironment.resolveUrl.run(registry, {
          environmentId: target,
          input: { url, ...(projectId ? { projectId: ProjectId.make(projectId) } : {}) },
        });
        if (resolved._tag === "Success") {
          const { projectId: issueProjectId, tracker, host, scope, key } = resolved.value;
          openIssue({
            environmentId: target,
            projectId: issueProjectId,
            tracker,
            host,
            scope,
            key,
            originalURL: url,
          });
          return true;
        }
      }
      return openPullRequest(url);
    },
    [allowed, issues, openIssue, openPullRequest, projectId, projects, registry, target],
  );
}
