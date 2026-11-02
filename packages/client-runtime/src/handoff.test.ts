import {
  ContextHandoffId,
  MessageId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveHandoffEndpoints,
  resolveModelSwitches,
  resolvePendingHandoff,
  type HandoffTimelineRun,
  type ModelSwitchRun,
} from "./handoff.ts";

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const item = {
  runId: RunId.make("target"),
  fromProviderInstanceIds: [from],
  toProviderInstanceId: to,
};
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

describe("handoff endpoints shared by web and mobile", () => {
  it("preserves stamped models including several models from the same provider", () => {
    const fromModelSelections = [
      { instanceId: from, model: "source-a" },
      { instanceId: from, model: "source-b" },
    ];
    expect(
      resolveHandoffEndpoints({ ...item, fromModelSelections, toModel: "destination" }, [
        run("target", 2, to, "later-model"),
      ]),
    ).toEqual({
      from: fromModelSelections,
      to: { instanceId: to, model: "destination" },
    });
  });

  it("recovers legacy models from the handoff run and latest earlier source run", () => {
    const runs = [
      run("later", 4, from, "wrong-later-model"),
      run("old", 1, from, "old-model"),
      run("target", 3, to, "destination"),
      run("source", 2, from, "source-model"),
    ];
    expect(resolveHandoffEndpoints(item, runs)).toEqual({
      from: [{ instanceId: from, model: "source-model" }],
      to: { instanceId: to, model: "destination" },
    });
  });

  it("retains provider identities when historical runs are not loaded", () => {
    expect(resolveHandoffEndpoints(item, [])).toEqual({
      from: [{ instanceId: from, model: undefined }],
      to: { instanceId: to, model: undefined },
    });
  });

  it("does not borrow a target model from another provider", () => {
    expect(
      resolveHandoffEndpoints(item, [run("target", 2, from, "wrong-model")]).to.model,
    ).toBeUndefined();
  });
});

const projection = {
  runs: [
    {
      ...run("source", 1, from, "source"),
      status: "completed",
      contextHandoffId: null,
      startedAt: "2026-10-11T00:00:00Z",
    },
  ],
  visibleTurnItems: [{ item: { type: "user_message" } }],
} as unknown as OrchestrationV2ThreadProjection;

describe("pending context handoff", () => {
  it("removes the preview while the handoff starts", () => {
    const selection = { instanceId: to, model: "destination" };
    const providers = [{ instanceId: from }] as unknown as ServerProvider[];
    const starting = {
      ...projection,
      runs: [
        ...projection.runs,
        {
          ...projection.runs[0]!,
          ...run("target", 2, to, "destination"),
          status: "starting" as const,
          startedAt: null,
          contextHandoffId: ContextHandoffId.make("handoff"),
        },
      ],
    };

    expect(resolvePendingHandoff(projection, selection, providers)).not.toBeNull();
    expect(resolvePendingHandoff(starting, selection, providers)).toBeNull();
    expect(
      resolvePendingHandoff(starting, { instanceId: from, model: "source" }, providers),
    ).toEqual({
      from: [selection],
      to: { instanceId: from, model: "source" },
    });
  });

  it.each(["preparing", "queued", "failed", "cancelled", "rolled_back"] as const)(
    "keeps the preview when an unstarted handoff run is %s",
    (status) => {
      const selection = { instanceId: to, model: "destination" };
      const unstarted = {
        ...projection,
        runs: [
          ...projection.runs,
          {
            ...projection.runs[0]!,
            ...run("target", 2, to, "destination"),
            status,
            startedAt: null,
            contextHandoffId: ContextHandoffId.make("handoff"),
          },
        ],
      };

      expect(resolvePendingHandoff(unstarted, selection, [])).toEqual({
        from: [{ instanceId: from, model: "source" }],
        to: selection,
      });
    },
  );

  it("appears on selection, updates the destination, and disappears on returning", () => {
    expect(resolvePendingHandoff(projection, { instanceId: to, model: "first" }, [])).toEqual({
      from: [{ instanceId: from, model: "source" }],
      to: { instanceId: to, model: "first" },
    });
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "second" }, [])?.to.model,
    ).toBe("second");
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "source" }, [])).toBeNull();
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "other" }, [])).toBeNull();
  });
  it("stays hidden while the thread's timeline is empty", () => {
    const empty = { ...projection, visibleTurnItems: [] };
    expect(resolvePendingHandoff(empty, { instanceId: to, model: "first" }, [])).toBeNull();
    // Paging can leave a window of only tool rows after the prompt.
    const toolRowsOnly = {
      ...projection,
      visibleTurnItems: [{ item: { type: "command_execution" } }],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(
      resolvePendingHandoff(toolRowsOnly, { instanceId: to, model: "first" }, [])?.to.model,
    ).toBe("first");
  });
  it("resumes compatible account overlays without showing a handoff", () => {
    const providers = [from, to].map((instanceId) => ({
      instanceId,
      driver: "codex",
      continuation: { groupKey: "shared" },
    })) as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "target" }, providers),
    ).toBeNull();
  });
});

describe("model switches", () => {
  const switchRun = (
    id: string,
    ordinal: number,
    model: string,
    effort?: string,
    overrides: Partial<ModelSwitchRun> = {},
  ): ModelSwitchRun => ({
    ordinal,
    status: "completed",
    startedAt: DateTime.makeUnsafe("2026-10-11T00:00:00Z"),
    modelSelection: {
      instanceId: from,
      model,
      ...(effort === undefined ? {} : { options: [{ id: "reasoningEffort", value: effort }] }),
    },
    userMessageId: MessageId.make(`message-${id}`),
    contextHandoffId: null,
    ...overrides,
  });
  const keys = (switches: ReadonlyMap<MessageId, unknown>) =>
    [...switches.keys()].map((id) => id.replace("message-", ""));

  it("marks model and stated effort changes in run order", () => {
    const switches = resolveModelSwitches([
      switchRun("d", 4, "gpt", "low"),
      switchRun("a", 1, "gpt", "high"),
      switchRun("b", 2, "gpt", "high"),
      switchRun("c", 3, "gpt"),
      switchRun("e", 5, "mini", "low"),
    ]);
    expect(keys(switches)).toEqual(["e"]);
    expect(switches.get(MessageId.make("message-e"))).toMatchObject({
      label: "Model changed",
      from: { model: "gpt" },
      to: { model: "mini" },
      effortChanged: false,
    });
    expect(
      resolveModelSwitches([switchRun("a", 1, "gpt", "high"), switchRun("b", 2, "gpt", "low")]).get(
        MessageId.make("message-b"),
      ),
    ).toMatchObject({ label: "Effort changed", effortChanged: true });
  });

  it("reads an unset effort as the model's default", () => {
    const providers = [
      {
        instanceId: from,
        models: [
          {
            slug: "gpt",
            capabilities: {
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  type: "select",
                  options: [{ id: "medium", isDefault: true }, { id: "high" }],
                },
              ],
            },
          },
        ],
      },
    ] as unknown as ServerProvider[];
    const switches = resolveModelSwitches(
      [
        switchRun("a", 1, "gpt"),
        switchRun("b", 2, "gpt", "medium"),
        switchRun("c", 3, "gpt", "high"),
        switchRun("d", 4, "gpt"),
      ],
      providers,
    );
    expect(keys(switches)).toEqual(["c", "d"]);
    expect(switches.get(MessageId.make("message-d"))?.to.options).toEqual([
      { id: "reasoningEffort", value: "medium" },
    ]);
  });

  it("skips runs that never ran, handoff runs, and account-only switches", () => {
    const switches = resolveModelSwitches([
      switchRun("a", 1, "gpt"),
      switchRun("b", 2, "mini", undefined, { status: "rolled_back" }),
      switchRun("c", 3, "mini", undefined, { status: "cancelled", startedAt: null }),
      switchRun("d", 4, "mini", undefined, { status: "queued", startedAt: null }),
      switchRun("e", 5, "mini", undefined, { status: "failed", startedAt: null }),
      switchRun("f", 6, "gpt"),
      switchRun("g", 7, "other", undefined, {
        contextHandoffId: ContextHandoffId.make("handoff"),
      }),
      switchRun("h", 8, "other", undefined, {
        modelSelection: { instanceId: to, model: "other" },
      }),
    ]);
    expect(switches.size).toBe(0);
  });
});
