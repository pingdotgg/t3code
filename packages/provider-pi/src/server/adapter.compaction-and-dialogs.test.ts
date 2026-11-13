import {
  CheckpointId,
  Effect,
  RunId,
  THREAD_ID,
  TURN_ONE_ENTRIES,
  assert,
  at,
  decodeUserInputQuestions,
  describe,
  it,
  layerTest,
  makeFakePi,
  modelSelection,
  openRuntime,
  runtimePolicy,
  sessionMessage,
  startTurn,
  uncapturedTurns,
} from "./adapter-fixtures.testkit.ts";

describe("PiAdapterV2", () => {
  it.effect("preserves inherited history when rolling back an uncaptured first turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const rollBackToStart = (startedAt: number) =>
        runtime.rollbackThread({
          providerThread: { ...providerThread, createdAt: at(50) },
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-start"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [
            {
              ...uncapturedTurns(providerThread.id)[1]!,
              ordinal: 1,
              startedAt: at(startedAt),
            },
          ],
        });
      const forkedEntries = () =>
        fake
          .allRequests()
          .filter((request) => request.type === "fork")
          .map((request) => request.entryId);

      const entries = {
        entries: [
          ...TURN_ONE_ENTRIES,
          sessionMessage("u2", "a1b", "user", 100),
          sessionMessage("a2", "u2", "assistant", 120),
          sessionMessage("u3", "a2", "user", 160),
          sessionMessage("a3", "u3", "assistant", 180),
        ],
        leafId: "a3",
      };

      // The adopted wake precedes T3's first turn; its steer must be discarded with it.
      fake.queueEntries(entries);
      yield* rollBackToStart(150);
      assert.deepEqual(forkedEntries(), ["u2"]);

      fake.queueEntries(entries);
      yield* rollBackToStart(100);
      assert.deepEqual(forkedEntries(), ["u2", "u2"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("settles a command-only prompt from its deferred ack and idle probe", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/command-only");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-cmd",
        method: "notify",
        message: "Command finished\nwith details",
        notifyType: "info",
      });
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      const notice = yield* takeEvent(
        (event) =>
          (event.type === "turn_item.updated" && event.turnItem.type === "system_notice") ||
          event.type === "turn.terminal",
      );
      assert.isTrue(
        notice.type === "turn_item.updated" &&
          notice.turnItem.type === "system_notice" &&
          notice.turnItem.status === "completed" &&
          notice.turnItem.message === "Command finished\nwith details",
      );
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("leaves /compacted as an ordinary prompt", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compacted please");
      const prompt = yield* fake.takeRequest("prompt");
      assert.equal(prompt["message"], "/compacted please");
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "compact"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("fails a compact that never started", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      yield* fake.emit({
        type: "response",
        command: "compact",
        success: false,
        error: "Nothing to compact (session too small)",
      });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure.message === "Nothing to compact (session too small)",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("restarts Pi when Stop interrupts a user compact", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/compact");
      yield* fake.takeRequest("compact");
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      assert.isDefined(providerTurnId);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurnId! });
      assert.isFalse(fake.allRequests().some((request) => request["type"] === "abort"));
      yield* fake.closeStdout;
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("steers /compact as RPC compact instead of a prompt", () =>
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
      const running = yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      );
      const providerTurnId =
        running.type === "provider_turn.updated" ? running.providerTurn.id : undefined;
      yield* fake.emit({ type: "agent_start" });
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make("run:thread-pi-test:1"),
        providerThread,
        providerTurnId: providerTurnId!,
        message: {
          messageId: "message:thread-pi-test:steer-compact" as never,
          text: "/compact keep the tests",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      const compact = yield* fake.takeRequest("compact");
      assert.equal(compact["customInstructions"], "keep the tests");
      assert.isUndefined(compact["streamingBehavior"]);
      yield* fake.emit({ type: "compaction_start", reason: "manual" });
      yield* takeEvent(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
      );
      fake.queueState({ isStreaming: false, isCompacting: false, pendingMessageCount: 0 });
      yield* fake.emit({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "smaller", tokensBefore: 10_000, estimatedTokensAfter: 2_000 },
        aborted: false,
        willRetry: false,
      });
      yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "compaction" &&
          event.turnItem.status === "completed",
      );
      yield* fake.emit({ type: "response", command: "compact", success: true });
      yield* fake.emit({ type: "agent_settled" });
      yield* fake.takeRequest("get_state");
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([
    { toolName: "bash", exitCode: 0, legacy: false },
    { toolName: "powershell", exitCode: 2, legacy: false },
    { toolName: "bash", exitCode: 1, legacy: true },
    { toolName: "powershell", exitCode: 0, legacy: true },
  ])(
    "normalizes $toolName command results, exit=$exitCode legacy=$legacy",
    ({ toolName, exitCode, legacy }) =>
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
        yield* fake.emit({
          type: "tool_execution_start",
          toolCallId: "shell-call",
          toolName,
          args: { command: "echo hello" },
        });
        const running = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        assert.isTrue(
          running.type === "turn_item.updated" &&
            running.turnItem.type === "command_execution" &&
            running.turnItem.status === "running" &&
            running.turnItem.input === "echo hello",
        );
        yield* fake.emit({
          type: "tool_execution_end",
          toolCallId: "shell-call",
          toolName,
          isError: exitCode !== 0,
          result: {
            content: [{ type: "text", text: "hello" }],
            details: { exitCode: legacy ? exitCode : 99 },
            ...(legacy ? {} : { structuredContent: { exit_code: exitCode } }),
          },
        });
        const completed = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        assert.isTrue(
          completed.type === "turn_item.updated" &&
            completed.turnItem.type === "command_execution" &&
            completed.turnItem.title === toolName &&
            completed.turnItem.input === "echo hello" &&
            completed.turnItem.output === "hello" &&
            completed.turnItem.exitCode === exitCode &&
            completed.turnItem.status === (exitCode === 0 ? "completed" : "failed"),
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("emits session-start dialogs before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({ requestId: requestId!, decision: "accept" });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("cancels startup dialogs when Pi exits before a turn exists", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "startup",
        method: "confirm",
        title: "Trust project?",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      if (pending.type !== "runtime_request.updated") return;
      yield* fake.closeStdout;
      const cancelled = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" &&
          event.runtimeRequest.id === pending.runtimeRequest.id &&
          event.runtimeRequest.status === "cancelled",
      );
      assert.isTrue(cancelled.type === "runtime_request.updated");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("remembers session approvals only for identical confirmation content", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      const pending = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      const requestId =
        pending.type === "runtime_request.updated" ? pending.runtimeRequest.id : undefined;
      yield* runtime.respondToRuntimeRequest({
        requestId: requestId!,
        decision: "acceptForSession",
      });
      const uiResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(uiResponse["id"], "ui-trust");
      assert.equal(uiResponse["confirmed"], true);
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-trust-again",
        method: "confirm",
        title: "Run project extensions?",
        message: "This project has .pi/extensions.",
      });
      assert.equal((yield* fake.takeRequest("extension_ui_response"))["id"], "ui-trust-again");
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-other",
        method: "confirm",
        title: "Run project extensions?",
        message: "A different project.",
      });
      const other = yield* takeEvent(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
      );
      assert.isTrue(
        other.type === "runtime_request.updated" &&
          other.runtimeRequest.nativeRequestRef?.nativeId === "ui-other",
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps an input dialog's title as the header above its placeholder", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-input-placeholder",
        method: "input",
        title: "Name",
        placeholder: "Your name",
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request") {
        return assert.fail("expected a user input request");
      }
      assert.equal(event.turnItem.questions[0]?.header, "Name");
      assert.equal(event.turnItem.questions[0]?.question, "Your name");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("emits a valid empty select option and returns its original value", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-select",
        method: "select",
        title: "Pick a tag",
        options: ["stable", ""],
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request") {
        return assert.fail("expected a user input request");
      }
      const questions = decodeUserInputQuestions(event.turnItem.questions);
      assert.deepEqual(
        questions[0]?.options.map((option) => [option.label, option.value]),
        [
          ["stable", "stable"],
          ["Empty value", ""],
        ],
      );
      assert.equal(questions[0]?.header, "Question");
      assert.equal(questions[0]?.question, "Pick a tag");
      yield* runtime.respondToRuntimeRequest({
        requestId: event.turnItem.requestId,
        answers: { "ui-select": "" },
      });
      const response = yield* fake.takeRequest("extension_ui_response");
      assert.equal(response["value"], "");
      assert.isUndefined(response["cancelled"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("asks an input dialog's title when its placeholder is blank", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const title = "Which database?\n1. Postgres\n2. Type something.\nType your answer:";
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-input",
        method: "input",
        title,
        placeholder: "",
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request") {
        return assert.fail("expected a user input request");
      }
      assert.equal(decodeUserInputQuestions(event.turnItem.questions)[0]?.header, "Question");
      assert.equal(decodeUserInputQuestions(event.turnItem.questions)[0]?.question, title);
      yield* runtime.respondToRuntimeRequest({
        requestId: event.turnItem.requestId,
        answers: { "ui-input": "SQLite" },
      });
      const response = yield* fake.takeRequest("extension_ui_response");
      assert.equal(response["value"], "SQLite");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("keeps the complete editor prefill editable and returns exact edited text", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      const prefill = `  fix(server): retain full editor content\n\n${"detail\n".repeat(500)}  `;
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-editor",
        method: "editor",
        title: "Commit message",
        prefill,
      });
      const event = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
      );
      if (event.type !== "turn_item.updated" || event.turnItem.type !== "user_input_request")
        return;
      assert.equal(event.turnItem.questions[0]?.initialAnswer, prefill);
      assert.deepEqual(event.turnItem.questions[0]?.options, []);
      assert.equal(event.turnItem.questions[0]?.header, "Question");
      assert.equal(event.turnItem.questions[0]?.question, "Commit message");
      const edited = "  fix(server): edited commit message\n\n";
      yield* runtime.respondToRuntimeRequest({
        requestId: event.turnItem.requestId,
        answers: { "ui-editor": edited },
      });
      const response = yield* fake.takeRequest("extension_ui_response");
      assert.equal(response["value"], edited);
      assert.isUndefined(response["cancelled"]);
      yield* fake.emit({
        type: "extension_ui_request",
        id: "ui-editor-cleared",
        method: "editor",
        title: "Commit message",
        prefill,
      });
      const cleared = yield* takeEvent(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "user_input_request" &&
          event.turnItem.questions.some((question) => question.id === "ui-editor-cleared"),
      );
      if (cleared.type !== "turn_item.updated" || cleared.turnItem.type !== "user_input_request")
        return;
      yield* runtime.respondToRuntimeRequest({
        requestId: cleared.turnItem.requestId,
        answers: { "ui-editor-cleared": "" },
      });
      const emptyResponse = yield* fake.takeRequest("extension_ui_response");
      assert.equal(emptyResponse["value"], "");
      assert.isUndefined(emptyResponse["cancelled"]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("raises bridge edit confirmations as file-change approvals", () =>
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
      for (const [id, title, requestKind] of [
        ["ui-edit", "Allow edit?", "file-change"],
        ["ui-bash", "Allow bash?", "command"],
        ["ui-ext", "Deploy to staging?", "command"],
      ] as const) {
        yield* fake.emit({ type: "extension_ui_request", id, method: "confirm", title });
        const item = yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
        );
        assert.isTrue(
          item.type === "turn_item.updated" &&
            item.turnItem.type === "approval_request" &&
            item.turnItem.requestKind === requestKind,
          `${title} should be ${requestKind}`,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("reads a thread snapshot from pi's active branch", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueMessages({
        messages: [
          {
            role: "user",
            content: "hello pi",
            timestamp: 1700000000000,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "hello back" }],
            timestamp: 1700000001000,
          },
          { role: "toolResult", content: [] },
        ],
      });
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      assert.equal(snapshot.messages.length, 2);
      assert.equal(snapshot.messages[0]!.role, "user");
      assert.equal(snapshot.messages[0]!.text, "hello pi");
      assert.equal(snapshot.messages[1]!.role, "assistant");
      assert.equal(snapshot.messages[1]!.text, "hello back");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
