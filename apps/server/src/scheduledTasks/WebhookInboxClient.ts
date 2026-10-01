import { RelayApi, type RelayWebhookInbox } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

export class WebhookInboxClientError extends Schema.TaggedError<WebhookInboxClientError>()(
  "WebhookInboxClientError",
  {
    reason: Schema.Literals(["not_linked", "request_failed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "not_linked"
      ? "Webhook automations need this machine linked to T3 Connect with remote access."
      : "Could not reach T3 Connect.";
  }
}

/**
 * Webhook inboxes live on the T3 Connect relay, which pushes their deliveries
 * to this machine over its managed tunnel (see the `webhookDelivery` handler).
 */
export class WebhookInboxClient extends Context.Service<
  WebhookInboxClient,
  {
    readonly create: Effect.Effect<RelayWebhookInbox, WebhookInboxClientError>;
    readonly remove: (inboxId: string) => Effect.Effect<void, WebhookInboxClientError>;
  }
>()("t3/scheduledTasks/WebhookInboxClient") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

  const readSecretString = (name: string) =>
    secrets.get(name).pipe(
      Effect.map((bytes) => (Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : "")),
      Effect.orElseSucceed(() => ""),
    );

  // Read per call: linking, relinking and unlinking all happen while the server runs.
  const relay = Effect.gen(function* () {
    const [url, credential, endpointRuntimeConfig] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      readSecretString(CLOUD_ENDPOINT_RUNTIME_CONFIG),
    ]);
    // Deliveries arrive over the managed tunnel, so a publish-only link cannot receive them.
    if (!url || !credential || !endpointRuntimeConfig) {
      return yield* new WebhookInboxClientError({ reason: "not_linked" });
    }
    const client = yield* HttpApiClient.make(RelayApi, {
      baseUrl: url,
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.setHeader("authorization", `Bearer ${credential}`),
      ),
    }).pipe(Effect.provide(FetchHttpClient.layer));
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    return { server: client.server, params: { environmentId } };
  });

  const requestFailed = (cause: unknown) =>
    new WebhookInboxClientError({ reason: "request_failed", cause });

  return WebhookInboxClient.of({
    create: relay.pipe(
      Effect.flatMap(({ server, params }) =>
        server.createWebhookInbox({ params }).pipe(Effect.mapError(requestFailed)),
      ),
    ),
    remove: (inboxId) =>
      relay.pipe(
        Effect.flatMap(({ server, params }) =>
          server
            .deleteWebhookInbox({ params: { ...params, inboxId } })
            .pipe(Effect.mapError(requestFailed)),
        ),
        Effect.asVoid,
      ),
  });
});

export const layer = Layer.effect(WebhookInboxClient, make);
