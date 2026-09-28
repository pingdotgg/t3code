import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ThreadId } from "./baseSchemas.ts";

import {
  ProjectIconOverride,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ClientOrchestrationCommand,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetTurnDiffInput,
  ProjectCreatedPayload,
  OrchestrationProjectShell,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProjectCreateCommand,
  OrchestrationMessage,
  ThreadMessageSentPayload,
  ThreadMetaUpdatedPayload,
  ThreadLinkedPullRequest,
  ThreadTurnStartCommand,
  ThreadCreatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartRequestedPayload,
  SnapShotAccessibility,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeOrchestrationMessage = Schema.decodeUnknownEffect(OrchestrationMessage);
const decodeThreadMessageSentPayload = Schema.decodeUnknownEffect(ThreadMessageSentPayload);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeOrchestrationThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeOrchestrationThreadShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);
const encodeThreadCreatedPayload = Schema.encodeEffect(ThreadCreatedPayload);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);
const decodeSnapShotAccessibility = Schema.decodeUnknownEffect(SnapShotAccessibility);

it.effect("parses turn diff input when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeTurnDiffInput({
      threadId: "thread-1",
      fromTurnCount: 1,
      toTurnCount: 2,
    });
    assert.strictEqual(parsed.fromTurnCount, 1);
    assert.strictEqual(parsed.toTurnCount, 2);
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims branded ids and command string fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreateCommand({
      type: "project.create",
      commandId: " cmd-1 ",
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.commandId, "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.strictEqual(parsed.createWorkspaceRootIfMissing, undefined);
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "codex");
  }),
);

it.effect("rejects command fields that become empty after trim", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeProjectCreateCommand({
        type: "project.create",
        commandId: "cmd-1",
        projectId: "project-1",
        title: "  ",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("decodes thread.turn.start defaults for provider and runtime mode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-1",
      threadId: "thread-1",
      message: {
        messageId: "msg-1",
        role: "user",
        text: "hello",
        attachments: [],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection, undefined);
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("accepts inline images, uploaded images, and uploaded files from clients", () =>
  Effect.gen(function* () {
    const command = yield* decodeClientOrchestrationCommand({
      type: "thread.turn.start",
      commandId: "cmd-turn-attachments",
      threadId: "thread-1",
      message: {
        messageId: "msg-attachments",
        role: "user",
        text: "hello",
        attachments: [
          {
            type: "image",
            name: "legacy.png",
            mimeType: "image/png",
            sizeBytes: 3,
            dataUrl: "data:image/png;base64,YWJj",
          },
          {
            type: "image",
            id: "pending-00000000-0000-4000-8000-000000000001",
            name: "uploaded.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
          {
            type: "file",
            id: "pending-00000000-0000-4000-8000-000000000002-pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 3,
          },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    if (command.type !== "thread.turn.start") {
      assert.fail(`Expected thread.turn.start, received ${command.type}.`);
    }
    assert.strictEqual(command.message.attachments.length, 3);
    assert.strictEqual("dataUrl" in command.message.attachments[0]!, true);
    assert.strictEqual("id" in command.message.attachments[1]!, true);
    assert.strictEqual(command.message.attachments[2]!.type, "file");
  }),
);

// Attachments ride on persisted events and thread streams with no client
// version negotiation. A type this build does not know must decode instead of
// failing the whole message.
it.effect("tolerates attachment types from newer builds when decoding messages", () =>
  Effect.gen(function* () {
    const futureAttachment = {
      type: "somethingnew",
      id: "thread-1-00000000-0000-4000-8000-000000000003-glb",
      name: "scene.glb",
      mimeType: "model/gltf-binary",
      sizeBytes: 12,
    };

    const message = yield* decodeOrchestrationMessage({
      id: "message-1",
      role: "user",
      text: "look at this",
      attachments: [futureAttachment],
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(message.attachments?.length, 1);
    assert.strictEqual(message.attachments?.[0]!.type, "somethingnew");

    const payload = yield* decodeThreadMessageSentPayload({
      threadId: "thread-1",
      messageId: "message-1",
      role: "user",
      text: "look at this",
      attachments: [futureAttachment],
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(payload.attachments?.[0]!.type, "somethingnew");
  }),
);

// The tolerant member must not catch malformed known attachments: a file over
// the size cap or an image with a bad mime has to fail its own schema, not
// slide through the open one with those constraints unchecked.
it.effect("rejects malformed known attachment types instead of tolerating them", () =>
  Effect.gen(function* () {
    const base = {
      id: "thread-1-00000000-0000-4000-8000-000000000003-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    };
    const decode = (attachment: unknown) =>
      decodeOrchestrationMessage({
        id: "message-1",
        role: "user",
        text: "look at this",
        attachments: [attachment],
        turnId: null,
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

    const oversizedFile = yield* Effect.exit(
      decode({ ...base, type: "file", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 }),
    );
    assert.strictEqual(Exit.isFailure(oversizedFile), true);

    const badMimeImage = yield* Effect.exit(
      decode({ ...base, type: "image", mimeType: "application/pdf", sizeBytes: 12 }),
    );
    assert.strictEqual(Exit.isFailure(badMimeImage), true);
  }),
);

it.effect("rejects accessibility trees above the serialized payload limit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSnapShotAccessibility({
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize: { width: 800, height: 600 },
        truncated: false,
        root: {
          role: "window",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: Array.from({ length: 10 }, () => ({
            role: "text",
            value: "x".repeat(8_000),
            bounds: null,
            children: [],
          })),
        },
      }),
    );

    assert.strictEqual(Exit.isFailure(result), true);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.instanceId, "codex");
  }),
);

it.effect("decodes thread settle and unsettle commands", () =>
  Effect.gen(function* () {
    const settle = yield* decodeOrchestrationCommand({
      type: "thread.settle",
      commandId: "cmd-settle-1",
      threadId: "thread-1",
    });
    const unsettle = yield* decodeOrchestrationCommand({
      type: "thread.unsettle",
      commandId: "cmd-unsettle-1",
      threadId: "thread-1",
      reason: "user",
    });

    assert.strictEqual(settle.type, "thread.settle");
    assert.strictEqual(unsettle.type, "thread.unsettle");

    // "activity" is server-owned: it exists on the event, never on the
    // command, so a client cannot forge the neutral reset.
    const forged = yield* decodeOrchestrationCommand({
      type: "thread.unsettle",
      commandId: "cmd-unsettle-2",
      threadId: "thread-1",
      reason: "activity",
    }).pipe(Effect.flip);
    assert.ok(forged);
  }),
);

it.effect("defaults settled fields when decoding historical thread data", () =>
  Effect.gen(function* () {
    const common = {
      id: "thread-1",
      projectId: "project-1",
      title: "Historical thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
    };
    const thread = yield* decodeOrchestrationThread({
      ...common,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
    const shell = yield* decodeOrchestrationThreadShell({
      ...common,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });

    assert.strictEqual(thread.settledOverride, null);
    assert.strictEqual(thread.settledAt, null);
    assert.strictEqual(shell.settledOverride, null);
    assert.strictEqual(shell.settledAt, null);
    // Pre-link servers omit the array entirely.
    assert.deepStrictEqual(thread.pullRequests, []);
    assert.deepStrictEqual(shell.pullRequests, []);

    const legacyLink = {
      projectId: ProjectId.make("project-1"),
      repository: "acme/web",
      number: 42,
      url: "https://github.com/acme/web/pull/42",
    };
    const oldServerShell = yield* decodeOrchestrationThreadShell({
      ...common,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      linkedPullRequest: legacyLink,
    });
    assert.deepStrictEqual(oldServerShell.pullRequests, []);
    assert.deepStrictEqual(oldServerShell.linkedPullRequest, legacyLink);

    // A decoder from before the array must still read its single-link field
    // after a new server encodes the expanded snapshot.
    const oldLinkFields = Schema.Struct({
      linkedPullRequest: Schema.optional(ThreadLinkedPullRequest),
    });
    const newServerWire = yield* Schema.encodeEffect(OrchestrationThreadShell)({
      ...oldServerShell,
      pullRequests: [
        {
          host: "github.com",
          repository: legacyLink.repository,
          number: legacyLink.number,
          url: legacyLink.url,
          source: "agent",
          linkedAt: common.createdAt,
          snapshot: null,
          stack: null,
        },
      ],
    });
    const oldClientFields = yield* Schema.decodeUnknownEffect(oldLinkFields)(newServerWire);
    assert.deepStrictEqual(oldClientFields.linkedPullRequest, legacyLink);
  }),
);

// A stored event that fails to decode stops the event store read, and with it
// server startup, so rows written before `turnId` existed must still load.
it.effect("decodes a legacy message-sent event persisted without turnId", () =>
  Effect.gen(function* () {
    const event = yield* decodeOrchestrationEvent({
      sequence: 539,
      eventId: "event-message-legacy-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.message-sent",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-message-legacy-1",
      causationEventId: null,
      correlationId: "cmd-message-legacy-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        messageId: "message-1",
        role: "user",
        text: "written before turn ids were recorded",
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    assert.strictEqual(event.type, "thread.message-sent");
    if (event.type !== "thread.message-sent") return;
    assert.strictEqual(event.payload.turnId, null);
  }),
);

it.effect("normalizes legacy object-shaped modelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Legacy options thread",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,
          // Falsy/garbage entries are dropped, matching migration 026.
          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.modelSelection.instanceId, ProviderInstanceId.make("claudeAgent"));
    assert.deepStrictEqual(parsed.modelSelection.options, [
      { id: "effort", value: "max" },
      { id: "fastMode", value: true },
    ]);
  }),
);

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeThreadCreatedPayload({
        threadId: "thread-1",
        projectId: "project-1",
        title: "Round trip thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: { fastMode: true },
        },
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      const encoded = yield* encodeThreadCreatedPayload(decoded);
      assert.deepStrictEqual(encoded.modelSelection.options, [{ id: "fastMode", value: true }]);
    }),
);

it.effect("decodes active reorder commands through client and orchestration boundaries", () =>
  Effect.gen(function* () {
    const input = {
      type: "thread.active.reorder",
      commandId: "cmd-active-reorder",
      threadId: "thread-1",
      orderKey: "gm",
    };
    const clientCommand = yield* decodeClientOrchestrationCommand(input);
    const command = yield* decodeOrchestrationCommand(input);
    for (const decoded of [clientCommand, command]) {
      assert.strictEqual(decoded.type, "thread.active.reorder");
      if (decoded.type === "thread.active.reorder") {
        assert.strictEqual(decoded.threadId, "thread-1");
        assert.strictEqual(decoded.orderKey, "gm");
      }
    }
    const emptyKey = yield* Effect.exit(
      decodeClientOrchestrationCommand({ ...input, orderKey: " " }),
    );
    assert.isTrue(Exit.isFailure(emptyKey));
  }),
);

it.effect("decodes active placement on existing metadata events while accepting old payloads", () =>
  Effect.gen(function* () {
    const payload = { threadId: "thread-1", updatedAt: "2026-01-01T00:00:00.000Z" };
    const oldPayload = yield* decodeThreadMetaUpdatedPayload(payload);
    assert.strictEqual(oldPayload.activeOrderKey, undefined);
    const resetPayload = yield* decodeThreadMetaUpdatedPayload({
      ...payload,
      activeOrderKey: null,
    });
    assert.strictEqual(resetPayload.activeOrderKey, null);
    const event = yield* decodeOrchestrationEvent({
      type: "thread.meta-updated",
      sequence: 1,
      eventId: "event-active-reorder",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-active-reorder",
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: { ...payload, activeOrderKey: "gm" },
    });
    assert.strictEqual(event.type, "thread.meta-updated");
    if (event.type === "thread.meta-updated") {
      assert.strictEqual(event.payload.activeOrderKey, "gm");
      assert.strictEqual(event.payload.updatedAt, payload.updatedAt);
    }
  }),
);

it.effect("accepts a title regeneration intent in thread.meta.update", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationCommand({
      type: "thread.meta.update",
      commandId: "cmd-title-regenerate",
      threadId: "thread-1",
      regenerateTitle: true,
    });
    assert.strictEqual(parsed.type, "thread.meta.update");
    if (parsed.type === "thread.meta.update") {
      assert.strictEqual(parsed.regenerateTitle, true);
    }
  }),
);

it.effect("still decodes a persisted thread.meta-updated event carrying linkedPullRequest", () =>
  Effect.gen(function* () {
    const event = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-legacy-link",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.meta-updated",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-legacy-link",
      causationEventId: null,
      correlationId: "cmd-legacy-link",
      metadata: {},
      payload: {
        threadId: "thread-1",
        linkedPullRequest: {
          projectId: "project-1",
          repository: "pingdotgg/t3code",
          number: 42,
          url: "https://github.com/pingdotgg/t3code/pull/42",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    if (event.type !== "thread.meta-updated") {
      assert.fail(`Expected thread.meta-updated event, received ${event.type}.`);
    }
    assert.strictEqual(event.payload.linkedPullRequest?.number, 42);
  }),
);

it.effect("accepts pull request synchronization only as an internal command", () =>
  Effect.gen(function* () {
    const pullRequest = {
      projectId: ProjectId.make("project-1"),
      repository: "pingdotgg/t3code",
      number: 42,
      url: "https://github.com/pingdotgg/t3code/pull/42",
    };
    const command = {
      type: "thread.pull-request.sync" as const,
      commandId: CommandId.make("cmd-pull-request-sync"),
      threadId: ThreadId.make("thread-1"),
      projectId: pullRequest.projectId,
      snapshotSequence: 12,
      expected: {
        workspaceRoot: "/workspace/project",
        branch: "feature",
        worktreePath: null,
        linkedPullRequest: null,
        branchPullRequest: null,
      },
      branchPullRequest: pullRequest,
      linkedPullRequest: pullRequest,
    };

    assert.deepStrictEqual(yield* decodeOrchestrationCommand(command), command);
    assert.ok(yield* decodeClientOrchestrationCommand(command).pipe(Effect.flip));

    const cleared = { ...command, branchPullRequest: null };
    assert.deepStrictEqual(yield* decodeOrchestrationCommand(cleared), cleared);

    const metadata = yield* decodeClientOrchestrationCommand({
      type: "thread.meta.update",
      commandId: "cmd-forged-branch-pull-request",
      threadId: "thread-1",
      branchPullRequest: pullRequest,
    });
    assert.isFalse("branchPullRequest" in metadata);
  }),
);

it.effect("rejects an explicit title combined with title regeneration", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "thread.meta.update",
        commandId: "cmd-title-regenerate-with-title",
        threadId: "thread-1",
        title: "Explicit title",
        regenerateTitle: true,
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

// ── ModelSelection: instance-keyed wire shape + legacy decoder ────────
//
// `ModelSelection` is routing-keyed on `instanceId` — never a driver kind.
// Persisted and in-flight payloads from pre-instance builds carry a
// `provider` field whose value was a driver kind; those payloads are migrated
// at the wire boundary by
// promoting `provider` to the default instance id for that driver
// (built-in drivers use the driver kind slug as their default instance id, so
// the migration is a 1:1 rename).
//
// These tests pin the rollback/fork tolerance invariant: legacy payloads
// decode cleanly for fork-provided drivers, and the decoded form uses
// `instanceId` uniformly regardless of origin.

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection accepts an explicit instanceId routing key", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect("ModelSelection encodes to the canonical instanceId wire form", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeModelSelection({
      provider: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
    const encoded = yield* encodeModelSelection(decoded);
    assert.deepStrictEqual(encoded, {
      instanceId: "ollama",
      model: "llama3:70b",
      options: [{ id: "temperature", value: "0.4" }],
    });
  }),
);

it.effect("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeModelSelection({
        instanceId: "1invalid", // must start with a letter
        model: "x",
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("project favicon overrides accept only supported image files", () =>
  Effect.gen(function* () {
    const valid = yield* decodeOrchestrationCommand({
      type: "project.meta.update",
      commandId: "cmd-project-favicon",
      projectId: "project-1",
      faviconPath: "brand/icon.svg",
    });
    assert.strictEqual(valid.type, "project.meta.update");

    const invalid = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "project.meta.update",
        commandId: "cmd-project-secret",
        projectId: "project-1",
        faviconPath: ".env",
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it.effect("project icon overrides accept Lucide icons, colors, and emoji", () =>
  Effect.gen(function* () {
    const lucide = yield* decodeOrchestrationCommand({
      type: "project.meta.update",
      commandId: "cmd-project-lucide-icon",
      projectId: "project-1",
      projectIcon: { kind: "lucide", name: "alarm-clock", color: "violet" },
    });
    assert.strictEqual(lucide.type, "project.meta.update");

    const emoji = yield* decodeOrchestrationCommand({
      type: "project.meta.update",
      commandId: "cmd-project-emoji-icon",
      projectId: "project-1",
      projectIcon: { kind: "emoji", emoji: "👩🏽‍💻" },
    });
    assert.strictEqual(emoji.type, "project.meta.update");

    const invalid = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "project.meta.update",
        commandId: "cmd-project-invalid-icon",
        projectId: "project-1",
        projectIcon: { kind: "lucide", name: "Alarm Clock", color: "ultraviolet" },
      }),
    );
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

it.effect("project monograms validate text and palette colors", () =>
  Effect.gen(function* () {
    for (const text of ["A", "T3", "É", "文書", "कि", "किखि", "e\u0301"]) {
      const projectIcon = {
        kind: "monogram",
        color: "violet",
        text,
      } as const;
      const command = yield* decodeOrchestrationCommand({
        type: "project.meta.update",
        commandId: "cmd-monogram",
        projectId: "project-1",
        projectIcon,
      });
      assert.strictEqual(command.type, "project.meta.update");
      if (command.type === "project.meta.update")
        assert.deepEqual(command.projectIcon, { kind: "monogram", text, color: "violet" });
    }
    for (const projectIcon of [
      { kind: "monogram", text: "", color: "blue" },
      { kind: "monogram", text: "\u0301", color: "blue" },
      { kind: "monogram", text: "A B", color: "blue" },
      { kind: "monogram", text: "🚀", color: "blue" },
      { kind: "monogram", text: "T3", color: "ultraviolet" },
    ]) {
      const result = yield* Effect.exit(
        decodeOrchestrationCommand({
          type: "project.meta.update",
          commandId: "cmd-monogram-invalid",
          projectId: "project-1",
          projectIcon,
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }
  }),
);

it.effect("rejects thread history imports without messages", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeOrchestrationCommand({
        type: "thread.history.import",
        commandId: "command-empty-history",
        threadId: "thread-1",
        messages: [],
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);

it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});

const decodeProjectIcon = Schema.decodeUnknownEffect(ProjectIconOverride);
const encodeProjectIcon = Schema.encodeEffect(ProjectIconOverride);

// Pre-monogram clients reject unknown variants; nightly clients additionally validate monogram.
const decodeOldIcon = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("lucide"), name: Schema.String, color: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.String }),
  ]),
);
const decodeNightlyIcon = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("lucide"),
      name: Schema.String,
      color: Schema.String,
      // Fail if this field is ever sent; old validators must never see the new text.
      monogram: Schema.optional(Schema.Never),
    }),
    Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.String }),
  ]),
);

it.effect("sends monograms as fallback icons that old and nightly clients can decode", () =>
  Effect.gen(function* () {
    const fallback = { kind: "lucide", name: "folder-code", color: "violet" } as const;
    for (const text of ["T3", "क्ष्म", "e\u0301"]) {
      const monogram = { kind: "monogram", text, color: "violet" } as const;
      const wire = yield* encodeProjectIcon(monogram);
      assert.deepEqual(wire, { ...fallback, monogramText: text });
      assert.deepEqual(yield* decodeOldIcon(wire), fallback);
      assert.deepEqual(yield* decodeNightlyIcon(wire), fallback);
      assert.deepEqual(yield* decodeProjectIcon(wire), monogram);
      assert.deepEqual(yield* decodeProjectIcon(monogram), monogram);
      assert.deepEqual(yield* decodeProjectIcon({ ...fallback, monogram: text }), monogram);
    }
    for (const icon of [
      { kind: "lucide", name: "alarm-clock", color: "blue" },
      { kind: "emoji", emoji: "🚀" },
    ] as const) {
      assert.deepEqual(yield* decodeProjectIcon(icon), icon);
      assert.deepEqual(yield* encodeProjectIcon(icon), icon);
    }
  }),
);

const encodeProjectShell = Schema.encodeEffect(OrchestrationProjectShell);
const encodeClientCommand = Schema.encodeEffect(ClientOrchestrationCommand);
const decodeLegacyShell = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...OrchestrationProjectShell.fields,
    projectIcon: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          kind: Schema.Literal("lucide"),
          name: Schema.String,
          color: Schema.String,
        }),
      ),
    ),
  }),
);

it.effect("encodes compatible icons inside snapshots and client commands", () =>
  Effect.gen(function* () {
    const projectIcon = { kind: "monogram", text: "क्ष्म", color: "violet" } as const;
    const shell = yield* encodeProjectShell({
      id: ProjectId.make("monogram"),
      title: "Monogram",
      workspaceRoot: "/tmp/monogram",
      defaultModelSelection: null,
      scripts: [],
      projectIcon,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const fallback = { kind: "lucide", name: "folder-code", color: "violet" } as const;
    assert.deepEqual((yield* decodeLegacyShell(shell)).projectIcon, fallback);
    const command = yield* encodeClientCommand({
      type: "project.meta.update",
      projectId: ProjectId.make("monogram"),
      commandId: CommandId.make("monogram"),
      projectIcon,
    });
    if (command.type !== "project.meta.update") throw new Error("Unexpected command");
    assert.deepEqual(yield* decodeNightlyIcon(command.projectIcon), fallback);
  }),
);
