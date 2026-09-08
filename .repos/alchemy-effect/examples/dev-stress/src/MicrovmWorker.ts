import * as AWS from "alchemy/AWS";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { PORTS } from "./ports.ts";
import { ShellMicrovm } from "./ShellImage.ts";
// <<VM_IMPORTS>>
// <</VM_IMPORTS>>

/**
 * The headline cross-cloud resource: a **Cloudflare Worker that mounts an
 * AWS Lambda MicroVM**.
 *
 * A Worker has no AWS execution role, so binding the MicroVM instance
 * operations makes Alchemy mint an IAM User + AccessKey + assume-role Role
 * once for this Worker and assume that role at runtime (see
 * `AWS/Lambda/MicrovmBinding.ts`). Under `alchemy dev` every one of those
 * calls resolves to the floci emulator from local `workerd`, over the
 * emulator's own TLS certificate.
 *
 * `GET /roundtrip?message=…` boots a MicroVM, waits for it to run, mints a
 * data-plane auth token, drives BOTH protocols the VM speaks (typed RPC and
 * a raw HTTPS route), and terminates the VM again — on success or failure.
 */
export default class MicrovmWorker extends Cloudflare.Worker<MicrovmWorker>()(
  "MicrovmWorker",
  {
    main: import.meta.url,
    dev: { port: PORTS.microvm, strictPort: true },
  },
  Effect.gen(function* () {
    const runMicrovm = yield* AWS.Lambda.RunMicrovm(ShellMicrovm);
    const getMicrovm = yield* AWS.Lambda.GetMicrovm(ShellMicrovm);
    const createAuthToken = yield* AWS.Lambda.CreateAuthToken(ShellMicrovm);
    const terminateMicrovm = yield* AWS.Lambda.TerminateMicrovm(ShellMicrovm);
    // <<VM_BINDINGS>>
    // <</VM_BINDINGS>>

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://microvm-worker");
        // <<VM_ROUTES>>
        // <</VM_ROUTES>>

        if (url.pathname !== "/roundtrip") {
          return HttpServerResponse.text("ok");
        }
        const message = url.searchParams.get("message") ?? "world";

        const vm = yield* runMicrovm({
          idlePolicy: {
            maxIdleDurationSeconds: 900,
            suspendedDurationSeconds: 300,
            autoResumeEnabled: true,
          },
        });

        return yield* Effect.gen(function* () {
          yield* getMicrovm({ microvmIdentifier: vm.microvmId }).pipe(
            Effect.flatMap((m) =>
              m.state === "RUNNING"
                ? Effect.void
                : Effect.fail(new Error(`microvm ${m.state}`)),
            ),
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 45 }),
            Effect.orDie,
          );
          const { authToken } = yield* createAuthToken({
            microvmIdentifier: vm.microvmId,
            expirationInMinutes: 5,
            allowedPorts: [{ port: 8080 }],
          });

          // Typed RPC into the VM.
          const sandbox = yield* AWS.Lambda.connectMicrovm(ShellMicrovm, {
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

          // Raw HTTPS into the same VM.
          const client = yield* HttpClient.HttpClient;
          const headers = AWS.Lambda.microvmAuthHeaders(authToken);
          const response = yield* client
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
          const echo = (yield* response.json.pipe(Effect.orDie)) as {
            marker: string;
            message: string;
          };

          return yield* HttpServerResponse.json({
            microvmId: vm.microvmId,
            reply,
            marker: echo.marker,
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
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Lambda.RunMicrovmHttp,
        AWS.Lambda.GetMicrovmHttp,
        AWS.Lambda.CreateAuthTokenHttp,
        AWS.Lambda.TerminateMicrovmHttp,
        // <<VM_LAYERS>>
        // <</VM_LAYERS>>
      ),
    ),
  ),
) {}
