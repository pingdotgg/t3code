import type { McpServerEnabledPatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

// Codex is spawned to read its config, so allow more than a pure disk read.
const DEFAULT_MCP_INVENTORY_TIMEOUT_MS = 15_000;

/** MCP servers configured for every provider instance on one environment. */
export const fetchEnvironmentMcpInventory = Effect.fn(
  "clientRuntime.state.fetchEnvironmentMcpInventory",
)(function* (input: { readonly prepared: PreparedConnection; readonly timeoutMs?: number }) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/mcp-servers");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    Option.isSome(signer) ? signer : Option.none(),
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_MCP_INVENTORY_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.mcpServers.inventory({ headers }),
    ),
  );
});

/** Flip one server for one provider instance; resolves with the fresh inventory. */
export const setEnvironmentMcpServerEnabled = Effect.fn(
  "clientRuntime.state.setEnvironmentMcpServerEnabled",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly patch: McpServerEnabledPatch;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/mcp-servers/enabled");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    Option.isSome(signer) ? signer : Option.none(),
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_MCP_INVENTORY_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.mcpServers.setEnabled({ headers, payload: input.patch }),
    ),
  );
});
