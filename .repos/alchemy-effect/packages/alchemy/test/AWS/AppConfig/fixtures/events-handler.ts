import * as AppConfig from "@/AWS/AppConfig";
import * as Lambda from "@/AWS/Lambda";
import * as S3 from "@/AWS/S3";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "events-handler.ts");

export class AppConfigEventsTestFunction extends Lambda.Function<Lambda.Function>()(
  "AppConfigEventsTestFunction",
) {}

export default AppConfigEventsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const app = yield* AppConfig.Application("EventsApp", {});
    const env = yield* AppConfig.Environment("EventsEnv", {
      applicationId: app.applicationId,
    });
    const profile = yield* AppConfig.ConfigurationProfile("EventsProfile", {
      applicationId: app.applicationId,
      locationUri: "hosted",
    });
    yield* AppConfig.HostedConfigurationVersion("EventsV1", {
      applicationId: app.applicationId,
      configurationProfileId: profile.configurationProfileId,
      content: JSON.stringify({ revision: 1 }),
      contentType: "application/json",
    });
    const strategy = yield* AppConfig.DeploymentStrategy("EventsAllAtOnce", {
      deploymentDuration: 0,
      growthFactor: 100,
      finalBakeTime: 0,
      replicateTo: "NONE",
    });

    // Deployment notifications arrive as separate async invocations that may
    // land on a DIFFERENT warm instance than the one serving the test's
    // polls, so instance memory cannot capture them. Persist each event to
    // S3 under a deterministic key and read it back by key.
    const bucket = yield* S3.Bucket("EventsBucket", { forceDestroy: true });
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);

    // Deployments are triggered at runtime (POST /deploy) so the extension
    // association below exists before the first deployment starts.
    const startDeployment = yield* AppConfig.StartDeployment(
      app,
      env,
      profile,
      strategy,
    );

    yield* AppConfig.consumeDeploymentEvents(
      env,
      { events: ["ON_DEPLOYMENT_START", "ON_DEPLOYMENT_COMPLETE"] },
      (events) =>
        events.pipe(
          Stream.runForEach((event) =>
            putObject({
              Key: `events/${event.DeploymentNumber}-${event.Type}.json`,
              Body: JSON.stringify(event),
              ContentType: "application/json",
            }).pipe(Effect.orDie),
          ),
        ),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "POST" && pathname === "/deploy") {
          const body = (yield* request.json) as unknown as {
            version: string;
          };
          const started = yield* startDeployment({
            ConfigurationVersion: body.version,
          });
          return yield* HttpServerResponse.json({
            deploymentNumber: started.DeploymentNumber,
            state: started.State,
          });
        }

        if (request.method === "GET" && pathname === "/event") {
          const number = url.searchParams.get("number");
          const type = url.searchParams.get("type");
          return yield* getObject({
            Key: `events/${number}-${type}.json`,
          }).pipe(
            Effect.flatMap((result) =>
              Stream.mkString(Stream.decodeText(result.Body!)),
            ),
            Effect.flatMap((text) =>
              HttpServerResponse.json({ event: JSON.parse(text) }),
            ),
            // Notification not delivered yet — the test polls until it is.
            Effect.catchTag("NoSuchKey", () =>
              HttpServerResponse.json({ event: null }, { status: 404 }),
            ),
          );
        }

        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
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
        Lambda.AppConfigDeploymentEventSource,
        AppConfig.StartDeploymentHttp,
        S3.PutObjectHttp,
        S3.GetObjectHttp,
      ),
    ),
  ),
);
