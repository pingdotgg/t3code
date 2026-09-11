/* oxlint-disable unicorn/prefer-add-event-listener -- The MCP Transport interface uses callback properties, not DOM events. */
// @effect-diagnostics-next-line nodeBuiltinImport:off - A detached owner must outlive any one stdio client, including on Windows.
import * as NodeChildProcess from "node:child_process";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { sharedGatewayConfiguration, type SharedGatewayConfig } from "./sharedOwner.ts";
import { connectMcpSession, GatewayUnavailableError } from "./sharedTransport.ts";

export function launchSharedOwner(
  entryPoint: string,
  config: SharedGatewayConfig,
): Promise<NodeChildProcess.ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        ...process.execArgv.filter((arg) => !arg.startsWith("--inspect")),
        entryPoint,
        "--shared-owner",
      ],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          ...process.env,
          T3_MCP_BRIDGE_PORT: String(config.port),
          T3_MCP_BRIDGE_TOKEN: config.token,
          T3_MCP_STATE_FILE: config.stateFile,
          T3_MCP_EVENT_RETENTION: String(config.retentionEvents),
          T3_MCP_REPOSITORY_ALLOWLIST: config.repositoryAllowlist.join(","),
          T3_MCP_GRANTS: JSON.stringify(config.initialGrants),
        },
      },
    );
    const timeout = AbortSignal.timeout(15_000);
    const cleanup = () => {
      timeout.removeEventListener("abort", onTimeout);
      child.off("error", fail);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const fail = (error: Error) => {
      cleanup();
      child.kill();
      if (child.connected) child.disconnect();
      reject(error);
    };
    const onTimeout = () => fail(new Error("Timed out starting the shared MCP gateway owner."));
    const onExit = (code: number | null) =>
      fail(new Error(`Shared MCP gateway owner exited before startup (code ${code}).`));
    const onMessage = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("type" in value)) return;
      if (value.type === "error" && "message" in value && typeof value.message === "string") {
        fail(new Error(value.message));
      } else if (value.type === "ready") {
        cleanup();
        if (child.connected) child.disconnect();
        child.unref();
        resolve(child);
      }
    };
    timeout.addEventListener("abort", onTimeout, { once: true });
    child.once("error", fail);
    child.once("exit", onExit);
    child.on("message", onMessage);
  });
}

export async function connectSharedGateway(
  config: SharedGatewayConfig,
  launch: () => Promise<void>,
): Promise<Transport> {
  const input = {
    port: config.port,
    token: config.token,
    configuration: sharedGatewayConfiguration(config),
  };
  try {
    return await connectMcpSession(input);
  } catch (error) {
    if (!(error instanceof GatewayUnavailableError)) throw error;
  }
  await launch();
  return connectMcpSession(input);
}

/** Proxy complete MCP messages, keeping request ids and notifications scoped to this session. */
export async function proxyMcpStdio(remote: Transport): Promise<void> {
  const stdio = new StdioServerTransport();
  let stopping = false;
  const report = (error: Error) => {
    process.stderr.write(`t3-mcp-gateway: ${error.message}\n`);
    process.exitCode = 1;
    void shutdown();
  };
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    process.stdin.off("end", onEnd);
    process.off("SIGINT", onEnd);
    process.off("SIGTERM", onEnd);
    await Promise.allSettled([stdio.close(), remote.close()]);
  };
  const onEnd = () => {
    void shutdown();
  };
  process.stdin.once("end", onEnd);
  process.once("SIGINT", onEnd);
  process.once("SIGTERM", onEnd);
  stdio.onmessage = (message) => {
    void remote.send(message).catch(report);
  };
  remote.onmessage = (message) => {
    void stdio.send(message).catch(report);
  };
  stdio.onerror = report;
  remote.onerror = report;
  remote.onclose = () => {
    if (!stopping)
      report(
        new Error(
          "Shared gateway owner stopped. Reconnect this MCP session; in-flight work is not automatically replayed.",
        ),
      );
  };
  await remote.start();
  await stdio.start();
}
