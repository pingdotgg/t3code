import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  PROJECT_TRANSFER_CHUNK_BYTES,
  type ProjectTransferConfiguration,
} from "@t3tools/contracts";
import { copyProjectToEnvironment, type ProjectTransferRequest } from "./projectTransfer.ts";

const source = EnvironmentId.make("source");
const destination = EnvironmentId.make("destination");
const configuration: ProjectTransferConfiguration = {
  project: {
    id: ProjectId.make("project"),
    title: "Example",
    workspaceRoot: "/source",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
  },
  agentBrowserAccess: false,
  remoteUrl: "https://example.test/repo.git",
};
const base = {
  sourceEnvironmentId: source,
  destinationEnvironmentId: destination,
  projectId: configuration.project.id,
  destinationPath: "/destination",
  mode: "copy" as const,
  includeIgnored: true,
  onProgress: () => {},
};

describe("cross-environment project copying", () => {
  it("brokers bounded chunks and preserves configuration without sharing machine credentials", async () => {
    const reads: number[] = [];
    const writes: number[] = [];
    const released: string[] = [];
    const request: ProjectTransferRequest = async (environment, input) => {
      switch (input.operation) {
        case "prepare":
          expect(environment).toBe(source);
          return {
            operation: "prepare",
            transferId: "export",
            configuration,
            byteLength: PROJECT_TRANSFER_CHUNK_BYTES + 1,
          };
        case "begin":
          expect(environment).toBe(destination);
          expect(input.configuration).toBe(configuration);
          return { operation: "begin", transferId: "import" };
        case "read":
          expect(environment).toBe(source);
          reads.push(input.offset);
          return { operation: "read", data: "chunk" };
        case "write":
          expect(environment).toBe(destination);
          writes.push(input.offset);
          return { operation: "write" };
        case "finish":
          expect(writes).toEqual([0, PROJECT_TRANSFER_CHUNK_BYTES]);
          return { operation: "finish", projectId: ProjectId.make("copied"), cwd: "/destination" };
        case "release":
          released.push(input.transferId);
          return { operation: "release" };
      }
    };
    const result = await copyProjectToEnvironment({ ...base, request });
    expect(result.projectId).toBe("copied");
    expect(reads).toEqual(writes);
    expect(released.sort()).toEqual(["export", "import"]);
  });

  it("cleans both ends after a failed upload without replacing the original error", async () => {
    const released: string[] = [];
    const request: ProjectTransferRequest = async (_, input) => {
      if (input.operation === "prepare")
        return { operation: "prepare", transferId: "export", configuration, byteLength: 1 };
      if (input.operation === "begin") return { operation: "begin", transferId: "import" };
      if (input.operation === "read") return { operation: "read", data: "chunk" };
      if (input.operation === "release") {
        released.push(input.transferId);
        throw new Error("cleanup offline");
      }
      throw new Error("destination disconnected");
    };
    await expect(copyProjectToEnvironment({ ...base, request })).rejects.toThrow(
      "destination disconnected",
    );
    expect(released.sort()).toEqual(["export", "import"]);
  });

  it("cancellation after snapshot preparation releases it without creating a destination", async () => {
    const controller = new AbortController();
    const operations: string[] = [];
    const request: ProjectTransferRequest = async (_, input) => {
      operations.push(input.operation);
      if (input.operation === "prepare") {
        controller.abort(new Error("cancelled"));
        return { operation: "prepare", transferId: "export", configuration, byteLength: 1 };
      }
      if (input.operation === "release") return { operation: "release" };
      throw new Error("unexpected destination operation");
    };
    await expect(
      copyProjectToEnvironment({ ...base, request, signal: controller.signal }),
    ).rejects.toThrow("cancelled");
    expect(operations).toEqual(["prepare", "release"]);
  });
});
