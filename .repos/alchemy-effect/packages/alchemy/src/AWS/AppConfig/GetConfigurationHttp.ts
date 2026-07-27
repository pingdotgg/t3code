import * as appconfigdata from "@distilled.cloud/aws/appconfigdata";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import { AWSEnvironment } from "../Environment.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Application } from "./Application.ts";
import type { ConfigurationProfile } from "./ConfigurationProfile.ts";
import type { Environment } from "./Environment.ts";
import {
  GetConfiguration,
  type GetConfigurationOptions,
} from "./GetConfiguration.ts";

interface SessionCache {
  token: string | undefined;
  lastContent: string | undefined;
  lastContentType: string | undefined;
  lastVersionLabel: string | undefined;
}

/**
 * HTTP implementation of the {@link GetConfiguration} binding. Calls the
 * AppConfig data plane (`StartConfigurationSession` +
 * `GetLatestConfiguration`) with the Lambda's IAM role, caching the poll
 * token and last-seen content across calls.
 *
 * Provide it on the hosting Lambda function's Effect so the binding is
 * available at runtime:
 *
 * @example
 * ```typescript
 * export default MyFunction.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const getConfig = yield* AppConfig.GetConfiguration(app, env, profile);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { content } = yield* getConfig().pipe(Effect.orDie);
 *         return HttpServerResponse.text(content ?? "");
 *       }),
 *     };
 *   }).pipe(Effect.provide(AppConfig.GetConfigurationHttp)),
 * );
 * ```
 */
export const GetConfigurationHttp = Layer.effect(
  GetConfiguration,
  Effect.gen(function* () {
    const startSession = yield* appconfigdata.startConfigurationSession;
    const getLatest = yield* appconfigdata.getLatestConfiguration;

    return Effect.fn(function* (
      application: Application,
      environment: Environment,
      configurationProfile: ConfigurationProfile,
      options?: GetConfigurationOptions,
    ) {
      // Outputs yield DEFERRED effects — resolve again per invocation below.
      const ApplicationId = yield* application.applicationId;
      const EnvironmentId = yield* environment.environmentId;
      const ConfigurationProfileId =
        yield* configurationProfile.configurationProfileId;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const { accountId, region } =
            yield* AWSEnvironment.current as unknown as Effect.Effect<{
              accountId: string;
              region: string;
            }>;
          yield* host.bind`Allow(${host}, AWS.AppConfig.GetConfiguration(${application}, ${environment}, ${configurationProfile}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [
                    "appconfig:StartConfigurationSession",
                    "appconfig:GetLatestConfiguration",
                  ],
                  Resource: [
                    Output.interpolate`arn:aws:appconfig:${region}:${accountId}:application/${application.applicationId}/environment/${environment.environmentId}/configuration/${configurationProfile.configurationProfileId}`,
                  ],
                },
              ],
            },
          );
        }
      }

      const cache = yield* Ref.make<SessionCache>({
        token: undefined,
        lastContent: undefined,
        lastContentType: undefined,
        lastVersionLabel: undefined,
      });

      return Effect.fn(
        `AWS.AppConfig.GetConfiguration(${application.LogicalId}, ${environment.LogicalId}, ${configurationProfile.LogicalId})`,
      )(function* () {
        const applicationId = yield* ApplicationId;
        const environmentId = yield* EnvironmentId;
        const configurationProfileId = yield* ConfigurationProfileId;

        let state = yield* Ref.get(cache);
        if (state.token === undefined) {
          const session = yield* startSession({
            ApplicationIdentifier: applicationId,
            EnvironmentIdentifier: environmentId,
            ConfigurationProfileIdentifier: configurationProfileId,
            RequiredMinimumPollIntervalInSeconds: toWireSeconds(
              options?.requiredMinimumPollInterval,
            ),
          });
          state = { ...state, token: session.InitialConfigurationToken };
        }

        const response = yield* getLatest({
          ConfigurationToken: state.token!,
        });

        // Each token is single-use; the response hands back the next one.
        const nextToken = response.NextPollConfigurationToken ?? state.token;

        // Decoding the (already-buffered) config body only fails on a
        // corrupt payload — a defect, not part of the operation's typed union.
        const fetched = response.Configuration
          ? yield* Stream.mkString(
              Stream.decodeText(response.Configuration),
            ).pipe(Effect.orDie)
          : "";

        // An empty body means "unchanged" — keep the last-seen content.
        const content = fetched.length > 0 ? fetched : state.lastContent;
        const contentType = response.ContentType ?? state.lastContentType;
        const versionLabel = response.VersionLabel ?? state.lastVersionLabel;

        yield* Ref.set(cache, {
          token: nextToken,
          lastContent: content,
          lastContentType: contentType,
          lastVersionLabel: versionLabel,
        });

        return { content, contentType, versionLabel };
      });
    });
  }),
);
