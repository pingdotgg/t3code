import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { issueLinkEnvironment } from "~/state/issueLinks";
import { createMergedEnvironmentQuery } from "~/state/pullRequests";
import { environmentThreadShells } from "~/state/threads";
import { issueThreadTargets, mergeIssueRowThreads, workingThreadKeysOf } from "./issueStatus.logic";

const useThreadsForIssuesQuery = createMergedEnvironmentQuery(
  "web-issues:threads-for-issues",
  issueLinkEnvironment.threadsForIssues,
);

/** Shells change on every thread event; this string changes only when who is working does. */
const workingThreadKeysAtom = Atom.make((get) =>
  workingThreadKeysOf(get(environmentThreadShells.threadShellsAtom)),
).pipe(Atom.withLabel("web-issues:working-thread-keys"));

/**
 * The loaded rows' linked threads, read in batches from every server that keeps Issue links, and
 * which threads work now. Both feed the computed status; no GitHub read happens here.
 */
export function useIssueRowThreads(
  entries: Parameters<typeof issueThreadTargets>[0],
  linkEnvironments: ReadonlySet<EnvironmentId>,
) {
  const targets = useMemo(
    () => issueThreadTargets(entries, linkEnvironments),
    [entries, linkEnvironments],
  );
  const query = useThreadsForIssuesQuery(targets);
  const threadsByIssue = useMemo(() => mergeIssueRowThreads(query.values), [query.values]);
  const workingKey = useAtomValue(workingThreadKeysAtom);
  const working = useMemo(
    (): ReadonlySet<string> => new Set(workingKey.length === 0 ? [] : workingKey.split("\n")),
    [workingKey],
  );
  return { threadsByIssue, working };
}
