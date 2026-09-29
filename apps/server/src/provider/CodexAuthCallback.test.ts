// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Exercise the real local callback receiver without contacting OpenAI.
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as NodeHttp from "node:http";
import { subscribeCodexAuthCallback } from "./CodexAuthCallback.ts";

async function input() {
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const authorizationUrl = new URL("https://auth.openai.com/api/accounts/authorize");
  authorizationUrl.search = new URLSearchParams({
    client_id: "dynamic_agent_client",
    response_type: "code",
    redirect_uri: `http://127.0.0.1:${address.port}/auth/callback`,
    state: "a".repeat(43),
    code_challenge_method: "S256",
    code_challenge: "b".repeat(43),
  }).toString();
  return {
    authorizationUrl: authorizationUrl.toString(),
    returnUrl: "http://localhost:7001/welcome#agents:remote-nuc",
    environmentId: EnvironmentId.make("remote-nuc"),
    instanceId: ProviderInstanceId.make("work"),
    flowId: "remote-flow",
  };
}
function callback(authorizationUrl: string) {
  const request = new URL(authorizationUrl);
  const url = new URL(request.searchParams.get("redirect_uri")!);
  url.search = new URLSearchParams({
    state: request.searchParams.get("state")!,
    code: "test-code",
    client_id: "oaiapp_test",
  }).toString();
  return url;
}

it.effect("a local primary environment receives sign-in for a remote secondary environment", () =>
  Effect.gen(function* () {
    const request = yield* Effect.promise(input);
    const ready = yield* Deferred.make<void>();
    const states: string[] = [];
    let receivedCallbackUrl: string | undefined;
    const receiver = yield* subscribeCodexAuthCallback(request).pipe(
      Stream.runForEach((state) =>
        Effect.gen(function* () {
          states.push(state.phase);
          if (state.phase === "finished") receivedCallbackUrl = state.callbackUrl;
          if (state.phase === "ready") yield* Deferred.succeed(ready, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    const expected = callback(request.authorizationUrl);
    const foreign = new URL(expected);
    foreign.searchParams.set("state", "foreign");
    expect((yield* Effect.promise(() => fetch(foreign))).status).toBe(400);
    const response = yield* Effect.promise(() => fetch(expected, { redirect: "manual" }));
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBe(request.returnUrl);
    yield* Fiber.join(receiver);
    expect(receivedCallbackUrl).toBe(expected.toString());
    expect(states).toEqual(["ready", "finished"]);
  }).pipe(Effect.scoped),
);

it.effect("disconnecting the receiving client releases the exact callback port for retry", () =>
  Effect.gen(function* () {
    const request = yield* Effect.promise(input);
    const ready = yield* Deferred.make<void>();
    const receiver = yield* subscribeCodexAuthCallback(request).pipe(
      Stream.runForEach(() => Deferred.succeed(ready, undefined)),
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    yield* Fiber.interrupt(receiver);
    yield* subscribeCodexAuthCallback(request).pipe(
      Stream.runForEach((state) =>
        state.phase === "ready"
          ? Effect.promise(() => fetch(callback(request.authorizationUrl), { redirect: "manual" }))
          : Effect.void,
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("the local server refuses nonlocal return destinations", () =>
  Effect.gen(function* () {
    const request = yield* Effect.promise(input);
    const result = yield* subscribeCodexAuthCallback({
      ...request,
      returnUrl: "https://app.t3.codes/welcome",
    }).pipe(Stream.runDrain, Effect.result);
    expect(result._tag).toBe("Failure");
  }),
);
