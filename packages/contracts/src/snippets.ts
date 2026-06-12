/**
 * Saved-prompt snippet contracts.
 *
 * Snippets are user-authored, server-authoritative prompt templates that can
 * be expanded into the composer via `/<snippet-id>`. The trigger mirrors
 * the existing built-in slash commands (`/model`, `/plan`, `/default`) and
 * provider slash commands.
 *
 * Scope decisions:
 *   - `SnippetId` is a lowercase dashed slug, matching the script id rule
 *     used for `script.<id>.run` in keybindings. Lowercased so the trigger
 *     is case-insensitive in the menu.
 *   - The body is plain text in v1. No variable substitution yet — that
 *     is a follow-up. (Adding variables would mean picking a Lexical
 *     node vs. plain text, plus a server/client resolution contract.)
 *   - `promptSnippets` is keyed by id inside `ServerSettings` and stored
 *     as a record. Whole-map replacement on patch (mirrors the
 *     `providerInstances` design note in settings.ts).
 *
 * @module snippets
 */
import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const MAX_SNIPPET_ID_LENGTH = 40;
export const MAX_SNIPPET_TITLE_LENGTH = 80;
export const MAX_SNIPPET_DESCRIPTION_LENGTH = 160;
export const MAX_SNIPPET_BODY_LENGTH = 8_192;

const SNIPPET_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const SnippetId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_SNIPPET_ID_LENGTH),
  Schema.isPattern(SNIPPET_ID_PATTERN),
).pipe(Schema.brand("SnippetId"));
export type SnippetId = typeof SnippetId.Type;

export const SnippetTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MAX_SNIPPET_TITLE_LENGTH),
);
export type SnippetTitle = typeof SnippetTitle.Type;

export const SnippetDescription = TrimmedString.check(
  Schema.isMaxLength(MAX_SNIPPET_DESCRIPTION_LENGTH),
);
export type SnippetDescription = typeof SnippetDescription.Type;

export const SnippetBody = Schema.String.check(Schema.isMaxLength(MAX_SNIPPET_BODY_LENGTH));
export type SnippetBody = typeof SnippetBody.Type;

export const Snippet = Schema.Struct({
  id: SnippetId,
  title: SnippetTitle,
  description: Schema.optionalKey(SnippetDescription),
  body: SnippetBody,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Snippet = typeof Snippet.Type;

export const SnippetMap = Schema.Record(SnippetId, Snippet);
export type SnippetMap = typeof SnippetMap.Type;
