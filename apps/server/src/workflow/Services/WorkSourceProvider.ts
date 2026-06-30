import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { WorkSourceProviderName } from "@t3tools/contracts/workSource";

export class WorkSourceAuthError extends Schema.TaggedErrorClass<WorkSourceAuthError>()(
  "WorkSourceAuthError",
  { connectionRef: Schema.String },
) {}

export class WorkSourceRateLimitError extends Schema.TaggedErrorClass<WorkSourceRateLimitError>()(
  "WorkSourceRateLimitError",
  { retryAfterMs: Schema.Number },
) {}

export class WorkSourceTransientError extends Schema.TaggedErrorClass<WorkSourceTransientError>()(
  "WorkSourceTransientError",
  { message: Schema.String },
) {}

export class WorkSourceConfigError extends Schema.TaggedErrorClass<WorkSourceConfigError>()(
  "WorkSourceConfigError",
  { message: Schema.String },
) {}

export type WorkSourceProviderError =
  | WorkSourceAuthError
  | WorkSourceRateLimitError
  | WorkSourceTransientError
  | WorkSourceConfigError;

export interface ExternalWorkItem {
  readonly provider: WorkSourceProviderName;
  readonly externalId: string;
  readonly url: string;
  readonly lifecycle: "open" | "closed" | "deleted";
  readonly version: { readonly updatedAt?: string; readonly etag?: string };
  readonly fields: {
    readonly title: string;
    readonly description?: string;
    readonly assignees?: ReadonlyArray<string>;
    readonly labels?: ReadonlyArray<string>;
  };
}

export interface WorkSourcePage {
  readonly items: ReadonlyArray<ExternalWorkItem>;
  readonly nextPageToken?: string; // present => more pages remain
}

export interface Viewer {
  readonly id: string;
  readonly aliases: ReadonlyArray<string>; // comparable to ExternalWorkItem.fields.assignees of THIS provider
}

export interface ImportableViewParts {
  readonly displayRef: string; // "#82" (GitHub) | "" (Asana)
  readonly container: string; // "owner/repo" (GitHub) | projectGid (Asana)
}

export interface WorkSourceProvider {
  readonly provider: WorkSourceProviderName;
  readonly selectorSchema: Schema.Schema<any>; // PURE; used by synchronous lint
  readonly listPage: (input: {
    readonly connectionRef: string;
    readonly selector: unknown;
    readonly since?: string;
    readonly pageToken?: string;
    readonly pageSize: number;
  }) => Effect.Effect<WorkSourcePage, WorkSourceProviderError>;
  readonly getItem: (input: {
    readonly connectionRef: string;
    // The source's selector (provider-specific). GitHub needs owner/repo from
    // it to issue the single-issue lookup; Asana's gid is global so it ignores
    // this. A `null` result means the provider CONFIRMS deletion (404/gone); a
    // typed failure means "could not confirm" and must NOT be read as deleted.
    readonly selector: unknown;
    readonly externalId: string;
  }) => Effect.Effect<ExternalWorkItem | null, WorkSourceProviderError>;
  // writeBack?: FUTURE two-way seam — intentionally omitted in v1.

  // Best-effort "who am I" for the assigned-to-me filter. Returns null when the
  // provider cannot identify the viewer (filter then disabled for that source).
  readonly viewer: (input: {
    readonly connectionRef: string;
  }) => Effect.Effect<Viewer | null, WorkSourceProviderError>;

  // Pure formatting for a picker row. No I/O.
  readonly toImportableView: (input: {
    readonly selector: unknown;
    readonly item: ExternalWorkItem;
  }) => ImportableViewParts;
}

export interface WorkSourceProviderRegistryShape {
  readonly get: (provider: WorkSourceProviderName) => WorkSourceProvider;
}

export class WorkSourceProviderRegistry extends Context.Service<
  WorkSourceProviderRegistry,
  WorkSourceProviderRegistryShape
>()("t3/workflow/Services/WorkSourceProvider/WorkSourceProviderRegistry") {}

// Placeholder Context.Service tags for the two concrete providers.
// Tasks 4 and 5 provide Layer implementations for these exact tags.
export class GithubIssuesProvider extends Context.Service<
  GithubIssuesProvider,
  WorkSourceProvider
>()("t3/workflow/Services/WorkSourceProvider/GithubIssuesProvider") {}

export class AsanaProvider extends Context.Service<AsanaProvider, WorkSourceProvider>()(
  "t3/workflow/Services/WorkSourceProvider/AsanaProvider",
) {}

export class JiraProvider extends Context.Service<JiraProvider, WorkSourceProvider>()(
  "t3/workflow/Services/WorkSourceProvider/JiraProvider",
) {}
