import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  SandboxDescriptor,
  SandboxFailureDescriptor,
  SandboxProviderRef,
  SandboxRuntimeSelection,
  SandboxServiceDescriptor,
} from "./sandbox.ts";

const decodeSandboxDescriptor = Schema.decodeUnknownEffect(SandboxDescriptor);
const decodeSandboxProviderRef = Schema.decodeUnknownEffect(SandboxProviderRef);
const decodeSandboxFailure = Schema.decodeUnknownEffect(SandboxFailureDescriptor);
const decodeSandboxRuntimeSelection = Schema.decodeUnknownEffect(SandboxRuntimeSelection);
const decodeSandboxServiceDescriptor = Schema.decodeUnknownEffect(SandboxServiceDescriptor);

it.effect("decodes Sandbox descriptors with empty service and artifact defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeSandboxDescriptor({
      sandboxId: " sandbox-1 ",
      providerKind: "local",
      providerRef: {
        providerKind: "local",
        externalId: " sandbox-1 ",
      },
      status: "ready",
      taskId: "task-1",
      workSessionId: "work-session-1",
      project: {
        repoName: "t3code",
        workspaceRoot: "/repo/t3code",
        defaultBranch: "main",
      },
      resources: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.sandboxId, "sandbox-1");
    assert.deepStrictEqual(parsed.services, []);
    assert.deepStrictEqual(parsed.artifacts, []);
  }),
);

it.effect("rejects unknown Sandbox providers", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSandboxProviderRef({
        providerKind: "docker",
        externalId: "sandbox-1",
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes retryable failure defaults and runtime selection defaults", () =>
  Effect.gen(function* () {
    const failure = yield* decodeSandboxFailure({
      kind: "timeout",
      message: "Timed out waiting for runtime.",
    });
    const selection = yield* decodeSandboxRuntimeSelection({});

    assert.strictEqual(failure.retryable, false);
    assert.strictEqual(selection.providerKind, "local");
  }),
);

it.effect("decodes typed service endpoints without embedding secret values", () =>
  Effect.gen(function* () {
    const service = yield* decodeSandboxServiceDescriptor({
      serviceId: "t3-runtime",
      kind: "t3-runtime",
      status: "ready",
      endpoints: [
        {
          url: "https://runtime.example.com",
          protocol: "https",
          accessMode: "server",
          auth: {
            kind: "bridge-shared-secret",
            credentialRef: "T3_EXECUTION_BRIDGE_SHARED_SECRET",
          },
        },
      ],
    });

    assert.strictEqual(service.endpoints?.[0]?.auth?.kind, "bridge-shared-secret");
    assert.strictEqual(
      service.endpoints?.[0]?.auth?.credentialRef,
      "T3_EXECUTION_BRIDGE_SHARED_SECRET",
    );
  }),
);

it.effect("rejects zero sandbox resources", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSandboxRuntimeSelection({
        providerKind: "modal",
        resources: {
          memoryMiB: 0,
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes Modal runtime provider config", () =>
  Effect.gen(function* () {
    const selection = yield* decodeSandboxRuntimeSelection({
      providerKind: "modal",
      environment: "prod",
      providerConfig: {
        appName: "t3-task-runtime",
        imageTag: "2026-05-03",
        runtimePort: 8787,
        allowedSecretNames: ["T3_EXECUTION_BRIDGE_SHARED_SECRET"],
        imageDockerfileCommands: ["RUN echo building-runtime"],
      },
    });

    assert.strictEqual(selection.providerKind, "modal");
    assert.strictEqual(selection.providerConfig?.runtimePort, 8787);
  }),
);
