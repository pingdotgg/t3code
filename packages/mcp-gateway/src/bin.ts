#!/usr/bin/env node
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Gateway state path is initialized synchronously before the Effect runtime exists.
import * as NodePath from "node:path";

import { GATEWAY_SCOPE_VALUES } from "./port.ts";
import type { GatewayScope } from "./port.ts";
import { connectSharedGateway, launchSharedOwner, proxyMcpStdio } from "./sharedLauncher.ts";
import { startSharedGatewayOwner, type SharedGatewayConfig } from "./sharedOwner.ts";

function parseGrants(
  raw: string | undefined,
): Readonly<Record<string, ReadonlyArray<GatewayScope>>> {
  if (raw === undefined || raw.trim() === "") return {};
  const value = JSON.parse(raw) as Record<string, unknown>;
  const grants: Record<string, ReadonlyArray<GatewayScope>> = {};
  for (const [environmentId, scopes] of Object.entries(value)) {
    if (
      !Array.isArray(scopes) ||
      scopes.some(
        (scope) =>
          typeof scope !== "string" || !GATEWAY_SCOPE_VALUES.includes(scope as GatewayScope),
      )
    ) {
      throw new Error(`Invalid scopes for environment ${environmentId}.`);
    }
    grants[environmentId] = scopes as ReadonlyArray<GatewayScope>;
  }
  return grants;
}

try {
  const bridgePort = Number.parseInt(process.env.T3_MCP_BRIDGE_PORT ?? "47631", 10);
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65_535) {
    throw new Error("T3_MCP_BRIDGE_PORT must be a valid TCP port.");
  }

  const bridgeToken = process.env.T3_MCP_BRIDGE_TOKEN;
  if (bridgeToken === undefined || bridgeToken.length < 16) {
    throw new Error("T3_MCP_BRIDGE_TOKEN must contain at least 16 characters.");
  }

  const initialGrants = parseGrants(process.env.T3_MCP_GRANTS);
  const repositoryAllowlist = (process.env.T3_MCP_REPOSITORY_ALLOWLIST ?? "jayleaton/t3code")
    .split(",")
    .map((repository) => repository.trim())
    .filter((repository) => /^[^/\s]+\/[^/\s]+$/u.test(repository));
  if (repositoryAllowlist.length === 0) {
    throw new Error("T3_MCP_REPOSITORY_ALLOWLIST must contain owner/repository entries.");
  }
  const retentionEvents = Number.parseInt(process.env.T3_MCP_EVENT_RETENTION ?? "100000", 10);
  if (!Number.isInteger(retentionEvents) || retentionEvents < 1) {
    throw new Error("T3_MCP_EVENT_RETENTION must be a positive integer.");
  }
  const stateDirectory = process.env.T3CODE_HOME ?? NodePath.join(NodeOS.homedir(), ".t3code");
  const stateFile =
    process.env.T3_MCP_STATE_FILE ?? NodePath.join(stateDirectory, "mcp-gateway-v3.sqlite");
  const config: SharedGatewayConfig = {
    port: bridgePort,
    token: bridgeToken,
    stateFile,
    retentionEvents,
    repositoryAllowlist,
    initialGrants,
  };

  if (process.argv.includes("--shared-owner")) {
    const owner = await startSharedGatewayOwner(config, {
      onIdle: () => {
        void owner?.close();
      },
    });
    // The launcher waits for this receipt, rather than guessing when the port is ready.
    if (process.send !== undefined) {
      await new Promise<void>((resolve, reject) =>
        process.send?.({ type: "ready" }, (error: Error | null) =>
          error ? reject(error) : resolve(),
        ),
      );
    }
    if (owner !== undefined) {
      const stop = () => {
        void owner.close();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
  } else {
    const remote = await connectSharedGateway(config, async () => {
      await launchSharedOwner(process.argv[1]!, config);
    });
    await proxyMcpStdio(remote);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (process.send !== undefined && process.connected) {
    process.send({ type: "error", message });
    process.disconnect();
  }
  process.stderr.write(`t3-mcp-gateway: ${message}\n`);
  process.exitCode = 1;
}
