import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

import { ConnectionBlockedError } from "./model.ts";

export function orchestrationProtocolCompatibilityError(
  descriptor: ExecutionEnvironmentDescriptor,
): ConnectionBlockedError | null {
  if (descriptor.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION) {
    return null;
  }
  const hostProtocol = descriptor.orchestrationProtocolVersion;
  const detail =
    hostProtocol === undefined
      ? `Update T3 Code on ${descriptor.label} before reconnecting. This host predates orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`
      : `Update T3 Code on ${descriptor.label} and this client before reconnecting. The host uses orchestration protocol ${hostProtocol}, while this client requires ${ORCHESTRATION_PROTOCOL_VERSION}.`;
  return new ConnectionBlockedError({ reason: "unsupported", detail });
}

export function appendOrchestrationProtocol(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}
