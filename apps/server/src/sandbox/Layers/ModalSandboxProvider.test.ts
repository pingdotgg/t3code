import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { makeModalSandboxProvider, type ModalSandboxClient } from "./ModalSandboxProvider.ts";

describe("ModalSandboxProvider", () => {
  it("creates a Modal sandbox descriptor with a typed t3-runtime endpoint", async () => {
    const createOrReconnectSandbox = vi.fn<ModalSandboxClient["createOrReconnectSandbox"]>(
      async () => ({
        sandboxId: "sb-123",
        runtimeEndpointUrl: "https://runtime.modal.run",
      }),
    );
    const provider = makeModalSandboxProvider({ createOrReconnectSandbox });

    const result = await Effect.runPromise(
      provider.materializeTaskRuntime({
        taskId: "task-1",
        workSessionId: "work-session-1",
        title: "Fix checkout",
        initialPrompt: "Fix checkout",
        idempotencyKey: "sandbox:modal:task-1:work-session-1",
        startCodingAgent: false,
        project: {
          repoName: "t3code",
          workspaceRoot: "/workspace/t3code",
          defaultBranch: "main",
          projectKey: "affil/t3code",
        },
        environment: "prod",
        providerConfig: {
          appName: "t3-task-runtime",
          imageTag: "ghcr.io/affil-ai/t3-runtime:test",
          runtimePort: 8787,
          allowedSecretNames: ["T3_EXECUTION_BRIDGE_SHARED_SECRET"],
          imageDockerfileCommands: ["RUN echo building-runtime"],
        },
        resources: {
          memoryMiB: 2048,
          timeoutMs: 3_600_000,
          idleTimeoutMs: 900_000,
        },
        services: [
          {
            kind: "t3-runtime",
            required: true,
          },
        ],
      }),
    );

    expect(createOrReconnectSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: "t3-task-runtime",
        imageTag: "ghcr.io/affil-ai/t3-runtime:test",
        environment: "prod",
        imageDockerfileCommands: ["RUN echo building-runtime"],
        tags: expect.objectContaining({
          "t3.sandbox.provider": "modal",
          "t3.task.id": "task-1",
          "t3.workSession.id": "work-session-1",
        }),
      }),
    );
    expect(result.sandbox.providerKind).toBe("modal");
    expect(result.sandbox.providerRef.externalId).toBe("sb-123");
    expect(result.environment.platform.os).toBe("linux");
    expect(result.services[0]?.endpointUrl).toBe("https://runtime.modal.run");
    expect(result.services[0]?.endpoints?.[0]?.auth?.kind).toBe("bridge-shared-secret");
  });
});
