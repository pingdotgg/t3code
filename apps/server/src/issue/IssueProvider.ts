import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  IssueAction,
  IssueAssigneeCandidateList,
  IssueCapabilities,
  IssueCloseReason,
  IssueComment,
  IssueEvent,
  IssueInvolvement,
  IssueListOrder,
  IssueListSort,
  IssueLabelCandidateList,
  IssueLinkedPullRequest,
  IssueReaction,
  IssueReactionContent,
  IssueListState,
  IssueState,
  IssueTemplateList,
  IssueViewerPermissions,
  IssueActor,
  IssueLabel,
  IssueProviderKind,
  OrchestrationProjectShell,
} from "@t3tools/contracts";
import { IssueProviderKind as IssueProviderKindSchema, issueSourceKey } from "@t3tools/contracts";

/**
 * The one failure shape every provider reports, so the service can decide what a failure means
 * without knowing which CLI or API produced it.
 *
 * `reason` is the part the service acts on: a missing or unauthenticated tool disables the
 * provider for the whole workspace, a switched-off tracker disables one repository, and anything
 * else is specific to the request.
 */
export class IssueProviderError extends Schema.TaggedErrorClass<IssueProviderError>()(
  "IssueProviderError",
  {
    provider: IssueProviderKindSchema,
    operation: Schema.String,
    reason: Schema.Literals(["missing-tool", "unauthenticated", "tracker-disabled", "failed"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

/** An issue as the provider sees it, before the service attaches project context. */
export interface ProviderIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: IssueActor | null;
  readonly state: IssueState;
  readonly stateReason: IssueCloseReason | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  readonly assignees: ReadonlyArray<IssueActor>;
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly milestone: string | null;
  readonly commentCount: number;
  readonly reactions?: ReadonlyArray<IssueReaction>;
}

export interface ProviderIssuePage {
  readonly items: ReadonlyArray<ProviderIssue>;
  /** True when the host has more rows than the page size asked for. */
  readonly truncated: boolean;
  /**
   * This page can be carried on from, so the service may hand the caller a cursor for it. False
   * where the host answered in an order a cursor means nothing in, which leaves a larger `limit`
   * as the only way to the rest.
   */
  readonly continues: boolean;
}

/**
 * Where a repository's next slice starts, as the provider that has to ask for it needs it. Built
 * by the service out of the slice it just handed over, so the boundary that decides whether a row
 * arrives twice or not at all is decided in one place rather than in four.
 */
export interface ProviderListCursor {
  /**
   * The instant of the oldest row already handed over, asked for inclusively: several rows share
   * one instant often enough that asking for strictly older would lose whichever of them the
   * slice ended before. The service drops the ones it has already sent.
   */
  readonly updatedBefore: string;
}

/** One repository's row inside an answer that spans several of them. */
export interface ProviderBatchedIssue extends ProviderIssue {
  /** Provider-native identity, exactly as it was asked for, so the caller can file the row. */
  readonly repository: string;
}

/**
 * One slice of a host read across several repositories at once, newest update first across all of
 * them. There is no per-repository page here because the host was asked one question: the caller
 * splits the rows by `repository` and works out where each of them carries on from.
 */
export interface ProviderBatchedIssuePage {
  readonly items: ReadonlyArray<ProviderBatchedIssue>;
  readonly truncated: boolean;
}

export interface ProviderIssueDetail extends ProviderIssue {
  readonly body: string;
  readonly linkedPullRequests: ReadonlyArray<IssueLinkedPullRequest>;
  readonly viewerPermissions: IssueViewerPermissions;
}

/** The conversation-shaped half of a detail, loaded after the core can already render. */
export interface ProviderIssueActivity {
  /** An optional richer actor, e.g. after a GraphQL read supplies an avatar the listing lacks. */
  readonly author?: IssueActor | null;
  readonly comments: ReadonlyArray<IssueComment>;
  /**
   * The host's own count of the conversation, which a bounded read can fall short of. A host that
   * reports no count of its own answers with what it handed over.
   */
  readonly commentCount: number;
  readonly commentsTruncated: boolean;
  readonly nextCommentsCursor?: string | null;
  readonly events: ReadonlyArray<IssueEvent>;
  readonly reactions?: ReadonlyArray<IssueReaction>;
}

export interface ProviderIssueCommentsPage {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly nextCursor: string | null;
}

export interface ProviderCreatedIssue {
  readonly number: number;
  readonly url: string;
}

export interface IssueProviderContext {
  readonly credentialId?: string;
}

export function issueProviderContextKey(
  provider: IssueProviderKind,
  host: string,
  credentialId?: string,
): string {
  return credentialId === undefined
    ? issueSourceKey(provider, host)
    : JSON.stringify([provider, host.toLowerCase(), credentialId]);
}

export interface ProviderRepositoryRef extends IssueProviderContext {
  readonly cwd: string;
  /** Provider-native repository identity, e.g. `owner/repo` or `group/subgroup/project`. */
  readonly repository: string;
  /**
   * The host it lives on, which `repository` deliberately leaves out — the same `owner/repo`
   * exists on github.com and on a GitHub Enterprise install, and only the caller knows which one
   * a project's remote points at.
   */
  readonly host: string;
}

export interface IssueAdapterSource extends IssueProviderContext {
  readonly host: string;
  readonly repository: string;
}

/**
 * One host's issues. Implementations own their own tool and JSON shapes and hand back the neutral
 * types above; anything a host cannot do is declared in `capabilities` rather than failing at call
 * time.
 */
export interface IssueAdapter {
  readonly kind: IssueProviderKind;
  readonly capabilities: IssueCapabilities;

  /**
   * Optional local project binding for adapters selected outside source control, such as a future
   * project-level Jira setting. Reads local settings only; it must not spend API calls.
   */
  readonly resolveSource?: (
    project: OrchestrationProjectShell,
  ) => Effect.Effect<IssueAdapterSource | null>;

  /** The signed-in account, which is what involvement filtering compares against. */
  readonly getViewer: (
    input: {
      readonly cwd: string;
      readonly host: string;
    } & IssueProviderContext,
  ) => Effect.Effect<string, IssueProviderError>;

  readonly listIssues: (
    input: ProviderRepositoryRef & {
      readonly state: IssueListState;
      readonly involvement: IssueInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly sort?: IssueListSort | undefined;
      readonly order?: IssueListOrder | undefined;
      /**
       * Free text to narrow the listing by, as the host understands it. A host with no text
       * filter of its own ignores it and answers with the page it would have answered anyway.
       */
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
    },
  ) => Effect.Effect<ProviderIssuePage, IssueProviderError>;

  /**
   * The same listing for a whole host in one request, for a host that has a search across
   * repositories. Optional: the caller falls back to `listIssues` per repository where this is
   * absent, and where it fails.
   */
  readonly listIssuesAcross?: (input: {
    /** Any checkout on the host, which is what the tool is run in. */
    readonly cwd: string;
    readonly host: string;
    readonly repositories: ReadonlyArray<string>;
    readonly state: IssueListState;
    readonly involvement: IssueInvolvement;
    readonly viewer: string;
    readonly limit: number;
    readonly sort?: IssueListSort | undefined;
    readonly order?: IssueListOrder | undefined;
    readonly query?: string | undefined;
    readonly cursor?: ProviderListCursor | undefined;
  }) => Effect.Effect<ProviderBatchedIssuePage, IssueProviderError>;

  readonly getIssue: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderIssueDetail, IssueProviderError>;

  /** Comments and state changes, kept off the critical path for the core detail. */
  readonly getIssueActivity: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<ProviderIssueActivity, IssueProviderError>;

  readonly getIssueComments?: (
    input: ProviderRepositoryRef & { readonly number: number; readonly cursor: string },
  ) => Effect.Effect<ProviderIssueCommentsPage, IssueProviderError>;

  /**
   * The same answer `getIssue` carries, on its own. Asked freshly before anything is written, so
   * a request that reached the server without going past the page is refused by what the host
   * says rather than by what the client claimed. Implementations read the cheapest thing that
   * answers it, which for a host with nothing to say is no request at all.
   */
  readonly getViewerPermissions: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<IssueViewerPermissions, IssueProviderError>;

  readonly runAction: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly action: IssueAction;
      /** Only passed for a close, and only where the host declared it takes one. */
      readonly reason?: IssueCloseReason | undefined;
    },
  ) => Effect.Effect<void, IssueProviderError>;

  readonly comment: (
    input: ProviderRepositoryRef & { readonly number: number; readonly body: string },
  ) => Effect.Effect<void, IssueProviderError>;

  readonly updateComment?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly commentId: string;
      readonly body: string;
    },
  ) => Effect.Effect<void, IssueProviderError>;

  readonly setReaction?: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: IssueReactionContent;
      readonly reacted: boolean;
    },
  ) => Effect.Effect<void, IssueProviderError>;

  /** Only called when `capabilities.create` is true. */
  readonly create: (
    input: ProviderRepositoryRef & {
      readonly title: string;
      readonly body: string;
      readonly labels: ReadonlyArray<string>;
      readonly assignees: ReadonlyArray<string>;
    },
  ) => Effect.Effect<ProviderCreatedIssue, IssueProviderError>;

  /** Only called when `capabilities.edit` is true, and never with both fields absent. */
  readonly update: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    },
  ) => Effect.Effect<void, IssueProviderError>;

  /** The whole set rather than a change to it, which is how every host here writes labels. */
  readonly setLabels: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
    },
  ) => Effect.Effect<void, IssueProviderError>;

  readonly setAssignees: (
    input: ProviderRepositoryRef & {
      readonly number: number;
      readonly assignees: ReadonlyArray<string>;
    },
  ) => Effect.Effect<void, IssueProviderError>;

  /** Only called when `capabilities.listLabelCandidates` is true. */
  readonly listLabelCandidates: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<IssueLabelCandidateList, IssueProviderError>;

  /** Only called when `capabilities.listAssigneeCandidates` is true. */
  readonly listAssigneeCandidates: (
    input: ProviderRepositoryRef & { readonly number: number },
  ) => Effect.Effect<IssueAssigneeCandidateList, IssueProviderError>;

  /**
   * What this repository offers as a starting point for a new issue. Optional and only called
   * when `capabilities.issueTemplates` is true, because a host with no such notion has nothing to
   * implement here rather than an empty list to return.
   */
  readonly listIssueTemplates?: (
    input: ProviderRepositoryRef,
  ) => Effect.Effect<IssueTemplateList, IssueProviderError>;
}
