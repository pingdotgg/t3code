import * as Lambda from "@/AWS/Lambda";
import * as RePostSpace from "@/AWS/RePostSpace";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "bindings-handler.ts");

// A syntactically-valid but nonexistent IAM Identity Center accessor id.
const BOGUS_ACCESSOR_ID = "00000000-0000-0000-0000-000000000000";

/** Unwrap a distilled sensitive value into its plain string. */
const unwrapSensitive = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

export class RePostSpaceBindingsFunction extends Lambda.Function<Lambda.Function>()(
  "RePostSpaceBindingsFunction",
) {}

export default RePostSpaceBindingsFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const space = yield* RePostSpace.Space("BindingsSpace", {
      // subdomain must be globally unique across re:Post Private —
      // deterministic, alchemy-branded constant.
      subdomain: "alchemy-e2e-repost-bindings",
      tier: "BASIC",
      description: "alchemy repostspace bindings fixture",
      tags: { fixture: "repostspace-bindings" },
    });

    const sendInvites = yield* RePostSpace.SendInvites(space);
    const registerAdmin = yield* RePostSpace.RegisterAdmin(space);
    const deregisterAdmin = yield* RePostSpace.DeregisterAdmin(space);
    const batchAddRole = yield* RePostSpace.BatchAddRole(space);
    const batchRemoveRole = yield* RePostSpace.BatchRemoveRole(space);
    const createChannel = yield* RePostSpace.CreateChannel(space);
    const getChannel = yield* RePostSpace.GetChannel(space);
    const listChannels = yield* RePostSpace.ListChannels(space);
    const updateChannel = yield* RePostSpace.UpdateChannel(space);
    const addChannelRole =
      yield* RePostSpace.BatchAddChannelRoleToAccessors(space);
    const removeChannelRole =
      yield* RePostSpace.BatchRemoveChannelRoleFromAccessors(space);

    const bound = {
      sendInvites,
      registerAdmin,
      deregisterAdmin,
      batchAddRole,
      batchRemoveRole,
      createChannel,
      getChannel,
      listChannels,
      updateChannel,
      addChannelRole,
      removeChannelRole,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/channels") {
          const response = yield* listChannels();
          return yield* HttpServerResponse.json({
            count: (response.channels ?? []).length,
          });
        }

        if (request.method === "POST" && pathname === "/channels") {
          // Create → read → rename round-trip; channels cannot be deleted,
          // but the whole space is destroyed at teardown so nothing leaks.
          const { channelId } = yield* createChannel({
            channelName: "alchemy-bindings-channel",
            channelDescription: "created by the alchemy bindings fixture",
          });
          const read = yield* getChannel({ channelId });
          yield* updateChannel({
            channelId,
            channelName: "alchemy-bindings-channel-renamed",
          });
          const reread = yield* getChannel({ channelId });
          return yield* HttpServerResponse.json({
            channelId,
            name: unwrapSensitive(read.channelName),
            renamed: unwrapSensitive(reread.channelName),
          });
        }

        if (request.method === "POST" && pathname === "/roles/bogus") {
          // Batch role APIs report per-accessor failures in the output's
          // `errors` list (or fail with a typed 400 for malformed input) —
          // either shape proves the grant + spaceId injection end-to-end.
          const added = yield* batchAddRole({
            accessorIds: [BOGUS_ACCESSOR_ID],
            role: "EXPERT",
          }).pipe(
            Effect.map((r) => ({
              ok: true,
              errors: r.errors.length,
              added: r.addedAccessorIds.length,
            })),
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ ok: false, tag: e._tag }),
            ),
          );
          const removed = yield* batchRemoveRole({
            accessorIds: [BOGUS_ACCESSOR_ID],
            role: "EXPERT",
          }).pipe(
            Effect.map((r) => ({
              ok: true,
              errors: r.errors.length,
              removed: r.removedAccessorIds.length,
            })),
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ ok: false, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json({ added, removed });
        }

        if (request.method === "POST" && pathname === "/channel-roles/bogus") {
          const channelId = url.searchParams.get("channelId") ?? "";
          const added = yield* addChannelRole({
            channelId,
            accessorIds: [BOGUS_ACCESSOR_ID],
            channelRole: "EXPERT",
          }).pipe(
            Effect.map((r) => ({ ok: true, errors: r.errors.length })),
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ ok: false, tag: e._tag }),
            ),
          );
          const removed = yield* removeChannelRole({
            channelId,
            accessorIds: [BOGUS_ACCESSOR_ID],
            channelRole: "EXPERT",
          }).pipe(
            Effect.map((r) => ({ ok: true, errors: r.errors.length })),
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ ok: false, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json({ added, removed });
        }

        if (request.method === "POST" && pathname === "/admins/bogus") {
          // A nonexistent accessor id surfaces the typed 400/404 union —
          // an IAM gap would surface AccessDeniedException instead, so the
          // typed tag proves the grant reached the space-scoped API.
          const register = yield* registerAdmin({
            adminId: BOGUS_ACCESSOR_ID,
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          const deregister = yield* deregisterAdmin({
            adminId: BOGUS_ACCESSOR_ID,
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json({ register, deregister });
        }

        if (request.method === "POST" && pathname === "/invites/bogus") {
          const result = yield* sendInvites({
            accessorIds: [BOGUS_ACCESSOR_ID],
            title: "alchemy bindings probe",
            body: "This invite targets a nonexistent accessor on purpose.",
          }).pipe(
            Effect.map(() => ({ ok: true as const })),
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) => Effect.succeed({ ok: false as const, tag: e._tag }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        RePostSpace.SendInvitesHttp,
        RePostSpace.RegisterAdminHttp,
        RePostSpace.DeregisterAdminHttp,
        RePostSpace.BatchAddRoleHttp,
        RePostSpace.BatchRemoveRoleHttp,
        RePostSpace.CreateChannelHttp,
        RePostSpace.GetChannelHttp,
        RePostSpace.ListChannelsHttp,
        RePostSpace.UpdateChannelHttp,
        RePostSpace.BatchAddChannelRoleToAccessorsHttp,
        RePostSpace.BatchRemoveChannelRoleFromAccessorsHttp,
      ),
    ),
  ),
);
