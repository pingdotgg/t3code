import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { IsolatedSandbox } from "./sandbox.ts";

/**
 * Lambda orchestrator for {@link IsolatedSandbox}: `POST /rpc` runs one
 * MicroVM, waits for RUNNING, calls the in-VM `hello` RPC and the `/echo`
 * fetch route over the MicroVM endpoint, and always terminates the VM.
 */
export default class IsolatedOrchestrator extends AWS.Lambda.Function<IsolatedOrchestrator>()(
  "IsolatedProjectMicrovmOrchestrator",
  {
    main: import.meta.filename,
    // The `/rpc` route waits for the MicroVM to reach RUNNING and then
    // connects to it synchronously within the one invocation.
    timeout: Duration.seconds(120),
    functionUrl: true,
  },
  Effect.gen(function* () {
    const runMicrovm = yield* AWS.Lambda.RunMicrovm(IsolatedSandbox);
    const getMicrovm = yield* AWS.Lambda.GetMicrovm(IsolatedSandbox);
    const terminateMicrovm =
      yield* AWS.Lambda.TerminateMicrovm(IsolatedSandbox);
    const createAuthToken = yield* AWS.Lambda.CreateAuthToken(IsolatedSandbox);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "POST" && url.pathname === "/rpc") {
          const message = url.searchParams.get("message") ?? "world";
          const vm = yield* runMicrovm({
            idlePolicy: {
              maxIdleDurationSeconds: 900,
              suspendedDurationSeconds: 300,
              autoResumeEnabled: true,
            },
          });
          // Always terminate the MicroVM we launched — on success OR failure
          // — so a failing step never leaks a running MicroVM.
          return yield* Effect.gen(function* () {
            yield* getMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
              Effect.flatMap((m) =>
                m.state === "RUNNING"
                  ? Effect.void
                  : Effect.fail(new Error(`microvm ${m.state}`)),
              ),
              Effect.retry({
                schedule: Schedule.spaced("2 seconds"),
                times: 30,
              }),
              Effect.orDie,
            );
            const { authToken } = yield* createAuthToken({
              microvmIdentifier: vm.microvmId,
              expirationInMinutes: 5,
              allowedPorts: [{ port: 8080 }],
            });

            const sandbox = yield* AWS.Lambda.connectMicrovm(IsolatedSandbox, {
              endpoint: vm.endpoint,
              authToken,
            });
            const reply = yield* sandbox.hello(message).pipe(
              Effect.retry({
                schedule: Schedule.exponential("500 millis"),
                times: 8,
              }),
              Effect.orDie,
            );

            const client = yield* HttpClient.HttpClient;
            const headers = AWS.Lambda.microvmAuthHeaders(authToken);
            const echoRes = yield* client
              .get(
                `https://${vm.endpoint}/echo?message=${encodeURIComponent(message)}`,
                { headers },
              )
              .pipe(
                Effect.retry({
                  schedule: Schedule.exponential("500 millis"),
                  times: 8,
                }),
                Effect.orDie,
              );
            const echo = (yield* echoRes.json.pipe(Effect.orDie)) as {
              message: string;
            };

            return yield* HttpServerResponse.json({
              reply,
              echo: echo.message,
            });
          }).pipe(
            Effect.ensuring(
              terminateMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
                Effect.ignore,
              ),
            ),
            Effect.provide(FetchHttpClient.layer),
          );
        }

        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Lambda.RunMicrovmHttp,
        AWS.Lambda.GetMicrovmHttp,
        AWS.Lambda.TerminateMicrovmHttp,
        AWS.Lambda.CreateAuthTokenHttp,
      ),
    ),
  ),
) {}
