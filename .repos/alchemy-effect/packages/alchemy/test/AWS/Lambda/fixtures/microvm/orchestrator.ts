import * as AWS from "@/AWS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Sandbox } from "./sandbox.ts";

/**
 * Lambda orchestrator — the AWS analog of a Durable Object driving a Cloudflare
 * Container. It binds the MicroVM instance operations to the {@link Sandbox}
 * image and exposes one HTTP route per operation so the test can drive the full
 * lifecycle over HTTP.
 */
export default class Orchestrator extends AWS.Lambda.Function<Orchestrator>()(
  "MicrovmOrchestrator",
  // Generous timeout: the `/rpc` route waits for the MicroVM to reach RUNNING
  // and then connects to it synchronously within the one invocation.
  {
    main: import.meta.filename,
    timeout: Duration.seconds(120),
    url: true,
  },
  Effect.gen(function* () {
    const runMicrovm = yield* AWS.Lambda.RunMicrovm(Sandbox);
    const getMicrovm = yield* AWS.Lambda.GetMicrovm(Sandbox);
    const listMicrovms = yield* AWS.Lambda.ListMicrovms(Sandbox);
    const suspendMicrovm = yield* AWS.Lambda.SuspendMicrovm(Sandbox);
    const resumeMicrovm = yield* AWS.Lambda.ResumeMicrovm(Sandbox);
    const terminateMicrovm = yield* AWS.Lambda.TerminateMicrovm(Sandbox);
    const createAuthToken = yield* AWS.Lambda.CreateAuthToken(Sandbox);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
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

        if (request.method === "POST" && pathname === "/suspend") {
          const id = url.searchParams.get("id")!;
          yield* suspendMicrovm({ microvmIdentifier: id });
          return yield* HttpServerResponse.json({ ok: true });
        }

        if (request.method === "POST" && pathname === "/resume") {
          const id = url.searchParams.get("id")!;
          yield* resumeMicrovm({ microvmIdentifier: id });
          return yield* HttpServerResponse.json({ ok: true });
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
        // end-to-end over the MicroVM endpoint.
        if (request.method === "POST" && pathname === "/rpc") {
          const message = url.searchParams.get("message") ?? "world";
          const vm = yield* runMicrovm({
            idlePolicy: {
              maxIdleDurationSeconds: 900,
              suspendedDurationSeconds: 300,
              autoResumeEnabled: true,
            },
          });
          // Always terminate the MicroVM we launched — on success OR failure —
          // so a failing step (or an HTTP-level retry of this route) never
          // leaks a running MicroVM against the account's memory quota.
          return yield* Effect.gen(function* () {
            // Wait until the MicroVM is RUNNING before connecting.
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
            // The in-VM endpoint calls (RPC stub + raw `/echo`) need an
            // `HttpClient`; provide one for this request scope.
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
        AWS.Lambda.SuspendMicrovmHttp,
        AWS.Lambda.ResumeMicrovmHttp,
        AWS.Lambda.TerminateMicrovmHttp,
        AWS.Lambda.CreateAuthTokenHttp,
      ),
    ),
  ),
) {}
