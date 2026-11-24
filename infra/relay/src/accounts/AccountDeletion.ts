import { RelayApi } from "@t3tools/contracts/relay";
import { eq, inArray } from "drizzle-orm";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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
import * as RelayDb from "../db.ts";
import { unlinkEnvironmentRecord } from "../http/Api.ts";
import {
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
    stage: Schema.Literals(["list-environments", "deprovision", "delete-rows", "unlink-t3chat"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete relay data for ${this.userId} during ${this.stage}.`;
  }
}

/** Hard-deletes everything the relay holds for a cloud account. Safe to retry. */
export class AccountDeletion extends Context.Service<
  AccountDeletion,
  {
    readonly deleteAccount: (input: {
      readonly userId: string;
    }) => Effect.Effect<void, AccountDeletionFailed>;
  }
>()("t3code-relay/accounts/AccountDeletion") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const t3Chat = yield* T3ChatAccounts.T3ChatAccounts;
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

    const environmentIds = yield* Effect.all([
      db
        .select({ environmentId: relayEnvironmentLinks.environmentId })
        .from(relayEnvironmentLinks)
        .where(eq(relayEnvironmentLinks.userId, userId)),
      db
        .select({ environmentId: relayManagedEndpointAllocations.environmentId })
        .from(relayManagedEndpointAllocations)
        .where(eq(relayManagedEndpointAllocations.userId, userId)),
    ]).pipe(
      Effect.map((rows) => [...new Set(rows.flat().map((row) => row.environmentId))]),
      Effect.mapError(fail("list-environments")),
    );

    // Revoke, clear held webhooks, and delete each Cloudflare tunnel and DNS record before
    // dropping rows, so no live tunnel is left without the allocation that tracks it.
    yield* Effect.forEach(
      environmentIds,
      (environmentId) =>
        unlinkEnvironmentRecord({
          userId,
          environmentId,
          managedEndpointNamespace: config.managedEndpointNamespace,
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
          yield* db.delete(relayEnvironmentLinks).where(eq(relayEnvironmentLinks.userId, userId));
          // Environment-scoped rows go only when no other account still links the environment.
          const stillLinked =
            environmentIds.length === 0
              ? []
              : yield* db
                  .select({ environmentId: relayEnvironmentLinks.environmentId })
                  .from(relayEnvironmentLinks)
                  .where(inArray(relayEnvironmentLinks.environmentId, environmentIds));
          const shared = new Set(stillLinked.map((row) => row.environmentId));
          const orphaned = environmentIds.filter((environmentId) => !shared.has(environmentId));
          if (orphaned.length > 0) {
            yield* db
              .delete(relayEnvironmentCredentials)
              .where(inArray(relayEnvironmentCredentials.environmentId, orphaned));
            yield* db
              .delete(relayAgentActivityRows)
              .where(inArray(relayAgentActivityRows.environmentId, orphaned));
          }
          yield* db.delete(relayLiveActivities).where(eq(relayLiveActivities.userId, userId));
          yield* db.delete(relayMobileDevices).where(eq(relayMobileDevices.userId, userId));
          yield* db.delete(relayDeliveryAttempts).where(eq(relayDeliveryAttempts.userId, userId));
          yield* db
            .delete(relayManagedTunnelLimits)
            .where(eq(relayManagedTunnelLimits.userId, userId));
        }),
      )
      .pipe(Effect.mapError(fail("delete-rows")));

    if (t3Chat.available) {
      // T3 Chat owns the link; only ask it to drop one that exists.
      yield* t3Chat.getLink({ userId }).pipe(
        Effect.flatMap((link) => (link === null ? Effect.void : t3Chat.unlink({ userId }))),
        Effect.mapError(fail("unlink-t3chat")),
      );
    }
  });

  return AccountDeletion.of({ deleteAccount });
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
  // A failure answers 500 so Clerk retries; every step is idempotent.
  return yield* accounts.deleteAccount({ userId: user.value.id }).pipe(
    Effect.as(HttpServerResponse.empty({ status: 204 })),
    Effect.catch((error) =>
      Effect.logError("Account deletion failed", { stage: error.stage, cause: error.cause }).pipe(
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
