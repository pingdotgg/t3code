import * as AppConfig from "@/AWS/AppConfig";
import * as Lambda from "@/AWS/Lambda";
import * as Output from "@/Output";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const CONFIG = { featureX: true, limit: 42 } as const;

export class AppConfigTestFunction extends Lambda.Function<Lambda.Function>()(
  "AppConfigTestFunction",
) {}

export default AppConfigTestFunction.make(
  {
    main,
    url: true,
    // Starting a configuration session + fetching config fans out two SDK
    // calls; AWS's 3s default intermittently times out on a cold start.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const app = yield* AppConfig.Application("App", {});
    const env = yield* AppConfig.Environment("Env", {
      applicationId: app.applicationId,
    });
    const profile = yield* AppConfig.ConfigurationProfile("Profile", {
      applicationId: app.applicationId,
      locationUri: "hosted",
    });
    const version = yield* AppConfig.HostedConfigurationVersion("V1", {
      applicationId: app.applicationId,
      configurationProfileId: profile.configurationProfileId,
      content: JSON.stringify(CONFIG),
      contentType: "application/json",
    });
    const strategy = yield* AppConfig.DeploymentStrategy("AllAtOnce", {
      deploymentDuration: 0,
      growthFactor: 100,
      finalBakeTime: 0,
      replicateTo: "NONE",
    });
    // A deliberately slow strategy so a rollout can be stopped mid-flight.
    const slowStrategy = yield* AppConfig.DeploymentStrategy("Slow", {
      deploymentDuration: "20 minutes",
      growthFactor: 5,
      growthType: "LINEAR",
      finalBakeTime: 0,
      replicateTo: "NONE",
    });
    // Deploy the version to the environment so the data plane can serve it.
    yield* AppConfig.Deployment("Deploy", {
      applicationId: app.applicationId,
      environmentId: env.environmentId,
      deploymentStrategyId: strategy.deploymentStrategyId,
      configurationProfileId: profile.configurationProfileId,
      configurationVersion: Output.interpolate`${version.versionNumber}`,
    });

    const getConfig = yield* AppConfig.GetConfiguration(app, env, profile);
    const createVersion = yield* AppConfig.CreateHostedConfigurationVersion(
      app,
      profile,
    );
    const startDeployment = yield* AppConfig.StartDeployment(
      app,
      env,
      profile,
      strategy,
    );
    const startSlowDeployment = yield* AppConfig.StartDeployment(
      app,
      env,
      profile,
      slowStrategy,
    );
    const getDeployment = yield* AppConfig.GetDeployment(app, env);
    const stopDeployment = yield* AppConfig.StopDeployment(app, env);
    const validateConfiguration = yield* AppConfig.ValidateConfiguration(
      app,
      profile,
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/config") {
          const result = yield* getConfig();
          return yield* HttpServerResponse.json({
            content: result.content,
            contentType: result.contentType,
          });
        }

        if (request.method === "POST" && pathname === "/version") {
          const body = (yield* request.json) as unknown as {
            content: string;
          };
          const created = yield* createVersion({
            Content: body.content,
            ContentType: "application/json",
          });
          return yield* HttpServerResponse.json({
            versionNumber: created.VersionNumber,
          });
        }

        if (request.method === "POST" && pathname === "/deploy") {
          const body = (yield* request.json) as unknown as {
            version: string;
            slow?: boolean;
          };
          const started = yield* (
            body.slow ? startSlowDeployment : startDeployment
          )({
            ConfigurationVersion: body.version,
          });
          return yield* HttpServerResponse.json({
            deploymentNumber: started.DeploymentNumber,
            state: started.State,
          });
        }

        if (request.method === "GET" && pathname === "/deployment") {
          const number = Number(
            new URL(request.originalUrl).searchParams.get("number"),
          );
          const deployment = yield* getDeployment({
            DeploymentNumber: number,
          });
          return yield* HttpServerResponse.json({
            state: deployment.State,
            percentageComplete: deployment.PercentageComplete,
            configurationVersion: deployment.ConfigurationVersion,
          });
        }

        if (request.method === "POST" && pathname === "/stop") {
          const body = (yield* request.json) as unknown as {
            number: number;
          };
          const stopped = yield* stopDeployment({
            DeploymentNumber: body.number,
          });
          return yield* HttpServerResponse.json({ state: stopped.State });
        }

        if (request.method === "POST" && pathname === "/validate") {
          const body = (yield* request.json) as unknown as {
            version: string;
          };
          yield* validateConfiguration({
            ConfigurationVersion: body.version,
          });
          return yield* HttpServerResponse.json({ valid: true });
        }

        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(
        // Surface failures as a 500 whose body carries the cause so the
        // test's transient-retry error logs show WHAT failed in the Lambda.
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(
              `${Cause.pretty(cause)}\n${JSON.stringify(Cause.squash(cause))}`,
              { status: 500 },
            ),
          ),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AppConfig.GetConfigurationHttp,
        AppConfig.CreateHostedConfigurationVersionHttp,
        AppConfig.StartDeploymentHttp,
        AppConfig.GetDeploymentHttp,
        AppConfig.StopDeploymentHttp,
        AppConfig.ValidateConfigurationHttp,
      ),
    ),
  ),
);
