import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  SandboxDescriptor,
  SandboxFailureDescriptor,
  SandboxProviderRef,
  SandboxRuntimeSelection,
} from "./sandbox.ts";

const decodeSandboxDescriptor = Schema.decodeUnknownEffect(SandboxDescriptor);
const decodeSandboxProviderRef = Schema.decodeUnknownEffect(SandboxProviderRef);
const decodeSandboxFailure = Schema.decodeUnknownEffect(SandboxFailureDescriptor);
const decodeSandboxRuntimeSelection = Schema.decodeUnknownEffect(SandboxRuntimeSelection);

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
