import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, SourceControlProviderInfo } from "@t3tools/contracts";
import { memo, useEffect, useMemo } from "react";

import { gitEnvironment } from "../../state/git";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import {
  prStatusIndicator,
  resolveThreadPr,
  type PrStatusIndicator,
} from "../ThreadStatusIndicators";
import {
  isSessionGridMissingChangeRequestError,
  sessionGridChangeRequestKey,
  type SessionGridChangeRequestState,
} from "./sessionGrid.logic";

export interface SessionGridChangeRequestObservation {
  readonly key: string;
  readonly state: SessionGridChangeRequestState;
  readonly prStatus: PrStatusIndicator | null;
}

type ChangeRequestReporter = (observations: readonly SessionGridChangeRequestObservation[]) => void;

function observationKey(thread: EnvironmentThreadShell): string {
  return sessionGridChangeRequestKey({
    branch: thread.branch,
    threadKey: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  });
}

/**
 * One VCS subscription fans out to every grid thread sharing a checkout.
 * Missing observations deliberately mean "loading": the first stream event
 * contains local Git state only, and `pr: null` is not authoritative until
 * the slower remote half resolves. Shared-root branch mismatches use the
 * branch-aware resolution RPC rather than inferring from the current checkout.
 */
export const SessionGridChangeRequestObserverGroup = memo(
  function SessionGridChangeRequestObserverGroup(props: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly threads: readonly EnvironmentThreadShell[];
    readonly transient: boolean;
    readonly onChangeRequestState: ChangeRequestReporter;
  }) {
    const { cwd, environmentId, onChangeRequestState, threads, transient } = props;
    const gitStatus = useEnvironmentQuery(
      (transient ? vcsEnvironment.reconciliationStatus : vcsEnvironment.status)({
        environmentId,
        input: { cwd },
      }),
    );
    const mismatchedThreads = useMemo(() => {
      const data = gitStatus.data;
      if (data === null || !data.isRepo) return [];
      return threads.filter((thread) => thread.branch !== data.refName);
    }, [gitStatus.data, threads]);
    const observations = useMemo(() => {
      const data = gitStatus.data;
      if (data === null) {
        if (gitStatus.error === null) return null;
        return threads.map((thread) => ({
          key: observationKey(thread),
          state: "unknown" as const,
          prStatus: null,
        }));
      }
      if (!data.isRepo) {
        return threads.map((thread) => ({
          key: observationKey(thread),
          state: null,
          prStatus: null,
        }));
      }
      if (!data.remoteStatusResolved) {
        return threads.flatMap((thread): SessionGridChangeRequestObservation[] =>
          thread.branch === data.refName
            ? [
                {
                  key: observationKey(thread),
                  state: "unknown",
                  prStatus: null,
                },
              ]
            : [],
        );
      }
      return threads.flatMap((thread): SessionGridChangeRequestObservation[] => {
        if (thread.branch !== data.refName) return [];
        const pr = resolveThreadPr({
          threadBranch: thread.branch,
          gitStatus: data,
        });
        return [
          {
            key: observationKey(thread),
            state: pr?.state ?? null,
            prStatus: prStatusIndicator(pr, data.sourceControlProvider),
          },
        ];
      });
    }, [gitStatus.data, gitStatus.error, threads]);

    useEffect(() => {
      if (observations !== null && observations.length > 0) {
        onChangeRequestState(observations);
      }
    }, [observations, onChangeRequestState]);

    return (
      <>
        {mismatchedThreads.map((thread) => (
          <SessionGridBranchChangeRequestObserver
            cwd={cwd}
            environmentId={environmentId}
            key={observationKey(thread)}
            onChangeRequestState={onChangeRequestState}
            sourceControlProvider={gitStatus.data?.sourceControlProvider ?? null}
            thread={thread}
          />
        ))}
      </>
    );
  },
);

const SessionGridBranchChangeRequestObserver = memo(
  function SessionGridBranchChangeRequestObserver(props: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly thread: EnvironmentThreadShell;
    readonly sourceControlProvider: SourceControlProviderInfo | null;
    readonly onChangeRequestState: ChangeRequestReporter;
  }) {
    const { cwd, environmentId, onChangeRequestState, sourceControlProvider, thread } = props;
    const resolution = useEnvironmentQuery(
      thread.branch === null
        ? null
        : gitEnvironment.pullRequestResolution({
            environmentId,
            input: { cwd, reference: thread.branch },
          }),
    );
    const observation = useMemo((): SessionGridChangeRequestObservation | null => {
      const resolved = resolution.data?.pullRequest ?? null;
      if (resolved !== null) {
        const pr = {
          number: resolved.number,
          title: resolved.title,
          url: resolved.url,
          baseRef: resolved.baseBranch,
          headRef: resolved.headBranch,
          state: resolved.state,
        };
        return {
          key: observationKey(thread),
          state: resolved.state,
          prStatus: prStatusIndicator(pr, sourceControlProvider),
        };
      }
      if (resolution.error === null) return null;
      return {
        key: observationKey(thread),
        state: isSessionGridMissingChangeRequestError(resolution.error) ? null : "unknown",
        prStatus: null,
      };
    }, [resolution.data, resolution.error, sourceControlProvider, thread]);

    useEffect(() => {
      if (observation !== null) onChangeRequestState([observation]);
    }, [observation, onChangeRequestState]);
    return null;
  },
);
