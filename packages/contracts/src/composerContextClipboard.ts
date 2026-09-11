import * as Schema from "effect/Schema";

import { EnvironmentId, MessageId, ThreadId } from "./baseSchemas.ts";
import { COMPOSER_CONTEXT_MAX_RECORDS, ComposerContextRecord } from "./composerContext.ts";
import { ForwardCompatibleArray } from "./baseSchemas.ts";

/**
 * Structured clipboard payload for context copied between drafts and messages. Carries the
 * records behind the copied links plus where they came from, never bytes or URLs; the receiver
 * resolves binaries through its own environment.
 */
export const COMPOSER_CONTEXT_CLIPBOARD_MIME = "web application/x-t3-context-fragment+json";

export const ComposerContextClipboardFragment = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Struct({
    environmentId: EnvironmentId,
    threadId: Schema.optional(ThreadId),
    messageId: Schema.optional(MessageId),
  }),
  records: ForwardCompatibleArray(ComposerContextRecord).check(
    Schema.isMaxLength(COMPOSER_CONTEXT_MAX_RECORDS),
  ),
});
export type ComposerContextClipboardFragment = typeof ComposerContextClipboardFragment.Type;
