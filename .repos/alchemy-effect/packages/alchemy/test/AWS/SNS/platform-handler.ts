import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "platform-handler.ts");

/**
 * Gated fixture for the SNS mobile-push bindings. SNS validates platform
 * credentials at CreatePlatformApplication time (probe-verified: a fake GCM
 * key fails with `InvalidParameterException` "Platform credentials are
 * invalid"), so this fixture only deploys when real credentials are supplied:
 *
 *   AWS_TEST_SNS_PLATFORM=1
 *   AWS_TEST_SNS_PLATFORM_NAME     (e.g. GCM)
 *   AWS_TEST_SNS_PLATFORM_CREDENTIAL
 *   AWS_TEST_SNS_PLATFORM_TOKEN    (a registrable device token)
 */
export class PlatformFixture extends Context.Service<
  PlatformFixture,
  { application: AWS.SNS.PlatformApplication }
>()("PlatformFixture") {}

export const PlatformFixtureLive = Layer.effect(
  PlatformFixture,
  Effect.gen(function* () {
    const application = yield* AWS.SNS.PlatformApplication("TestPushApp", {
      platform: process.env.AWS_TEST_SNS_PLATFORM_NAME ?? "GCM",
      platformCredential: Redacted.make(
        process.env.AWS_TEST_SNS_PLATFORM_CREDENTIAL ?? "",
      ),
    });
    return { application };
  }),
);

export class PlatformApiFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "PlatformApiFunction",
) {}

const formatError = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error
    ? { ok: false as const, error: (error as { _tag: string })._tag }
    : { ok: false as const, error: `${error}` };

export const PlatformApiFunctionLive = PlatformApiFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const { application } = yield* PlatformFixture;

    const createEndpoint = yield* AWS.SNS.CreatePlatformEndpoint(application);
    const getEndpointAttributes =
      yield* AWS.SNS.GetEndpointAttributes(application);
    const setEndpointAttributes =
      yield* AWS.SNS.SetEndpointAttributes(application);
    const deleteEndpoint = yield* AWS.SNS.DeleteEndpoint(application);
    const listEndpoints =
      yield* AWS.SNS.ListEndpointsByPlatformApplication(application);
    const publishToEndpoint = yield* AWS.SNS.PublishToEndpoint(application);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "POST" && url.pathname === "/endpoint-cycle") {
          const body = (yield* request.json) as { token: string };

          // Create → read → disable → publish (tolerant; the device token
          // may not be reachable) → list → delete.
          const created = yield* createEndpoint({ Token: body.token });
          if (!created.EndpointArn) {
            return yield* HttpServerResponse.json(
              { ok: false, error: "no EndpointArn" },
              { status: 500 },
            );
          }
          const attributes = yield* getEndpointAttributes({
            EndpointArn: created.EndpointArn,
          });
          yield* setEndpointAttributes({
            EndpointArn: created.EndpointArn,
            Attributes: { Enabled: "true" },
          });
          const published = yield* publishToEndpoint({
            TargetArn: created.EndpointArn,
            Message: "alchemy sns platform binding test",
          }).pipe(Effect.catch((error) => Effect.succeed(formatError(error))));
          const listed = yield* listEndpoints();
          yield* deleteEndpoint({ EndpointArn: created.EndpointArn });

          return yield* HttpServerResponse.json({
            ok: true,
            endpointArn: created.EndpointArn,
            attributes: attributes.Attributes,
            published,
            endpointCount: (listed.Endpoints ?? []).length,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found" },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.provideMerge(
        PlatformFixtureLive,
        Layer.mergeAll(
          AWS.SNS.CreatePlatformEndpointHttp,
          AWS.SNS.DeleteEndpointHttp,
          AWS.SNS.GetEndpointAttributesHttp,
          AWS.SNS.ListEndpointsByPlatformApplicationHttp,
          AWS.SNS.PublishToEndpointHttp,
          AWS.SNS.SetEndpointAttributesHttp,
        ),
      ),
    ),
  ),
).pipe(Layer.provideMerge(PlatformFixtureLive));

export default PlatformApiFunctionLive;
