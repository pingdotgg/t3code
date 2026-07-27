import * as Lambda from "@/AWS/Lambda";
import * as RAM from "@/AWS/RAM";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Fabricate a well-formed same-account invitation ARN that cannot exist —
 * drives the typed not-found path for the invitation bindings, proving the
 * grant reaches the API (an IAM gap would surface AccessDeniedException
 * instead).
 */
const fakeInvitationArn = (shareArn: string) => {
  const [, , , region, accountId] = shareArn.split(":");
  return `arn:aws:ram:${region}:${accountId}:resource-share-invitation/00000000-0000-4000-8000-000000000000`;
};

/** A well-formed same-account subnet ARN that cannot exist. */
const fakeSubnetArn = (shareArn: string) => {
  const [, , , region, accountId] = shareArn.split(":");
  return `arn:aws:ec2:${region}:${accountId}:subnet/subnet-00000000000000000`;
};

export class RAMTestFunction extends Lambda.Function<Lambda.Function>()(
  "RAMTestFunction",
) {}

export default RAMTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // A resource share owned by the fixture — guarantees that
    // GetResourceShares(SELF) is non-empty and provides the region/account
    // for the fabricated not-found ARNs.
    yield* RAM.ResourceShare("BindingsShare", {
      allowExternalPrincipals: true,
    });

    const acceptInvitation = yield* RAM.AcceptResourceShareInvitation();
    const rejectInvitation = yield* RAM.RejectResourceShareInvitation();
    const getInvitations = yield* RAM.GetResourceShareInvitations();
    const listPendingResources = yield* RAM.ListPendingInvitationResources();
    const getResourceShares = yield* RAM.GetResourceShares();
    const getAssociations = yield* RAM.GetResourceShareAssociations();
    const listResources = yield* RAM.ListResources();
    const listPrincipals = yield* RAM.ListPrincipals();
    const getResourcePolicies = yield* RAM.GetResourcePolicies();
    const getPermission = yield* RAM.GetPermission();
    const listPermissions = yield* RAM.ListPermissions();

    const bound = {
      acceptInvitation,
      rejectInvitation,
      getInvitations,
      listPendingResources,
      getResourceShares,
      getAssociations,
      listResources,
      listPrincipals,
      getResourcePolicies,
      getPermission,
      listPermissions,
    };

    // The fixture's own share doubles as the region/account source for
    // fabricated ARNs.
    const firstShareArn = getResourceShares({ resourceOwner: "SELF" }).pipe(
      Effect.map((r) => r.resourceShares?.[0]?.resourceShareArn),
    );

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

        if (request.method === "GET" && pathname === "/shares") {
          const result = yield* getResourceShares({ resourceOwner: "SELF" });
          return yield* HttpServerResponse.json({
            count: (result.resourceShares ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/associations") {
          const shareArn = yield* firstShareArn;
          if (shareArn === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoShares" });
          }
          const result = yield* getAssociations({
            associationType: "PRINCIPAL",
            resourceShareArns: [shareArn],
          });
          return yield* HttpServerResponse.json({
            tag: "Ok",
            count: (result.resourceShareAssociations ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/invitations") {
          const result = yield* getInvitations();
          return yield* HttpServerResponse.json({
            count: (result.resourceShareInvitations ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/accept-nonexistent") {
          const shareArn = yield* firstShareArn;
          if (shareArn === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoShares" });
          }
          // Typed not-found path — proves the AcceptResourceShareInvitation
          // grant reaches the API.
          const result = yield* acceptInvitation({
            resourceShareInvitationArn: fakeInvitationArn(shareArn),
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              [
                "ResourceShareInvitationArnNotFoundException",
                "MalformedArnException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (request.method === "GET" && pathname === "/reject-nonexistent") {
          const shareArn = yield* firstShareArn;
          if (shareArn === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoShares" });
          }
          const result = yield* rejectInvitation({
            resourceShareInvitationArn: fakeInvitationArn(shareArn),
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              [
                "ResourceShareInvitationArnNotFoundException",
                "MalformedArnException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (
          request.method === "GET" &&
          pathname === "/pending-resources-nonexistent"
        ) {
          const shareArn = yield* firstShareArn;
          if (shareArn === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoShares" });
          }
          const result = yield* listPendingResources({
            resourceShareInvitationArn: fakeInvitationArn(shareArn),
          }).pipe(
            Effect.map(() => "Ok"),
            Effect.catchTag(
              [
                "ResourceShareInvitationArnNotFoundException",
                "MalformedArnException",
                "InvalidParameterException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag: result });
        }

        if (request.method === "GET" && pathname === "/resources") {
          const result = yield* listResources({ resourceOwner: "SELF" });
          return yield* HttpServerResponse.json({
            count: (result.resources ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/principals") {
          const result = yield* listPrincipals({ resourceOwner: "SELF" });
          return yield* HttpServerResponse.json({
            count: (result.principals ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/resource-policies-nonexistent"
        ) {
          const shareArn = yield* firstShareArn;
          if (shareArn === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoShares" });
          }
          // A fabricated subnet ARN — either the typed not-found or an empty
          // policy list proves the grant.
          const result = yield* getResourcePolicies({
            resourceArns: [fakeSubnetArn(shareArn)],
          }).pipe(
            Effect.map((r) => ({
              tag: "Ok" as string,
              count: (r.policies ?? []).length,
            })),
            Effect.catchTag(
              ["ResourceArnNotFoundException", "MalformedArnException"],
              (e) => Effect.succeed({ tag: e._tag as string, count: 0 }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/permissions") {
          const result = yield* listPermissions();
          return yield* HttpServerResponse.json({
            count: (result.permissions ?? []).length,
          });
        }

        if (request.method === "GET" && pathname === "/permission") {
          const listed = yield* listPermissions({ maxResults: 5 });
          const first = (listed.permissions ?? [])[0];
          if (first?.arn === undefined) {
            return yield* HttpServerResponse.json({ tag: "NoPermissions" });
          }
          const result = yield* getPermission({ permissionArn: first.arn });
          return yield* HttpServerResponse.json({
            tag: "Ok",
            name: result.permission?.name,
          });
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
        Lambda.EventSource,
        RAM.AcceptResourceShareInvitationHttp,
        RAM.RejectResourceShareInvitationHttp,
        RAM.GetResourceShareInvitationsHttp,
        RAM.ListPendingInvitationResourcesHttp,
        RAM.GetResourceSharesHttp,
        RAM.GetResourceShareAssociationsHttp,
        RAM.ListResourcesHttp,
        RAM.ListPrincipalsHttp,
        RAM.GetResourcePoliciesHttp,
        RAM.GetPermissionHttp,
        RAM.ListPermissionsHttp,
      ),
    ),
  ),
);
