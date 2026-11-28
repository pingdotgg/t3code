import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AssetCreateUrlResult, AttachmentCreateUploadUrlResult } from "./assets.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

describe("WebSocket RPC contracts", () => {
  it("round-trips private mail rows and legacy empty answers through the answer RPC's JSON exit", () => {
    const rpc = WsRpcGroup.requests.get(WS_METHODS.secretsAnswerRequest)!;
    const codec = Schema.toCodecJson(Rpc.exitSchema(rpc));
    const encode = Schema.encodeSync(codec);
    const decode = Schema.decodeUnknownSync(codec);
    const row = { from: "sender@example.test", subject: "Test", date: "Mon", snippet: "Preview" };
    for (const value of [undefined, { messages: [row] }]) {
      const exit = decode(JSON.parse(JSON.stringify(encode(Exit.succeed(value)))));
      expect(Exit.isSuccess(exit) && exit.value).toEqual(value);
    }
  });

  it("rejects invalid connection secrets at the vault RPC without returning their values", () => {
    const rpc = WsRpcGroup.requests.get(WS_METHODS.serverManageLocalVault)!;
    const decode = Schema.decodeUnknownExit(Schema.toCodecJson(rpc.payloadSchema));
    const base = { name: "work", title: "Work", pin: "731906" };
    const inputs = [
      (secret: string) => ({ ...base, action: "connect-service", service: "asana", token: secret }),
      (secret: string) => ({
        ...base,
        action: "gmail-configure",
        clientId: "fixture.apps.googleusercontent.com",
        redirectUri: "https://work.example.test/oauth/gmail/callback",
        clientSecret: secret,
      }),
    ];
    for (const input of inputs) {
      expect(Exit.isSuccess(decode(input("a".repeat(4096))))).toBe(true);
      for (const secret of [
        "",
        "fixture-secret ",
        "fixture-secret\nx",
        "fixture-secret".padEnd(4097, "x"),
      ]) {
        const exit = decode(input(secret));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).not.toContain("fixture-secret");
      }
    }
  });

  it("only accepts asset and upload URLs on their own server routes", () => {
    const decodeAsset = Schema.decodeUnknownExit(AssetCreateUrlResult);
    const decodeUpload = Schema.decodeUnknownExit(AttachmentCreateUploadUrlResult);
    const expiresAt = 10_000;

    expect(
      Exit.isSuccess(
        decodeAsset({ relativeUrl: "/api/assets/token.sig/my%20file.png", expiresAt }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decodeUpload({
          relativeUrl: "/api/attachments/upload/token.sig",
          expiresAt,
          attachmentId: "attachment",
        }),
      ),
    ).toBe(true);

    for (const relativeUrl of [
      "data:text/plain,hello",
      "file:///tmp/document",
      "https://other.example/document",
      "//other.example/document",
      "/api/assets/token/../../../other",
    ]) {
      expect(Exit.isFailure(decodeAsset({ relativeUrl, expiresAt }))).toBe(true);
      expect(
        Exit.isFailure(decodeUpload({ relativeUrl, expiresAt, attachmentId: "attachment" })),
      ).toBe(true);
    }
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});
