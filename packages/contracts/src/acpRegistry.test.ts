import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AcpRegistryManagedBinaryUninstallInput,
  AcpRegistryManagedBinaryUninstallResult,
  AcpRegistryOperationError,
  AcpRegistryPrepareResult,
  AcpRegistryProbeResult,
  AcpRegistrySearchAgent,
  AcpRegistrySearchInput,
} from "./acpRegistry.ts";

const decodeSearchInput = Schema.decodeUnknownSync(AcpRegistrySearchInput);
const decodePrepareResult = Schema.decodeUnknownSync(AcpRegistryPrepareResult);
const decodeSearchAgent = Schema.decodeUnknownSync(AcpRegistrySearchAgent);
const decodeUninstallInput = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallInput);
const decodeUninstallResult = Schema.decodeUnknownSync(AcpRegistryManagedBinaryUninstallResult);
const decodeProbeResult = Schema.decodeUnknownSync(AcpRegistryProbeResult);
const decodeOperationError = Schema.decodeUnknownSync(AcpRegistryOperationError);

describe("ACP Registry contracts", () => {
  it("decodes bounded search and prepare payloads", () => {
    expect(decodeSearchInput({ query: "  codex  " })).toEqual({
      query: "codex",
    });
    expect(
      decodePrepareResult({
        agentId: "codex-acp",
        version: "1.2.0",
        distribution: "npx",
        prepared: true,
      }),
    ).toMatchObject({ agentId: "codex-acp", distribution: "npx", prepared: true });
  });

  it("rejects oversized queries and result metadata", () => {
    expect(() => decodeSearchInput({ query: "x".repeat(121) })).toThrow();
    expect(() =>
      decodeSearchAgent({
        id: "agent",
        name: "Agent",
        version: "1.0.0",
        description: "x".repeat(1_025),
        authors: [],
        license: null,
        website: null,
        repository: null,
        icon: null,
        distribution: "binary",
        integrity: "sha256",
      }),
    ).toThrow();
  });

  it("decodes managed binary uninstall payloads and rejects unsafe agent IDs", () => {
    expect(decodeUninstallInput({ agentId: "  example-agent  " })).toEqual({
      agentId: "example-agent",
    });
    expect(decodeUninstallResult({ agentId: "example-agent", removed: false })).toEqual({
      agentId: "example-agent",
      removed: false,
    });
    expect(() => decodeUninstallInput({ agentId: "../example-agent" })).toThrow();
  });

  it("decodes valid probe metadata and rejects oversized or invalid payloads", () => {
    const authMethod = {
      id: "oauth",
      name: "Browser login",
      description: null,
      type: "agent",
    };
    expect(
      decodeProbeResult({
        instanceId: "acpRegistry_example",
        ready: true,
        icon: null,
        authMethods: [authMethod],
        models: [{ id: "default", name: "Default", description: "Agent-selected model" }],
        currentModelId: "default",
        configOptions: [],
      }),
    ).toMatchObject({ ready: true, currentModelId: "default" });
    expect(() =>
      decodeProbeResult({
        instanceId: "acpRegistry_example",
        ready: true,
        icon: null,
        authMethods: Array.from({ length: 33 }, () => authMethod),
        models: [],
        currentModelId: null,
      }),
    ).toThrow();
    expect(() =>
      decodeProbeResult({
        instanceId: "acpRegistry_example",
        ready: true,
        icon: null,
        authMethods: [{ ...authMethod, type: "passive" }],
        models: [],
        currentModelId: null,
      }),
    ).toThrow();
    expect(() =>
      decodeProbeResult({
        instanceId: "acpRegistry_example",
        ready: true,
        icon: null,
        authMethods: [],
        models: Array.from({ length: 257 }, () => ({
          id: "default",
          name: "Default",
          description: null,
        })),
        currentModelId: null,
      }),
    ).toThrow();
    expect(() =>
      decodeOperationError({
        _tag: "AcpRegistryOperationError",
        reason: "authentication_failed",
        message: "Authentication required.",
        authMethods: Array.from({ length: 33 }, () => authMethod),
      }),
    ).toThrow();
  });
});
