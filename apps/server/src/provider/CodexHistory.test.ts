import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { ProviderNativeHistory } from "@t3tools/provider-core/server/nativeHistory";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";

import { makeCodexNativeHistory } from "./CodexHistory.ts";

type NativeThread = CodexSchema.V2ThreadReadResponse["thread"];
type NativeEntry = CodexSchema.V2ThreadItemsListResponse__ThreadItemEntry;

const thread = (overrides: Partial<NativeThread> = {}): NativeThread => ({
  id: "native-thread",
  sessionId: "native-session",
  cliVersion: "0.163.0",
  createdAt: 1_780_000_000,
  updatedAt: 1_780_000_100,
  cwd: "/source-project",
  ephemeral: false,
  modelProvider: "openai",
  name: "Native diagnostic conversation",
  originator: "codex_cli_rs",
  preview: "Investigate a failing build",
  projectId: null,
  source: "cli",
  status: { type: "idle" },
  turns: [],
  ...overrides,
});

const message = (text: string, id = "native-item", turnId = "native-turn"): NativeEntry => ({
  turnId,
  startedAtMs: 1_780_000_050_000,
  item: { type: "agentMessage", id, text },
});

const command = (output: string): NativeEntry => ({
  turnId: "native-turn",
  item: {
    type: "commandExecution",
    id: "native-command",
    status: "failed",
    command: "pnpm test",
    commandActions: [],
    cwd: "/source-project",
    exitCode: 1,
    aggregatedOutput: output,
  },
});

const makeFixture = Effect.fn("CodexHistory.test.fixture")(function* (
  continuationKey = "codex:home:/shared-codex-home",
  enabled = true,
) {
  const state: {
    homePath: string;
    thread: NativeThread;
    list: CodexSchema.V2ThreadListResponse;
    items: CodexSchema.V2ThreadItemsListResponse;
    error: CodexErrors.CodexAppServerError | null;
  } = {
    homePath: continuationKey.slice("codex:home:".length),
    thread: thread(),
    list: { data: [thread()], nextCursor: null },
    items: { data: [message("Build failed in the compiler.")], nextCursor: null },
    error: null,
  };
  const calls = {
    cwd: [] as Array<string>,
    list: [] as Array<CodexSchema.V2ThreadListParams>,
    read: [] as Array<CodexSchema.V2ThreadReadParams>,
    items: [] as Array<CodexSchema.V2ThreadItemsListParams>,
  };
  const history = yield* makeCodexNativeHistory({
    enabled,
    homePath: state.homePath,
    identity: { driverKind: ProviderDriverKind.make("codex"), continuationKey },
    withClient: (cwd, use) =>
      Effect.suspend(() => {
        calls.cwd.push(cwd);
        return use({
          homePath: state.homePath,
          list: (params) =>
            Effect.suspend(() => {
              calls.list.push(params);
              return state.error ? Effect.fail(state.error) : Effect.succeed(state.list);
            }),
          read: (params) =>
            Effect.suspend(() => {
              calls.read.push(params);
              return state.error
                ? Effect.fail(state.error)
                : Effect.succeed({ thread: state.thread });
            }),
          items: (params) =>
            Effect.sync(() => {
              calls.items.push(params);
              return state.items;
            }),
        });
      }),
  });
  return { history, state, calls };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("Codex native history", (it) => {
  it.effect("refuses an app-server that reports another history home", () =>
    Effect.gen(function* () {
      const { history, state, calls } = yield* makeFixture();
      state.homePath = "/unexpected-account-home";
      const error = yield* history.list({ cwd: "/project" }).pipe(Effect.flip);
      expect(error.reason).toBe("unavailable");
      expect(calls.list).toEqual([]);
      expect(calls.items).toEqual([]);
    }),
  );
  it.effect(
    "discovers interactive native sources across projects without treating a filtered page as the end",
    () =>
      Effect.gen(function* () {
        const { history, state, calls } = yield* makeFixture();
        state.list = {
          data: [
            thread(),
            thread({ id: "editor", cwd: "/another-project", source: "vscode" }),
            thread({ id: "app", source: "appServer" }),
            thread({ id: "exec", source: "exec" }),
            thread({ id: "ephemeral", ephemeral: true }),
          ],
          nextCursor: "more-threads",
        };
        const all = yield* history.list({ cwd: "/operational-cwd", archived: true });
        expect(all.threads.map((value) => value.nativeThreadId)).toEqual([
          "native-thread",
          "editor",
          "app",
        ]);
        expect(all.nextCursor).toBe("more-threads");
        expect(calls.cwd).toEqual(["/operational-cwd"]);
        expect(calls.list[0]).toMatchObject({
          archived: true,
          sourceKinds: ["cli", "vscode", "appServer"],
          modelProviders: [],
          useStateDbOnly: true,
        });
        expect(calls.list[0]).not.toHaveProperty("cwd");
        const filtered = yield* history.list({
          cwd: "/operational-cwd",
          filterCwd: "/another-project/",
        });
        expect(filtered.threads.map((value) => value.nativeThreadId)).toEqual(["editor"]);
        const empty = yield* history.list({ cwd: "/operational-cwd", filterCwd: "/no-matches" });
        expect(empty.threads).toEqual([]);
        expect(empty.nextCursor).toBe("more-threads");
      }),
  );

  it.effect(
    "finds a literal match beyond the preview and recovers every exact tool-output character",
    () =>
      Effect.gen(function* () {
        const { history, state, calls } = yield* makeFixture();
        const pathAndError = "C:\\repo\\src\\broken.ts\nfatal: missing symbol";
        const output =
          "diagnostic😀\n".repeat(3_000) +
          "İ failure NEEDLE[.*] at the output tail\n" +
          pathAndError;
        state.items = { data: [command(output)], nextCursor: "later-items" };
        const expected =
          "Tool evidence: commandExecution\nStatus: failed\nCommand: pnpm test\nDirectory: /source-project\nExit code: 1\n\nOutput:\n" +
          output;
        const pathMatch = yield* history.items({
          cwd: "/project",
          nativeThreadId: "native-thread",
          query: pathAndError,
        });
        expect(pathMatch.items).toHaveLength(1);
        expect(pathMatch.items[0]?.text).toContain(pathAndError);
        const page = yield* history.items({
          cwd: "/project",
          nativeThreadId: "native-thread",
          query: "needle[.*]",
          maxCharsPerItem: 400,
        });
        expect(page.examinedItems).toBe(1);
        expect(page.nextCursor).toBe("later-items");
        expect(page.items).toHaveLength(1);
        const item = page.items[0]!;
        expect(item.text).toContain("NEEDLE[.*]");
        expect(item.textOffset).toBeGreaterThan(30_000);
        expect(item.match).toEqual({
          start: expected.indexOf("NEEDLE[.*]"),
          end: expected.indexOf("NEEDLE[.*]") + "NEEDLE[.*]".length,
        });
        expect(item.totalChars).toBe(expected.length);
        expect(item.text.length).toBeLessThanOrEqual(400);
        expect(item.truncated).toBe(true);
        let offset: number | null = 0;
        let recovered = "";
        while (offset !== null) {
          const source: Effect.Success<ReturnType<ProviderNativeHistory["readSource"]>> =
            yield* history.readSource({
              cwd: "/project",
              nativeThreadId: item.nativeThreadId,
              readCursor: item.readCursor,
              digest: item.digest,
              textOffset: offset,
              maxChars: 1_803,
            });
          expect(source.item.digest).toBe(item.digest);
          expect(source.item.text.length).toBeLessThanOrEqual(1_803);
          expect(source.item.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
          recovered += source.item.text;
          offset = source.nextTextOffset;
        }
        expect(recovered).toBe(expected);
        expect(calls.read.every((request) => request.includeTurns === false)).toBe(true);
      }),
  );

  it.effect(
    "preserves pagination through nonmatching and private items and keeps Unicode match offsets in the original text",
    () =>
      Effect.gen(function* () {
        const { history, state } = yield* makeFixture();
        state.items = {
          data: [
            message("ordinary text"),
            {
              turnId: "native-turn",
              item: { type: "reasoning", id: "private", summary: ["ÉCLAIR"] },
            },
          ],
          nextCursor: "next-native-page",
        };
        const empty = yield* history.items({
          cwd: "/project",
          nativeThreadId: "native-thread",
          query: "éclair",
        });
        expect(empty.items).toEqual([]);
        expect(empty.examinedItems).toBe(2);
        expect(empty.nextCursor).toBe("next-native-page");
        state.items = { data: [message("İ😀 ÉCLAIR matched here")], nextCursor: null };
        const next = yield* history.items({
          cwd: "/project",
          nativeThreadId: "native-thread",
          cursor: empty.nextCursor!,
          query: "éclair",
        });
        expect(next.items[0]?.match).toEqual({ start: 4, end: 10 });
        expect(next.nextCursor).toBeNull();
      }),
  );

  it.effect(
    "withholds edited, removed, cross-home and cross-thread sources instead of returning stale evidence",
    () =>
      Effect.gen(function* () {
        const { history, state, calls } = yield* makeFixture();
        const first = (yield* history.items({ cwd: "/project", nativeThreadId: "native-thread" }))
          .items[0]!;
        const request = {
          cwd: "/project",
          nativeThreadId: first.nativeThreadId,
          readCursor: first.readCursor,
          digest: first.digest,
        };
        state.items = { data: [message("A changed compiler failure.")] };
        expect((yield* history.readSource(request).pipe(Effect.flip)).reason).toBe("changed");
        state.items = { data: [message("Build failed in the compiler.", "different-item")] };
        expect((yield* history.readSource(request).pipe(Effect.flip)).reason).toBe("changed");
        const before = calls.items.length;
        expect(
          (yield* history
            .readSource({ ...request, nativeThreadId: "foreign-thread" })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid_cursor");
        expect(calls.items).toHaveLength(before);
        const foreign = yield* makeFixture("codex:home:/another-account");
        expect((yield* foreign.history.readSource(request).pipe(Effect.flip)).reason).toBe(
          "invalid_cursor",
        );
        expect(foreign.calls.cwd).toEqual([]);
        state.thread = thread({ id: "wrong-thread" });
        expect((yield* history.readSource(request).pipe(Effect.flip)).reason).toBe("changed");
      }),
  );

  it.effect(
    "keeps failure outcomes and diffs while excluding binary, private and incomplete payloads",
    () =>
      Effect.gen(function* () {
        const { history, state } = yield* makeFixture();
        state.items = {
          data: [
            command("compiler error: missing symbol"),
            {
              turnId: "native-turn",
              item: {
                type: "fileChange",
                id: "patch",
                status: "completed",
                changes: [{ path: "a.ts", kind: { type: "update" }, diff: "-broken\n+fixed" }],
              },
            },
            {
              turnId: "native-turn",
              item: {
                type: "mcpToolCall",
                id: "mcp",
                status: "failed",
                server: "test",
                tool: "lookup",
                arguments: { query: "error" },
                error: { message: "permission denied" },
                result: {
                  _meta: { internal: "private metadata" },
                  content: [
                    { type: "text", text: "visible result" },
                    { type: "image", data: "binary image" },
                  ],
                  structuredContent: { matches: 1 },
                },
              },
            },
            {
              turnId: "native-turn",
              item: {
                type: "dynamicToolCall",
                id: "dynamic",
                status: "completed",
                tool: "lookup",
                arguments: {},
                success: false,
                contentItems: [
                  { type: "inputText", text: "visible dynamic result" },
                  { type: "inputImage", imageUrl: "binary dynamic image" },
                ],
              },
            },
            {
              turnId: "native-turn",
              item: {
                type: "functionCallOutput",
                id: "function",
                name: "lookup",
                output: [
                  { type: "input_text", text: "visible function output" },
                  { type: "encrypted_content", encrypted_content: "private encrypted data" },
                ],
              },
            },
            {
              turnId: "native-turn",
              item: { type: "reasoning", id: "private", content: ["private reasoning"] },
            },
            {
              turnId: "native-turn",
              item: {
                ...command("unfinished output").item,
                type: "commandExecution",
                id: "running",
                command: "running",
                commandActions: [],
                cwd: "/project",
                status: "inProgress",
              },
            },
          ],
        };
        const page = yield* history.items({
          cwd: "/project",
          nativeThreadId: "native-thread",
          maxCharsPerItem: 2_000,
        });
        expect(page.examinedItems).toBe(7);
        expect(page.items.map((item) => item.nativeItemId)).toEqual([
          "native-command",
          "patch",
          "mcp",
          "dynamic",
          "function",
        ]);
        const text = page.items.map((item) => item.text).join("\n");
        expect(text).toContain("Exit code: 1");
        expect(text).toContain("missing symbol");
        expect(text).toContain("-broken\n+fixed");
        expect(text).toContain("permission denied");
        expect(text).toContain("visible result");
        expect(text).toContain("visible dynamic result");
        expect(text).toContain("visible function output");
        expect(text).not.toMatch(/binary|private|unfinished/);
      }),
  );

  it.effect(
    "fails bounded pages explicitly instead of advertising partial results as complete",
    () =>
      Effect.gen(function* () {
        const { history, state } = yield* makeFixture();
        state.items = { data: [message("first"), message("second", "second-item")] };
        expect(
          (yield* history
            .items({ cwd: "/project", nativeThreadId: "native-thread", limit: 1 })
            .pipe(Effect.flip)).reason,
        ).toBe("limit_exceeded");
        state.items = { data: [message("x".repeat(8 * 1024 * 1024))] };
        expect(
          (yield* history
            .items({ cwd: "/project", nativeThreadId: "native-thread" })
            .pipe(Effect.flip)).reason,
        ).toBe("limit_exceeded");
        state.items = { data: [message("first")], nextCursor: "stuck" };
        expect(
          (yield* history
            .items({ cwd: "/project", nativeThreadId: "native-thread", cursor: "stuck" })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid_cursor");
        state.list = { data: [thread()], nextCursor: "stuck" };
        expect(
          (yield* history.list({ cwd: "/project", cursor: "stuck" }).pipe(Effect.flip)).reason,
        ).toBe("invalid_cursor");
      }),
  );

  it.effect(
    "distinguishes unavailable and unsupported providers from confirmed missing native threads",
    () =>
      Effect.gen(function* () {
        const { history, state } = yield* makeFixture();
        for (const [code, errorMessage, expected] of [
          [-32601, "Method not found", "unsupported"],
          [-32600, "thread not found: native-thread", "missing"],
          [-32603, "thread store is temporarily unavailable", "unavailable"],
        ] as const) {
          state.error = new CodexErrors.CodexAppServerRequestError({
            code,
            errorMessage,
            method: "thread/read",
          });
          const error = yield* history
            .items({ cwd: "/project", nativeThreadId: "native-thread" })
            .pipe(Effect.flip);
          expect(error.reason).toBe(expected);
        }
        state.error = new CodexErrors.CodexAppServerRequestError({
          code: -32602,
          errorMessage: "Unsupported response shape",
          operation: "decode-payload",
        });
        expect((yield* history.list({ cwd: "/project" }).pipe(Effect.flip)).reason).toBe(
          "unsupported",
        );
        const disabled = yield* makeFixture("codex:home:/disabled", false);
        expect((yield* disabled.history.list({ cwd: "/project" }).pipe(Effect.flip)).reason).toBe(
          "unsupported",
        );
        expect(disabled.calls.cwd).toEqual([]);
      }),
  );
});
