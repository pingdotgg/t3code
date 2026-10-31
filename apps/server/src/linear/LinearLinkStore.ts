import { LinearIssueLink, type LinearCommentMode } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class LinearStoreError extends Schema.TaggedError<LinearStoreError>()("LinearStoreError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** A link as stored: the contract fields plus what the server needs to keep comments current. */
export interface StoredLink {
  readonly link: LinearIssueLink;
  readonly threadUrl: string;
  /** Hash of the last comment body written, so unchanged pipeline state costs no API call. */
  readonly commentBodyHash: string | null;
}

export interface NewLinearLink {
  readonly linkId: string;
  readonly issueId: string;
  readonly issueIdentifier: string;
  readonly teamId: string;
  readonly projectId: string | null;
  readonly targetKind: LinearIssueLink["targetKind"];
  readonly targetId: string;
  readonly threadId: string;
  readonly createdAt: string;
  readonly commentMode: LinearCommentMode;
  readonly threadUrl: string;
  readonly environmentId?: string | null;
}

interface LinkRow {
  readonly link_id: string;
  readonly issue_id: string;
  readonly issue_identifier: string;
  readonly team_id: string;
  readonly project_id: string | null;
  readonly target_kind: string;
  readonly target_id: string;
  readonly thread_id: string;
  readonly created_at: string;
  readonly comment_id: string | null;
  readonly comment_mode: string;
  readonly state_moved_to: string | null;
  readonly thread_url: string;
  readonly comment_body_hash: string | null;
  readonly environment_id: string | null;
}

const decodeLink = Schema.decodeUnknownEffect(LinearIssueLink);

const toStoredLink = (row: LinkRow) =>
  decodeLink({
    linkId: row.link_id,
    issueId: row.issue_id,
    issueIdentifier: row.issue_identifier,
    teamId: row.team_id,
    projectId: row.project_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    threadId: row.thread_id,
    createdAt: row.created_at,
    commentId: row.comment_id,
    commentMode: row.comment_mode,
    stateMovedTo: row.state_moved_to,
    environmentId: row.environment_id,
  }).pipe(
    Effect.map((link): StoredLink => ({
      link,
      threadUrl: row.thread_url,
      commentBodyHash: row.comment_body_hash,
    })),
  );

export class LinearLinkStore extends Context.Service<
  LinearLinkStore,
  {
    /** Inserts the link or returns the existing one for (issue, target); never overwrites it. */
    readonly upsert: (link: NewLinearLink) => Effect.Effect<StoredLink, LinearStoreError>;
    readonly get: (linkId: string) => Effect.Effect<StoredLink | null, LinearStoreError>;
    /** Newest first; rows that no longer decode are skipped. */
    readonly list: (limit: number) => Effect.Effect<ReadonlyArray<StoredLink>, LinearStoreError>;
    readonly listByCommentMode: (
      mode: LinearCommentMode,
      createdAfter: string,
    ) => Effect.Effect<ReadonlyArray<StoredLink>, LinearStoreError>;
    readonly recordStateMove: (
      linkId: string,
      stateId: string,
    ) => Effect.Effect<void, LinearStoreError>;
    readonly recordComment: (
      linkId: string,
      commentId: string,
      bodyHash: string,
    ) => Effect.Effect<void, LinearStoreError>;
    readonly recordBodyHash: (
      linkId: string,
      bodyHash: string,
    ) => Effect.Effect<void, LinearStoreError>;
  }
>()("t3/linear/LinearLinkStore") {}

const storage =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, LinearStoreError, R> =>
    effect.pipe(Effect.mapError((cause) => new LinearStoreError({ message, cause })));

export const layer: Layer.Layer<LinearLinkStore, never, SqlClient.SqlClient> = Layer.effect(
  LinearLinkStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const decodeRows = (rows: ReadonlyArray<LinkRow>) =>
      Effect.forEach(rows, (row) =>
        toStoredLink(row).pipe(
          Effect.option,
          Effect.tap((decoded) =>
            Option.isNone(decoded)
              ? Effect.logWarning("Skipping undecodable Linear link", { linkId: row.link_id })
              : Effect.void,
          ),
        ),
      ).pipe(Effect.map((entries) => entries.flatMap((entry) => Option.toArray(entry))));

    const selectOne = (linkId: string) =>
      sql<LinkRow>`SELECT * FROM linear_issue_links WHERE link_id = ${linkId}`;

    return LinearLinkStore.of({
      upsert: Effect.fn("LinearLinkStore.upsert")(function* (link) {
        yield* sql`
          INSERT INTO linear_issue_links (
            link_id, issue_id, issue_identifier, team_id, project_id, target_kind, target_id,
            thread_id, created_at, comment_mode, thread_url, environment_id
          ) VALUES (
            ${link.linkId}, ${link.issueId}, ${link.issueIdentifier}, ${link.teamId},
            ${link.projectId}, ${link.targetKind}, ${link.targetId}, ${link.threadId},
            ${link.createdAt}, ${link.commentMode}, ${link.threadUrl}, ${link.environmentId ?? null}
          )
          ON CONFLICT (issue_id, target_kind, target_id) DO NOTHING
        `.pipe(storage("Could not save the Linear link."));
        const rows = yield* sql<LinkRow>`
          SELECT * FROM linear_issue_links
          WHERE issue_id = ${link.issueId}
            AND target_kind = ${link.targetKind}
            AND target_id = ${link.targetId}
        `.pipe(storage("Could not read the Linear link."));
        const row = rows[0];
        if (row === undefined) {
          return yield* new LinearStoreError({ message: "The Linear link was not saved." });
        }
        return yield* toStoredLink(row).pipe(storage("Could not decode the Linear link."));
      }),
      get: Effect.fn("LinearLinkStore.get")(function* (linkId) {
        const rows = yield* selectOne(linkId).pipe(
          NodeSqliteClient.readOnly,
          storage("Could not read the Linear link."),
        );
        const row = rows[0];
        return row === undefined
          ? null
          : yield* toStoredLink(row).pipe(storage("Could not decode the Linear link."));
      }),
      list: Effect.fn("LinearLinkStore.list")(function* (limit) {
        const rows = yield* sql<LinkRow>`
          SELECT * FROM linear_issue_links ORDER BY created_at DESC, link_id DESC LIMIT ${limit}
        `.pipe(NodeSqliteClient.readOnly, storage("Could not read Linear links."));
        return yield* decodeRows(rows);
      }),
      listByCommentMode: Effect.fn("LinearLinkStore.listByCommentMode")(
        function* (mode, createdAfter) {
          const rows = yield* sql<LinkRow>`
          SELECT * FROM linear_issue_links
          WHERE comment_mode = ${mode} AND created_at >= ${createdAfter}
          ORDER BY created_at ASC
        `.pipe(NodeSqliteClient.readOnly, storage("Could not read Linear links."));
          return yield* decodeRows(rows);
        },
      ),
      recordStateMove: Effect.fn("LinearLinkStore.recordStateMove")(function* (linkId, stateId) {
        yield* sql`
          UPDATE linear_issue_links SET state_moved_to = ${stateId} WHERE link_id = ${linkId}
        `.pipe(storage("Could not update the Linear link."));
      }),
      recordComment: Effect.fn("LinearLinkStore.recordComment")(
        function* (linkId, commentId, bodyHash) {
          yield* sql`
          UPDATE linear_issue_links
          SET comment_id = ${commentId}, comment_body_hash = ${bodyHash}
          WHERE link_id = ${linkId}
        `.pipe(storage("Could not update the Linear link."));
        },
      ),
      recordBodyHash: Effect.fn("LinearLinkStore.recordBodyHash")(function* (linkId, bodyHash) {
        yield* sql`
          UPDATE linear_issue_links SET comment_body_hash = ${bodyHash} WHERE link_id = ${linkId}
        `.pipe(storage("Could not update the Linear link."));
      }),
    });
  }),
);
