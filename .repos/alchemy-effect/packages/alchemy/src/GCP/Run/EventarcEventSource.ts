import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import * as RemovalPolicy from "../../RemovalPolicy.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  EventarcEventSource as EventarcEventSourceTag,
  type CloudEvent,
  type EventarcEventSourceProps,
  type EventarcEventSourceService,
} from "../Eventarc/EventSource.ts";
import { Trigger, type EventFilter } from "../Eventarc/Trigger.ts";
import { bindGcpHost } from "../Host.ts";
import { Member } from "../IAM/Member.ts";
import {
  grantSelfInvoker,
  hostEndpoint,
  listenForDeliveries,
  pathSegment,
  pushHost,
} from "../PushDelivery.ts";

const lastSegment = (value: string) => value.split("/").pop() ?? value;

/** Default delivery path for an Eventarc subscription. */
export const eventarcPath = (id: string, props: EventarcEventSourceProps) =>
  props.path ?? `/__alchemy/eventarc/${pathSegment(id)}`;

const hasTypePrefix = (props: EventarcEventSourceProps, prefix: string) =>
  props.eventFilters.some(
    (filter) =>
      typeof filter === "object" &&
      "attribute" in filter &&
      filter.attribute === "type" &&
      typeof filter.value === "string" &&
      filter.value.startsWith(prefix),
  );

const isStorageEvent = (props: EventarcEventSourceProps) =>
  hasTypePrefix(props, "google.cloud.storage.");

/**
 * Firestore triggers reject an unset `eventDataContentType`, so default it
 * to the `application/protobuf` encoding `gcloud` uses.
 */
const eventDataContentType = (props: EventarcEventSourceProps) =>
  props.eventDataContentType ??
  (hasTypePrefix(props, "google.cloud.firestore.")
    ? "application/protobuf"
    : undefined);

/**
 * Decode a binary-mode CloudEvent delivery. JSON payloads are parsed,
 * `text/*` payloads stay strings, and anything else (e.g. the
 * `application/protobuf` Firestore events) is handed over as raw bytes.
 */
const toCloudEvent = (
  request: HttpServerRequest,
  body: Uint8Array,
): CloudEvent => {
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.startsWith("ce-") && typeof value === "string") {
      attributes[name.slice(3)] = value;
    }
  }
  const contentType = request.headers["content-type"] ?? "";
  let data: unknown = body;
  if (contentType.includes("json") || contentType.startsWith("text/")) {
    const text = new TextDecoder().decode(body);
    data = text;
    if (contentType.includes("json") && text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
  }
  return {
    id: attributes.id ?? "",
    type: attributes.type ?? "",
    source: attributes.source ?? "",
    subject: attributes.subject,
    time: attributes.time,
    attributes,
    data,
  };
};

/**
 * HTTP implementation of `GCP.Eventarc.EventSource` for `GCP.Run.Service`
 * / `GCP.Function` and `GCP.CloudFunctions.Function`.
 *
 * Deploy-time: grants the host's runtime service account
 * `roles/eventarc.eventReceiver` on the project and `roles/run.invoker` on
 * the host (and, for Cloud Storage events, the Storage service agent
 * `roles/pubsub.publisher` on the project, which direct Storage events
 * require), then creates the trigger with that account as its identity.
 * Each grant and the trigger block until GCP reports them in place and
 * healthy. Runtime: claims deliveries on the path, verifies the OIDC
 * token, decodes the binary-mode CloudEvent, and runs the handler; a 2xx
 * acks, a failed handler answers 500 and Eventarc redelivers.
 *
 * @layer
 * @provides GCP.Eventarc.EventSource
 * @category Run
 */
export const EventarcEventSource = Layer.effect(
  EventarcEventSourceTag,
  Effect.gen(function* () {
    const trigger = yield* Trigger;
    const member = yield* Member;

    return Effect.fn(function* <Req = never>(
      id: string,
      props: EventarcEventSourceProps,
      process: (event: CloudEvent) => Effect.Effect<void, never, Req>,
    ) {
      const host = yield* pushHost("GCP.Eventarc.EventSource");
      const path = eventarcPath(id, props);

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const endpoint = hostEndpoint(host);
        const attrs = host as unknown as Record<string, Output.Output<string>>;
        const env = yield* GcpEnvironment.current;
        // Requested through the host's own bindings, so the host's IAM sync
        // keeps it on every redeploy instead of revoking it as out of band.
        yield* bindGcpHost({
          tag: "GCP.Eventarc.EventSource",
          resource: { LogicalId: id },
          iam: [{ role: "roles/eventarc.eventReceiver" }],
        });
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* grantSelfInvoker(host);
            // Project-wide prerequisite shared by every Storage trigger and
            // notification in the project: retained, never revoked on destroy.
            const storageAgent = isStorageEvent(props)
              ? yield* member(`${id}-StorageAgentPublisher`, {
                  kind: "project",
                  name: env.project,
                  role: "roles/pubsub.publisher",
                  member: `serviceAccount:${
                    (yield* storage.getProjectsServiceAccount({
                      projectId: env.project,
                    })).email_address
                  }`,
                }).pipe(RemovalPolicy.retain())
              : undefined;
            yield* trigger(`${id}-Trigger`, {
              location: props.location ?? attrs.location,
              eventFilters: props.eventFilters as EventFilter[],
              eventDataContentType: eventDataContentType(props),
              // The host's service account resolves after the host (and its
              // IAM, including eventReceiver) is in place.
              serviceAccount:
                storageAgent === undefined
                  ? endpoint.serviceAccount
                  : Output.map(
                      Output.all(endpoint.serviceAccount, storageAgent.member),
                      ([email]) => email,
                    ),
              destination: {
                cloudRun: {
                  service: Output.map(endpoint.invokerService, lastSegment),
                  region: attrs.location!,
                  path,
                },
              },
            });
          }),
        );
      }

      yield* listenForDeliveries(host, path, (request) =>
        Effect.gen(function* () {
          const body = yield* request.arrayBuffer.pipe(
            Effect.map((buffer) => new Uint8Array(buffer)),
            Effect.orElseSucceed(() => new Uint8Array()),
          );
          yield* process(toCloudEvent(request, body)).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }),
      );
    }) as EventarcEventSourceService;
  }),
);
