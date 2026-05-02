import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  TaskRuntimeArchiveRequest,
  TaskRuntimeMaterializeRequest,
  TaskRuntimeMaterializeResponse,
  TaskRuntimeReconnectRequest,
  TaskRuntimeSandboxStatusQuery,
} from "./executionBridge.ts";

const decodeArchiveRequest = Schema.decodeUnknownEffect(TaskRuntimeArchiveRequest);
const decodeMaterializeRequest = Schema.decodeUnknownEffect(TaskRuntimeMaterializeRequest);
const decodeMaterializeResponse = Schema.decodeUnknownEffect(TaskRuntimeMaterializeResponse);
const decodeReconnectRequest = Schema.decodeUnknownEffect(TaskRuntimeReconnectRequest);
const decodeStatusQuery = Schema.decodeUnknownEffect(TaskRuntimeSandboxStatusQuery);

it.effect("decodes historical Task runtime materialize responses without Sandbox fields", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeMaterializeResponse({
      taskId: "task-1",
      workSessionId: "work-session-1",
      t3ProjectId: "project-1",
      t3ThreadId: "thread-1",
      branch: "task/demo",
      worktreePath: "/repo/.worktrees/task-demo",
      acceptedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.taskId, "task-1");
    assert.strictEqual(parsed.t3ProjectId, "project-1");
    assert.strictEqual(parsed.sandbox, undefined);
  }),
);

it.effect("decodes Task runtime materialize requests with Sandbox selection and services", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeMaterializeRequest({
      taskId: "task-1",
      workSessionId: "work-session-1",
      initialPrompt: "Investigate the report",
      project: {
        repoName: "t3code",
        workspaceRoot: "/repo/t3code",
        defaultBranch: "main",
        projectKey: "github:Affil/t3code",
      },
      title: "Investigate bug",
      sandbox: {
        providerKind: "modal",
        resources: {
          memoryMiB: 2048,
        },
      },
      services: [
        {
          kind: "t3-runtime",
        },
        {
          kind: "browser",
          required: false,
        },
      ],
      idempotencyKey: "sandbox:modal:task-1:work-session-1",
    });

    assert.strictEqual(parsed.sandbox?.providerKind, "modal");
    assert.strictEqual(parsed.project.projectKey, "github:Affil/t3code");
    assert.strictEqual(parsed.services?.[0]?.required, true);
    assert.strictEqual(parsed.services?.[1]?.required, false);
  }),
);

it.effect("decodes follow-up Task runtime requests with branded Sandbox ids", () =>
  Effect.gen(function* () {
    const reconnect = yield* decodeReconnectRequest({
      taskId: "task-1",
      workSessionId: "work-session-1",
      sandboxId: "sandbox-1",
    });
    const archive = yield* decodeArchiveRequest({
      taskId: "task-1",
      workSessionId: "work-session-1",
      sandboxId: "sandbox-1",
    });
    const status = yield* decodeStatusQuery({
      taskId: "task-1",
      workSessionId: "work-session-1",
      sandboxId: "sandbox-1",
    });

    assert.strictEqual(reconnect.sandboxId, "sandbox-1");
    assert.strictEqual(archive.sandboxId, "sandbox-1");
    assert.strictEqual(status.sandboxId, "sandbox-1");
  }),
);

it.effect("decodes Task runtime materialize responses with Sandbox descriptors", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeMaterializeResponse({
      taskId: "task-1",
      workSessionId: "work-session-1",
      t3ProjectId: "project-1",
      t3ThreadId: "thread-1",
      branch: "task/demo",
      worktreePath: "/repo/.worktrees/task-demo",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      sandbox: {
        sandboxId: "sandbox-1",
        providerKind: "local",
        providerRef: {
          providerKind: "local",
          externalId: "sandbox-1",
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
        services: [
          {
            serviceId: "svc-runtime",
            kind: "t3-runtime",
            status: "ready",
          },
        ],
        artifacts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      environment: {
        environmentId: "env-1",
        label: "Fake Sandbox",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "fake",
        capabilities: {
          repositoryIdentity: true,
        },
      },
      services: [
        {
          serviceId: "svc-runtime",
          kind: "t3-runtime",
          status: "ready",
        },
      ],
    });

    assert.strictEqual(parsed.t3ThreadId, "thread-1");
    assert.strictEqual(parsed.sandbox?.sandboxId, "sandbox-1");
    assert.strictEqual(parsed.environment?.environmentId, "env-1");
    assert.strictEqual(parsed.services?.[0]?.kind, "t3-runtime");
  }),
);
