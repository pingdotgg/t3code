import * as Lambda from "@/AWS/Lambda";
import * as Route53Profiles from "@/AWS/Route53Profiles";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class ProfilesTestFunction extends Lambda.Function<Lambda.Function>()(
  "ProfilesTestFunction",
) {}

export default ProfilesTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The profile the bindings are bound to. Nothing is ever associated with
    // it (no VPC association, no attached DNS resources), so both lists
    // legitimately return empty item lists — which still proves the IAM
    // grants and the ProfileId injection end-to-end.
    const profile = yield* Route53Profiles.Profile("BindingProfile");

    const listProfileAssociations =
      yield* Route53Profiles.ListProfileAssociations(profile);
    const listProfileResourceAssociations =
      yield* Route53Profiles.ListProfileResourceAssociations(profile);

    const bound = { listProfileAssociations, listProfileResourceAssociations };

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

        // Account-wide list filtered to the bound profile: the ProfileId is
        // injected from the binding.
        if (request.method === "GET" && pathname === "/associations") {
          const { ProfileAssociations = [] } = yield* listProfileAssociations();
          return yield* HttpServerResponse.json({
            count: ProfileAssociations.length,
            resourceIds: ProfileAssociations.map((item) => item.ResourceId),
          });
        }

        // Profile-scoped list: the ProfileId is injected from the binding.
        if (request.method === "GET" && pathname === "/resource-associations") {
          const { ProfileResourceAssociations = [] } =
            yield* listProfileResourceAssociations();
          return yield* HttpServerResponse.json({
            count: ProfileResourceAssociations.length,
            resourceArns: ProfileResourceAssociations.map(
              (item) => item.ResourceArn,
            ),
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
        Route53Profiles.ListProfileAssociationsHttp,
        Route53Profiles.ListProfileResourceAssociationsHttp,
      ),
    ),
  ),
);
