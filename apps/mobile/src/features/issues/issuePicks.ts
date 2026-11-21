import { noIssuePicks } from "@t3tools/client-runtime/issue-selection";
import type { IssueAssigneeCandidate, IssueLabelCandidate } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

// Outside the sheets: a sheet is gone before its write lands, and one reopened in between must
// build on those picks rather than on the issue as it was last read.
const IDLE_TTL_MS = 60_000;

export const issueLabelPicksFamily = Atom.family((_issueKey: string) =>
  Atom.make(noIssuePicks<IssueLabelCandidate>()).pipe(Atom.setIdleTTL(IDLE_TTL_MS)),
);

export const issueAssigneePicksFamily = Atom.family((_issueKey: string) =>
  Atom.make(noIssuePicks<IssueAssigneeCandidate>()).pipe(Atom.setIdleTTL(IDLE_TTL_MS)),
);
