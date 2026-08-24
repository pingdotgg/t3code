import * as AWS from "alchemy/AWS";
import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpBody from "effect/unstable/http/HttpBody";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BunMicrovm } from "./bun-image.ts";
import { ExternalMicrovm } from "./external-image.ts";
import { EffectfulBun } from "./effectful-bun.ts";
import { EffectfulNode } from "./effectful-node.ts";
import { NodeMicrovm } from "./node-image.ts";
import { OpencodeMicrovm } from "./opencode-image.ts";

/**
 * Lambda host for the MicroVM cold-start benchmark. Exposes a boot/shutdown
 * lifecycle so the driver can time each cold start from the OUTSIDE:
 *
 * - `GET /boot?variant=effectful|external&key=K` launches ONE fresh MicroVM and
 *   blocks until its in-VM service answers, returning `{ id, readyMs }` where
 *   `readyMs` = `RunMicrovm` → service-available (time to usable service). It
 *   does NOT terminate.
 * - `GET /shutdown?variant=…&id=ID` terminates the MicroVM.
 */
type Variant = {
  readonly run: (
    req: AWS.Lambda.RunMicrovmRequest,
  ) => Effect.Effect<microvms.RunMicrovmResponse, microvms.RunMicrovmError>;
  readonly get: (
    req: AWS.Lambda.GetMicrovmRequest,
  ) => Effect.Effect<microvms.GetMicrovmResponse, microvms.GetMicrovmError>;
  readonly auth: (
    req: AWS.Lambda.CreateAuthTokenRequest,
  ) => Effect.Effect<
    microvms.CreateMicrovmAuthTokenResponse,
    microvms.CreateMicrovmAuthTokenError
  >;
  readonly term: (
    req: AWS.Lambda.TerminateMicrovmRequest,
  ) => Effect.Effect<
    microvms.TerminateMicrovmResponse,
    microvms.TerminateMicrovmError
  >;
  readonly reachable: (
    endpoint: string,
    authToken: AWS.Lambda.MicrovmConnection["authToken"],
  ) => Effect.Effect<
    unknown,
    HttpClientError.HttpClientError | Error,
    HttpClient.HttpClient
  >;
};

export default class Orchestrator extends AWS.Lambda.Function<Orchestrator>()(
  "MicrovmBenchOrchestrator",
  {
    main: import.meta.filename,
    url: true,
    timeout: Duration.seconds(120),
  },
  Effect.gen(function* () {
    // Plain-HTTP reachable check shared by every non-effectful (raw) image:
    // hit `GET /` with the MicroVM auth headers and read the body.
    const rawReachable =
      (endpoint: string, authToken: AWS.Lambda.MicrovmConnection["authToken"]) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const res = yield* client.get(`https://${endpoint}/`, {
            headers: AWS.Lambda.microvmAuthHeaders(authToken),
          });
          return yield* res.text;
        });

    const effectfulBun: Variant = {
      run: yield* AWS.Lambda.RunMicrovm(EffectfulBun),
      get: yield* AWS.Lambda.GetMicrovm(EffectfulBun),
      auth: yield* AWS.Lambda.CreateAuthToken(EffectfulBun),
      term: yield* AWS.Lambda.TerminateMicrovm(EffectfulBun),
      reachable: (endpoint, authToken) =>
        Effect.gen(function* () {
          const sandbox = yield* AWS.Lambda.connectMicrovm(EffectfulBun, {
            endpoint,
            authToken,
          });
          return yield* sandbox.hello("bench");
        }),
    };
    const effectfulNode: Variant = {
      run: yield* AWS.Lambda.RunMicrovm(EffectfulNode),
      get: yield* AWS.Lambda.GetMicrovm(EffectfulNode),
      auth: yield* AWS.Lambda.CreateAuthToken(EffectfulNode),
      term: yield* AWS.Lambda.TerminateMicrovm(EffectfulNode),
      reachable: (endpoint, authToken) =>
        Effect.gen(function* () {
          const sandbox = yield* AWS.Lambda.connectMicrovm(EffectfulNode, {
            endpoint,
            authToken,
          });
          return yield* sandbox.hello("bench");
        }),
    };
    // Raw baselines: same image-build path + `GET /` reachable as each other,
    // differing only by runtime (bun / node) or language (Python external).
    const bun: Variant = {
      run: yield* AWS.Lambda.RunMicrovm(BunMicrovm),
      get: yield* AWS.Lambda.GetMicrovm(BunMicrovm),
      auth: yield* AWS.Lambda.CreateAuthToken(BunMicrovm),
      term: yield* AWS.Lambda.TerminateMicrovm(BunMicrovm),
      reachable: rawReachable,
    };
    const node: Variant = {
      run: yield* AWS.Lambda.RunMicrovm(NodeMicrovm),
      get: yield* AWS.Lambda.GetMicrovm(NodeMicrovm),
      auth: yield* AWS.Lambda.CreateAuthToken(NodeMicrovm),
      term: yield* AWS.Lambda.TerminateMicrovm(NodeMicrovm),
      reachable: rawReachable,
    };
    const external: Variant = {
      run: yield* AWS.Lambda.RunMicrovm(ExternalMicrovm),
      get: yield* AWS.Lambda.GetMicrovm(ExternalMicrovm),
      auth: yield* AWS.Lambda.CreateAuthToken(ExternalMicrovm),
      term: yield* AWS.Lambda.TerminateMicrovm(ExternalMicrovm),
      reachable: rawReachable,
    };
    // opencode is "usable" when its health endpoint answers healthy AND a
    // session can actually be created — a real write through the app, which
    // proves the server is functional after the snapshot resume, not merely
    // listening. The server requires basic auth (see
    // contexts/microvm-opencode/Dockerfile), stacked on the MicroVM proxy
    // auth headers.
    const opencode: Variant = {
      run: yield* AWS.Lambda.RunMicrovm(OpencodeMicrovm),
      get: yield* AWS.Lambda.GetMicrovm(OpencodeMicrovm),
      auth: yield* AWS.Lambda.CreateAuthToken(OpencodeMicrovm),
      term: yield* AWS.Lambda.TerminateMicrovm(OpencodeMicrovm),
      reachable: (endpoint, authToken) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const headers = {
            ...AWS.Lambda.microvmAuthHeaders(authToken),
            // base64("opencode:bench")
            authorization: "Basic b3BlbmNvZGU6YmVuY2g=",
          };
          const health = yield* client.get(
            `https://${endpoint}/global/health`,
            { headers },
          );
          const healthBody = yield* health.text;
          if (health.status !== 200 || !healthBody.includes('"healthy":true')) {
            return yield* Effect.fail(
              new Error(
                `opencode health ${health.status}: ${healthBody.slice(0, 120)}`,
              ),
            );
          }
          const session = yield* client.post(`https://${endpoint}/session`, {
            headers,
            body: HttpBody.text("{}", "application/json"),
          });
          const sessionBody = yield* session.text;
          if (session.status !== 200 || !sessionBody.includes('"id"')) {
            return yield* Effect.fail(
              new Error(
                `opencode session ${session.status}: ${sessionBody.slice(0, 120)}`,
              ),
            );
          }
          return sessionBody;
        }),
    };
    const variants: Record<string, Variant> = {
      "effectful-bun": effectfulBun,
      "effectful-node": effectfulNode,
      bun,
      node,
      external,
      opencode,
    };
    const pick = (v: string | null): Variant => variants[v ?? ""] ?? effectfulBun;

    // Run one fresh MicroVM and time RunMicrovm → service-reachable (readyMs).
    // Leaves it running for an explicit /shutdown; self-terminates only if boot
    // itself fails.
    const boot = (v: Variant) =>
      Effect.gen(function* () {
        const start = yield* Effect.sync(() => Date.now());
        const vm = yield* v.run({
          idlePolicy: {
            maxIdleDurationSeconds: 900,
            suspendedDurationSeconds: 300,
            autoResumeEnabled: true,
          },
        });
        return yield* Effect.gen(function* () {
          yield* v.get({ microvmIdentifier: vm.microvmId }).pipe(
            Effect.flatMap((m) =>
              m.state === "RUNNING"
                ? Effect.void
                : Effect.fail(new Error(`microvm ${m.state}`)),
            ),
            Effect.retry({
              schedule: Schedule.spaced("500 millis"),
              times: 180,
            }),
          );
          const { authToken } = yield* v.auth({
            microvmIdentifier: vm.microvmId,
            expirationInMinutes: 5,
            allowedPorts: [{ port: 8080 }],
          });
          yield* v.reachable(vm.endpoint, authToken).pipe(
            Effect.retry({
              schedule: Schedule.exponential("250 millis"),
              times: 14,
            }),
          );
          const readyMs = (yield* Effect.sync(() => Date.now())) - start;
          return yield* HttpServerResponse.json({ id: vm.microvmId, readyMs });
        }).pipe(
          Effect.onError(() =>
            v.term({ microvmIdentifier: vm.microvmId }).pipe(Effect.ignore),
          ),
          Effect.provide(FetchHttpClient.layer),
        );
      });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const v = pick(url.searchParams.get("variant"));

        if (request.method === "GET" && url.pathname === "/boot") {
          return yield* boot(v);
        }
        if (request.method === "GET" && url.pathname === "/shutdown") {
          const id = url.searchParams.get("id")!;
          yield* v.term({ microvmIdentifier: id }).pipe(Effect.ignore);
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.Lambda.RunMicrovmHttp,
        AWS.Lambda.GetMicrovmHttp,
        AWS.Lambda.CreateAuthTokenHttp,
        AWS.Lambda.TerminateMicrovmHttp,
      ),
    ),
  ),
) {}
