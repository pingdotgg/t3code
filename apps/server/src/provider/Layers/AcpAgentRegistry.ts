import nodeFs from "node:fs";
import nodePath from "node:path";

import { type AcpAgentServer, type ServerAcpAgentStatus } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { AcpAgentRegistry, type AcpAgentRegistryShape } from "../Services/AcpAgentRegistry.ts";

function commandExists(command: string): boolean {
  if (nodePath.isAbsolute(command)) {
    try {
      nodeFs.accessSync(command, nodeFs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathValue = process.env.PATH ?? "";
  const pathEntries = pathValue.split(nodePath.delimiter).filter(Boolean);
  const executableNames =
    process.platform === "win32"
      ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
      : [command];

  return pathEntries.some((entry) =>
    executableNames.some((name) => {
      try {
        nodeFs.accessSync(nodePath.join(entry, name), nodeFs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

function toStatus(agent: AcpAgentServer, checkedAt: string): ServerAcpAgentStatus {
  const installed = commandExists(agent.launch.command);
  return {
    agentServerId: agent.id,
    displayName: agent.name,
    enabled: agent.enabled,
    installed,
    status: agent.enabled ? (installed ? "ready" : "error") : "disabled",
    authStatus: "unknown",
    checkedAt,
    version: agent.importedVersion ?? null,
    ...(installed
      ? {}
      : {
          message:
            agent.distributionType === "binaryUnsupported"
              ? "Binary ACP agents are discoverable but require manual setup in this version."
              : `Command '${agent.launch.command}' was not found.`,
        }),
  };
}

const makeAcpAgentRegistry = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;

  const getAgentServers: AcpAgentRegistryShape["getAgentServers"] = settings.getSettings.pipe(
    Effect.map((serverSettings) => serverSettings.providers.acp.agentServers),
  );

  const listStatuses: AcpAgentRegistryShape["listStatuses"] = Effect.gen(function* () {
    const agents = yield* getAgentServers;
    const checkedAt = new Date().toISOString();
    return agents.map((agent) => toStatus(agent, checkedAt));
  });

  return {
    getAgentServers,
    listStatuses,
  } satisfies AcpAgentRegistryShape;
});

export const AcpAgentRegistryLive = Layer.effect(AcpAgentRegistry, makeAcpAgentRegistry);
