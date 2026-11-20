import { resolveThreadGroupFor } from "@t3tools/client-runtime/state/thread-groups";
import { topicUpdatedSince } from "@t3tools/client-runtime/state/thread-board";
import type { EnvironmentId, OrchestrationV2BoardTopic, ThreadId } from "@t3tools/contracts";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

export interface BoardTopicPresentation {
  readonly editedLabel: string | null;
  readonly updated: boolean;
  readonly authorLeft: boolean;
}

export function presentBoardTopic(
  topic: Pick<OrchestrationV2BoardTopic, "editCount" | "updatedAt"> & {
    readonly authorInGroup: boolean;
  },
  viewedAt: string | null,
  resolve: MessageResolver = m,
): BoardTopicPresentation {
  return {
    editedLabel:
      topic.editCount === 0
        ? null
        : resolve(
            msg("{count, plural, one {edited {count} time} other {edited {count} times}}", {
              count: topic.editCount,
            }),
          ),
    updated: topicUpdatedSince(topic, viewedAt),
    authorLeft: !topic.authorInGroup,
  };
}

/** The group lead's shell for a lead or a worker; null when the thread is not in a group. */
export function resolveBoardLeadShell<
  T extends Parameters<typeof resolveThreadGroupFor>[0][number],
>(shells: ReadonlyArray<T>, environmentId: EnvironmentId, threadId: ThreadId): T | null {
  return resolveThreadGroupFor(shells, environmentId, threadId)?.parent ?? null;
}
