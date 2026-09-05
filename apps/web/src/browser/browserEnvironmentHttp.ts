import type { EnvironmentId } from "@t3tools/contracts";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environment-http-auth";
import {
  createRuntimeCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { HttpBody, HttpClient } from "effect/unstable/http";

import { connectionAtomRuntime } from "~/connection/runtime";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readPreparedConnection } from "~/state/session";

const post = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:preview:post",
  execute: (input: {
    prepared: NonNullable<ReturnType<typeof readPreparedConnection>>;
    path: string;
    body?: Blob;
  }) =>
    Effect.gen(function* () {
      const prepared = input.prepared;
      const http = yield* HttpClient.HttpClient;
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        prepared,
        signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
        remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
        method: "POST",
        url: (base) => new URL(input.path, base).toString(),
        timeoutMs: input.body ? 120_000 : 15_000,
        request: ({ headers, url }) =>
          Effect.gen(function* () {
            const response = yield* http.post(url, {
              headers: { ...headers },
              ...(input.body ? { body: HttpBody.raw(input.body) } : {}),
            });
            const text = yield* response.text;
            return {
              url,
              status: response.status,
              ok: response.status >= 200 && response.status < 300,
              json: async (): Promise<unknown> => JSON.parse(text),
            };
          }),
        isUnauthorizedResponse: (response) => response.status === 401,
      });
    }),
});

export async function previewEnvironmentPost(
  environmentId: EnvironmentId,
  path: string,
  body?: Blob,
) {
  const prepared = readPreparedConnection(environmentId);
  if (!prepared) throw new Error(`Environment ${environmentId} is not connected.`);
  const result = await post.run(appAtomRegistry, {
    prepared,
    path,
    ...(body ? { body } : {}),
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}
