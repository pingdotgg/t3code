import {
  CheckpointId,
  Effect,
  NodeId,
  PI_PROVIDER,
  ProviderTurnId,
  THREAD_ID,
  TURN_ONE_ENTRIES,
  UNCAPTURED_TURN_TREE,
  assert,
  describe,
  it,
  layerTest,
  loadMcpBridge,
  makeFakePi,
  modelSelection,
  openRuntime,
  runtimePolicy,
  startTurn,
  toolOutputImages,
  turnItemOutputText,
  uncapturedTurns,
  type OrchestrationV2ProviderTurn,
} from "./adapter-fixtures.testkit.ts";

describe("PiAdapterV2", () => {
  it.effect(
    "delivers realistic MCP screenshots through the bridge, JSONL transport, and adapter",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        for (const size of [3.25 * 1024 * 1024, 10 * 1024 * 1024]) {
          const pixels = Buffer.alloc(size, 0x61);
          const data = pixels.toString("base64");
          const content = [
            { type: "text", text: "Screenshot captured" },
            { type: "image", data, mimeType: "image/png" },
          ];
          const metadata = { screenshot: { width: 1200, height: 800 }, ready: true };
          const bridge = yield* Effect.promise(() =>
            loadMcpBridge({ modern: true, result: { content, structuredContent: metadata } }),
          );
          const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot")!;
          const result = yield* Effect.promise(() => tool.execute("screenshot", {}));
          assert.deepEqual(result.structuredContent, { content, structuredContent: metadata });
          yield* fake.emit(
            {
              type: "tool_execution_end",
              toolCallId: "screenshot",
              toolName: tool.name,
              result,
              isError: false,
            },
            64 * 1024,
          );
          yield* fake.emit({
            type: "tool_execution_end",
            toolCallId: "after-screenshot",
            toolName: "marker",
            result: { content: [{ type: "text", text: "after" }] },
          });
          const event = yield* takeEvent(
            (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
          );
          if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
            return yield* Effect.die("Expected a screenshot tool item");
          assert.equal(event.turnItem.toolName, tool.name);
          assert.equal(event.turnItem.status, "completed");
          assert.deepEqual(event.turnItem.output, { content, structuredContent: metadata });
          assert.equal(turnItemOutputText(event.turnItem), "Screenshot captured");
          const image = toolOutputImages(event.turnItem.output)[0];
          assert.equal(image?.mimeType, "image/png");
          assert.deepEqual(Buffer.from(image!.data!, "base64"), pixels);
          yield* takeEvent(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.toolName === "marker",
          );
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("observes official subagent results without inventing child threads", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({
        type: "tool_execution_update",
        toolCallId: "call_sub",
        toolName: "subagent",
        partialResult: {
          content: [{ type: "text", text: "(running...)" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stderr: "",
                sessionFile: "/ignored/custom-extension-session.jsonl",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "scanning files" }] },
                ],
              },
            ],
          },
        },
      });
      const running = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "running",
      );
      assert.isTrue(
        running.type === "subagent.updated" &&
          running.subagent.title === "scout" &&
          running.subagent.prompt === "map the repo" &&
          running.subagent.progress === "scanning files" &&
          running.subagent.childThreadId === null,
      );

      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_sub",
        toolName: "subagent",
        isError: false,
        result: {
          content: [{ type: "text", text: "done" }],
          details: {
            mode: "single",
            results: [
              {
                agent: "scout",
                task: "map the repo",
                exitCode: 0,
                stopReason: "stop",
                stderr: "",
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "repo has one file" }] },
                ],
              },
            ],
          },
        },
      });
      const doneCard = yield* takeEvent(
        (event) => event.type === "subagent.updated" && event.subagent.status === "completed",
      );
      assert.isTrue(
        doneCard.type === "subagent.updated" &&
          doneCard.subagent.result === "repo has one file" &&
          doneCard.subagent.childThreadId === null,
      );
      const subagentItem = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "subagent" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        subagentItem.type === "turn_item.updated" &&
          subagentItem.turnItem.type === "subagent" &&
          subagentItem.turnItem.childThreadId === null,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("persists edit patches and write content on file change items", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      const patch = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-old\n+new\n";
      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_edit",
        toolName: "edit",
        args: { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_edit",
        toolName: "edit",
        isError: false,
        result: {
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.ts." }],
          details: { diff: "-1 old\n+1 new", patch, firstChangedLine: 1 },
        },
      });
      const edit = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "file_change" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        edit.type === "turn_item.updated" &&
          edit.turnItem.type === "file_change" &&
          edit.turnItem.fileName === "a.ts" &&
          edit.turnItem.diffStr === patch,
      );

      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_write",
        toolName: "write",
        args: { path: "b.ts", content: "export {};\n" },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_write",
        toolName: "write",
        isError: false,
        result: { content: [{ type: "text", text: "Successfully wrote to b.ts" }] },
      });
      const write = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "file_change" &&
          event.turnItem.status === "completed",
      );
      assert.isTrue(
        write.type === "turn_item.updated" &&
          write.turnItem.type === "file_change" &&
          write.turnItem.fileName === "b.ts" &&
          write.turnItem.newStr === "export {};\n",
      );

      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_edit_failed",
        toolName: "edit",
        args: { path: "c.ts", edits: [{ oldText: "missing", newText: "new" }] },
      });
      yield* fake.emit({
        type: "tool_execution_end",
        toolCallId: "call_edit_failed",
        toolName: "edit",
        isError: true,
        result: { content: [{ type: "text", text: "Could not find the text in c.ts." }] },
      });
      const failedEdit = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "file_change" &&
          event.turnItem.status === "failed",
      );
      assert.isTrue(
        failedEdit.type === "turn_item.updated" &&
          failedEdit.turnItem.type === "file_change" &&
          failedEdit.turnItem.diffStr === "Could not find the text in c.ts.",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([false, true])("follows an extension rewind with summarize=%s", (summarize) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const root = { type: "model_change", id: "root", parentId: null };
      const user = (id: string, parentId: string) => ({
        type: "message",
        id,
        parentId,
        message: { role: "user", content: [{ type: "text", text: id }] },
      });
      const reply = (id: string, parentId: string) => ({
        type: "message",
        id,
        parentId,
        message: { role: "assistant", content: [] },
      });
      fake.queueEntries({ entries: [root], leafId: "root" });
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const settle = Effect.fnUntraced(function* (
        text: string,
        runOrdinal: number,
        ...listings: ReadonlyArray<unknown>
      ) {
        yield* startTurn(runtime, providerThread, "default", [], text, undefined, runOrdinal);
        yield* fake.takeRequest("prompt");
        for (const listing of listings) fake.queueEntries(listing);
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        if (!text.startsWith("/")) {
          yield* fake.emit({ type: "agent_start" });
          yield* fake.emit({ type: "agent_settled" });
        }
        const turn = yield* takeEvent(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        const thread = yield* takeEvent(
          (event) =>
            event.type === "provider_thread.updated" && event.providerThread.status === "idle",
        );
        yield* takeEvent((event) => event.type === "turn.terminal");
        return {
          turnRef:
            turn.type === "provider_turn.updated" ? turn.providerTurn.nativeTurnRef : undefined,
          head:
            thread.type === "provider_thread.updated"
              ? thread.providerThread.nativeConversationHeadRef?.nativeId
              : undefined,
          retained:
            thread.type === "provider_thread.updated" ? thread.retainedNativeTurnIds : undefined,
        };
      });

      yield* settle("prompt A", 1, {
        entries: [user("uA", "root"), reply("aA", "uA")],
        leafId: "aA",
      });
      const promptB = yield* settle("prompt B", 2, {
        entries: [user("uB", "aA"), reply("aB", "uB")],
        leafId: "aB",
      });
      assert.equal(promptB.turnRef?.nativeId, "uB");
      assert.isUndefined(promptB.retained);

      const rewoundLeaf = summarize ? "summary" : "aA";
      const summary = summarize ? [{ type: "branch_summary", id: "summary", parentId: "aA" }] : [];
      const rewind = yield* settle(
        "/rewind",
        3,
        { entries: summary, leafId: rewoundLeaf },
        {
          entries: [
            root,
            user("uA", "root"),
            reply("aA", "uA"),
            user("uB", "aA"),
            reply("aB", "uB"),
            ...summary,
          ],
          leafId: rewoundLeaf,
        },
      );
      assert.deepEqual(rewind.retained, ["uA"]);
      assert.equal(rewind.head, rewoundLeaf);
      if (summarize) {
        assert.equal(rewind.turnRef?.strength, "weak");
      } else {
        assert.isNull(rewind.turnRef);
      }

      const promptC = yield* settle("prompt C", 4, {
        entries: [
          ...(summarize ? [] : [user("uB", "aA"), reply("aB", "uB")]),
          user("uC", rewoundLeaf),
          reply("aC", "uC"),
        ],
        leafId: "aC",
      });
      assert.deepEqual(promptC.turnRef, {
        driver: PI_PROVIDER,
        nativeId: "uC",
        strength: "strong",
      });
      assert.isUndefined(promptC.retained);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["turn window", "full tree"] as const)(
    "finishes a turn whose %s has a parentId cycle",
    (cycleIn) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const root = { type: "model_change", id: "root", parentId: null };
        const cycle = [
          { type: "message", id: "x", parentId: "y", message: { role: "user", content: [] } },
          { type: "message", id: "y", parentId: "x", message: { role: "assistant", content: [] } },
        ];
        fake.queueEntries({ entries: [root], leafId: "root" });
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread, "default", [], "prompt", undefined, 1);
        yield* fake.takeRequest("prompt");
        if (cycleIn === "turn window") {
          fake.queueEntries({ entries: cycle, leafId: "x" });
        } else {
          fake.queueEntries({ entries: [], leafId: "x" });
          fake.queueEntries({ entries: [root, ...cycle], leafId: "x" });
        }
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        const thread = yield* takeEvent(
          (event) =>
            event.type === "provider_thread.updated" && event.providerThread.status === "idle",
        );
        assert.isUndefined(
          thread.type === "provider_thread.updated" ? thread.retainedNativeTurnIds : null,
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(["missing parent", "invalid parent", "duplicate id"] as const)(
    "does not reconcile malformed session entries: %s",
    (malformed) =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent } = yield* openRuntime(fake);
        const root = { type: "model_change", id: "root", parentId: null };
        fake.queueEntries({ entries: [root], leafId: "root" });
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        const entry = {
          type: "message",
          id: "x",
          message: { role: "user", content: [] },
          ...(malformed === "missing parent"
            ? {}
            : { parentId: malformed === "invalid parent" ? 42 : null }),
        };
        fake.queueEntries({ entries: [], leafId: "x" });
        fake.queueEntries({
          entries: [
            root,
            entry,
            ...(malformed === "duplicate id" ? [{ ...entry, parentId: "root" }] : []),
          ],
          leafId: "x",
        });
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        yield* takeEvent(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        const thread = yield* takeEvent(
          (event) =>
            event.type === "provider_thread.updated" && event.providerThread.status === "idle",
        );
        assert.isUndefined(
          thread.type === "provider_thread.updated" ? thread.retainedNativeTurnIds : null,
        );
        yield* takeEvent((event) => event.type === "turn.terminal");
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("does not reconcile a replacement session tree as a native rewind", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueEntries({
        entries: [{ type: "model_change", id: "old-leaf", parentId: null }],
        leafId: "old-leaf",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const finish = Effect.fnUntraced(function* () {
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "response", command: "prompt", success: true });
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "agent_settled" });
        const update = yield* takeEvent(
          (event) =>
            event.type === "provider_thread.updated" && event.providerThread.status === "idle",
        );
        yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isUndefined(
          update.type === "provider_thread.updated" ? update.retainedNativeTurnIds : null,
        );
      });
      fake.queueEntries({ entries: [] });
      yield* finish();
      fake.queueEntries({
        entries: [
          {
            type: "message",
            id: "new-user",
            parentId: null,
            message: { role: "user", content: [] },
          },
        ],
        leafId: "new-user",
      });
      yield* finish();
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rolls back past turns that left nothing in the session tree", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = (ordinal: number, entryId: string | null): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`turn-${ordinal}`),
        providerThreadId: providerThread.id,
        nodeId: NodeId.make(`node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef:
          entryId === null ? null : { driver: PI_PROVIDER, nativeId: entryId, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      const rollBackToFirst = (turns: ReadonlyArray<OrchestrationV2ProviderTurn>) =>
        runtime.rollbackThread({
          providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-1"),
            appRunOrdinal: 1,
            providerTurn: turns[0]!,
          },
          providerThreadTurns: turns,
        });
      const forkedEntries = () =>
        fake
          .allRequests()
          .filter((request) => request.type === "fork")
          .map((request) => request.entryId);

      yield* rollBackToFirst([turn(1, "u1"), turn(2, null)]);
      assert.deepEqual(forkedEntries(), []);
      yield* rollBackToFirst([turn(1, "u1"), turn(2, null), turn(3, "u3")]);
      assert.deepEqual(forkedEntries(), ["u3"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rolls back past a turn whose start entry was never captured", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const rollBackToFirst = (turns: ReadonlyArray<OrchestrationV2ProviderTurn>) =>
        runtime.rollbackThread({
          providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-1"),
            appRunOrdinal: 1,
            providerTurn: turns[0]!,
          },
          providerThreadTurns: turns,
        });
      const forkedEntries = () =>
        fake
          .allRequests()
          .filter((request) => request.type === "fork")
          .map((request) => request.entryId);

      fake.queueEntries(UNCAPTURED_TURN_TREE);
      const unresolved = yield* rollBackToFirst(
        uncapturedTurns(providerThread.id, { startedAt: 60, completedAt: 100 }),
      ).pipe(Effect.result);
      assert.deepEqual(forkedEntries(), []);
      assert.equal(unresolved._tag, "Failure");

      fake.queueEntries({ entries: TURN_ONE_ENTRIES, leafId: "a1b" });
      const missing = yield* rollBackToFirst(uncapturedTurns(providerThread.id)).pipe(
        Effect.result,
      );
      assert.deepEqual(forkedEntries(), []);
      assert.equal(missing._tag, "Failure");

      // An adopted wake precedes its T3 turn, but follows turn 1 and its steer.
      fake.queueEntries(UNCAPTURED_TURN_TREE);
      yield* rollBackToFirst(uncapturedTurns(providerThread.id));
      assert.deepEqual(forkedEntries(), ["u2"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
