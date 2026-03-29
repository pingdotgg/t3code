import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";

import {
  ClientOrchestrationCommand,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationGetTurnDiffInput,
  OrchestrationLatestTurn,
  OrchestrationProposedPlan,
  OrchestrationReadModel,
  OrchestrationSession,
  ProjectCreateCommand,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  ThreadCreatedPayload,
  ThreadMetaUpdatedPayload,
  ThreadTurnDiff,
  ThreadTurnStartCommand,
  ThreadTurnStartRequestedPayload,
} from "./orchestration";

const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeProjectCreateCommand = Schema.decodeUnknownEffect(ProjectCreateCommand);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeClientOrchestrationCommand = Schema.decodeUnknownEffect(ClientOrchestrationCommand);
const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeThreadTurnStartCommand = Schema.decodeUnknownEffect(ThreadTurnStartCommand);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeOrchestrationCommand = Schema.decodeUnknownEffect(OrchestrationCommand);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);

describe("orchestration contracts", () => {
  it("parses turn diff input when fromTurnCount <= toTurnCount", async () => {
    const parsed = await Effect.runPromise(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 1,
        toTurnCount: 2,
      }),
    );

    expect(parsed.fromTurnCount).toBe(1);
    expect(parsed.toTurnCount).toBe(2);
  });

  it("rejects turn diff input when fromTurnCount > toTurnCount", async () => {
    const result = await Effect.runPromise(
      Effect.exit(
        decodeTurnDiffInput({
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
  });

  it("rejects thread turn diff when fromTurnCount > toTurnCount", async () => {
    const result = await Effect.runPromise(
      Effect.exit(
        decodeThreadTurnDiff({
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
          diff: "patch",
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
  });

  it("trims branded ids and command string fields at decode boundaries", async () => {
    const parsed = await Effect.runPromise(
      decodeProjectCreateCommand({
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
      }),
    );

    expect(parsed.commandId).toBe("cmd-1");
    expect(parsed.projectId).toBe("project-1");
    expect(parsed.title).toBe("Project Title");
    expect(parsed.workspaceRoot).toBe("/tmp/workspace");
    expect(parsed.defaultModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.2",
    });
  });

  it("decodes historical project.created payloads with a default provider", async () => {
    const parsed = await Effect.runPromise(
      decodeProjectCreatedPayload({
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
      }),
    );

    expect(parsed.defaultModelSelection?.provider).toBe("codex");
  });

  it("decodes project.meta-updated payloads with explicit default provider", async () => {
    const parsed = await Effect.runPromise(
      decodeProjectMetaUpdatedPayload({
        projectId: "project-1",
        defaultModelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.defaultModelSelection?.provider).toBe("claudeAgent");
  });

  it("rejects command fields that become empty after trim", async () => {
    const result = await Effect.runPromise(
      Effect.exit(
        decodeProjectCreateCommand({
          type: "project.create",
          commandId: "cmd-1",
          projectId: "project-1",
          title: "  ",
          workspaceRoot: "/tmp/workspace",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
  });

  it("decodes thread.turn.start defaults for provider and runtime mode", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadTurnStartCommand({
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
      }),
    );

    expect(parsed.modelSelection).toBeUndefined();
    expect(parsed.runtimeMode).toBe(DEFAULT_RUNTIME_MODE);
    expect(parsed.interactionMode).toBe(DEFAULT_PROVIDER_INTERACTION_MODE);
  });

  it("preserves explicit provider and runtime mode in thread.turn.start", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadTurnStartCommand({
        type: "thread.turn.start",
        commandId: "cmd-turn-2",
        threadId: "thread-1",
        message: {
          messageId: "msg-2",
          role: "user",
          text: "hello",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.modelSelection?.provider).toBe("codex");
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.interactionMode).toBe(DEFAULT_PROVIDER_INTERACTION_MODE);
  });

  it("accepts a title seed in thread.turn.start", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadTurnStartCommand({
        type: "thread.turn.start",
        commandId: "cmd-turn-title-seed",
        threadId: "thread-1",
        message: {
          messageId: "msg-title-seed",
          role: "user",
          text: "hello",
          attachments: [],
        },
        titleSeed: "Investigate reconnect failures",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.titleSeed).toBe("Investigate reconnect failures");
  });

  it("accepts a source proposed plan reference in thread.turn.start", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadTurnStartCommand({
        type: "thread.turn.start",
        commandId: "cmd-turn-source-plan",
        threadId: "thread-2",
        message: {
          messageId: "msg-source-plan",
          role: "user",
          text: "implement this",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: "thread-1",
          planId: "plan-1",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.sourceProposedPlan).toEqual({
      threadId: "thread-1",
      planId: "plan-1",
    });
  });

  it("decodes thread.created runtime mode for historical events", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadCreatedPayload({
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
      }),
    );

    expect(parsed.runtimeMode).toBe(DEFAULT_RUNTIME_MODE);
    expect(parsed.modelSelection.provider).toBe("codex");
  });

  it("decodes thread.meta-updated payloads with explicit provider", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadMetaUpdatedPayload({
        threadId: "thread-1",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
  });

  it("decodes thread archive and unarchive commands", async () => {
    const archive = await Effect.runPromise(
      decodeOrchestrationCommand({
        type: "thread.archive",
        commandId: "cmd-archive-1",
        threadId: "thread-1",
      }),
    );
    const unarchive = await Effect.runPromise(
      decodeOrchestrationCommand({
        type: "thread.unarchive",
        commandId: "cmd-unarchive-1",
        threadId: "thread-1",
      }),
    );

    expect(archive.type).toBe("thread.archive");
    expect(unarchive.type).toBe("thread.unarchive");
  });

  it("decodes thread archived and unarchived events", async () => {
    const archived = await Effect.runPromise(
      decodeOrchestrationEvent({
        sequence: 1,
        eventId: "event-archive-1",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        type: "thread.archived",
        occurredAt: "2026-01-01T00:00:00.000Z",
        commandId: "cmd-archive-1",
        causationEventId: null,
        correlationId: "cmd-archive-1",
        metadata: {},
        payload: {
          threadId: "thread-1",
          archivedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    const unarchived = await Effect.runPromise(
      decodeOrchestrationEvent({
        sequence: 2,
        eventId: "event-unarchive-1",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        type: "thread.unarchived",
        occurredAt: "2026-01-02T00:00:00.000Z",
        commandId: "cmd-unarchive-1",
        causationEventId: null,
        correlationId: "cmd-unarchive-1",
        metadata: {},
        payload: {
          threadId: "thread-1",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    );

    expect(archived.type).toBe("thread.archived");
    expect(unarchived.type).toBe("thread.unarchived");
    if (archived.type !== "thread.archived") {
      throw new Error(`Unexpected archived event type: ${archived.type}`);
    }
    expect(archived.payload.archivedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("accepts provider-scoped model options in thread.turn.start", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadTurnStartCommand({
        type: "thread.turn.start",
        commandId: "cmd-turn-options",
        threadId: "thread-1",
        message: {
          messageId: "msg-options",
          role: "user",
          text: "hello",
          attachments: [],
        },
        modelSelection: {
          provider: "codex",
          model: "gpt-5.3-codex",
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.modelSelection?.provider).toBe("codex");
    if (parsed.modelSelection?.provider !== "codex") {
      throw new Error(`Unexpected provider: ${parsed.modelSelection?.provider ?? "missing"}`);
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("high");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });

  it("decodes queued follow-up enqueue commands from client payloads", async () => {
    const parsed = await Effect.runPromise(
      decodeClientOrchestrationCommand({
        type: "thread.queued-follow-up.enqueue",
        commandId: "cmd-queue-1",
        threadId: "thread-1",
        followUp: {
          id: "follow-up-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          prompt: "send this next",
          attachments: [
            {
              type: "image",
              name: "example.png",
              mimeType: "image/png",
              sizeBytes: 4,
              dataUrl: "data:image/png;base64,AAAA",
            },
          ],
          terminalContexts: [],
          modelSelection: {
            provider: "codex",
            model: "gpt-5.3-codex",
          },
          runtimeMode: "full-access",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    if (parsed.type !== "thread.queued-follow-up.enqueue") {
      throw new Error(`Unexpected command type: ${parsed.type}`);
    }
    expect(parsed.followUp.lastSendError).toBeNull();
    expect(parsed.followUp.interactionMode).toBe(DEFAULT_PROVIDER_INTERACTION_MODE);
    expect(parsed.followUp.attachments).toEqual([
      {
        type: "image",
        name: "example.png",
        mimeType: "image/png",
        sizeBytes: 4,
        dataUrl: "data:image/png;base64,AAAA",
      },
    ]);
  });

  it("decodes thread snapshots with queued follow-ups defaulting to empty", async () => {
    const parsed = await Effect.runPromise(
      decodeReadModel({
        snapshotSequence: 1,
        projects: [],
        threads: [
          {
            id: "thread-1",
            projectId: "project-1",
            title: "Thread 1",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.threads[0]?.queuedFollowUps).toEqual([]);
  });

  it("decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.modelSelection).toBeUndefined();
    expect(parsed.runtimeMode).toBe(DEFAULT_RUNTIME_MODE);
    expect(parsed.interactionMode).toBe(DEFAULT_PROVIDER_INTERACTION_MODE);
    expect(parsed.sourceProposedPlan).toBeUndefined();
  });

  it("decodes thread.turn-start-requested source proposed plan metadata when present", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadTurnStartRequestedPayload({
        threadId: "thread-2",
        messageId: "msg-2",
        sourceProposedPlan: {
          threadId: "thread-1",
          planId: "plan-1",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.sourceProposedPlan).toEqual({
      threadId: "thread-1",
      planId: "plan-1",
    });
  });

  it("decodes thread.turn-start-requested title seed when present", async () => {
    const parsed = await Effect.runPromise(
      decodeThreadTurnStartRequestedPayload({
        threadId: "thread-2",
        messageId: "msg-2",
        titleSeed: "Investigate reconnect failures",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.titleSeed).toBe("Investigate reconnect failures");
  });

  it("decodes latest turn source proposed plan metadata when present", async () => {
    const parsed = await Effect.runPromise(
      decodeOrchestrationLatestTurn({
        turnId: "turn-2",
        state: "running",
        requestedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: null,
        assistantMessageId: null,
        sourceProposedPlan: {
          threadId: "thread-1",
          planId: "plan-1",
        },
      }),
    );

    expect(parsed.sourceProposedPlan).toEqual({
      threadId: "thread-1",
      planId: "plan-1",
    });
  });

  it("decodes orchestration session runtime mode defaults", async () => {
    const parsed = await Effect.runPromise(
      decodeOrchestrationSession({
        threadId: "thread-1",
        status: "idle",
        providerName: null,
        providerSessionId: null,
        providerThreadId: null,
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.runtimeMode).toBe(DEFAULT_RUNTIME_MODE);
  });

  it("defaults proposed plan implementation metadata for historical rows", async () => {
    const parsed = await Effect.runPromise(
      decodeOrchestrationProposedPlan({
        id: "plan-1",
        turnId: "turn-1",
        planMarkdown: "# Plan",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(parsed.implementedAt).toBeNull();
    expect(parsed.implementationThreadId).toBeNull();
  });

  it("preserves proposed plan implementation metadata when present", async () => {
    const parsed = await Effect.runPromise(
      decodeOrchestrationProposedPlan({
        id: "plan-2",
        turnId: "turn-2",
        planMarkdown: "# Plan",
        implementedAt: "2026-01-02T00:00:00.000Z",
        implementationThreadId: "thread-2",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );

    expect(parsed.implementedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(parsed.implementationThreadId).toBe("thread-2");
  });
});
