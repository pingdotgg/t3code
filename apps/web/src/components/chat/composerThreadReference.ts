import type { ThreadContextRecord } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";

/** Answers have no context-record channel; put the same-environment thread ID in the text. */
export function composerThreadReferenceText(
  record: ThreadContextRecord,
  answeringQuestion: boolean,
) {
  return answeringQuestion
    ? formatThreadLink(record, record.title)
    : formatInlineContextReference(threadContextReference(record));
}
