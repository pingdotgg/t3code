import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import { AwsV4Signer } from "aws4fetch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  GraphQL,
  GraphQLApiError,
  type GraphQLClient,
  type GraphQLRequest,
  type GraphQLResult,
} from "./GraphQL.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

/**
 * HTTP implementation of the {@link GraphQL} binding. The AppSync data
 * plane has no SDK operation — each request is a SigV4-signed POST
 * (service `"appsync"`) to the API's `graphqlUrl`, made with the host
 * Function's own credentials. Grants `appsync:GraphQL` on every field of
 * the bound API (`{apiArn}/types/*&#47;fields/*`).
 */
export const GraphQLHttp = Layer.effect(
  GraphQL,
  Effect.gen(function* () {
    // Resolve the ambient distilled context once at layer construction —
    // credentials themselves are re-read per request (SSO/STS rotate).
    const services = yield* Effect.context<
      Credentials.Credentials | Region.Region
    >();

    return Effect.fn(function* (api: GraphqlApi) {
      // Outputs yield DEFERRED effects — resolving them here registers the
      // attribute on the host environment; re-yield per invocation below.
      const GraphqlUrl = yield* api.graphqlUrl;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.AppSync.GraphQL(${api}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["appsync:GraphQL"],
                Resource: [Output.interpolate`${api.apiArn}/types/*/fields/*`],
              },
            ],
          });
        }
      }

      const execute = Effect.fn(`AWS.AppSync.GraphQL(${api.LogicalId})`)(
        function* (request: GraphQLRequest) {
          const url = new URL(yield* GraphqlUrl);
          const body = JSON.stringify({
            query: request.query,
            variables: request.variables,
            operationName: request.operationName,
          });

          // Sign for the API's own region, parsed from its endpoint.
          const { credentials, region } = yield* Effect.gen(function* () {
            const credentials = yield* yield* Credentials.Credentials;
            const region =
              /\.appsync-api\.([a-z0-9-]+)\.amazonaws\.com$/.exec(
                url.hostname,
              )?.[1] ?? (yield* yield* Region.Region);
            return { credentials, region };
          }).pipe(Effect.provideContext(services));

          const signer = new AwsV4Signer({
            method: "POST",
            url: url.toString(),
            headers: { "content-type": "application/json" },
            body,
            accessKeyId: Redacted.value(credentials.accessKeyId),
            secretAccessKey: Redacted.value(credentials.secretAccessKey),
            sessionToken: credentials.sessionToken
              ? Redacted.value(credentials.sessionToken)
              : undefined,
            service: "appsync",
            region,
            allHeaders: true,
          });
          const signed = yield* Effect.promise(() => signer.sign());

          const toError = (status: number) => (cause: unknown) =>
            new GraphQLApiError({
              status,
              body: cause instanceof Error ? cause.message : String(cause),
            });

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(signed.url.toString(), {
                method: signed.method,
                headers: signed.headers,
                body: signed.body as BodyInit | undefined,
              }),
            catch: toError(0),
          });
          const text = yield* Effect.tryPromise({
            try: () => response.text(),
            catch: toError(response.status),
          });
          if (response.status < 200 || response.status >= 300) {
            return yield* Effect.fail(
              new GraphQLApiError({ status: response.status, body: text }),
            );
          }
          return yield* Effect.try({
            try: () => JSON.parse(text) as GraphQLResult,
            catch: toError(response.status),
          });
        },
      );

      return { execute } as GraphQLClient;
    });
  }),
);
