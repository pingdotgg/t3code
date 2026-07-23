import { EnvironmentId } from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { availableCloudEnvironmentPresentation } from "./cloudEnvironmentPresentation";

function relayStatus(
  status: RelayEnvironmentStatusResponse["status"],
  error?: string,
  traceId?: string,
): RelayEnvironmentStatusResponse {
  return {
    environmentId: EnvironmentId.make("environment-cloud"),
    endpoint: {
      httpBaseUrl: "https://cloud.example.test/",
      wsBaseUrl: "wss://cloud.example.test/ws",
      providerKind: "cloudflare_tunnel",
    },
    status,
    checkedAt: "2026-06-05T16:49:11.000Z",
    ...(error ? { error } : {}),
    ...(traceId ? { traceId } : {}),
  };
}

describe("available cloud environment presentation", () => {
  it("presents an online unsaved environment as available, not connected", () => {
    expect(
      availableCloudEnvironmentPresentation({
        isStatusPending: false,
        status: relayStatus("online"),
        statusError: null,
        statusErrorTraceId: null,
      }),
    ).toEqual({
      connectionError: null,
      connectionErrorTraceId: null,
      connectionState: "available",
      statusText: "Available · Relay online",
    });
  });

  it("keeps relay status checks distinct from connection attempts", () => {
    expect(
      availableCloudEnvironmentPresentation({
        isStatusPending: true,
        status: null,
        statusError: null,
        statusErrorTraceId: null,
      }),
    ).toEqual({
      connectionError: null,
      connectionErrorTraceId: null,
      connectionState: "available",
      statusText: "Available · Checking relay status...",
    });
  });

  it("surfaces an offline relay as an error", () => {
    expect(
      availableCloudEnvironmentPresentation({
        isStatusPending: false,
        status: relayStatus("offline", "Tunnel is unavailable.", "trace-offline"),
        statusError: null,
        statusErrorTraceId: null,
      }),
    ).toEqual({
      connectionError: "Tunnel is unavailable.",
      connectionErrorTraceId: "trace-offline",
      connectionState: "error",
      statusText: "Tunnel is unavailable.",
    });
  });

  it("preserves trace metadata for relay request failures", () => {
    expect(
      availableCloudEnvironmentPresentation({
        isStatusPending: false,
        status: null,
        statusError: "Could not get relay environment status.",
        statusErrorTraceId: "trace-status",
      }),
    ).toMatchObject({
      connectionError: "Could not get relay environment status.",
      connectionErrorTraceId: "trace-status",
    });
  });
});
