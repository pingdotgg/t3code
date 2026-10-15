import { useAtomValue } from "@effect/atom-react";
import type { AtomRegistry } from "effect/reactivity";
import { EnvironmentId, type IssueDetail, type IssueRef } from "@t3tools/contracts";
import { issueEnvironment } from "../../state/issues";
import { usePullRequestConnected } from "../pull-requests/usePullRequestConnected";
import { issueAccess } from "./issueDetail";
import { markIssueWritten } from "./issueList";
import type { IssueParams } from "./issueSelection";

export function issueTarget(params: IssueParams) {
  const input: IssueRef = {
    projectId: params.projectId as IssueRef["projectId"],
    tracker: params.tracker as IssueRef["tracker"],
    host: params.host,
    scope: params.scope,
    key: params.key,
  };
  return { environmentId: EnvironmentId.make(params.environmentId), input };
}

/** Tells the list which source to re-read after a confirmed write to this issue. */
export function markIssueTargetWritten(registry: AtomRegistry.AtomRegistry, params: IssueParams) {
  const { environmentId, input } = issueTarget(params);
  markIssueWritten(
    registry,
    environmentId,
    { projectId: input.projectId, tracker: input.tracker, host: params.host, scope: params.scope },
    params.key,
  );
}

export function useIssueAccess(params: IssueParams, detail: IssueDetail | null) {
  const environmentId = EnvironmentId.make(params.environmentId);
  const connected = usePullRequestConnected(params.environmentId);
  const comment = useAtomValue(issueEnvironment.comment.permissionAtom(environmentId));
  const update = useAtomValue(issueEnvironment.update.permissionAtom(environmentId));
  const setState = useAtomValue(issueEnvironment.setState.permissionAtom(environmentId));
  const react = useAtomValue(issueEnvironment.react.permissionAtom(environmentId));
  return { connected, ...issueAccess(detail, { connected, comment, update, setState, react }) };
}
