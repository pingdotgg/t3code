import {
  DEFAULT_UPSTREAM_CLIENT_THREAD_VISIBILITY,
  TEAM_CLIENT_CAPABILITY_HEADER,
  TEAM_CLIENT_CAPABILITY_QUERY_PARAM,
  TEAM_CLIENT_CAPABILITY_VALUE,
  TeamId,
  TeamMemberId,
  type AuthEnvironmentScope,
  type AuthSessionId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2SearchThreadsResult,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadLinkMetadata,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type TeamUpstreamClientThreadVisibility,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Pure prefix context designed so Milestone 8's team-owned threads (`ownerKind === "team"`,
 * `teamDisplayName`) plug in without changing call sites or callers.
 */
export interface TeamThreadTitlePrefixContext {
  readonly ownerKind?: "member" | "team";
  readonly creatorPseudo?: string | null;
  readonly teamDisplayName?: string | null;
}

export interface TeamPairingMetaRecord {
  readonly pairingLinkId: string;
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

/**
 * Forked web/desktop clients advertise team awareness via `X-T3-Teams-Client: 1` (HTTP) or
 * `?t3TeamsClient=1` (WebSocket upgrade). Unmodified upstream clients (such as the official iOS/Android
 * mobile app or upstream `app.t3.codes`) omit both, automatically activating server-side compatibility mode.
 */
export function isTeamAwareClientRequest(
  request: { readonly headers: Readonly<Record<string, string | undefined>> },
  url?: URL | null,
): boolean {
  const headerValue = request.headers[TEAM_CLIENT_CAPABILITY_HEADER];
  if (typeof headerValue === "string" && headerValue.trim() === TEAM_CLIENT_CAPABILITY_VALUE) {
    return true;
  }
  const queryValue = url?.searchParams.get(TEAM_CLIENT_CAPABILITY_QUERY_PARAM);
  return queryValue === TEAM_CLIENT_CAPABILITY_VALUE;
}

export function resolveTeamThreadTitlePrefix(
  context: TeamThreadTitlePrefixContext | null | undefined,
): string | null {
  if (!context) return null;
  const raw =
    context.ownerKind === "team"
      ? context.teamDisplayName
      : (context.creatorPseudo ?? context.teamDisplayName);
  const trimmed = raw?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function hasLeadingPrefixColon(value: string, prefix: string, lowerPrefix: string): boolean {
  return (
    value.length > prefix.length &&
    value[prefix.length] === ":" &&
    value.slice(0, prefix.length).toLowerCase() === lowerPrefix
  );
}

/**
 * Dynamically formats a thread title for non-team-aware clients (`<creatorPseudo>: <title>` or
 * `<teamDisplayName>: <title>`) without mutating SQLite. Avoids double-prefixing if the raw title
 * already starts with the exact prefix.
 */
export function formatUpstreamCompatThreadTitle(
  rawTitle: string,
  context: TeamThreadTitlePrefixContext | null | undefined,
): string {
  const prefix = resolveTeamThreadTitlePrefix(context);
  if (prefix === null) return rawTitle;
  const expectedPrefix = `${prefix}: `;
  if (rawTitle.startsWith(expectedPrefix)) {
    return rawTitle;
  }
  const lowerPrefix = prefix.toLowerCase();
  if (hasLeadingPrefixColon(rawTitle, prefix, lowerPrefix)) {
    const rest = rawTitle.slice(prefix.length + 1).trimStart();
    if (rest.length === 0) {
      return `${prefix}:`;
    }
    return `${expectedPrefix}${rest}`;
  }
  return `${expectedPrefix}${rawTitle}`;
}

/**
 * Strips one or more matching leading `<prefix>:` segments when a non-team-aware client renames a
 * thread so SQLite keeps the clean raw title and repeated renames never produce `alice: alice: ...`.
 * Leaves unrelated prefixes (e.g. `fix: ...` or `bob: ...` on Alice's thread) untouched and never
 * strips down to an empty string.
 */
export function stripUpstreamCompatThreadTitlePrefix(
  incomingTitle: string,
  context: TeamThreadTitlePrefixContext | null | undefined,
): string {
  const prefix = resolveTeamThreadTitlePrefix(context);
  if (prefix === null) return incomingTitle;
  let current = incomingTitle.trim();
  const lowerPrefix = prefix.toLowerCase();
  while (hasLeadingPrefixColon(current, prefix, lowerPrefix)) {
    const remainder = current.slice(prefix.length + 1).trimStart();
    if (remainder.length === 0) {
      break;
    }
    current = remainder;
  }
  return current;
}

export function formatUpstreamCompatLocalEnvironmentBlockedMessage(
  environmentLabel: string,
): string {
  return `Cannot run turns on "${environmentLabel}" from this client. Local-environment threads run exclusively on their owner's machine. Open T3 Code on Desktop or Web to leave a Note or fork this thread onto an accessible environment.`;
}

export function formatUpstreamCompatRemoteEnvironmentBlockedMessage(
  environmentLabel: string,
): string {
  return `You do not have permission to run turns on environment "${environmentLabel}". Open T3 Code on Desktop or Web to leave a Note or fork this thread onto an accessible environment.`;
}

export function formatUpstreamCompatLockedThreadBlockedMessage(): string {
  return "This thread is locked. Only team owners and admins can post in it.";
}

export function formatUpstreamCompatReadOnlyViewBlockedMessage(): string {
  return "You have read-only access to this view and cannot post in colleagues' threads.";
}

export interface UpstreamCompatTitleLookup {
  readonly isTeamConfigured: () => Effect.Effect<boolean>;
  readonly getThreadTitlePrefixContextMap: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyMap<ThreadId, TeamThreadTitlePrefixContext>>;
  readonly filterVisibleShellThreadIds: (
    sessionId: AuthSessionId,
    threadIds: ReadonlyArray<ThreadId>,
    options?: { readonly upstreamCompat?: boolean },
  ) => Effect.Effect<ReadonlySet<ThreadId>>;
  readonly canShowThreadInShell: (
    sessionId: AuthSessionId,
    threadId: ThreadId,
    options?: { readonly upstreamCompat?: boolean },
  ) => Effect.Effect<boolean>;
}

const THREAD_APP_PAYLOAD_EVENT_TYPES = new Set<OrchestrationV2DomainEvent["type"]>([
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.pinned",
  "thread.auto-settle-set",
  "thread.unpinned",
  "thread.pin-reordered",
  "thread.active-reordered",
  "thread.tags-updated",
  "thread.visited",
  "thread.marked-unread",
  "thread.pull-request-synced",
  "thread.issue-synced",
  "thread.metadata-updated",
  "thread.runtime-mode-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
  "thread.guest-share-updated",
]);

function prefixThreadShell(
  shell: OrchestrationV2ThreadShell,
  prefixByThreadId: ReadonlyMap<ThreadId, TeamThreadTitlePrefixContext>,
): OrchestrationV2ThreadShell {
  const ctx = prefixByThreadId.get(shell.id);
  if (!ctx) return shell;
  const nextTitle = formatUpstreamCompatThreadTitle(shell.title, ctx);
  return nextTitle === shell.title ? shell : { ...shell, title: nextTitle };
}

function prefixAppThread(
  thread: OrchestrationV2AppThread,
  ctx: TeamThreadTitlePrefixContext | undefined,
): OrchestrationV2AppThread {
  if (!ctx) return thread;
  const nextTitle = formatUpstreamCompatThreadTitle(thread.title, ctx);
  return nextTitle === thread.title ? thread : { ...thread, title: nextTitle };
}

export const adaptThreadShellsForUpstreamCompat = Effect.fn(
  "UpstreamMobileCompat.adaptThreadShells",
)(function* (
  lookup: UpstreamCompatTitleLookup,
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  upstreamCompat: boolean,
): Effect.fn.Return<ReadonlyArray<OrchestrationV2ThreadShell>> {
  if (!upstreamCompat || threads.length === 0 || !(yield* lookup.isTeamConfigured())) {
    return threads;
  }
  const prefixByThreadId = yield* lookup.getThreadTitlePrefixContextMap(
    threads.map((thread) => thread.id),
  );
  if (prefixByThreadId.size === 0) return threads;
  return threads.map((thread) => prefixThreadShell(thread, prefixByThreadId));
});

export const adaptShellSnapshotForUpstreamCompat = Effect.fn(
  "UpstreamMobileCompat.adaptShellSnapshot",
)(function* (
  lookup: UpstreamCompatTitleLookup,
  sessionId: AuthSessionId,
  snapshot: OrchestrationV2ShellSnapshot,
  upstreamCompat: boolean,
): Effect.fn.Return<OrchestrationV2ShellSnapshot> {
  if (!(yield* lookup.isTeamConfigured())) {
    return snapshot;
  }
  const allIds = [
    ...snapshot.threads.map((thread) => thread.id),
    ...snapshot.archivedThreads.map((thread) => thread.id),
  ];
  const visibleIds = yield* lookup.filterVisibleShellThreadIds(sessionId, allIds, {
    upstreamCompat,
  });
  const visibleThreads = snapshot.threads.filter((thread) => visibleIds.has(thread.id));
  const visibleArchived = snapshot.archivedThreads.filter((thread) => visibleIds.has(thread.id));
  if (!upstreamCompat) {
    return {
      ...snapshot,
      threads: visibleThreads,
      archivedThreads: visibleArchived,
    };
  }
  const prefixByThreadId = yield* lookup.getThreadTitlePrefixContextMap([
    ...visibleThreads.map((thread) => thread.id),
    ...visibleArchived.map((thread) => thread.id),
  ]);
  return {
    ...snapshot,
    threads: visibleThreads.map((thread) => prefixThreadShell(thread, prefixByThreadId)),
    archivedThreads: visibleArchived.map((thread) => prefixThreadShell(thread, prefixByThreadId)),
  };
});

export const adaptShellStreamItemForUpstreamCompat = Effect.fn(
  "UpstreamMobileCompat.adaptShellStreamItem",
)(function* (
  lookup: UpstreamCompatTitleLookup,
  sessionId: AuthSessionId,
  item: OrchestrationV2ShellStreamItem,
  upstreamCompat: boolean,
): Effect.fn.Return<OrchestrationV2ShellStreamItem | null> {
  if (item.kind === "snapshot") {
    if (item.snapshot.threads.length === 0 && item.snapshot.archivedThreads.length === 0) {
      return item;
    }
    const adapted = yield* adaptShellSnapshotForUpstreamCompat(
      lookup,
      sessionId,
      item.snapshot,
      upstreamCompat,
    );
    return { ...item, snapshot: adapted };
  }
  if (item.kind === "thread.updated") {
    const visible = yield* lookup.canShowThreadInShell(sessionId, item.thread.id, {
      upstreamCompat,
    });
    if (!visible) return null;
    if (!upstreamCompat) return item;
    const prefixByThreadId = yield* lookup.getThreadTitlePrefixContextMap([item.thread.id]);
    const nextThread = prefixThreadShell(item.thread, prefixByThreadId);
    return nextThread === item.thread ? item : { ...item, thread: nextThread };
  }
  if (item.kind === "thread.removed") {
    const visible = yield* lookup.canShowThreadInShell(sessionId, item.threadId, {
      upstreamCompat,
    });
    return visible ? item : null;
  }
  return item;
});

export const adaptThreadProjectionForUpstreamCompat = Effect.fn(
  "UpstreamMobileCompat.adaptThreadProjection",
)(function* (
  lookup: UpstreamCompatTitleLookup,
  projection: OrchestrationV2ThreadProjection,
  upstreamCompat: boolean,
): Effect.fn.Return<OrchestrationV2ThreadProjection> {
  if (!upstreamCompat || !(yield* lookup.isTeamConfigured())) {
    return projection;
  }
  const prefixByThreadId = yield* lookup.getThreadTitlePrefixContextMap([projection.thread.id]);
  const nextThread = prefixAppThread(projection.thread, prefixByThreadId.get(projection.thread.id));
  return nextThread === projection.thread ? projection : { ...projection, thread: nextThread };
});

export const adaptThreadStreamItemForUpstreamCompat = Effect.fn(
  "UpstreamMobileCompat.adaptThreadStreamItem",
)(function* (
  lookup: UpstreamCompatTitleLookup,
  item: OrchestrationV2ThreadStreamItem,
  upstreamCompat: boolean,
): Effect.fn.Return<OrchestrationV2ThreadStreamItem> {
  if (!upstreamCompat || !(yield* lookup.isTeamConfigured())) {
    return item;
  }
  if (item.kind === "snapshot") {
    const nextProjection = yield* adaptThreadProjectionForUpstreamCompat(
      lookup,
      item.projection,
      upstreamCompat,
    );
    return nextProjection === item.projection ? item : { ...item, projection: nextProjection };
  }
  if (item.kind === "event" && THREAD_APP_PAYLOAD_EVENT_TYPES.has(item.event.type)) {
    const payload = item.event.payload as OrchestrationV2AppThread;
    const prefixByThreadId = yield* lookup.getThreadTitlePrefixContextMap([payload.id]);
    const nextPayload = prefixAppThread(payload, prefixByThreadId.get(payload.id));
    if (nextPayload === payload) return item;
    return {
      ...item,
      event: {
        ...item.event,
        payload: nextPayload,
      } as OrchestrationV2DomainEvent,
    };
  }
  return item;
});

export const adaptSearchThreadsResultForUpstreamCompat = Effect.fn(
  "UpstreamMobileCompat.adaptSearchThreadsResult",
)(function* (
  lookup: UpstreamCompatTitleLookup,
  result: OrchestrationV2SearchThreadsResult,
  upstreamCompat: boolean,
): Effect.fn.Return<OrchestrationV2SearchThreadsResult> {
  if (!upstreamCompat || !result.threads || result.threads.length === 0) {
    return result;
  }
  const adaptedThreads = yield* adaptThreadShellsForUpstreamCompat(
    lookup,
    result.threads,
    upstreamCompat,
  );
  return adaptedThreads === result.threads ? result : { ...result, threads: adaptedThreads };
});

export const adaptThreadTitlesForUpstreamCompat = Effect.fn(
  "UpstreamMobileCompat.adaptThreadTitles",
)(function* (
  lookup: UpstreamCompatTitleLookup,
  titles: Record<ThreadId, string>,
  upstreamCompat: boolean,
): Effect.fn.Return<Record<ThreadId, string>> {
  const keys = Object.keys(titles) as Array<ThreadId>;
  if (!upstreamCompat || keys.length === 0 || !(yield* lookup.isTeamConfigured())) {
    return titles;
  }
  const prefixByThreadId = yield* lookup.getThreadTitlePrefixContextMap(keys);
  if (prefixByThreadId.size === 0) return titles;
  const adapted = {} as Record<ThreadId, string>;
  for (const key of keys) {
    adapted[key] = formatUpstreamCompatThreadTitle(titles[key]!, prefixByThreadId.get(key));
  }
  return adapted;
});

export const adaptThreadLinkMetadataForUpstreamCompat = Effect.fn(
  "UpstreamMobileCompat.adaptThreadLinkMetadata",
)(function* (
  lookup: UpstreamCompatTitleLookup,
  metadata: Record<ThreadId, OrchestrationV2ThreadLinkMetadata>,
  upstreamCompat: boolean,
): Effect.fn.Return<Record<ThreadId, OrchestrationV2ThreadLinkMetadata>> {
  const keys = Object.keys(metadata) as Array<ThreadId>;
  if (!upstreamCompat || keys.length === 0 || !(yield* lookup.isTeamConfigured())) {
    return metadata;
  }
  const prefixByThreadId = yield* lookup.getThreadTitlePrefixContextMap(keys);
  if (prefixByThreadId.size === 0) return metadata;
  const adapted = {} as Record<ThreadId, OrchestrationV2ThreadLinkMetadata>;
  for (const key of keys) {
    const entry = metadata[key]!;
    adapted[key] = {
      ...entry,
      title: formatUpstreamCompatThreadTitle(entry.title, prefixByThreadId.get(key)),
    };
  }
  return adapted;
});

export const stripTitlePrefixOnCompatCommand = Effect.fn(
  "UpstreamMobileCompat.stripTitlePrefixOnCompatCommand",
)(function* (
  lookup: Pick<UpstreamCompatTitleLookup, "isTeamConfigured" | "getThreadTitlePrefixContextMap">,
  command: OrchestrationV2Command,
  upstreamCompat: boolean,
): Effect.fn.Return<OrchestrationV2Command> {
  if (!upstreamCompat || !(yield* lookup.isTeamConfigured())) {
    return command;
  }
  if (command.type === "thread.metadata.update" && command.title !== undefined) {
    const prefixByThreadId = yield* lookup.getThreadTitlePrefixContextMap([command.threadId]);
    const cleaned = stripUpstreamCompatThreadTitlePrefix(
      command.title,
      prefixByThreadId.get(command.threadId),
    );
    return cleaned === command.title ? command : { ...command, title: cleaned };
  }
  if (command.type === "thread.fork" && command.title !== undefined) {
    const prefixByThreadId = yield* lookup.getThreadTitlePrefixContextMap([command.sourceThreadId]);
    const cleaned = stripUpstreamCompatThreadTitlePrefix(
      command.title,
      prefixByThreadId.get(command.sourceThreadId),
    );
    return cleaned === command.title ? command : { ...command, title: cleaned };
  }
  return command;
});

interface PairingMetaRow {
  readonly pairing_link_id: string;
  readonly team_id: string;
  readonly member_id: string;
  readonly created_at: string;
  readonly revoked_at: string | null;
}

interface MemberPreferenceRow {
  readonly upstream_client_thread_visibility: TeamUpstreamClientThreadVisibility;
}

interface SessionScopeCeilingRow {
  readonly max_scopes_json: string;
}

export const upsertTeamPairingMeta = (
  sql: SqlClient.SqlClient,
  input: Omit<TeamPairingMetaRecord, "revokedAt">,
) => sql`
  INSERT INTO team_pairing_meta (pairing_link_id, team_id, member_id, created_at, revoked_at)
  VALUES (${input.pairingLinkId}, ${input.teamId}, ${input.memberId}, ${input.createdAt}, NULL)
  ON CONFLICT(pairing_link_id) DO UPDATE SET
    team_id = excluded.team_id,
    member_id = excluded.member_id,
    created_at = excluded.created_at,
    revoked_at = NULL
`;

export const getTeamPairingMeta = (sql: SqlClient.SqlClient, pairingLinkId: string) =>
  sql<PairingMetaRow>`
    SELECT pairing_link_id, team_id, member_id, created_at, revoked_at
    FROM team_pairing_meta
    WHERE pairing_link_id = ${pairingLinkId}
    LIMIT 1
  `.pipe(
    Effect.map((rows) =>
      rows[0]
        ? Option.some<TeamPairingMetaRecord>({
            pairingLinkId: rows[0].pairing_link_id,
            teamId: TeamId.make(rows[0].team_id),
            memberId: TeamMemberId.make(rows[0].member_id),
            createdAt: rows[0].created_at,
            revokedAt: rows[0].revoked_at,
          })
        : Option.none<TeamPairingMetaRecord>(),
    ),
  );

export const listTeamPairingLinkIdsForMember = (sql: SqlClient.SqlClient, memberId: TeamMemberId) =>
  sql<{ readonly pairing_link_id: string }>`
    SELECT pairing_link_id
    FROM team_pairing_meta
    WHERE member_id = ${memberId} AND revoked_at IS NULL
    ORDER BY created_at DESC
  `.pipe(Effect.map((rows) => rows.map((row) => row.pairing_link_id)));

export const markTeamPairingMetaRevoked = (
  sql: SqlClient.SqlClient,
  pairingLinkId: string,
  revokedAt: string,
) => sql`
  UPDATE team_pairing_meta
  SET revoked_at = COALESCE(revoked_at, ${revokedAt})
  WHERE pairing_link_id = ${pairingLinkId}
`;

export const markAllTeamPairingMetaRevokedForMember = (
  sql: SqlClient.SqlClient,
  memberId: TeamMemberId,
  revokedAt: string,
) => sql`
  UPDATE team_pairing_meta
  SET revoked_at = COALESCE(revoked_at, ${revokedAt})
  WHERE member_id = ${memberId} AND revoked_at IS NULL
`;

export const upsertTeamSessionScopeCeiling = (
  sql: SqlClient.SqlClient,
  input: {
    readonly sessionId: AuthSessionId;
    readonly maxScopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly createdAt: string;
  },
) => sql`
  INSERT INTO team_session_scope_ceilings (session_id, max_scopes_json, created_at)
  VALUES (${input.sessionId}, ${JSON.stringify(input.maxScopes)}, ${input.createdAt})
  ON CONFLICT(session_id) DO UPDATE SET
    max_scopes_json = excluded.max_scopes_json
`;

export const getTeamSessionScopeCeiling = (sql: SqlClient.SqlClient, sessionId: AuthSessionId) =>
  sql<SessionScopeCeilingRow>`
    SELECT max_scopes_json
    FROM team_session_scope_ceilings
    WHERE session_id = ${sessionId}
    LIMIT 1
  `.pipe(
    Effect.map((rows) => {
      const raw = rows[0]?.max_scopes_json;
      if (!raw) return Option.none<ReadonlyArray<AuthEnvironmentScope>>();
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return Option.none<ReadonlyArray<AuthEnvironmentScope>>();
        return Option.some(
          parsed.filter((entry): entry is AuthEnvironmentScope => typeof entry === "string"),
        );
      } catch {
        return Option.none<ReadonlyArray<AuthEnvironmentScope>>();
      }
    }),
  );

export const getMemberUpstreamMobileVisibility = (
  sql: SqlClient.SqlClient,
  memberId: TeamMemberId,
) =>
  sql<MemberPreferenceRow>`
    SELECT upstream_client_thread_visibility
    FROM team_member_preferences
    WHERE member_id = ${memberId}
    LIMIT 1
  `.pipe(
    Effect.map(
      (rows) =>
        rows[0]?.upstream_client_thread_visibility ?? DEFAULT_UPSTREAM_CLIENT_THREAD_VISIBILITY,
    ),
  );

export const setMemberUpstreamMobileVisibility = (
  sql: SqlClient.SqlClient,
  input: {
    readonly memberId: TeamMemberId;
    readonly teamId: TeamId;
    readonly visibility: TeamUpstreamClientThreadVisibility;
    readonly updatedAt: string;
  },
) => sql`
  INSERT INTO team_member_preferences (
    member_id,
    team_id,
    upstream_client_thread_visibility,
    updated_at
  )
  VALUES (
    ${input.memberId},
    ${input.teamId},
    ${input.visibility},
    ${input.updatedAt}
  )
  ON CONFLICT(member_id) DO UPDATE SET
    upstream_client_thread_visibility = excluded.upstream_client_thread_visibility,
    updated_at = excluded.updated_at
`;
