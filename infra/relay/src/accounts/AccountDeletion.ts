import { RelayApi } from "@t3tools/contracts/relay";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Base64 from "effect/encoding/Base64";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as RelayConfiguration from "../Config.ts";
import { RELAY_DPOP_ACCESS_TOKEN_TTL } from "../auth/RelayTokens.ts";
import * as RelayDb from "../db.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import { unlinkEnvironmentRecord } from "../http/Api.ts";
import {
  relayAccountDeletions,
  relayAgentActivityRows,
  relayDeliveryAttempts,
  relayEnvironmentCredentials,
  relayEnvironmentLinks,
  relayLiveActivities,
  relayManagedEndpointAllocations,
  relayManagedTunnelLimits,
  relayMobileDevices,
} from "../persistence/schema.ts";
import * as T3ChatAccounts from "../t3chat/T3ChatAccounts.ts";

export class AccountDeletionFailed extends Schema.TaggedError<AccountDeletionFailed>()(
  "AccountDeletionFailed",
  {
    userId: Schema.String,
    stage: Schema.Literals([
      "record-request",
      "list-environments",
      "clear-held-webhooks",
      "deprovision",
      "delete-rows",
      "unlink-t3chat",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete relay data for ${this.userId} during ${this.stage}.`;
  }
}

const isAccountDeletionFailed = Schema.is(AccountDeletionFailed);

export class AccountDeletionQueueFailed extends Schema.TaggedError<AccountDeletionQueueFailed>()(
  "AccountDeletionQueueFailed",
  { cause: Schema.Defect() },
) {}

// A client can keep calling the relay until its access token expires, so a pass only counts as
// final once every token issued before the request is dead; earlier passes still run.
const DELETION_SETTLE = Duration.sum(
  Duration.fromInputUnsafe(RELAY_DPOP_ACCESS_TOKEN_TTL),
  Duration.minutes(5),
);
const PENDING_BATCH_SIZE = 25;

const identityKey = (identity: {
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) => `${identity.environmentId}\u0000${identity.environmentPublicKey}`;

/** Hard-deletes everything the relay holds for a cloud account. Safe to retry. */
export class AccountDeletion extends Context.Service<
  AccountDeletion,
  {
    /** Durably records a deletion; `processPending` carries it out. */
    readonly request: (input: {
      readonly userId: string;
    }) => Effect.Effect<void, AccountDeletionFailed>;
    readonly deleteAccount: (input: {
      readonly userId: string;
    }) => Effect.Effect<void, AccountDeletionFailed>;
    /** Runs pending deletions, retrying failures on the next call until one settles. */
    readonly processPending: Effect.Effect<
      { readonly completed: number; readonly failed: number },
      AccountDeletionQueueFailed
    >;
  }
>()("t3code-relay/accounts/AccountDeletion") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const t3Chat = yield* T3ChatAccounts.T3ChatAccounts;
  const inbox = yield* HookInbox.HookInbox;
  // unlinkEnvironmentRecord reads these from context; capture them once for the service.
  const unlinkContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof unlinkEnvironmentRecord>>>();

  const deleteAccount = Effect.fn("relay.account_deletion.delete_account")(function* (input: {
    readonly userId: string;
  }) {
    const { userId } = input;
    yield* Effect.annotateCurrentSpan({ "relay.user_id": userId });
    const fail = (stage: AccountDeletionFailed["stage"]) => (cause: unknown) =>
      new AccountDeletionFailed({ userId, stage, cause });

    const [links, allocations] = yield* Effect.all([
      db
        .select({
          environmentId: relayEnvironmentLinks.environmentId,
          environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
        })
        .from(relayEnvironmentLinks)
        .where(eq(relayEnvironmentLinks.userId, userId)),
      db
        .select({
          environmentId: relayManagedEndpointAllocations.environmentId,
          tunnelName: relayManagedEndpointAllocations.tunnelName,
        })
        .from(relayManagedEndpointAllocations)
        .where(eq(relayManagedEndpointAllocations.userId, userId)),
    ]).pipe(Effect.mapError(fail("list-environments")));
    const environmentIds = [...new Set([...links, ...allocations].map((row) => row.environmentId))];
    // Credentials and activity rows belong to an environment identity (id and key), not an account.
    const identities = [...new Map(links.map((link) => [identityKey(link), link])).entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, identity]) => identity);

    // Unlink only logs a failed clear; here it must fail the pass while the allocation that names
    // the inbox still exists, or a retry could no longer find it.
    const { managedEndpointNamespace } = config;
    if (managedEndpointNamespace !== undefined) {
      yield* Effect.forEach(
        allocations.flatMap((allocation) => {
          const endpointKey = HeldHooks.endpointKeyForTunnelName(
            managedEndpointNamespace,
            allocation.tunnelName,
          );
          return endpointKey === null ? [] : [endpointKey];
        }),
        (endpointKey) => inbox.clear({ endpointKey }),
        { discard: true },
      ).pipe(Effect.mapError(fail("clear-held-webhooks")));
    }

    // Revoke and delete each Cloudflare tunnel and DNS record before
    // dropping rows, so no live tunnel is left without the allocation that tracks it.
    yield* Effect.forEach(
      environmentIds,
      (environmentId) =>
        unlinkEnvironmentRecord({
          userId,
          environmentId,
          managedEndpointNamespace: config.managedEndpointNamespace,
          // The account is gone, so its hosts' connectors are dropped rather than waited out.
          forceDisconnect: true,
        }).pipe(Effect.provideContext(unlinkContext)),
      { discard: true },
    ).pipe(Effect.mapError(fail("deprovision")));
    const remainingAllocations = yield* db
      .select({ environmentId: relayManagedEndpointAllocations.environmentId })
      .from(relayManagedEndpointAllocations)
      .where(eq(relayManagedEndpointAllocations.userId, userId))
      .pipe(Effect.mapError(fail("deprovision")));
    if (remainingAllocations.length > 0) {
      return yield* fail("deprovision")(
        new Error(`${remainingAllocations.length} managed tunnel(s) still allocated`),
      );
    }

    yield* transactions
      .withTransaction(
        Effect.gen(function* () {
          // Linking takes this lock while writing a link and its credential, so a link another
          // account makes for the same environment either commits before the check below or
          // waits for this transaction. Sorted, so two deletions cannot deadlock.
          for (const identity of identities) {
            yield* db.execute(
              sql`select pg_advisory_xact_lock(hashtext(${identity.environmentId}), hashtext(${identity.environmentPublicKey}))`,
            );
          }
          const deletedLinks = yield* db
            .delete(relayEnvironmentLinks)
            .where(eq(relayEnvironmentLinks.userId, userId))
            .returning({
              environmentId: relayEnvironmentLinks.environmentId,
              environmentPublicKey: relayEnvironmentLinks.environmentPublicKey,
            });
          // A link written after the identities were read is not locked or cleaned below. Roll
          // back and let the next sweep start over with it.
          const locked = new Set(identities.map(identityKey));
          const unlocked = deletedLinks.filter((link) => !locked.has(identityKey(link)));
          if (unlocked.length > 0) {
            return yield* fail("delete-rows")(
              new Error(`${unlocked.length} link(s) changed during deletion; retrying`),
            );
          }
          for (const identity of identities) {
            const sameIdentity = (
              table:
                | typeof relayEnvironmentLinks
                | typeof relayEnvironmentCredentials
                | typeof relayAgentActivityRows,
            ) =>
              and(
                eq(table.environmentId, identity.environmentId),
                eq(table.environmentPublicKey, identity.environmentPublicKey),
              );
            const stillLinked = yield* db
              .select({ environmentId: relayEnvironmentLinks.environmentId })
              .from(relayEnvironmentLinks)
              .where(
                and(sameIdentity(relayEnvironmentLinks), isNull(relayEnvironmentLinks.revokedAt)),
              )
              .limit(1);
            if (stillLinked.length > 0) continue;
            yield* db
              .delete(relayEnvironmentCredentials)
              .where(sameIdentity(relayEnvironmentCredentials));
            yield* db.delete(relayAgentActivityRows).where(sameIdentity(relayAgentActivityRows));
          }
          yield* db.delete(relayLiveActivities).where(eq(relayLiveActivities.userId, userId));
          yield* db.delete(relayMobileDevices).where(eq(relayMobileDevices.userId, userId));
          yield* db.delete(relayDeliveryAttempts).where(eq(relayDeliveryAttempts.userId, userId));
          yield* db
            .delete(relayManagedTunnelLimits)
            .where(eq(relayManagedTunnelLimits.userId, userId));
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isAccountDeletionFailed(cause) ? cause : fail("delete-rows")(cause),
        ),
      );

    if (t3Chat.available) {
      // T3 Chat owns the link; only ask it to drop one that exists.
      yield* t3Chat.getLink({ userId }).pipe(
        Effect.flatMap((link) => (link === null ? Effect.void : t3Chat.unlink({ userId }))),
        Effect.mapError(fail("unlink-t3chat")),
      );
    }
  });

  const request = Effect.fn("relay.account_deletion.request")(function* (input: {
    readonly userId: string;
  }) {
    yield* Effect.annotateCurrentSpan({ "relay.user_id": input.userId });
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* db
      .insert(relayAccountDeletions)
      .values({ userId: input.userId, requestedAt: now })
      .onConflictDoNothing()
      .pipe(
        Effect.mapError(
          (cause) =>
            new AccountDeletionFailed({ userId: input.userId, stage: "record-request", cause }),
        ),
      );
  });

  const processPending = Effect.gen(function* () {
    const settledBefore = DateTime.formatIso(
      DateTime.subtractDuration(yield* DateTime.now, DELETION_SETTLE),
    );
    const pending = yield* db
      .select()
      .from(relayAccountDeletions)
      .where(isNull(relayAccountDeletions.completedAt))
      // Fewest failures first, so deletions that keep failing cannot starve newer ones.
      .orderBy(asc(relayAccountDeletions.attempts), asc(relayAccountDeletions.requestedAt))
      .limit(PENDING_BATCH_SIZE)
      .pipe(Effect.mapError((cause) => new AccountDeletionQueueFailed({ cause })));
    let completed = 0;
    let failed = 0;
    for (const row of pending) {
      const result = yield* Effect.exit(deleteAccount({ userId: row.userId }));
      if (result._tag === "Failure") {
        failed += 1;
        yield* Effect.logWarning("Account deletion attempt failed; retrying next sweep", {
          "relay.user_id": row.userId,
          attempts: row.attempts + 1,
          cause: result.cause,
        });
        yield* db
          .update(relayAccountDeletions)
          .set({ attempts: sql`${relayAccountDeletions.attempts} + 1` })
          .where(eq(relayAccountDeletions.userId, row.userId))
          .pipe(Effect.mapError((cause) => new AccountDeletionQueueFailed({ cause })));
      } else if (row.requestedAt <= settledBefore) {
        completed += 1;
        yield* db
          .update(relayAccountDeletions)
          .set({ completedAt: DateTime.formatIso(yield* DateTime.now) })
          .where(eq(relayAccountDeletions.userId, row.userId))
          .pipe(Effect.mapError((cause) => new AccountDeletionQueueFailed({ cause })));
      }
    }
    yield* Effect.annotateCurrentSpan({
      "relay.account_deletion.pending": pending.length,
      "relay.account_deletion.completed": completed,
      "relay.account_deletion.failed": failed,
    });
    return { completed, failed };
  }).pipe(Effect.withSpan("relay.account_deletion.process_pending"));

  return AccountDeletion.of({ request, deleteAccount, processPending });
});

export const layer = Layer.effect(AccountDeletion, make);

// Svix, which signs Clerk webhooks, rejects timestamps more than five minutes off.
const SVIX_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** Verifies Svix's `v1` HMAC-SHA256 signature over `<id>.<timestamp>.<body>`. */
const verifyClerkSignature = Effect.fn("relay.account_deletion.verify_clerk_signature")(
  function* (
    signingSecret: Redacted.Redacted<string>,
    headers: HttpServerRequest.HttpServerRequest["headers"],
    body: string,
  ) {
    const id = headers["svix-id"];
    const timestamp = headers["svix-timestamp"];
    const signatures = headers["svix-signature"];
    if (!id || !timestamp || !signatures) return false;
    const signedAtSeconds = Number(timestamp);
    const nowSeconds = (yield* Clock.currentTimeMillis) / 1_000;
    if (
      !Number.isInteger(signedAtSeconds) ||
      Math.abs(nowSeconds - signedAtSeconds) > SVIX_TIMESTAMP_TOLERANCE_SECONDS
    ) {
      return false;
    }
    const keyBytes = Base64.decode(Redacted.value(signingSecret).replace(/^whsec_/, ""));
    if (Result.isFailure(keyBytes)) return false;
    const mac = yield* Mac.Mac;
    const key = yield* Mac.key(Mac.hmacSha256, keyBytes.success);
    const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
    // The header lists space-separated `<version>,<base64 tag>` entries, one per active secret.
    for (const entry of signatures.split(" ")) {
      const [version, encoded] = entry.split(",");
      if (version !== "v1" || encoded === undefined) continue;
      const tag = Base64.decode(encoded);
      if (Result.isSuccess(tag) && (yield* mac.verify(key, tag.success, signed))) return true;
    }
    return false;
  },
  Effect.orElseSucceed(() => false),
);

const ClerkEvent = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, data: Schema.Unknown }),
);
const decodeClerkEvent = Schema.decodeUnknownEffect(ClerkEvent);
const ClerkDeletedUser = Schema.Struct({ id: Schema.String.check(Schema.isNonEmpty()) });
const decodeClerkDeletedUser = Schema.decodeUnknownEffect(ClerkDeletedUser);

export const handleClerkWebhook = Effect.fn("relay.account_deletion.clerk_webhook")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const signingSecret = config.clerkWebhookSigningSecret;
  if (signingSecret === undefined) {
    return HttpServerResponse.empty({ status: 404 });
  }
  const body = yield* request.text.pipe(Effect.orElseSucceed(() => null));
  if (body === null) {
    return HttpServerResponse.empty({ status: 400 });
  }
  if (!(yield* verifyClerkSignature(signingSecret, request.headers, body))) {
    yield* Effect.annotateCurrentSpan({ "relay.clerk_webhook.rejected": true });
    return HttpServerResponse.empty({ status: 401 });
  }
  const event = yield* decodeClerkEvent(body).pipe(Effect.option);
  if (event._tag === "None") {
    return HttpServerResponse.empty({ status: 400 });
  }
  yield* Effect.annotateCurrentSpan({ "relay.clerk_webhook.type": event.value.type });
  if (event.value.type !== "user.deleted") {
    return HttpServerResponse.empty({ status: 204 });
  }
  const user = yield* decodeClerkDeletedUser(event.value.data).pipe(Effect.option);
  if (user._tag === "None") {
    return HttpServerResponse.empty({ status: 400 });
  }
  const accounts = yield* AccountDeletion;
  // Once recorded, the deletion is ours to retry. Clerk retries only if recording fails.
  return yield* accounts.request({ userId: user.value.id }).pipe(
    Effect.as(HttpServerResponse.empty({ status: 200 })),
    Effect.catch((error) =>
      Effect.logError("Could not record account deletion", { cause: error.cause }).pipe(
        Effect.as(HttpServerResponse.empty({ status: 500 })),
      ),
    ),
  );
});

export const layerApi = HttpApiBuilder.group(
  RelayApi,
  "accountWebhooks",
  Effect.fnUntraced(function* (handlers) {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const accounts = yield* AccountDeletion;
    const mac = yield* Mac.Mac;
    return handlers.handleRaw("clerk", ({ request }) =>
      handleClerkWebhook(request).pipe(
        Effect.provideService(RelayConfiguration.RelayConfiguration, config),
        Effect.provideService(AccountDeletion, accounts),
        Effect.provideService(Mac.Mac, mac),
      ),
    );
  }),
);
