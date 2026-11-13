import {
  Cause,
  DateTime,
  Effect,
  Exit,
  FAKE_SESSION_FILE,
  NodeId,
  PI_INSTANCE_ID,
  PI_PROVIDER,
  ProviderThreadId,
  ProviderTurnId,
  SESSION_ID,
  THREAD_ID,
  ThreadId,
  UNCAPTURED_TURN_TREE,
  assert,
  compactDynamicToolOutput,
  describe,
  it,
  layerTest,
  makeFakePi,
  modelSelection,
  openRuntime,
  runtimePolicy,
  startTurn,
  toolOutputImages,
  turnItemOutputText,
  uncapturedTurns,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "./adapter-fixtures.testkit.ts";

describe("PiAdapterV2", () => {
  it.effect("adopts the run's provider thread identity instead of minting a second row", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const now = yield* DateTime.now;
      const placeholder: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("thread:provider:pi:native-thread:pending:run:thread-pi-test:1"),
        driver: PI_PROVIDER,
        providerInstanceId: PI_INSTANCE_ID,
        providerSessionId: SESSION_ID,
        appThreadId: THREAD_ID,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
        existingProviderThread: placeholder,
      });
      assert.equal(providerThread.id, placeholder.id);
      assert.equal(providerThread.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      assert.isFalse(fake.allRequests().some((request) => request.type === "new_session"));
      const updated = yield* takeEvent((event) => event.type === "provider_thread.updated");
      assert.isTrue(
        updated.type === "provider_thread.updated" && updated.providerThread.id === placeholder.id,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("resets applied thinking when returning to Pi default", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      fake.queueState({
        model: { provider: "xai", id: "grok-4.6" },
        thinkingLevel: "medium",
        sessionFile: FAKE_SESSION_FILE,
        sessionId: "abc",
      });
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* startTurn(runtime, providerThread, "default", [], "Hello pi", {
        instanceId: PI_INSTANCE_ID,
        model: "xai/grok-4.6",
        options: [{ id: "thinking", value: "high" }],
      });
      const modelRequest = yield* fake.takeRequest("set_model");
      assert.equal(modelRequest["provider"], "xai");
      assert.equal(modelRequest["modelId"], "grok-4.6");
      const levelRequest = yield* fake.takeRequest("set_thinking_level");
      assert.equal(levelRequest["level"], "high");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_end", messages: [], willRetry: false });
      yield* fake.emit({ type: "agent_settled" });
      yield* takeEvent((event) => event.type === "turn.terminal");

      yield* startTurn(
        runtime,
        providerThread,
        "default",
        [],
        "Hello pi",
        {
          instanceId: PI_INSTANCE_ID,
          model: "default",
        },
        2,
      );
      const replayModel = yield* fake.takeRequest("set_model");
      assert.equal(replayModel["provider"], "xai");
      assert.equal(replayModel["modelId"], "grok-4.6");
      const resetLevel = yield* fake.takeRequest("set_thinking_level");
      assert.equal(resetLevel["level"], "medium");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { historical: false, label: "the latest turn" },
    { historical: true, label: "a historical turn" },
  ])("natively forks $label into an independent session", ({ historical }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const forkFile = "/fake/forked.jsonl";
      const { runtime, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        forkFake,
      );
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const turn = (ordinal: number): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(`turn-${ordinal}`),
        providerThreadId: source.id,
        nodeId: NodeId.make(`node-${ordinal}`),
        runAttemptId: null,
        nativeTurnRef: { driver: PI_PROVIDER, nativeId: `u${ordinal}`, strength: "strong" },
        ordinal,
        status: "completed",
        startedAt: null,
        completedAt: null,
      });
      forkFake.queueState({ sessionFile: forkFile });
      fake.queueState({ sessionFile: forkFile });
      const target = ThreadId.make("fork-target");
      const forked = yield* runtime.forkThread({
        sourceProviderThread: source,
        sourceProviderTurns: historical ? [turn(1), turn(2)] : [turn(1)],
        providerTurnId: turn(1).id,
        targetThreadId: target,
      });
      assert.equal(forked.appThreadId, target);
      assert.equal(forked.nativeThreadRef?.nativeId, forkFile);
      assert.notEqual(forked.id, source.id);
      assert.equal(source.nativeThreadRef?.nativeId, FAKE_SESSION_FILE);
      const args = forkFake.lastSpawn().args;
      assert.equal(args[args.indexOf("--fork") + 1], FAKE_SESSION_FILE);
      assert.include(args, "--no-extensions");
      assert.include(args, "--no-tools");
      assert.include(args, "--offline");
      assert.notInclude(args, "--no-session");
      assert.deepEqual(
        forkFake
          .allRequests()
          .filter((request) => request.type === "fork")
          .map((request) => request.entryId),
        historical ? ["u2"] : [],
      );
      assert.isFalse(
        fake.allRequests().some((request) => request.type === "fork" || request.type === "clone"),
      );
      const adopted = { ...forked, id: ProviderThreadId.make("pending-fork-row") };
      yield* startTurn(runtime, adopted, "default", [], "Continue", undefined, 1, target);
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const updated = yield* takeEvent(
        (event) =>
          event.type === "provider_thread.updated" && event.providerThread.appThreadId === target,
      );
      assert.isTrue(
        updated.type === "provider_thread.updated" && updated.providerThread.id === adopted.id,
      );
      yield* takeEvent((event) => event.type === "turn.terminal");
      yield* runtime.resumeThread({ providerThread: adopted });
      assert.equal(
        fake.allRequests().findLast((request) => request.type === "switch_session")?.sessionPath,
        forkFile,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("natively forks before a turn whose start entry was never captured", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const forkFile = "/fake/forked.jsonl";
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const forkAtFirst = (turns: ReadonlyArray<OrchestrationV2ProviderTurn>) =>
        runtime.forkThread({
          sourceProviderThread: source,
          sourceProviderTurns: turns,
          providerTurnId: turns[0]!.id,
          targetThreadId: ThreadId.make("fork-target"),
        });
      const forkedEntries = () =>
        forkFake
          .allRequests()
          .filter((request) => request.type === "fork")
          .map((request) => request.entryId);

      // A later prompt cannot stand in for a cancelled turn that ended before it landed.
      forkFake.queueEntries(UNCAPTURED_TURN_TREE);
      const unresolved = yield* forkAtFirst(
        uncapturedTurns(source.id, { startedAt: 60, completedAt: 100 }),
      ).pipe(Effect.result);
      assert.deepEqual(forkedEntries(), []);
      assert.equal(unresolved._tag, "Failure");

      forkFake.queueEntries(UNCAPTURED_TURN_TREE);
      forkFake.queueState({ sessionFile: forkFile });
      fake.queueState({ sessionFile: forkFile });
      const forked = yield* forkAtFirst(
        uncapturedTurns(source.id, { startedAt: 100, completedAt: 200 }),
      );
      assert.equal(forked.nativeThreadRef?.nativeId, forkFile);
      assert.deepEqual(forkedEntries(), ["u2"]);
      assert.isFalse(fake.allRequests().some((request) => request.type === "fork"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("natively forks before a running turn whose start entry was not captured yet", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const forkFake = yield* makeFakePi;
      const forkFile = "/fake/forked.jsonl";
      const { runtime } = yield* openRuntime(fake, "default", THREAD_ID, SESSION_ID, forkFake);
      const source = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // Turn 2 is still in flight, so it has no end to bound the session-tree search.
      const turns = uncapturedTurns(source.id, { startedAt: 100, completedAt: 200 }).map((turn) =>
        turn.ordinal === 2 ? { ...turn, status: "running" as const, completedAt: null } : turn,
      );
      forkFake.queueEntries(UNCAPTURED_TURN_TREE);
      forkFake.queueState({ sessionFile: forkFile });
      fake.queueState({ sessionFile: forkFile });

      const result = yield* runtime
        .forkThread({
          sourceProviderThread: source,
          sourceProviderTurns: turns,
          providerTurnId: turns[0]!.id,
          targetThreadId: ThreadId.make("fork-target"),
        })
        .pipe(Effect.exit);
      assert.isTrue(
        Exit.isSuccess(result),
        `forking turn 1 while turn 2 runs must locate turn 2's prompt in the session tree, got: ${
          Exit.isFailure(result) ? Cause.pretty(result.cause) : ""
        }`,
      );
      if (!Exit.isSuccess(result)) return;
      assert.equal(result.value.nativeThreadRef?.nativeId, forkFile);

      const forkedEntries = forkFake
        .allRequests()
        .filter((request) => request.type === "fork")
        .map((request) => request.entryId);
      // Pi keeps only the fork entry's ancestors, so u2 (not steer2) drops all of turn 2.
      assert.deepEqual(forkedEntries, ["u2"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("presents explicitly namespaced MCP extension tools", () =>
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
      for (const type of ["tool_execution_start", "tool_execution_end"]) {
        yield* fake.emit({
          type,
          toolCallId: "weather-call",
          toolName: "mcp__weather__get_weather",
          args: { city: "Berlin" },
          result: { content: [{ type: "text", text: "Sunny" }] },
          isError: false,
        });
        const event = yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
        );
        if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
          return yield* Effect.die("Expected an MCP tool item");
        assert.equal(event.turnItem.title, "get weather");
        assert.equal(
          event.turnItem.status,
          type === "tool_execution_start" ? "running" : "completed",
        );
        assert.deepEqual(event.turnItem.toolSource, {
          key: "mcp:weather",
          name: "weather",
          kind: "integration",
        });
        assert.deepEqual(event.turnItem.input, { city: "Berlin" });
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("nests tools called through another tool under their caller", () =>
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
      const takeToolEvents = Effect.fnUntraced(function* (toolCallId: string) {
        const node = yield* takeEvent(
          (event) =>
            event.type === "node.updated" && event.node.nativeItemRef?.nativeId === toolCallId,
        );
        const item = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === toolCallId,
        );
        if (node.type !== "node.updated" || item.type !== "turn_item.updated")
          return yield* Effect.die("Expected tool node and item events");
        return { node: node.node, item: item.turnItem };
      });

      yield* fake.emit({
        type: "tool_execution_start",
        toolCallId: "call_code",
        toolName: "codemode",
        args: { code: "await read({ path: 'a.ts' })" },
      });
      const caller = yield* takeToolEvents("call_code");
      assert.equal(caller.node.parentNodeId, caller.node.rootNodeId);
      assert.isNull(caller.item.parentItemId);

      // Pi tags every phase, so an update that arrives before its start still nests.
      const phases = [
        { type: "tool_execution_update", partialResult: { content: [] }, status: "running" },
        { type: "tool_execution_start", args: { path: "a.ts" }, status: "running" },
        {
          type: "tool_execution_end",
          isError: true,
          result: { content: [{ type: "text", text: "ENOENT" }] },
          status: "failed",
        },
      ] as const;
      for (const { status, ...phase } of phases) {
        yield* fake.emit({
          ...phase,
          toolCallId: "call_code/1",
          toolName: "read",
          parentToolCallId: "call_code",
        });
        const nested = yield* takeToolEvents("call_code/1");
        assert.equal(nested.node.status, status);
        assert.equal(nested.node.parentNodeId, caller.node.id);
        assert.equal(nested.item.parentItemId, caller.item.id);
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "keeps native and MCP images available to the shared asset reader with typed results",
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
        const image = {
          type: "image",
          mimeType: "image/png",
          data: Buffer.alloc(64 * 1024, 0x61).toString("base64"),
        };
        const note = "Read image file [image/png]";
        const content = [{ type: "text", text: note }, image];
        const structured = { count: 2, ready: true, paths: ["one.png", "two.png"] };
        const scriptResult = { content, structuredContent: { threadId: "child-thread" } };
        const cases = [
          {
            toolName: "read",
            result: { content, structuredContent: { ...image, note } },
            expected: { content },
          },
          {
            toolName: "image_generate",
            result: { content, structuredContent: structured },
            expected: { content, structuredContent: structured },
          },
          {
            toolName: "mcp__t3-code__preview_snapshot",
            result: {
              content,
              structuredContent: scriptResult,
              details: { server: "t3-code", tool: "preview_snapshot" },
            },
            expected: { content, structuredContent: { threadId: "child-thread" } },
          },
          {
            toolName: "structured_tool",
            result: { content: [], structuredContent: [false, 2, null, { ready: true }] },
            expected: { content: [], structuredContent: [false, 2, null, { ready: true }] },
          },
          {
            toolName: "mcp__custom__extension",
            result: { content, structuredContent: { content: ["domain content"], ready: true } },
            expected: { content, structuredContent: { content: ["domain content"], ready: true } },
          },
          {
            toolName: "mcp__t3-code__preview_snapshot",
            result: {
              content: [
                { type: "text", text: "first" },
                { type: "text", text: "second" },
              ],
              structuredContent: {
                content: [
                  { type: "text", text: "first" },
                  { type: "text", text: "second" },
                ],
              },
              details: { server: "t3-code", tool: "preview_snapshot" },
            },
            expected: {
              content: [
                { type: "text", text: "first" },
                { type: "text", text: "second" },
              ],
            },
          },
        ];
        for (const [index, test] of cases.entries()) {
          for (const phase of ["update", "end"] as const) {
            yield* fake.emit({
              type: `tool_execution_${phase}`,
              toolCallId: `image-${index}`,
              toolName: test.toolName,
              ...(phase === "end" ? { result: test.result } : { partialResult: test.result }),
              isError: false,
            });
            const event = yield* takeEvent(
              (event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
            );
            if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
              return yield* Effect.die("Expected an image tool item");
            assert.equal(event.turnItem.status, phase === "end" ? "completed" : "running");
            assert.deepEqual(event.turnItem.output, test.expected);
            assert.deepEqual(
              toolOutputImages(event.turnItem.output),
              test.expected.content.some((block) => block.type === "image")
                ? [{ mimeType: "image/png", data: image.data }]
                : [],
            );
            if (index === 0) assert.equal(turnItemOutputText(event.turnItem), note);
            if (index === 5) assert.equal(turnItemOutputText(event.turnItem), "first\nsecond");
            if (index === 2) {
              assert.deepEqual(compactDynamicToolOutput(event.turnItem.output), {
                threadId: "child-thread",
              });
              assert.equal(JSON.stringify(event.turnItem.output).split(image.data).length - 1, 1);
            }
          }
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "keeps large tool text readable, drops identical read mirrors, and bounds structured values",
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
        const text = "hello\nworld\n" + "🙂".repeat(40_000);
        const content = [{ type: "text", text }];
        const cases = [
          { content, structuredContent: text },
          { content, structuredContent: { oversized: "x".repeat(128 * 1024) } },
          { content, structuredContent: Array.from({ length: 10_000 }, () => 1) },
          {
            content,
            structuredContent: Array.from({ length: 40 }).reduce<unknown>(
              (nested) => ({ nested }),
              null,
            ),
          },
        ];
        for (const [index, result] of cases.entries()) {
          yield* fake.emit({
            type: "tool_execution_end",
            toolCallId: `structured-${index}`,
            toolName: "read",
            result,
            isError: true,
          });
          const event = yield* takeEvent(
            (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
          );
          if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
            return yield* Effect.die("Expected a tool item");
          assert.equal(event.turnItem.status, "failed");
          assert.notProperty(event.turnItem.output, "structuredContent");
          const displayed = turnItemOutputText(event.turnItem);
          if (index === 0) {
            assert.equal(event.turnItem.output, text);
            assert.equal(displayed, text);
          } else {
            assert.equal(
              displayed,
              text + "\nStructured output omitted because it exceeds the stored result limit.",
            );
            assert.deepEqual(Object.keys(event.turnItem.output as object), ["content"]);
          }
        }
        yield* fake.emit({
          type: "tool_execution_end",
          toolCallId: "distinct-metadata",
          toolName: "read",
          result: { content, structuredContent: { path: "read.ts", ready: true } },
        });
        const event = yield* takeEvent(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
        );
        if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
          return yield* Effect.die("Expected a tool item");
        assert.deepEqual(event.turnItem.output, {
          content,
          structuredContent: { path: "read.ts", ready: true },
        });
        assert.equal(turnItemOutputText(event.turnItem), text);
        const note = "Read image file [image/png]";
        const image = { type: "image", data: "AAAA", mimeType: "image/png" };
        const imageContent = [{ type: "text", text: note }, image];
        for (const structuredContent of [
          { ...image, note, width: 1200 },
          { ...image, note: "A distinct note" },
          { ...image, note, data: "AQID" },
        ]) {
          yield* fake.emit({
            type: "tool_execution_end",
            toolCallId: "distinct-image-metadata",
            toolName: "read",
            result: { content: imageContent, structuredContent },
          });
          const event = yield* takeEvent(
            (event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool",
          );
          if (event.type !== "turn_item.updated" || event.turnItem.type !== "dynamic_tool")
            return yield* Effect.die("Expected a read image tool item");
          assert.deepEqual(event.turnItem.output, { content: imageContent, structuredContent });
          assert.equal(turnItemOutputText(event.turnItem), note);
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
