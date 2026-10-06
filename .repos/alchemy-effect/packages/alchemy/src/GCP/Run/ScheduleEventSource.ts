import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Job } from "../CloudScheduler/Job.ts";
import {
  ScheduleEventSource as SchedulerScheduleEventSource,
  type ScheduledEvent,
  type ScheduleEventSourceProps,
  type ScheduleEventSourceService,
} from "../CloudScheduler/ScheduleEventSource.ts";
import {
  deliveryAudience,
  grantSelfInvoker,
  hostEndpoint,
  listenForDeliveries,
  pathSegment,
  pushHost,
} from "../PushDelivery.ts";

/** Default delivery path for a schedule. */
export const schedulePushPath = (id: string, props: ScheduleEventSourceProps) =>
  props.path ?? `/__alchemy/scheduler/${pathSegment(id)}`;

/**
 * Implementation of `GCP.CloudScheduler.ScheduleEventSource` for HTTP
 * hosts (`GCP.Run.Service` / `GCP.Function`, `GCP.CloudFunctions.Function`).
 *
 * Deploy-time: grants the host's runtime service account
 * `roles/run.invoker` on the host and creates a Cloud Scheduler job that
 * `POST`s to the host's URL with an OIDC token for that account. Runtime:
 * claims the job's deliveries on its path, verifies the token, and runs
 * the handler with the `X-CloudScheduler-*` headers. 204 marks the run
 * successful; a failed handler answers 500 and the job's retry policy
 * applies.
 *
 * ### Running on a schedule
 * **Example:** Every 5 minutes
 * ```typescript
 * Effect.gen(function* () {
 *   yield* GCP.CloudScheduler.consumeSchedule(
 *     "Sweep",
 *     { schedule: "every 5 minutes" },
 *     (event) => Effect.log(`sweep ${event.scheduleTime}`),
 *   );
 * }).pipe(Effect.provide(GCP.Run.ScheduleEventSource));
 * ```
 *
 * @layer
 * @provides GCP.CloudScheduler.ScheduleEventSource
 * @category Run
 */
export const ScheduleEventSource = Layer.effect(
  SchedulerScheduleEventSource,
  Effect.gen(function* () {
    const jobs = yield* Job;

    return Effect.fn(function* <Req = never>(
      id: string,
      props: ScheduleEventSourceProps,
      process: (event: ScheduledEvent) => Effect.Effect<void, never, Req>,
    ) {
      const host = yield* pushHost("GCP.CloudScheduler.ScheduleEventSource");
      const path = schedulePushPath(id, props);

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const endpoint = hostEndpoint(host);
        yield* Namespace.push(
          host.LogicalId,
          Effect.gen(function* () {
            yield* grantSelfInvoker(host);
            yield* jobs(`${id}-Schedule`, {
              location: props.location,
              schedule: props.schedule,
              timeZone: props.timeZone,
              retryConfig: props.retryConfig ?? {
                retryCount: 5,
                minBackoffDuration: "10s",
                maxBackoffDuration: "120s",
              },
              httpTarget: {
                uri: Output.interpolate`${endpoint.url}${path}`,
                httpMethod: "POST",
                body: props.body,
                oidcToken: {
                  serviceAccountEmail: endpoint.serviceAccount,
                  audience: deliveryAudience(endpoint.url, path),
                },
              },
            });
          }),
        );
      }

      yield* listenForDeliveries(host, path, (request) =>
        Effect.gen(function* () {
          const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
          yield* process({
            scheduleTime:
              request.headers["x-cloudscheduler-scheduletime"] ?? "",
            jobName: request.headers["x-cloudscheduler-jobname"] ?? "",
            body: body.length > 0 ? body : undefined,
          }).pipe(Effect.orDie);
          return HttpServerResponse.empty({ status: 204 });
        }),
      );
    }) as ScheduleEventSourceService;
  }),
);
