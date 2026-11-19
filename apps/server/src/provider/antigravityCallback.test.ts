// @effect-diagnostics nodeBuiltinImport:off - the fixture is the runtime's loopback callback server.
import * as NodeHttp from "node:http";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  forwardAntigravityCallback,
  validateAntigravityCallbackUrl,
} from "./antigravityCallback.ts";

const instanceId = ProviderInstanceId.make("antigravity-callback-test");
const pending = { redirectUri: "http://127.0.0.1:51234/", state: "owned-state" };

it.effect("accepts the exact owned Google callback and an explicit Google denial", () =>
  Effect.gen(function* () {
    for (const response of ["code=example-code", "error=access_denied"]) {
      const callback = `http://127.0.0.1:51234/?state=owned-state&${response}&iss=https%3A%2F%2Faccounts.google.com`;
      const parsed = yield* validateAntigravityCallbackUrl(instanceId, pending, callback);
      assert.equal(parsed.toString(), callback);
    }
  }),
);

it.effect("rejects different targets, credentials, fragments, and duplicate OAuth fields", () =>
  Effect.gen(function* () {
    const callbacks = [
      "https://127.0.0.1:51234/?state=owned-state&code=x",
      "http://localhost:51234/?state=owned-state&code=x",
      "http://127.0.0.2:51234/?state=owned-state&code=x",
      "http://127.0.0.1:51235/?state=owned-state&code=x",
      "http://127.0.0.1:51234/other?state=owned-state&code=x",
      "http://user:password@127.0.0.1:51234/?state=owned-state&code=x",
      "http://127.0.0.1:51234/?state=owned-state&code=x#fragment",
      "http://127.0.0.1:51234/?state=wrong-state&code=x",
      "http://127.0.0.1:51234/?state=owned-state&state=owned-state&code=x",
      "http://127.0.0.1:51234/?state=owned-state&code=x&code=y",
      "http://127.0.0.1:51234/?state=owned-state&code=x&error=access_denied",
      "http://127.0.0.1:51234/?state=owned-state&error=access_denied&error=other",
      "http://127.0.0.1:51234/?state=owned-state&code=",
      "http://127.0.0.1:51234/?state=owned-state&iss=https%3A%2F%2Faccounts.google.com",
      "http://127.0.0.1:51234/?state=owned-state&code=x&iss=https%3A%2F%2Fexample.com",
      "http://127.0.0.1:51234/?state=owned-state&code=x&iss=https%3A%2F%2Faccounts.google.com&iss=https%3A%2F%2Faccounts.google.com",
    ];
    for (const callback of callbacks) {
      const result = yield* validateAntigravityCallbackUrl(instanceId, pending, callback).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(result), callback);
    }
  }),
);

it.live("delivers a callback the runtime answers with a redirect to its license picker", () =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server>((resume) => {
      const server = NodeHttp.createServer((_request, response) => {
        response.writeHead(302, { Location: "/license" }).end();
      });
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  ).pipe(
    Effect.flatMap((server) => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      return forwardAntigravityCallback(
        instanceId,
        new URL(`http://127.0.0.1:${port}/?state=owned-state&code=example-code`),
      );
    }),
    Effect.scoped,
  ),
);
