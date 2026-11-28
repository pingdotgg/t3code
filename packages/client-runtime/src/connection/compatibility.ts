import { msg } from "gt-i18n";
import { translatableDetail } from "../errors/translatable.ts";
import {
  CLIENT_CAPABILITIES_QUERY_PARAM,
  HTTP_USAGE_LIMIT_SOURCES_CAPABILITY,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

import { ConnectionBlockedError } from "./model.ts";

export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  // Servers shipped before negotiation use the original wire protocol.
  const serverProtocolVersion = descriptor.orchestrationProtocolVersion ?? 1;
  if (serverProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) {
    return null;
  }
  return serverProtocolVersion > ORCHESTRATION_PROTOCOL_VERSION
    ? new ConnectionBlockedError({
        reason: "unsupported",
        ...translatableDetail(
          msg(
            "This client is not supported by this server. Update your app or use a compatible release to connect to {host}.",
            { host: descriptor.label },
          ),
        ),
      })
    : new ConnectionBlockedError({
        reason: "unsupported",
        ...translatableDetail(
          msg("This client requires a newer server. Update T3 Code on {host} to connect.", {
            host: descriptor.label,
          }),
        ),
        ...(canSelfUpdate(descriptor) ? { serverUpdateRequired: true } : {}),
      });
}

function canSelfUpdate(descriptor: ExecutionEnvironmentDescriptor): boolean {
  const { serverSelfUpdate, desktopAppUpdate } = descriptor.capabilities;
  return (
    serverSelfUpdate !== undefined &&
    (serverSelfUpdate !== "desktop-managed" || desktopAppUpdate === true)
  );
}

export function appendOrchestrationProtocol(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set(
    CLIENT_CAPABILITIES_QUERY_PARAM,
    [SETTINGS_SECRET_REFERENCES_CAPABILITY, HTTP_USAGE_LIMIT_SOURCES_CAPABILITY].join(","),
  );
  return url.toString();
}
