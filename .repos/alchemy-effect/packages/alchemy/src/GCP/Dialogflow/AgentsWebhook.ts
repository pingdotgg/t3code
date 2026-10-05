import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectionParent,
  DEFAULT_LOCATION,
  encodeOwnershipLine,
  expandAgent,
  fingerprint,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  locationOf,
  namedAgents,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  projectOf,
  sameText,
  toResourceId,
  updateMaskOf,
  retryQuota,
} from "./internal.ts";

export type WebhookHttpMethod =
  | "HTTP_METHOD_UNSPECIFIED"
  | "POST"
  | "GET"
  | "HEAD"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "OPTIONS";

export type WebhookType = "WEBHOOK_TYPE_UNSPECIFIED" | "STANDARD" | "FLEXIBLE";

export type WebhookServiceAgentAuth =
  | "SERVICE_AGENT_AUTH_UNSPECIFIED"
  | "NONE"
  | "ID_TOKEN"
  | "ACCESS_TOKEN";

export type WebhookOAuthConfig = {
  /** OAuth token endpoint. */
  tokenEndpoint?: string;
  /** OAuth client id. */
  clientId?: string;
  /** OAuth client secret. Prefer `secretVersionForClientSecret`. */
  clientSecret?: string;
  /** Secret Manager version holding the client secret. */
  secretVersionForClientSecret?: string;
  /** OAuth scopes. */
  scopes?: string[];
};

export type WebhookGenericWebService = {
  /** HTTPS URI of the webhook. Required for generic web service. */
  uri?: string;
  /** HTTP method. Defaults to POST for STANDARD webhooks. */
  httpMethod?: WebhookHttpMethod | (string & {});
  /** Webhook type. */
  webhookType?: WebhookType | (string & {});
  /** Request headers. */
  requestHeaders?: Record<string, string>;
  /** Secret Manager versions used as request headers. */
  secretVersionsForRequestHeaders?: Record<
    string,
    { secretVersion?: string } | undefined
  >;
  /** Allowed CA certificates (DER, base64). */
  allowedCaCerts?: string[];
  /** OAuth client-credentials config. */
  oauthConfig?: WebhookOAuthConfig;
  /** Auth token minted from the Dialogflow service agent. */
  serviceAgentAuth?: WebhookServiceAgentAuth | (string & {});
  /** Service account used to generate ID tokens. */
  serviceAccountAuthConfig?: { serviceAccount?: string };
  /** Custom request body (FLEXIBLE webhooks). */
  requestBody?: string;
  /** Map webhook response fields onto session parameters (FLEXIBLE). */
  parameterMapping?: Record<string, string>;
  /** Secret Manager version holding username:password. */
  secretVersionForUsernamePassword?: string;
};

export type WebhookServiceDirectoryConfig = {
  /** Service Directory service resource name. */
  service?: string;
  /** Generic web service settings used with Service Directory. */
  genericWebService?: WebhookGenericWebService;
};

export type AgentsWebhookProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}` or a bare
   * agent id (combined with `location`). Immutable — changing it
   * replaces the webhook.
   */
  agent: string;
  /**
   * Webhook id (the `{webhook}` segment). Server-assigned on create.
   * Immutable — changing it replaces the webhook.
   */
  webhookId?: string;
  /**
   * Location used when `agent` is a bare id.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name, unique within the agent. Webhooks have no
   * labels field, so Alchemy stamps ownership into this field for
   * `list` / nuke.
   */
  displayName?: string;
  /**
   * Webhook execution timeout (e.g. `"5s"`). Execution fails if
   * Dialogflow does not receive a response before the timeout.
   */
  timeout?: string;
  /**
   * When true, the webhook is not called.
   * @default false
   */
  disabled?: boolean;
  /**
   * Generic HTTPS webhook configuration. Mutually exclusive with
   * `serviceDirectory`.
   */
  genericWebService?: WebhookGenericWebService;
  /**
   * Service Directory webhook configuration. Mutually exclusive with
   * `genericWebService`.
   */
  serviceDirectory?: WebhookServiceDirectoryConfig;
};

export type AgentsWebhook = Resource<
  "GCP.Dialogflow.AgentsWebhook",
  AgentsWebhookProps,
  {
    /** Full resource name `.../agents/{agent}/webhooks/{webhook}`. */
    name: string;
    /** Webhook id (last path segment). */
    webhookId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Execution timeout. */
    timeout: string | undefined;
    /** Whether the webhook is disabled. */
    disabled: boolean;
    /** Generic HTTPS webhook configuration. */
    genericWebService: WebhookGenericWebService | undefined;
    /** Service Directory webhook configuration. */
    serviceDirectory: WebhookServiceDirectoryConfig | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX webhook that hosts fulfillment business logic.
 *
 * Webhooks have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent agent and id are immutable.
 * Display name, timeout, disabled flag, and webhook config update in
 * place.
 *
 * ### Creating a Webhook
 * **Example:** Generic HTTPS webhook
 * ```typescript
 * const webhook = yield* GCP.Dialogflow.AgentsWebhook("Fulfillment", {
 *   agent: agent.name,
 *   displayName: "orders",
 *   genericWebService: { uri: "https://example.com/dialogflow" },
 * });
 * ```
 *
 * ### Updating a Webhook
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Disable and retarget
 * ```typescript
 * const webhook = yield* GCP.Dialogflow.AgentsWebhook("Fulfillment", {
 *   agent: agent.name,
 *   displayName: "orders-v2",
 *   disabled: true,
 *   genericWebService: { uri: "https://example.com/dialogflow-v2" },
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsWebhook = Resource<AgentsWebhook>(
  "GCP.Dialogflow.AgentsWebhook",
);

export class AgentsWebhookNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsWebhookNotResolved",
)<{
  name: string;
}> {}

const resourceName = (agent: string, webhookId: string) =>
  `${agent}/webhooks/${webhookId}`;

const stringMapOf = (
  value: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
};

const genericOf = (
  service:
    | dialogflow.GoogleCloudDialogflowCxV3WebhookGenericWebService
    | undefined,
): WebhookGenericWebService | undefined => {
  if (service === undefined) return undefined;
  return {
    uri: service.uri,
    httpMethod: service.httpMethod,
    webhookType: service.webhookType,
    requestHeaders: stringMapOf(service.requestHeaders),
    secretVersionsForRequestHeaders: service.secretVersionsForRequestHeaders,
    allowedCaCerts: service.allowedCaCerts
      ? [...service.allowedCaCerts]
      : undefined,
    oauthConfig: service.oauthConfig
      ? {
          tokenEndpoint: service.oauthConfig.tokenEndpoint,
          clientId: service.oauthConfig.clientId,
          clientSecret: service.oauthConfig.clientSecret,
          secretVersionForClientSecret:
            service.oauthConfig.secretVersionForClientSecret,
          scopes: service.oauthConfig.scopes
            ? [...service.oauthConfig.scopes]
            : undefined,
        }
      : undefined,
    serviceAgentAuth: service.serviceAgentAuth,
    serviceAccountAuthConfig: service.serviceAccountAuthConfig
      ? { serviceAccount: service.serviceAccountAuthConfig.serviceAccount }
      : undefined,
    requestBody: service.requestBody,
    parameterMapping: stringMapOf(service.parameterMapping),
    secretVersionForUsernamePassword: service.secretVersionForUsernamePassword,
  };
};

const directoryOf = (
  config:
    | dialogflow.GoogleCloudDialogflowCxV3WebhookServiceDirectoryConfig
    | undefined,
): WebhookServiceDirectoryConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    service: config.service,
    genericWebService: genericOf(config.genericWebService),
  };
};

const toAttrs = (
  webhook: dialogflow.GoogleCloudDialogflowCxV3Webhook,
  project: string,
  agentHint?: string,
) => {
  const name = webhook.name ?? "";
  return {
    name,
    webhookId: lastSegment(name),
    agent: name.includes("/webhooks/")
      ? collectionParent(name, "agents")
      : (agentHint ?? parentOf(name)),
    project: projectOf(name) || project,
    location: locationOf(name),
    displayName: parseOwnership(webhook.displayName).text,
    timeout: webhook.timeout,
    disabled: webhook.disabled === true,
    genericWebService: genericOf(webhook.genericWebService),
    serviceDirectory: directoryOf(webhook.serviceDirectory),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsWebhooks({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsAgentsWebhooks
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.webhooks ?? [])),
      Stream.filter((webhook) => hasOwnershipMarker(webhook.displayName)),
      Stream.map((webhook) => toAttrs(webhook, project, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  dialogflow.listProjectsLocationsAgentsWebhooks
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.webhooks ?? [])),
      Stream.filter((webhook) => webhook.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const AgentsWebhookProvider = () =>
  Provider.succeed(AgentsWebhook, {
    stables: ["name", "webhookId", "agent", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      if (previousAgent !== undefined && news.agent !== previousAgent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.webhookId ?? output?.webhookId;
      if (
        previousId !== undefined &&
        news.webhookId !== undefined &&
        news.webhookId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(news.location)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const agent = olds?.agent
        ? expandAgent(olds.agent, env.project, location)
        : output?.agent;
      const webhookId = yield* toResourceId(
        id,
        olds?.webhookId,
        output?.webhookId,
      );
      const name =
        output?.name ??
        (agent !== undefined ? resourceName(agent, webhookId) : "");
      let existing = yield* getByName(name);
      if (existing === undefined && agent !== undefined) {
        const ownership = yield* internalLabels(id);
        existing = yield* findByDisplayName(
          agent,
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, agent);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* namedAgents(env.project);
        const pages = yield* Effect.forEach(
          agents,
          (agent) => listAt(agent.name, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const agent = expandAgent(news.agent, env.project, location);
      const webhookId = yield* toResourceId(
        id,
        news.webhookId,
        output?.webhookId,
      );
      const name = output?.name ?? resourceName(agent, webhookId);
      const ownership = yield* internalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const disabled = news.disabled === true;
      const body: dialogflow.GoogleCloudDialogflowCxV3Webhook = {
        displayName,
        timeout: news.timeout,
        disabled,
        genericWebService: news.genericWebService,
        serviceDirectory: news.serviceDirectory,
      };

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findByDisplayName(agent, displayName);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsWebhooks({
            parent: agent,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(agent, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsWebhookNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const timeoutChanged = !sameText(current.timeout, news.timeout);
      const disabledChanged = (current.disabled === true) !== disabled;
      const genericChanged =
        fingerprint(genericOf(current.genericWebService)) !==
        fingerprint(news.genericWebService);
      const directoryChanged =
        fingerprint(directoryOf(current.serviceDirectory)) !==
        fingerprint(news.serviceDirectory);

      if (
        displayChanged ||
        timeoutChanged ||
        disabledChanged ||
        genericChanged ||
        directoryChanged
      ) {
        current = yield* dialogflow.patchProjectsLocationsAgentsWebhooks({
          name: currentName,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            timeoutChanged ? "timeout" : undefined,
            disabledChanged ? "disabled" : undefined,
            genericChanged ? "generic_web_service" : undefined,
            directoryChanged ? "service_directory" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project, agent);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsWebhooks({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });
