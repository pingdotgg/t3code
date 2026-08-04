import * as AppRegistry from "@/AWS/AppRegistry";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Deterministic name of a stack that never exists — drives the typed
// ResourceNotFoundException paths for GetAssociatedResource / SyncResource.
const NONEXISTENT_STACK = "alchemy-appregistry-bindings-nonexistent-stack";

export class AppRegistryTestFunction extends Lambda.Function<Lambda.Function>()(
  "AppRegistryTestFunction",
) {}

export default AppRegistryTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const app = yield* AppRegistry.Application("BindingsApp", {
      description: "AppRegistry bindings fixture",
    });
    const group = yield* AppRegistry.AttributeGroup("BindingsGroup", {
      attributes: { owner: "alchemy-test", tier: "bindings" },
    });
    yield* AppRegistry.AttributeGroupAssociation("BindingsGroupAssoc", {
      application: app.applicationId,
      attributeGroup: group.attributeGroupId,
    });

    // --- application-scoped bindings ---
    const getApplication = yield* AppRegistry.GetApplication(app);
    const getAssociatedResource = yield* AppRegistry.GetAssociatedResource(app);
    const listAssociatedResources =
      yield* AppRegistry.ListAssociatedResources(app);
    const listAssociatedAttributeGroups =
      yield* AppRegistry.ListAssociatedAttributeGroups(app);
    const listAttributeGroupsForApplication =
      yield* AppRegistry.ListAttributeGroupsForApplication(app);

    // --- attribute-group-scoped bindings ---
    const getAttributeGroup = yield* AppRegistry.GetAttributeGroup(group);

    // --- account-level bindings ---
    const syncResource = yield* AppRegistry.SyncResource();
    const listApplications = yield* AppRegistry.ListApplications();
    const listAttributeGroups = yield* AppRegistry.ListAttributeGroups();

    const bound = {
      getApplication,
      getAssociatedResource,
      listAssociatedResources,
      listAssociatedAttributeGroups,
      listAttributeGroupsForApplication,
      getAttributeGroup,
      syncResource,
      listApplications,
      listAttributeGroups,
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

        if (request.method === "GET" && pathname === "/application") {
          const result = yield* getApplication();
          return yield* HttpServerResponse.json({
            name: result.name ?? null,
            associatedResourceCount: result.associatedResourceCount ?? 0,
          });
        }

        if (request.method === "GET" && pathname === "/attribute-group") {
          const result = yield* getAttributeGroup();
          return yield* HttpServerResponse.json({
            name: result.name ?? null,
            attributes: JSON.parse(result.attributes ?? "{}"),
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/associated-attribute-groups"
        ) {
          const result = yield* listAssociatedAttributeGroups({
            maxResults: 20,
          });
          return yield* HttpServerResponse.json({
            count: (result.attributeGroups ?? []).length,
            attributeGroups: result.attributeGroups ?? [],
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/attribute-groups-details"
        ) {
          const result = yield* listAttributeGroupsForApplication({
            maxResults: 20,
          });
          return yield* HttpServerResponse.json({
            names: (result.attributeGroupsDetails ?? []).map(
              (detail) => detail.name ?? null,
            ),
          });
        }

        if (request.method === "GET" && pathname === "/associated-resources") {
          const result = yield* listAssociatedResources({ maxResults: 20 });
          return yield* HttpServerResponse.json({
            count: (result.resources ?? []).length,
          });
        }

        if (
          request.method === "GET" &&
          pathname === "/associated-resource-not-found"
        ) {
          // Exercises `application` injection + the typed not-found path.
          const result = yield* getAssociatedResource({
            resourceType: "CFN_STACK",
            resource: NONEXISTENT_STACK,
          }).pipe(
            Effect.map(() => ({ found: true })),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed({ found: false }),
            ),
          );
          return yield* HttpServerResponse.json(result);
        }

        if (request.method === "GET" && pathname === "/applications") {
          // The fixture's own application must appear in the account listing.
          // Bounded pagination (5 pages) keeps the assertion robust as the
          // account accumulates applications.
          const names: (string | null)[] = [];
          let nextToken: string | undefined;
          for (let page = 0; page < 5; page++) {
            const result = yield* listApplications({
              maxResults: 25,
              nextToken,
            });
            names.push(
              ...(result.applications ?? []).map((a) => a.name ?? null),
            );
            nextToken = result.nextToken;
            if (!nextToken) break;
          }
          return yield* HttpServerResponse.json({ names });
        }

        if (request.method === "GET" && pathname === "/attribute-groups") {
          // The fixture's own attribute group must appear in the account
          // listing. Bounded pagination (5 pages) as above.
          const names: (string | null)[] = [];
          let nextToken: string | undefined;
          for (let page = 0; page < 5; page++) {
            const result = yield* listAttributeGroups({
              maxResults: 25,
              nextToken,
            });
            names.push(
              ...(result.attributeGroups ?? []).map((g) => g.name ?? null),
            );
            nextToken = result.nextToken;
            if (!nextToken) break;
          }
          return yield* HttpServerResponse.json({ names });
        }

        if (request.method === "POST" && pathname === "/sync-resource") {
          // A nonexistent stack proves the servicecatalog:SyncResource grant
          // end-to-end via its typed error (an IAM gap would surface
          // AccessDeniedException instead).
          const tag = yield* syncResource({
            resourceType: "CFN_STACK",
            resource: NONEXISTENT_STACK,
          }).pipe(
            Effect.map(() => "Synced"),
            Effect.catchTag(
              [
                "ResourceNotFoundException",
                "ValidationException",
                // Not expected — surfaced (and failed on) by the test with a
                // readable tag instead of an opaque 500 if the grant is wrong.
                "AccessDeniedException",
              ],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ tag });
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
        AppRegistry.GetApplicationHttp,
        AppRegistry.GetAssociatedResourceHttp,
        AppRegistry.ListAssociatedResourcesHttp,
        AppRegistry.ListAssociatedAttributeGroupsHttp,
        AppRegistry.ListAttributeGroupsForApplicationHttp,
        AppRegistry.GetAttributeGroupHttp,
        AppRegistry.SyncResourceHttp,
        AppRegistry.ListApplicationsHttp,
        AppRegistry.ListAttributeGroupsHttp,
      ),
    ),
  ),
);
