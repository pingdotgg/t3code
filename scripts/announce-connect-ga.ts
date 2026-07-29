#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

const CLERK_API_URL = "https://api.clerk.com/v1";
const PAGE_SIZE = 500;

export class WaitlistEntry extends Schema.Class<WaitlistEntry>("WaitlistEntry")({
  id: Schema.String,
  email_address: Schema.String,
  status: Schema.Literals(["pending", "invited", "completed", "rejected"]),
}) {}

const ClerkWaitlistResponse = Schema.Struct({
  data: Schema.Array(WaitlistEntry),
  total_count: Schema.Int,
});
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0));
const ClerkSecretKey = Config.string("CLERK_SECRET_KEY");

export interface ConnectGaOptions {
  readonly invite: boolean;
  readonly limit: number | undefined;
}

export class ConnectGaRequestError extends Schema.TaggedErrorClass<ConnectGaRequestError>()(
  "ConnectGaRequestError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Clerk ${this.operation} request failed.`;
  }
}

export class ConnectGaResponseError extends Schema.TaggedErrorClass<ConnectGaResponseError>()(
  "ConnectGaResponseError",
  {
    operation: Schema.String,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Clerk ${this.operation} returned status ${this.status}.`;
  }
}

const executeClerkJsonRequest = Effect.fn("executeClerkJsonRequest")(function* <
  S extends Schema.Top,
>(request: HttpClientRequest.HttpClientRequest, schema: S, operation: string) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      times: 3,
    }),
  );
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError((cause) => new ConnectGaRequestError({ operation, cause })));
  const success = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectGaResponseError({
          operation,
          status: response.status,
          cause,
        }),
    ),
  );
  return yield* HttpClientResponse.schemaBodyJson(schema)(success).pipe(
    Effect.mapError(
      (cause) =>
        new ConnectGaResponseError({
          operation,
          status: response.status,
          cause,
        }),
    ),
  );
});

const fetchWaitlistPage = Effect.fn("fetchWaitlistPage")(function* (
  secretKey: string,
  offset: number,
) {
  const url = new URL(`${CLERK_API_URL}/waitlist_entries`);
  url.searchParams.set("status", "pending");
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("order_by", "+created_at");
  const request = HttpClientRequest.get(url.href).pipe(
    HttpClientRequest.bearerToken(secretKey),
    HttpClientRequest.setHeader("Clerk-API-Version", "2026-05-12"),
  );
  return yield* executeClerkJsonRequest(
    request,
    ClerkWaitlistResponse,
    "list pending waitlist entries",
  );
});

export const fetchPendingWaitlistEntries = Effect.fn("fetchPendingWaitlistEntries")(function* (
  secretKey: string,
  limit?: number,
) {
  const entries: Array<WaitlistEntry> = [];
  while (true) {
    if (limit !== undefined && entries.length >= limit) break;
    const page = yield* fetchWaitlistPage(secretKey, entries.length);
    entries.push(...page.data);
    if (entries.length >= page.total_count || page.data.length === 0) break;
  }
  return limit === undefined ? entries : entries.slice(0, limit);
});

export const inviteWaitlistEntry = Effect.fn("inviteWaitlistEntry")(function* (
  secretKey: string,
  entry: WaitlistEntry,
) {
  const request = HttpClientRequest.post(
    `${CLERK_API_URL}/waitlist_entries/${encodeURIComponent(entry.id)}/invite`,
  ).pipe(
    HttpClientRequest.bearerToken(secretKey),
    HttpClientRequest.setHeader("Clerk-API-Version", "2026-05-12"),
  );
  return yield* executeClerkJsonRequest(
    request,
    WaitlistEntry,
    `invite waitlist entry ${entry.id}`,
  );
});

export const announceConnectGa = Effect.fn("announceConnectGa")(function* (
  options: ConnectGaOptions,
) {
  const clerkSecretKey = yield* ClerkSecretKey;
  const entries = yield* fetchPendingWaitlistEntries(clerkSecretKey, options.limit);

  yield* Effect.logInfo(
    options.invite ? "Connect GA waitlist invitations starting" : "Connect GA dry run",
  ).pipe(
    Effect.annotateLogs({
      pendingEntries: entries.length,
    }),
  );

  if (!options.invite) {
    for (const entry of entries) {
      yield* Effect.logInfo("pending waitlist entry").pipe(
        Effect.annotateLogs({
          waitlistEntryId: entry.id,
          emailAddress: entry.email_address,
        }),
      );
    }
    yield* Effect.logInfo("No invitation was sent. Re-run with --invite after reviewing the list.");
    return;
  }

  for (const [index, entry] of entries.entries()) {
    const invited = yield* inviteWaitlistEntry(clerkSecretKey, entry);
    yield* Effect.logInfo("Clerk waitlist invitation sent").pipe(
      Effect.annotateLogs({
        waitlistEntryId: invited.id,
        completed: index + 1,
        total: entries.length,
      }),
    );
  }
});

export const announceConnectGaCommand = Command.make(
  "announce-connect-ga",
  {
    invite: Flag.boolean("invite").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Invite pending entries through Clerk. Without this flag, only print a dry-run list.",
      ),
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withSchema(PositiveInteger),
      Flag.optional,
      Flag.withDescription("Process at most this many pending waitlist entries."),
    ),
  },
  ({ invite, limit }) =>
    announceConnectGa({
      invite,
      limit: Option.getOrUndefined(limit),
    }),
).pipe(
  Command.withDescription(
    "Invite pending Clerk waitlist members now that T3 Connect is generally available.",
  ),
);

if (import.meta.main) {
  Command.run(announceConnectGaCommand, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
