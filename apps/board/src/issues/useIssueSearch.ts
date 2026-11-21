import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { IssueListEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { issueEnvironment } from "../state/issues";
import { GITHUB, LINEAR } from "./issueLinks";

const SEARCH_DEBOUNCE_MS = 120;
const ROWS = 20;
const HOSTS = { [GITHUB]: "github.com", [LINEAR]: "linear.app" } as const;

export type SearchTracker = keyof typeof HOSTS;

export interface Found<Row> {
  readonly rows: ReadonlyArray<Row>;
  readonly loading: boolean;
  readonly error: string | null;
}

const IDLE = Atom.make(AsyncResult.initial<never, never>()).pipe(
  Atom.withLabel("issue-search-idle"),
);

function useSettled(text: string): string {
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(text), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return settled;
}

/** Marks the paint of the results for `query`, once, so the keystroke-to-paint time can be read. */
function useResultsPainted(query: string, painted: boolean) {
  useEffect(() => {
    if (!painted) return;
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => performance.mark("board:issue-results", { detail: { query } })),
    );
    return () => cancelAnimationFrame(frame);
  }, [query, painted]);
}

const failureOf = (result: AsyncResult.AsyncResult<unknown, unknown>): string | null => {
  if (result._tag !== "Failure") return null;
  const failure = Cause.squash(result.cause);
  return failure instanceof Error ? failure.message : "The engine could not read issues.";
};

/** Open issues of one tracker for the project, matched by the text through `issues.list`. GitHub lists nothing for an empty box. */
export function useIssueSearch(
  project: EnvironmentProject,
  tracker: SearchTracker,
  text: string,
  active: boolean,
): Found<IssueListEntry> {
  const settled = useSettled(text.trim());
  const asks = tracker === GITHUB;
  const enabled = active && (!asks || settled !== "");
  const result = useAtomValue(
    enabled
      ? issueEnvironment.list({
          environmentId: project.environmentId,
          input: {
            state: "open",
            projectId: project.id,
            host: HOSTS[tracker],
            limit: ROWS,
            ...(settled === "" ? {} : { query: settled }),
          },
        })
      : IDLE,
  );
  const answer = AsyncResult.getOrElse(result, () => null);
  const current = settled === text.trim();
  const rows = answer?.entries.filter((entry) => entry.tracker === tracker) ?? [];
  useResultsPainted(settled, enabled && current && !result.waiting && answer !== null);
  return {
    rows,
    loading: active && (!current || (enabled && result.waiting && answer === null)),
    error: failureOf(result),
  };
}
