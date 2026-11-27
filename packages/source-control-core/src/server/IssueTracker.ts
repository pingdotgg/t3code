/**
 * The port every issue tracker implements. A tracker hands back the neutral contract types and
 * declares what it cannot do in `capabilities`; the service refuses a call outside them.
 */
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type {
  IssueState,
  IssueCandidates,
  IssueCapabilities,
  IssueComment,
  IssueCommentsPage,
  IssueCreateResult,
  IssueEvent,
  IssueInvolvement,
  IssueListSort,
  IssueLinkedPullRequest,
  IssueListState,
  IssueReaction,
  IssueReactionContent,
  IssueSummary,
  IssueTemplateList,
  IssueTrackerKind,
  IssueTrackerScope,
  IssueViewerPermissions,
  StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import { IssueTrackerKind as IssueTrackerKindSchema } from "@t3tools/contracts";
import type { IssueLink } from "../shared/definition.ts";

/**
 * The one failure shape every tracker reports, so the service can decide what a failure means
 * without knowing which CLI or API produced it. A missing or unauthenticated tool disables the
 * tracker for the whole workspace; everything else is specific to the request.
 */
export class IssueTrackerError extends Schema.TaggedError<IssueTrackerError>()(
  "IssueTrackerError",
  {
    tracker: IssueTrackerKindSchema,
    operation: Schema.String,
    reason: Schema.Literals([
      "missing-tool",
      "unauthenticated",
      "rate-limited",
      "not-found",
      "failed",
    ]),
    detail: Schema.String,
    retryAt: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.tracker} failed in ${this.operation}: ${this.detail}`;
  }
}

/**
 * Where a tracker's issues are addressed from. `cwd` is a checkout whose credentials serve the
 * read; `host` is where the tracker is served from (`github.com`, a GHE install, `linear.app`);
 * `scope` is the tracker's own container — a repository path, a team or project key.
 */
export interface IssueScopeTarget {
  readonly cwd: string;
  readonly host: string;
  readonly scope: string;
}

export interface IssueTarget extends IssueScopeTarget {
  /** The issue's native id within the scope: `"123"` on GitHub, `"ENG-123"` on Linear. */
  readonly key: string;
}

/** An issue as the tracker sees it, before the service attaches project context. */
export type TrackerIssueSummary = Omit<IssueSummary, "tracker" | "host" | "scope">;
export type TrackerIssueLink = Pick<TrackerIssueSummary, "title" | "url" | "displayKey">;

export interface TrackerIssuePage {
  readonly items: ReadonlyArray<TrackerIssueSummary>;
  /** Where the next slice starts, or null once the tracker has nothing more. Opaque. */
  readonly nextCursor: string | null;
}

export interface TrackerIssueDetail extends TrackerIssueSummary {
  readonly body: string;
  readonly viewer: string | null;
  readonly viewerPermissions: IssueViewerPermissions;
  /** Every state the issue can be in, in workflow order; `setState` is asked for one by name. */
  readonly states: ReadonlyArray<IssueState>;
  readonly reactions?: ReadonlyArray<IssueReaction>;
  readonly comments: ReadonlyArray<IssueComment>;
  /** Where older comments carry on; null once the conversation is whole. */
  readonly commentsCursor: string | null;
  readonly events: ReadonlyArray<IssueEvent>;
  readonly linkedPullRequests: ReadonlyArray<IssueLinkedPullRequest>;
}

/**
 * Whose issues a listing keeps. Only a narrowed listing names the signed-in account it compares
 * against, so an `all` listing never has to read it.
 */
export type IssueInvolvementFilter =
  | { readonly involvement: "all" }
  | { readonly involvement: Exclude<IssueInvolvement, "all">; readonly viewer: string };

export interface IssueTrackerApi {
  readonly kind: IssueTrackerKind;
  readonly capabilities: IssueCapabilities;

  /** The signed-in account, which is what involvement filtering compares against. */
  readonly getViewer: (input: {
    readonly cwd: string;
    readonly host: string;
  }) => Effect.Effect<string, IssueTrackerError>;

  readonly listIssues: (
    input: IssueScopeTarget &
      IssueInvolvementFilter & {
        readonly state: IssueListState;
        readonly limit: number;
        /** Free text as the tracker understands it; ignored by a tracker without `search`. */
        readonly query?: string | undefined;
        /** Label names an issue must carry, every one of them. */
        readonly labels?: ReadonlyArray<string> | undefined;
        /** The `login` of an assignee, as this tracker's own issues name them. */
        readonly assignee?: string | undefined;
        readonly sort: IssueListSort;
        /** A cursor this tracker handed back from an earlier page. Absent asks for the first. */
        readonly cursor?: string | undefined;
        /** Whether to re-read tracker metadata for a first page. */
        readonly refresh?: boolean | undefined;
      },
  ) => Effect.Effect<TrackerIssuePage, IssueTrackerError>;

  /** The issue with its first page of conversation, in one read where the tracker allows. */
  readonly getIssue: (input: IssueTarget) => Effect.Effect<TrackerIssueDetail, IssueTrackerError>;

  /** Confirms an issue exists and names it for a thread link. */
  readonly getIssueLink?: (
    input: IssueTarget,
  ) => Effect.Effect<TrackerIssueLink, IssueTrackerError>;

  /** One page of older comments past a cursor `getIssue` or a previous page handed over. */
  readonly getComments: (
    input: IssueTarget & { readonly cursor: string },
  ) => Effect.Effect<IssueCommentsPage, IssueTrackerError>;

  /** Only called when `capabilities.create` is true. */
  readonly create?: (
    input: IssueScopeTarget & {
      readonly title: string;
      readonly body: string;
      readonly labels: ReadonlyArray<string>;
      readonly assignees: ReadonlyArray<string>;
    },
  ) => Effect.Effect<IssueCreateResult, IssueTrackerError>;

  /** Only called when `capabilities.comment` is true. */
  readonly comment?: (
    input: IssueTarget & { readonly body: string },
  ) => Effect.Effect<void, IssueTrackerError>;

  /**
   * Rewrites the present fields. Only called with a field the tracker declared it can write
   * (`edit` for title and body, `labels`, `assignees`), and never with all of them absent.
   */
  readonly update?: (
    input: IssueTarget & {
      readonly title?: string | undefined;
      readonly body?: string | undefined;
      readonly labels?: ReadonlyArray<string> | undefined;
      readonly assignees?: ReadonlyArray<string> | undefined;
    },
  ) => Effect.Effect<void, IssueTrackerError>;

  /**
   * Moves the issue to the state `getIssue` listed under that name, and refuses any other: the
   * name comes from a client, so the tracker is what proves it.
   */
  readonly setState?: (
    input: IssueTarget & { readonly state: string },
  ) => Effect.Effect<void, IssueTrackerError>;

  /**
   * Adds a reaction or takes it back. `subjectId` is a comment id as the detail carried it;
   * absent means the issue itself. Only called when `capabilities.reactions` is true.
   */
  readonly setReaction?: (
    input: IssueTarget & {
      readonly subjectId?: string | undefined;
      readonly content: IssueReactionContent;
      readonly reacted: boolean;
    },
  ) => Effect.Effect<void, IssueTrackerError>;

  /** Only called when `capabilities.templates` is true. */
  readonly listTemplates?: (
    input: IssueScopeTarget,
  ) => Effect.Effect<IssueTemplateList, IssueTrackerError>;

  /** Only called when `capabilities.labels` or `capabilities.assignees` is true. */
  readonly listCandidates?: (
    input: IssueScopeTarget,
  ) => Effect.Effect<IssueCandidates, IssueTrackerError>;
}

/** What a user saved to reach a standalone tracker: the secret, and the descriptor's fields. */
export interface IssueTrackerCredential {
  readonly token: string;
  readonly fields: Readonly<Record<string, string>>;
}

/**
 * A tracker reached with its own credential rather than a checkout's: Linear, Jira. The server
 * stores one credential per kind and offers the connect flow from `standalone`; a project reads
 * the tracker by binding one of the scopes `probeCredential` lists. The `cwd` on every target is
 * then only the project's root, which such a tracker ignores.
 */
export interface StandaloneIssueTrackerApi extends IssueTrackerApi {
  readonly standalone: StandaloneIssueTrackerDescriptor;
  /** Retains the workspace identity so canonical URLs can disambiguate repeated scope keys. */
  readonly parseIssueUrl: (url: URL) => (IssueLink & { readonly workspace: string }) | null;
  /**
   * Who a credential signs in as and which scopes it reaches, asked of the tracker itself. Run on
   * a credential before it is stored, and on the stored one to report connection status.
   */
  readonly probeCredential: (credential: IssueTrackerCredential) => Effect.Effect<
    {
      readonly account: string;
      /** What the tracker's issue URLs name the credential's workspace by, where they name one. */
      readonly workspace?: string | undefined;
      readonly scopes: ReadonlyArray<IssueTrackerScope>;
    },
    IssueTrackerError
  >;
}

export function isStandaloneIssueTracker(api: IssueTrackerApi): api is StandaloneIssueTrackerApi {
  return "standalone" in api;
}
