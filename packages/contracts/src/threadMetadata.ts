import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ExecutionEnvironmentPlatform } from "./environment.ts";
import { ModelCapabilities, ProviderOptionSelectionValue } from "./model.ts";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ThreadMetadataField = Schema.Literals([
  "id",
  "name",
  "project",
  "runtime",
  "provider",
  "model",
  "serviceTier",
  "reasoningEffort",
  "daybreak",
  "host",
  "environment",
]);
export type ThreadMetadataField = typeof ThreadMetadataField.Type;

export const GetThreadMetadataInput = Schema.Struct({
  fields: Schema.optional(
    Schema.Array(ThreadMetadataField).annotate({
      description:
        "Return only these fields. Omit for all metadata; an empty array returns an empty object.",
    }),
  ),
});

const SelectionValue = Schema.Struct({
  saved: Schema.NullOr(ProviderOptionSelectionValue),
  requested: Schema.NullOr(ProviderOptionSelectionValue),
  providerConfirmed: Schema.Null,
});

export const ThreadMetadata = Schema.Struct({
  id: Schema.optional(ThreadId),
  name: Schema.optional(Schema.String),
  project: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: ProjectId,
        name: Schema.String,
        workspaceRoot: Schema.String,
      }),
    ),
  ),
  runtime: Schema.optional(
    Schema.Struct({
      branch: Schema.NullOr(Schema.String),
      worktreePath: Schema.NullOr(Schema.String),
      cwd: Schema.NullOr(Schema.String),
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
      sessionStatus: Schema.NullOr(Schema.String),
    }),
  ),
  provider: Schema.optional(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      kind: Schema.NullOr(ProviderDriverKind),
      name: Schema.NullOr(Schema.String),
    }),
  ),
  model: Schema.optional(
    Schema.Struct({
      savedSelection: ModelSelection,
      requestedSelection: Schema.NullOr(ModelSelection),
      catalog: Schema.NullOr(
        Schema.Struct({
          slug: Schema.String,
          name: Schema.String,
          capabilities: Schema.NullOr(ModelCapabilities),
        }),
      ),
      providerConfirmed: Schema.Null,
    }),
  ),
  serviceTier: Schema.optional(SelectionValue),
  reasoningEffort: Schema.optional(SelectionValue),
  daybreak: Schema.optional(
    Schema.Struct({
      access: Schema.Literals(["available", "unavailable", "unknown", "unsupported"]),
      availablePrograms: Schema.NullOr(Schema.Array(Schema.String)),
      saved: Schema.NullOr(ProviderOptionSelectionValue),
      requested: Schema.NullOr(ProviderOptionSelectionValue),
      providerConfirmed: Schema.Null,
    }),
  ),
  host: Schema.optional(
    Schema.Struct({
      hostname: Schema.String,
      platform: ExecutionEnvironmentPlatform,
    }),
  ),
  environment: Schema.optional(
    Schema.Struct({
      id: EnvironmentId,
      name: Schema.String,
      serverVersion: Schema.String,
    }),
  ),
});
export type ThreadMetadata = typeof ThreadMetadata.Type;

export const SetThreadNameInput = Schema.Struct({ name: TrimmedNonEmptyString });
export const SetThreadNameResult = Schema.Struct({ id: ThreadId, name: TrimmedNonEmptyString });

export class ThreadMetadataNotFoundError extends Schema.TaggedError<ThreadMetadataNotFoundError>()(
  "ThreadMetadataNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The current thread was not found.";
  }
}

export class ThreadMetadataReadError extends Schema.TaggedError<ThreadMetadataReadError>()(
  "ThreadMetadataReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the current thread.";
  }
}

export class ThreadMetadataRenameError extends Schema.TaggedError<ThreadMetadataRenameError>()(
  "ThreadMetadataRenameError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not rename the current thread.";
  }
}
