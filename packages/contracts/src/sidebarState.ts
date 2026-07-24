import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PinnedThreadKeysByProjectKey = Schema.Record(
  TrimmedNonEmptyString,
  Schema.Array(TrimmedNonEmptyString),
);
export type PinnedThreadKeysByProjectKey = typeof PinnedThreadKeysByProjectKey.Type;

export const SidebarStateSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  pinnedThreadKeysByProjectKey: PinnedThreadKeysByProjectKey,
});
export type SidebarStateSnapshot = typeof SidebarStateSnapshot.Type;

const SidebarMutationId = TrimmedNonEmptyString;

export const SidebarStateMutation = Schema.Union([
  Schema.Struct({
    mutationId: SidebarMutationId,
    type: Schema.Literal("set-pinned"),
    projectKey: TrimmedNonEmptyString,
    threadKey: TrimmedNonEmptyString,
    pinned: Schema.Boolean,
  }),
  Schema.Struct({
    mutationId: SidebarMutationId,
    type: Schema.Literal("reorder-pinned"),
    projectKey: TrimmedNonEmptyString,
    draggedThreadKey: TrimmedNonEmptyString,
    targetThreadKey: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    mutationId: SidebarMutationId,
    type: Schema.Literal("import-pins"),
    pinnedThreadKeysByProjectKey: PinnedThreadKeysByProjectKey,
  }),
]);
export type SidebarStateMutation = typeof SidebarStateMutation.Type;

export class SidebarStateError extends Schema.TaggedErrorClass<SidebarStateError>()(
  "SidebarStateError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
