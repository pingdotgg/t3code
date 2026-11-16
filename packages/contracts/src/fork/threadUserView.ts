import * as Schema from "effect/Schema";

import { ThreadId } from "../baseSchemas.ts";
import { OrchestratorMcpEnvironmentTarget } from "../orchestratorMcp.ts";

export const THREAD_USER_VIEW_TOOL_NAME = "t3_thread_user_view";

const messageId = (description: string) =>
  Schema.String.annotate({ description }).check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const ThreadUserViewInput = Schema.Struct({
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: Schema.optional(ThreadId),
  subThread: Schema.optional(
    messageId(
      "A sub-thread: the id of its first message or of a reply in it, or the id of the message its first message answers.",
    ),
  ),
  main: Schema.optional(
    Schema.Int.annotate({
      description:
        "How many main-list messages: the latest (default 20), or with subThread, those before it (default 3).",
    }).check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(200)),
  ),
  through: Schema.optional(messageId("The id of the last message to show.")),
  expect: Schema.optional(
    Schema.String.annotate({ description: "The sha256 a Pinned line carries." }).check(
      Schema.isMaxLength(256),
    ),
  ),
});
export type ThreadUserViewInput = typeof ThreadUserViewInput.Type;

export const ThreadUserViewResult = Schema.Struct({ text: Schema.String });
export type ThreadUserViewResult = typeof ThreadUserViewResult.Type;
