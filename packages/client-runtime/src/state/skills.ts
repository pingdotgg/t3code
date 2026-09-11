import type { AgentSkillDetailParams, AgentSkillQuery } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export const fetchEnvironmentSkills = Effect.fn("clientRuntime.fetchEnvironmentSkills")(function* (
  prepared: PreparedConnection,
  query: AgentSkillQuery,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "GET",
    timeoutMs: 35_000,
    url: (httpBaseUrl) => makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).skills.list({ query }),
    request: ({ client, headers }) => client.skills.list({ headers, query }),
  });
});

export const fetchEnvironmentSkill = Effect.fn("clientRuntime.fetchEnvironmentSkill")(function* (
  prepared: PreparedConnection,
  query: AgentSkillQuery,
  params: AgentSkillDetailParams,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "GET",
    timeoutMs: 35_000,
    url: (httpBaseUrl) =>
      makeEnvironmentHttpApiUrlBuilder(httpBaseUrl).skills.detail({ params, query }),
    request: ({ client, headers }) => client.skills.detail({ headers, query, params }),
  });
});
