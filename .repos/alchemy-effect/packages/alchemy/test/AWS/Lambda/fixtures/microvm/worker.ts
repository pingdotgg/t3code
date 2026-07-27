import * as AWS from "@/AWS";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Sandbox } from "./sandbox.ts";

/**
 * Cloudflare Worker orchestrator — the cross-cloud analog of the Lambda
 * {@link import("./orchestrator.ts")} fixture. It binds the AWS MicroVM
 * instance operations to the {@link Sandbox} image and exposes one HTTP route
 * per operation.
 *
 * Because a Worker has no AWS execution role, binding these operations causes
 * Alchemy to provision an IAM User + AccessKey + assume-role Role (once for the
 * worker) and assume that role at runtime — see `MicrovmBinding.ts`.
 */
export default Cloudflare.Worker(
  "MicrovmWorker",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const runMicrovm = yield* AWS.Lambda.RunMicrovm(Sandbox);
    const getMicrovm = yield* AWS.Lambda.GetMicrovm(Sandbox);
    const listMicrovms = yield* AWS.Lambda.ListMicrovms(Sandbox);
    const terminateMicrovm = yield* AWS.Lambda.TerminateMicrovm(Sandbox);
    const createAuthToken = yield* AWS.Lambda.CreateAuthToken(Sandbox);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://microvm");
        const pathname = url.pathname;

        if (request.method === "POST" && pathname === "/run") {
          const vm = yield* runMicrovm({
            idlePolicy: {
              maxIdleDurationSeconds: 900,
              suspendedDurationSeconds: 300,
              autoResumeEnabled: true,
            },
          });
          return yield* HttpServerResponse.json({
            microvmId: vm.microvmId,
            endpoint: vm.endpoint,
            state: vm.state,
          });
        }

        if (request.method === "GET" && pathname === "/get") {
          const id = url.searchParams.get("id")!;
          const vm = yield* getMicrovm({ microvmIdentifier: id });
          return yield* HttpServerResponse.json({ state: vm.state });
        }

        if (request.method === "GET" && pathname === "/list") {
          const { items } = yield* listMicrovms({});
          return yield* HttpServerResponse.json({ count: items.length });
        }

        if (request.method === "POST" && pathname === "/auth-token") {
          const id = url.searchParams.get("id")!;
          const { authToken } = yield* createAuthToken({
            microvmIdentifier: id,
            expirationInMinutes: 5,
            allowedPorts: [{ port: 8080 }],
          });
          return yield* HttpServerResponse.json({
            hasToken: Object.keys(authToken).length > 0,
          });
        }

        if (request.method === "POST" && pathname === "/terminate") {
          const id = url.searchParams.get("id")!;
          yield* terminateMicrovm({ microvmIdentifier: id });
          return yield* HttpServerResponse.json({ ok: true });
        }

        // Run a MicroVM, then exercise BOTH the in-VM tagged-RPC server (the
        // `hello` method) and its raw `fetch` handler (the `/echo` route)
        // end-to-end over the MicroVM endpoint — entirely from a Worker, using
        // assume-role credentials.
        if (request.method === "POST" && pathname === "/rpc") {
          const message = url.searchParams.get("message") ?? "world";
          const vm = yield* runMicrovm({
            idlePolicy: {
              maxIdleDurationSeconds: 900,
              suspendedDurationSeconds: 300,
              autoResumeEnabled: true,
            },
          });
          // Always terminate the MicroVM we launched — on success OR failure.
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

            // RPC path: typed stub → `hello`.
            const sandbox = yield* AWS.Lambda.connectMicrovm(Sandbox, {
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

            // fetch path: raw HTTPS GET to the in-VM `/echo` route.
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
        AWS.Lambda.ListMicrovmsHttp,
        AWS.Lambda.TerminateMicrovmHttp,
        AWS.Lambda.CreateAuthTokenHttp,
      ),
    ),
  ),
);
