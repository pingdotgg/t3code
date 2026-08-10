import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  boundSupervisorText,
  createBoundedSupervisorReadResult,
  createSupervisorJsonSnapshot,
  createThreadSupervisorCore,
  makeSupervisorTargetVersion,
  type CreateThreadSupervisorCoreOptions,
  type PublishSupervisorTargetsResult,
  type SupervisorJsonSnapshotBounds,
  type SupervisorMutationProposalResult,
  type SupervisorProposalHandle,
  type SupervisorTargetCandidate,
  type SupervisorTargetHandle,
  type ThreadSupervisorCore,
} from "./threadSupervisor.ts";

const SNAPSHOT_BOUNDS: SupervisorJsonSnapshotBounds = {
  maxDepth: 8,
  maxNodes: 64,
  maxBytes: 2_048,
  maxKeys: 32,
  maxArrayItems: 16,
};

const MutationSchema = Schema.Struct({
  kind: Schema.Literals(["start", "follow-up", "interrupt"]),
  command: Schema.Struct({
    commandId: Schema.String,
    messageId: Schema.optional(Schema.String),
  }),
});
const PreviewSchema = Schema.Struct({
  instruction: Schema.String,
  model: Schema.String,
  workspace: Schema.Struct({
    mode: Schema.Literals(["local", "worktree"]),
    runSetupScript: Schema.Boolean,
  }),
});
const decodeMutation = Schema.decodeUnknownSync(MutationSchema);
const decodePreview = Schema.decodeUnknownSync(PreviewSchema);
const decodeJsonObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));

function projectTarget(input: {
  environmentId: string;
  projectId: string;
  label: string;
  aliases?: ReadonlyArray<string>;
  version?: string;
  availability?: SupervisorTargetCandidate["availability"];
}): SupervisorTargetCandidate {
  return {
    binding: {
      kind: "project",
      environmentId: EnvironmentId.make(input.environmentId),
      projectId: ProjectId.make(input.projectId),
      version: makeSupervisorTargetVersion(input.version ?? "1"),
    },
    label: input.label,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    availability: input.availability ?? "live",
  };
}

function threadTarget(input: {
  environmentId: string;
  projectId?: string;
  threadId: string;
  label: string;
  aliases?: ReadonlyArray<string>;
  version?: string;
  availability?: SupervisorTargetCandidate["availability"];
}): SupervisorTargetCandidate {
  return {
    binding: {
      kind: "thread",
      environmentId: EnvironmentId.make(input.environmentId),
      projectId: ProjectId.make(input.projectId ?? "project-1"),
      threadId: ThreadId.make(input.threadId),
      version: makeSupervisorTargetVersion(input.version ?? "1"),
    },
    label: input.label,
    ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
    availability: input.availability ?? "live",
  };
}

function makeCore(input: Partial<CreateThreadSupervisorCoreOptions> = {}): ThreadSupervisorCore {
  let nextId = 0;
  const {
    now = () => 1_000,
    makeOpaqueId = (kind: "target" | "proposal") => `${kind}-opaque-${++nextId}`,
    ...limits
  } = input;
  return createThreadSupervisorCore({ now, makeOpaqueId, ...limits });
}

function publishThreads(
  core: ThreadSupervisorCore,
  callId: string,
  targets: ReadonlyArray<SupervisorTargetCandidate>,
): PublishSupervisorTargetsResult {
  return core.publishTargets({ callId, targetKind: "thread", targets });
}

function publishProjects(
  core: ThreadSupervisorCore,
  callId: string,
  targets: ReadonlyArray<SupervisorTargetCandidate>,
): PublishSupervisorTargetsResult {
  return core.publishTargets({ callId, targetKind: "project", targets });
}

function publishedHandle(
  result: PublishSupervisorTargetsResult,
  index = 0,
): SupervisorTargetHandle {
  if (result.status !== "published") throw new Error("Expected targets to be published.");
  const handle = result.result.items[index]?.handle;
  if (handle === undefined) throw new Error("Expected a published target handle.");
  return handle;
}

function proposalHandle(result: SupervisorMutationProposalResult): SupervisorProposalHandle {
  if (result.status !== "proposed") throw new Error("Expected a mutation proposal.");
  return result.proposal.handle;
}

function preview(instruction = "Do the work") {
  return {
    instruction,
    model: "gpt-5",
    workspace: { mode: "worktree", runSetupScript: true },
  };
}

function proposalInput(targetHandle: string, callId: string) {
  return {
    callId,
    targetHandle,
    expectedTargetKind: "thread" as const,
    action: "Follow up",
    summary: "Ask the agent to continue",
    mutation: {
      kind: "follow-up",
      command: { commandId: `command-${callId}`, messageId: `message-${callId}` },
    },
    preview: preview(`Full instruction for ${callId}`),
  };
}

function jsonObject(value: Schema.Json): Schema.JsonObject {
  return decodeJsonObject(value);
}

describe("supervisor JSON snapshots", () => {
  it("creates sorted, deeply frozen own-data JSON objects", () => {
    const result = createSupervisorJsonSnapshot(
      { z: [1, { ok: true }], a: "first" },
      SNAPSHOT_BOUNDS,
    );

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.signature).toBe('{"a":"first","z":[1,{"ok":true}]}');
    if (result.value === null || typeof result.value !== "object") {
      throw new Error("Expected an object snapshot");
    }
    expect(typeof result.value).toBe("object");
    expect(Array.isArray(result.value)).toBe(false);
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(Object.keys(result.value)).toEqual(["a", "z"]);
    expect(Object.isFrozen(result.value)).toBe(true);
    const z = jsonObject(result.value).z;
    expect(Array.isArray(z)).toBe(true);
    expect(Object.isFrozen(z)).toBe(true);
    if (!Array.isArray(z)) return;
    expect(Object.isFrozen(z[1])).toBe(true);
  });

  it("rejects prototype smuggling and unsafe own keys", () => {
    const inherited: object = Object.create({ kind: "interrupt" });
    expect(createSupervisorJsonSnapshot(inherited, SNAPSHOT_BOUNDS)).toMatchObject({
      status: "rejected",
      reason: "unsupported-object",
    });

    const unsafe: unknown = JSON.parse('{"__proto__":{"kind":"interrupt"}}');
    expect(createSupervisorJsonSnapshot(unsafe, SNAPSHOT_BOUNDS)).toMatchObject({
      status: "rejected",
      reason: "unsafe-key",
    });
    expect(
      createSupervisorJsonSnapshot({ constructor: { kind: "interrupt" } }, SNAPSHOT_BOUNDS),
    ).toMatchObject({ status: "rejected", reason: "unsafe-key" });
  });

  it.each([
    Reflect.construct(globalThis.Date, ["2026-08-10T00:00:00.000Z"]),
    new Map([["kind", "interrupt"]]),
  ])("rejects non-plain object %s", (value) => {
    expect(createSupervisorJsonSnapshot(value, SNAPSHOT_BOUNDS)).toMatchObject({
      status: "rejected",
      reason: "unsupported-object",
    });
  });

  it("rejects accessors without invoking them", () => {
    const getter = vi.fn(() => "interrupt");
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, "kind", { enumerable: true, get: getter });

    expect(createSupervisorJsonSnapshot(value, SNAPSHOT_BOUNDS)).toMatchObject({
      status: "rejected",
      reason: "accessor",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects cycles and non-finite numbers", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(createSupervisorJsonSnapshot(cycle, SNAPSHOT_BOUNDS)).toMatchObject({
      status: "rejected",
      reason: "cycle",
    });
    expect(createSupervisorJsonSnapshot({ value: Number.NaN }, SNAPSHOT_BOUNDS)).toMatchObject({
      status: "rejected",
      reason: "non-finite-number",
    });
  });

  it("rejects arrays with own properties outside their JSON items", () => {
    const value = ["safe"];
    Object.defineProperty(value, "4294967295", {
      value: "hidden",
      enumerable: true,
    });

    expect(createSupervisorJsonSnapshot(value, SNAPSHOT_BOUNDS)).toMatchObject({
      status: "rejected",
      reason: "unsupported-object",
    });
  });

  it("fails closed on excessive depth, nodes, bytes, keys, and array items", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 6; index += 1) {
      const child: Record<string, unknown> = {};
      cursor.next = child;
      cursor = child;
    }
    expect(createSupervisorJsonSnapshot(deep, { ...SNAPSHOT_BOUNDS, maxDepth: 3 })).toMatchObject({
      status: "rejected",
      reason: "depth-limit",
    });
    expect(
      createSupervisorJsonSnapshot(
        { values: [1, 2, 3, 4] },
        {
          ...SNAPSHOT_BOUNDS,
          maxNodes: 3,
        },
      ),
    ).toMatchObject({ status: "rejected", reason: "node-limit" });
    expect(
      createSupervisorJsonSnapshot(
        { text: "x".repeat(100) },
        {
          ...SNAPSHOT_BOUNDS,
          maxBytes: 32,
        },
      ),
    ).toMatchObject({ status: "rejected", reason: "byte-limit" });
    expect(
      createSupervisorJsonSnapshot(
        { a: 1, b: 2, c: 3 },
        {
          ...SNAPSHOT_BOUNDS,
          maxKeys: 2,
        },
      ),
    ).toMatchObject({ status: "rejected", reason: "key-limit" });
    expect(
      createSupervisorJsonSnapshot([1, 2, 3], {
        ...SNAPSHOT_BOUNDS,
        maxArrayItems: 2,
      }),
    ).toMatchObject({ status: "rejected", reason: "array-limit" });
  });
});

describe("supervisor read and target boundaries", () => {
  it("caps generic reads and text", () => {
    expect(createBoundedSupervisorReadResult([1, 2, 3], { maxItems: 2 })).toEqual({
      items: [1, 2],
      totalCount: 3,
      omittedCount: 1,
      truncated: true,
    });
    expect(boundSupervisorText("abcdefghij", 7)).toBe("abcd...");
    expect(() => boundSupervisorText("text", Number.NaN)).toThrow("finite non-negative integer");
  });

  it("keeps raw IDs out of bounded model-facing publications", () => {
    const core = makeCore({ maxReadItems: 1, maxTextChars: 12 });
    const result = publishProjects(core, "read-1", [
      projectTarget({
        environmentId: "private-environment",
        projectId: "private-project",
        label: "A very long project label",
      }),
      projectTarget({ environmentId: "environment-2", projectId: "project-2", label: "Second" }),
    ]);

    expect(result).toMatchObject({
      status: "published",
      result: { totalCount: 2, omittedCount: 1, truncated: true },
    });
    expect(JSON.stringify(result)).not.toContain("private-environment");
    expect(JSON.stringify(result)).not.toContain("private-project");
  });

  it("resolves only exact labels/aliases while partial matches require a handle", () => {
    const core = makeCore();
    const published = publishThreads(core, "read-exact", [
      threadTarget({
        environmentId: "environment-a",
        threadId: "thread-a",
        label: "Voice supervisor",
        aliases: ["VS"],
      }),
    ]);
    const handle = publishedHandle(published);

    expect(core.resolveTarget("Voice supervisor", "thread")).toMatchObject({
      status: "resolved",
      target: { handle },
    });
    expect(core.resolveTarget("vs", "thread")).toMatchObject({
      status: "resolved",
      target: { handle },
    });
    expect(core.resolveTarget("Voice", "thread")).toEqual({
      status: "candidates",
      candidates: [expect.objectContaining({ handle })],
    });
    expect(core.resolveTarget(handle, "thread")).toMatchObject({ status: "resolved" });
  });

  it("reuses identical binding/version handles across publications and deduplicates one list", () => {
    const core = makeCore();
    const target = threadTarget({
      environmentId: "environment-a",
      threadId: "thread-a",
      label: "Task",
      version: "sequence-1",
    });
    const first = publishThreads(core, "read-repeat-1", [target]);
    const second = publishThreads(core, "read-repeat-2", [target, target]);

    expect(publishedHandle(second)).toBe(publishedHandle(first));
    expect(second).toMatchObject({
      status: "published",
      result: { items: [expect.anything()], totalCount: 2, omittedCount: 1 },
    });
    expect(core.resolveTarget("Task", "thread")).toMatchObject({
      status: "resolved",
      target: { handle: publishedHandle(first) },
    });
  });

  it("keeps duplicate labels ambiguous but advances exact-name resolution on version changes", () => {
    const core = makeCore();
    const duplicates = publishThreads(core, "read-duplicates", [
      threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
      threadTarget({ environmentId: "environment-b", threadId: "thread-b", label: "Task" }),
    ]);
    expect(core.resolveTarget("Task", "thread")).toMatchObject({
      status: "ambiguous",
      candidates: [
        { handle: publishedHandle(duplicates) },
        { handle: publishedHandle(duplicates, 1) },
      ],
    });

    const changed = publishThreads(core, "read-version-2", [
      threadTarget({
        environmentId: "environment-a",
        threadId: "thread-a",
        label: "Task",
        version: "sequence-2",
      }),
    ]);
    expect(publishedHandle(changed)).not.toBe(publishedHandle(duplicates));
    expect(core.resolveTarget("Task", "thread")).toMatchObject({
      status: "resolved",
      target: { handle: publishedHandle(changed) },
    });
  });

  it("advances an explicit empty publication and rejects mixed-kind sets", () => {
    const core = makeCore();
    publishThreads(core, "read-nonempty", [
      threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Old task" }),
    ]);
    expect(core.resolveTarget("Old task", "thread").status).toBe("resolved");

    expect(publishThreads(core, "read-empty", [])).toMatchObject({ status: "published" });
    expect(core.resolveTarget("Old task", "thread")).toEqual({ status: "not-found" });
    expect(
      core.publishTargets({
        callId: "read-mixed",
        targetKind: "thread",
        targets: [
          threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
          projectTarget({ environmentId: "environment-a", projectId: "project-a", label: "T3" }),
        ],
      }),
    ).toEqual({ status: "invalid-target-set" });
    expect(
      core.publishTargets({
        callId: "read-mixed-beyond-limit",
        targetKind: "thread",
        requestedLimit: 1,
        targets: [
          threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
          projectTarget({ environmentId: "environment-a", projectId: "project-a", label: "T3" }),
        ],
      }),
    ).toEqual({ status: "invalid-target-set" });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid requested limit %s without advancing or consuming its call ID",
    (limit) => {
      const core = makeCore({ maxCalls: 2 });
      publishThreads(core, "limit-seed", [
        threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Old task" }),
      ]);

      expect(
        core.publishTargets({
          callId: "limit-call",
          targetKind: "thread",
          targets: [],
          requestedLimit: limit,
        }),
      ).toEqual({ status: "invalid-limit" });
      expect(core.resolveTarget("Old task", "thread").status).toBe("resolved");
      expect(
        core.publishTargets({
          callId: "limit-call",
          targetKind: "thread",
          targets: [],
          requestedLimit: 0,
        }),
      ).toMatchObject({ status: "published" });
      expect(core.resolveTarget("Old task", "thread")).toEqual({ status: "not-found" });
    },
  );

  it("bounds aliases before resolution", () => {
    const core = makeCore({ maxAliasesPerTarget: 1 });
    publishThreads(core, "read-alias-bound", [
      threadTarget({
        environmentId: "environment-a",
        threadId: "thread-a",
        label: "Task",
        aliases: ["kept", "dropped"],
      }),
    ]);
    expect(core.resolveTarget("kept", "thread").status).toBe("resolved");
    expect(core.resolveTarget("dropped", "thread")).toEqual({ status: "not-found" });
  });
});

describe("supervisor proposal and confirmation safety", () => {
  it("requires an exact opaque handle and keeps frozen full previews local", async () => {
    const core = makeCore();
    const published = publishThreads(core, "read-mutation", [
      threadTarget({
        environmentId: "environment-b",
        threadId: "thread-b",
        label: "Voice supervisor",
        version: "sequence-42",
      }),
    ]);
    const mutation = {
      kind: "follow-up",
      command: { commandId: "stable-command", messageId: "stable-message" },
    };
    const fullPreview = preview("Full unabridged instruction for the trusted UI");

    expect(
      core.proposeMutation({
        ...proposalInput("Voice supervisor", "mutation-label"),
        mutation,
        preview: fullPreview,
      }),
    ).toEqual({ status: "not-found" });
    const proposed = core.proposeMutation({
      ...proposalInput(publishedHandle(published), "mutation-exact"),
      mutation,
      preview: fullPreview,
    });
    const handle = proposalHandle(proposed);
    expect(JSON.stringify(proposed)).not.toContain("stable-command");
    expect(JSON.stringify(proposed)).not.toContain(fullPreview.instruction);
    expect(JSON.stringify(proposed)).not.toContain("environment-b");
    expect(JSON.stringify(proposed)).not.toContain("thread-b");

    const local = core.getConfirmationPayloadLocally(handle);
    expect(local.status).toBe("pending");
    if (local.status !== "pending") return;
    expect(decodePreview(local.payload.preview)).toEqual(fullPreview);
    expect(Object.isFrozen(local.payload.preview)).toBe(true);
    expect(Object.getPrototypeOf(local.payload.preview)).toBeNull();
    mutation.command.commandId = "changed-after-proposal";
    fullPreview.model = "changed-after-proposal";

    let executions = 0;
    await expect(
      core.confirmProposalLocally(handle, {
        executeConfirmed: async ({ target, mutation: snapshot }) => {
          executions += 1;
          expect(target).toEqual({
            kind: "thread",
            environmentId: "environment-b",
            projectId: "project-1",
            threadId: "thread-b",
            version: "sequence-42",
          });
          expect(decodeMutation(snapshot)).toEqual({
            kind: "follow-up",
            command: { commandId: "stable-command", messageId: "stable-message" },
          });
          return { status: "executed", value: { sequence: 1 } };
        },
      }),
    ).resolves.toMatchObject({ status: "executed", value: { sequence: 1 } });
    expect(executions).toBe(1);
  });

  it("rejects invalid mutation and preview snapshots before creating proposals", () => {
    const core = makeCore();
    const target = publishedHandle(
      publishThreads(core, "read-invalid-snapshot", [
        threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
      ]),
    );
    const invalidDateInput = {
      ...proposalInput(target, "mutation-date"),
      mutation: Reflect.construct(globalThis.Date, []),
    };
    const invalidDate = core.proposeMutation(invalidDateInput);
    expect(invalidDate).toEqual({
      status: "invalid-snapshot",
      field: "mutation",
      reason: "unsupported-object",
    });
    expect(core.proposeMutation(invalidDateInput)).toEqual({ status: "call-id-conflict" });
    expect(
      core.proposeMutation({
        ...proposalInput(target, "mutation-date"),
        mutation: new Map([["kind", "follow-up"]]),
      }),
    ).toEqual({ status: "call-id-conflict" });
    expect(core.proposeMutation(proposalInput(target, "mutation-date"))).toEqual({
      status: "call-id-conflict",
    });

    const firstUnsafe: Record<string, unknown> = {};
    Object.defineProperty(firstUnsafe, "__proto__", { enumerable: true, value: "first" });
    expect(
      core.proposeMutation({
        ...proposalInput(target, "mutation-unsafe"),
        mutation: firstUnsafe,
      }),
    ).toEqual({ status: "invalid-snapshot", field: "mutation", reason: "unsafe-key" });
    const secondUnsafe: Record<string, unknown> = {};
    Object.defineProperty(secondUnsafe, "__proto__", { enumerable: true, value: "second" });
    expect(
      core.proposeMutation({
        ...proposalInput(target, "mutation-unsafe"),
        mutation: secondUnsafe,
      }),
    ).toEqual({ status: "call-id-conflict" });
    const getter = vi.fn(() => "secret");
    const invalidPreview: Record<string, unknown> = {};
    Object.defineProperty(invalidPreview, "instruction", { enumerable: true, get: getter });
    expect(
      core.proposeMutation({
        ...proposalInput(target, "preview-getter"),
        preview: invalidPreview,
      }),
    ).toEqual({ status: "invalid-snapshot", field: "preview", reason: "accessor" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("allows only one pending proposal with explicit cancellation and replacement", async () => {
    const core = makeCore();
    const target = publishedHandle(
      publishThreads(core, "read-pending", [
        threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
      ]),
    );
    const first = core.proposeMutation(proposalInput(target, "mutation-first"));
    const firstHandle = proposalHandle(first);
    expect(core.proposeMutation(proposalInput(target, "mutation-blocked"))).toMatchObject({
      status: "pending-proposal",
      proposal: { handle: firstHandle },
    });
    expect(core.cancelProposalLocally(firstHandle)).toEqual({ status: "cancelled" });
    await expect(
      core.confirmProposalLocally(firstHandle, {
        executeConfirmed: async () => ({ status: "executed", value: { impossible: true } }),
      }),
    ).resolves.toEqual({ status: "cancelled" });

    const source = core.proposeMutation(proposalInput(target, "mutation-source"));
    const sourceHandle = proposalHandle(source);
    const replacement = core.proposeMutation({
      ...proposalInput(target, "mutation-replacement"),
      replacePendingProposal: sourceHandle,
    });
    const replacementHandle = proposalHandle(replacement);
    expect(replacement).toMatchObject({ replacedProposalHandle: sourceHandle });
    expect(core.getConfirmationPayloadLocally(sourceHandle)).toEqual({
      status: "replaced",
      replacementHandle,
    });
    expect(core.cancelProposalLocally(replacementHandle)).toEqual({ status: "cancelled" });
  });

  it("rejects stale and disconnected targets before proposing", () => {
    const core = makeCore();
    const published = publishProjects(core, "read-unavailable", [
      projectTarget({
        environmentId: "environment-a",
        projectId: "project-stale",
        label: "Stale",
        availability: "stale",
      }),
      projectTarget({
        environmentId: "environment-b",
        projectId: "project-offline",
        label: "Offline",
        availability: "disconnected",
      }),
    ]);
    const makeInput = (targetHandle: string, callId: string) => ({
      ...proposalInput(targetHandle, callId),
      expectedTargetKind: "project" as const,
    });
    expect(core.proposeMutation(makeInput(publishedHandle(published), "mutation-stale"))).toEqual({
      status: "target-unavailable",
      availability: "stale",
    });
    expect(
      core.proposeMutation(makeInput(publishedHandle(published, 1), "mutation-offline")),
    ).toEqual({ status: "target-unavailable", availability: "disconnected" });
  });

  it.each(["disconnected", "stale", "missing", "version-changed"] as const)(
    "honors execution-time %s rejection",
    async (reason) => {
      const core = makeCore();
      const target = publishedHandle(
        publishThreads(core, `read-${reason}`, [
          threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
        ]),
      );
      const proposed = core.proposeMutation(proposalInput(target, `mutation-${reason}`));
      await expect(
        core.confirmProposalLocally(proposalHandle(proposed), {
          executeConfirmed: async () => ({ status: "rejected", reason }),
        }),
      ).resolves.toEqual({ status: "target-rejected", reason });
    },
  );

  it("shares one execution across double-clicks and keeps executing preview available", async () => {
    const core = makeCore();
    const target = publishedHandle(
      publishThreads(core, "read-double-click", [
        threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
      ]),
    );
    const handle = proposalHandle(
      core.proposeMutation(proposalInput(target, "mutation-double-click")),
    );
    let release: (() => void) | undefined;
    let executions = 0;
    const adapter = {
      executeConfirmed: async () => {
        executions += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: "executed" as const, value: { done: true } };
      },
    };

    const first = core.confirmProposalLocally(handle, adapter);
    const second = core.confirmProposalLocally(handle, adapter);
    expect(second).toBe(first);
    expect(core.getConfirmationPayloadLocally(handle)).toMatchObject({
      status: "executing",
      payload: { preview: expect.anything() },
    });
    await Promise.resolve();
    expect(executions).toBe(1);
    release?.();
    await expect(first).resolves.toMatchObject({ status: "executed", value: { done: true } });
    await expect(core.confirmProposalLocally(handle, adapter)).resolves.toMatchObject({
      status: "executed",
    });
    expect(executions).toBe(1);
  });

  it("expires proposals and makes late call replays fail closed without reproposing", async () => {
    let now = 1_000;
    const core = makeCore({ now: () => now, targetTtlMs: 100, proposalTtlMs: 20 });
    const target = publishedHandle(
      publishThreads(core, "read-expiry", [
        threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
      ]),
    );
    const input = proposalInput(target, "mutation-expiry");
    const first = core.proposeMutation(input);
    const handle = proposalHandle(first);
    now = 1_021;
    await expect(
      core.confirmProposalLocally(handle, {
        executeConfirmed: async () => ({ status: "executed", value: { impossible: true } }),
      }),
    ).resolves.toEqual({ status: "expired" });

    now = 10_000;
    expect(core.proposeMutation(input)).toEqual({ status: "proposal-expired" });
  });

  it("deduplicates normalized JSON calls and rejects changed arguments", () => {
    const core = makeCore();
    const target = publishedHandle(
      publishThreads(core, "read-dedupe", [
        threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
      ]),
    );
    const first = core.proposeMutation({
      ...proposalInput(target, "mutation-dedupe"),
      mutation: { z: 1, a: 2 },
    });
    expect(
      core.proposeMutation({
        ...proposalInput(target, "mutation-dedupe"),
        mutation: { a: 2, z: 1 },
      }),
    ).toBe(first);
    expect(
      core.proposeMutation({
        ...proposalInput(target, "mutation-dedupe"),
        mutation: { a: 3, z: 1 },
      }),
    ).toEqual({ status: "call-id-conflict" });
  });

  it("rejects invalid adapter results instead of caching corrupted values", async () => {
    const core = makeCore();
    const target = publishedHandle(
      publishThreads(core, "read-result", [
        threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
      ]),
    );
    const handle = proposalHandle(core.proposeMutation(proposalInput(target, "mutation-result")));
    await expect(
      core.confirmProposalLocally(handle, {
        executeConfirmed: async () => ({ status: "executed", value: new Map() }),
      }),
    ).resolves.toEqual({
      status: "execution-result-invalid",
      reason: "unsupported-object",
    });
  });
});

describe("supervisor capacity limits", () => {
  it("validates every numeric option as a finite positive integer", () => {
    const optionNames: ReadonlyArray<
      Exclude<keyof CreateThreadSupervisorCoreOptions, "now" | "makeOpaqueId">
    > = [
      "targetTtlMs",
      "proposalTtlMs",
      "maxReadItems",
      "maxTextChars",
      "maxAmbiguousCandidates",
      "maxAliasesPerTarget",
      "maxCallIdChars",
      "maxOpaqueIdChars",
      "maxTargets",
      "maxProposals",
      "maxCalls",
      "maxSnapshotDepth",
      "maxSnapshotNodes",
      "maxSnapshotBytes",
      "maxSnapshotKeys",
      "maxSnapshotArrayItems",
    ];
    for (const optionName of optionNames) {
      expect(() => makeCore({ [optionName]: 0 }), optionName).toThrow("finite positive integer");
    }
    expect(() => makeCore({ maxCalls: Number.NaN })).toThrow("finite positive integer");
    expect(() => makeCore({ maxCalls: Number.POSITIVE_INFINITY })).toThrow(
      "finite positive integer",
    );
    expect(() => makeCore({ maxCalls: 1.5 })).toThrow("finite positive integer");
  });

  it("bounds call IDs and target handles before snapshot processing", () => {
    const core = makeCore({ maxCallIdChars: 8, maxOpaqueIdChars: 16 });
    expect(publishThreads(core, "too-long-call-id", [])).toEqual({ status: "invalid-call-id" });
    expect(
      publishThreads(core, "bad-bind", [
        threadTarget({
          environmentId: "environment-id-that-is-too-long",
          threadId: "thread-a",
          label: "Task",
        }),
      ]),
    ).toEqual({ status: "invalid-target-set" });

    const getter = vi.fn(() => "interrupt");
    const mutation: Record<string, unknown> = {};
    Object.defineProperty(mutation, "kind", { enumerable: true, get: getter });
    const invalidHandleInput = {
      ...proposalInput(" invalid-handle ", "valid-id"),
      mutation,
    };
    const invalidHandle = core.proposeMutation(invalidHandleInput);
    expect(invalidHandle).toEqual({ status: "invalid-opaque-id" });
    expect(core.proposeMutation(invalidHandleInput)).toEqual({ status: "call-id-conflict" });
    expect(getter).not.toHaveBeenCalled();

    const published = publishThreads(core, "publish", [
      threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
    ]);
    expect(core.proposeMutation(proposalInput(publishedHandle(published), "valid-id"))).toEqual({
      status: "call-id-conflict",
    });
    expect(
      core.proposeMutation({
        ...proposalInput(publishedHandle(published), "proposal"),
        replacePendingProposal: " invalid-replacement " as SupervisorProposalHandle,
        mutation,
      }),
    ).toEqual({ status: "invalid-opaque-id" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("fails new call IDs closed at ledger capacity while preserving known replays", () => {
    const core = makeCore({ maxCalls: 2 });
    const published = publishThreads(core, "call-1", [
      threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
    ]);
    const input = proposalInput(publishedHandle(published), "call-2");
    const proposal = core.proposeMutation(input);
    expect(proposal.status).toBe("proposed");
    expect(publishThreads(core, "call-3", [])).toEqual({
      status: "capacity-exceeded",
      resource: "calls",
    });
    expect(core.proposeMutation(input)).toBe(proposal);
  });

  it("reuses identical targets at capacity and rejects new versions without eviction", () => {
    const core = makeCore({ maxTargets: 1 });
    const firstTarget = threadTarget({
      environmentId: "environment-a",
      threadId: "thread-a",
      label: "Task",
      version: "1",
    });
    const first = publishThreads(core, "target-1", [firstTarget]);
    const repeated = publishThreads(core, "target-2", [firstTarget]);
    expect(publishedHandle(repeated)).toBe(publishedHandle(first));
    expect(
      publishThreads(core, "target-3", [
        threadTarget({
          environmentId: "environment-a",
          threadId: "thread-a",
          label: "Task",
          version: "2",
        }),
      ]),
    ).toEqual({ status: "capacity-exceeded", resource: "targets" });
    expect(core.resolveTarget(publishedHandle(first), "thread").status).toBe("resolved");
  });

  it("never evicts an old proposal to create a new executable proposal", () => {
    const core = makeCore({ maxProposals: 1 });
    const target = publishedHandle(
      publishThreads(core, "proposal-read", [
        threadTarget({ environmentId: "environment-a", threadId: "thread-a", label: "Task" }),
      ]),
    );
    const firstInput = proposalInput(target, "proposal-1");
    const first = core.proposeMutation(firstInput);
    const firstHandle = proposalHandle(first);
    expect(core.cancelProposalLocally(firstHandle)).toEqual({ status: "cancelled" });
    expect(core.proposeMutation(proposalInput(target, "proposal-2"))).toEqual({
      status: "capacity-exceeded",
      resource: "proposals",
    });
    expect(core.proposeMutation(firstInput)).toBe(first);
    expect(core.getConfirmationPayloadLocally(firstHandle)).toEqual({ status: "cancelled" });
  });
});
