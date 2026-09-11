import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";

const descriptor = (orchestrationProtocolVersion?: number): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make("environment-remote"),
  label: "Build Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "9.0.0",
  ...(orchestrationProtocolVersion === undefined ? {} : { orchestrationProtocolVersion }),
  capabilities: { repositoryIdentity: true },
});

describe("orchestration protocol compatibility", () => {
  it("accepts the current protocol and announces it without disturbing socket credentials", () => {
    expect(
      orchestrationProtocolCompatibilityError(descriptor(ORCHESTRATION_PROTOCOL_VERSION)),
    ).toBeNull();

    const socketUrl = new URL(
      appendOrchestrationProtocol("wss://host.test/ws?wsTicket=secret&connectionMethod=relay"),
    );
    expect(socketUrl.searchParams.get("orchestrationProtocol")).toBe(
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    expect(socketUrl.searchParams.get("wsTicket")).toBe("secret");
    expect(socketUrl.searchParams.get("connectionMethod")).toBe("relay");
  });

  it("blocks a host that predates negotiation with host-specific upgrade guidance", () => {
    const error = orchestrationProtocolCompatibilityError(descriptor());

    expect(error).toMatchObject({ reason: "unsupported" });
    expect(error?.message).toContain("Update T3 Code on Build Mac");
    expect(error?.message).toContain(`protocol ${ORCHESTRATION_PROTOCOL_VERSION}`);
  });

  it("blocks a different explicit protocol instead of attempting to decode it", () => {
    const error = orchestrationProtocolCompatibilityError(
      descriptor(ORCHESTRATION_PROTOCOL_VERSION + 1),
    );

    expect(error).toMatchObject({ reason: "unsupported" });
    expect(error?.message).toContain(
      `host uses orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION + 1}`,
    );
    expect(error?.message).toContain(`client requires ${ORCHESTRATION_PROTOCOL_VERSION}`);
  });
});
