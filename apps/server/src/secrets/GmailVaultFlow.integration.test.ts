import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  type GmailReadOperation,
  type OrchestrationV2ServerCommand,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";
import * as RpcTest from "effect/rpc/RpcTest";
import { vi } from "vite-plus/test";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as VaultCipher from "../auth/VaultCipher.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { manageLocalVault, readVaultRecord } from "./LocalVault.ts";
import * as GmailOAuth from "./GmailOAuth.ts";
import * as SecretRequests from "./SecretRequests.ts";
import { setVaultPin } from "./VaultAccess.ts";

const pin = "8472951";
const password = "fixture-website-password";
const grant = {
  account: "work@example.test",
  clientId: "12345-work.apps.googleusercontent.com",
  refreshToken: "fixture-refresh-token",
};
const clientSecret = "fixture-client-secret";
const accessToken = "fixture-access-token";
const redirectUri = "https://work.example.test/oauth/gmail/callback";
const priorAccount = "before-reconnect@example.test";
const work = {
  name: "work-login",
  title: "Work mail",
  clientId: grant.clientId,
  clientSecret,
  redirectUri,
  account: grant.account,
  accessToken,
  refreshToken: grant.refreshToken,
};
const personal = {
  name: "personal",
  title: "Personal mail",
  clientId: "67890-personal.apps.googleusercontent.com",
  clientSecret: "fixture-other-secret",
  redirectUri,
  account: "personal@example.test",
  accessToken: "fixture-personal-access",
  refreshToken: "fixture-personal-refresh",
};
const operation = { folder: "spam", limit: 5 } as const satisfies GmailReadOperation;
const summary = (n: number) => ({
  from: `sender${n}@example.test`,
  subject: `Subject ${n}`,
  date: `2026-11-0${n}T12:00:00Z`,
  snippet: `Preview ${n}`,
});

// Only the two official hosts and requests authorized for this mailbox are served. There is
// no passthrough to the network; a missing or incorrectly refreshed token cannot read a row.
const google: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.href === "https://oauth2.googleapis.com/token" && request.method === "POST") {
    const form = new URLSearchParams(await request.text());
    if (form.get("grant_type") === "authorization_code") {
      const code = form.get("code");
      const slot =
        code === "personal-code"
          ? personal
          : code === "work-before" || code === "work-code"
            ? work
            : undefined;
      if (
        !slot ||
        form.get("client_id") !== slot.clientId ||
        form.get("client_secret") !== slot.clientSecret ||
        form.get("redirect_uri") !== slot.redirectUri ||
        !form.get("code_verifier")
      )
        return new Response(null, { status: 401 });
      return Response.json({
        access_token: code === "work-before" ? "fixture-before-access" : slot.accessToken,
        refresh_token: slot.refreshToken,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      });
    }
    if (
      form.get("grant_type") !== "refresh_token" ||
      form.get("refresh_token") !== grant.refreshToken ||
      form.get("client_id") !== grant.clientId ||
      form.get("client_secret") !== clientSecret
    ) {
      return new Response(null, { status: 401 });
    }
    return Response.json({
      access_token: accessToken,
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
  }
  if (
    url.href === "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress" &&
    request.method === "GET"
  ) {
    const bearer = request.headers.get("authorization");
    if (bearer === `Bearer ${personal.accessToken}`)
      return Response.json({ emailAddress: personal.account });
    if (bearer === `Bearer ${accessToken}`) return Response.json({ emailAddress: grant.account });
    if (bearer === "Bearer fixture-before-access")
      return Response.json({ emailAddress: priorAccount });
    return new Response(null, { status: 401 });
  }
  if (
    url.origin !== "https://gmail.googleapis.com" ||
    request.method !== "GET" ||
    request.headers.get("authorization") !== `Bearer ${accessToken}`
  ) {
    throw new Error("Unexpected Google request");
  }
  if (
    url.pathname === "/gmail/v1/users/me/messages" &&
    url.searchParams.getAll("labelIds").join(",") === "SPAM" &&
    url.searchParams.get("maxResults") === "5" &&
    url.searchParams.get("includeSpamTrash") === "true"
  ) {
    return Response.json({ messages: [3, 1, 5, 4, 2].map((n) => ({ id: `id${n}` })) });
  }
  const match = /^\/gmail\/v1\/users\/me\/messages\/id([1-5])$/.exec(url.pathname);
  if (!match || url.searchParams.get("format") !== "metadata") {
    throw new Error("Unexpected mailbox request");
  }
  const n = Number(match[1]);
  const { from, subject, date, snippet } = summary(n);
  return Response.json({
    id: `id${n}`,
    labelIds: ["SPAM"],
    internalDate: String(Date.parse(date)),
    snippet,
    payload: {
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
        { name: "Date", value: date },
      ],
    },
  });
};

type CardRecord = Extract<OrchestrationV2ServerCommand, { type: "secret_request.record" }>;

it.effect(
  "connects the tagged entry and returns five private spam rows only to the approving RPC",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      using _keyring = vi.spyOn(VaultCipher, "readVaultKey").mockImplementation(async (path) => {
        assert.equal(path, directory);
        return Buffer.alloc(32, 7);
      });
      using http = vi.spyOn(globalThis, "fetch").mockImplementation(google);
      yield* fs.writeFileString(`${directory}/${VaultCipher.vaultMarker}`, "");
      const store = yield* ServerSecretStore.make.pipe(
        Effect.provide(
          Layer.mock(ServerConfig.ServerConfig)({
            secretsDir: directory,
          } as ServerConfig.ServerConfig["Service"]),
        ),
      );
      yield* setVaultPin(store, Redacted.make(pin), undefined, true);
      const { name, title } = work;
      const login = {
        kind: "login",
        version: 1,
        title,
        origin: "https://accounts.google.com",
        username: grant.account,
        password,
      } as const;
      const saved = yield* manageLocalVault(store, {
        action: "save",
        name,
        value: Redacted.make(JSON.stringify(login)),
        structured: true,
        replace: false,
        access: "allow",
        pin: Redacted.make(pin),
      });
      assert.isNull(saved.error);

      const threadId = ThreadId.make("thread:gmail-flow");
      const projectId = ProjectId.make("project:gmail-flow");
      const runId = RunId.make("run:gmail-flow");
      const nodeId = NodeId.make("node:gmail-root");
      let turnItemId = TurnItemId.make("turn-item:gmail-read:private");
      const commands: CardRecord[] = [];
      const recorded = yield* Deferred.make<void>();
      let selected: CardRecord["taggedVault"];
      const thread = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: () =>
          Effect.sync(
            () =>
              ({
                thread: { id: threadId, projectId },
                runs: [{ id: runId, rootNodeId: nodeId, status: "running" }],
                nodes: [{ id: nodeId, threadId, runId, status: "running" }],
                turnItems: selected
                  ? [
                      {
                        type: "secret_request",
                        id: turnItemId,
                        threadId,
                        runId,
                        nodeId,
                        label: title,
                        taggedVault: selected,
                        reason: "Read the latest 5 messages from Gmail spam.",
                        secretStatus:
                          commands.findLast((command) => command.turnItemId === turnItemId)
                            ?.secretStatus ?? "pending",
                      },
                    ]
                  : [],
              }) as never,
          ),
        dispatch: (command) =>
          Effect.sync(() => {
            if (command.type !== "secret_request.record") throw new Error("Unexpected command");
            commands.push(command);
            return {} as never;
          }).pipe(Effect.tap(() => Deferred.succeed(recorded, undefined))),
      });
      yield* Effect.gen(function* () {
        const broker = yield* SecretRequests.SecretRequests;
        selected = yield* broker.resolveGmailEntry(title, operation);
        assert.deepEqual(selected, { name, gmail: operation, needsGmailConnection: true });
        const flows = yield* GmailOAuth.GmailOAuth;
        const session = "fixture-owner-session";
        const options = { canSetInitialPin: false };
        const connect = Effect.fn("test.connectEntry")(function* (
          slot: typeof work,
          code?: string,
        ) {
          const started = yield* GmailOAuth.manageGmailVault(
            flows,
            session,
            store,
            {
              action: "gmail-start",
              name: slot.name,
              title: slot.title,
            },
            options,
          );
          const auth = started.gmailAuthorization;
          if (!auth) throw new Error("Expected OAuth authorization handoff.");
          const params = new URL(auth.url).searchParams;
          assert.equal(params.get("client_id"), slot.clientId);
          assert.equal(params.get("redirect_uri"), slot.redirectUri);
          assert.notInclude(auth.url, slot.clientSecret);
          const state = params.get("state")!;
          if (!code) {
            assert.equal(
              flows.receive(new URLSearchParams({ state, error: "access_denied" })),
              "rejected",
            );
          } else {
            assert.equal(flows.receive(new URLSearchParams({ state, code })), "accepted");
          }
          const finish = yield* GmailOAuth.manageGmailVault(
            flows,
            session,
            store,
            {
              action: "gmail-finish",
              name: slot.name,
              flowId: auth.flowId,
              pin: Redacted.make(pin),
            },
            options,
          );
          if (code) assert.isNull(finish.error);
          else assert.isNotNull(finish.error);
        });
        for (const slot of [work, personal]) {
          const configured = yield* manageLocalVault(store, {
            action: "gmail-configure",
            name: slot.name,
            title: slot.title,
            clientId: slot.clientId,
            redirectUri: slot.redirectUri,
            clientSecret: Redacted.make(slot.clientSecret),
            pin: Redacted.make(pin),
          });
          assert.isNull(configured.error);
          assert.notInclude(JSON.stringify(configured), slot.clientSecret);
        }
        yield* connect(work);
        assert.lengthOf(http.mock.calls, 0);
        assert.isUndefined((yield* readVaultRecord(store, name))?.gmailGrant);
        yield* connect(personal, "personal-code");
        yield* connect(work, "work-before");
        const listed = yield* manageLocalVault(store, { action: "list" });
        const displayedAccount = listed.entries?.find((entry) => entry.name === name)?.gmailAccount;
        assert.equal(displayedAccount, priorAccount);
        assert.equal(
          listed.entries?.find((entry) => entry.name === personal.name)?.gmailAccount,
          personal.account,
        );
        assert.deepInclude(yield* readVaultRecord(store, name), login);
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
              typeof WS_METHODS.secretsAnswerRequest
            > => tag !== WS_METHODS.secretsAnswerRequest,
          ),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              group.toLayerHandler(WS_METHODS.secretsAnswerRequest, (input) =>
                broker.answer(input),
              ),
              RpcAuthorization.layer([AuthOrchestrationOperateScope, AuthProvidersManageScope]),
            ),
          ),
        );
        const answer = { type: "vault", name, fields: {} } as const;
        const denied = yield* broker.answer({ threadId, turnItemId, answer }).pipe(Effect.flip);
        assert.equal(denied.reason, "vault_access_denied");
        const approve = (account: string) =>
          client[WS_METHODS.secretsAnswerRequest]({
            threadId,
            turnItemId,
            answer: { type: "vault_gmail_display", name, account, pin: Redacted.make(pin) },
          });
        // Another client reconnects the same entry after the first client has rendered its mailbox.
        yield* connect(work, "work-code");
        assert.equal(http.mock.calls.length, 6); // Three code exchanges and three matching profiles.
        http.mockClear();
        const mismatch = yield* approve(displayedAccount!).pipe(Effect.flip);
        assert.deepInclude(mismatch, {
          _tag: "SecretRequestError",
          reason: "vault_gmail_approval",
        });
        assert.lengthOf(commands, 0);
        assert.lengthOf(http.mock.calls, 0);
        const answering = yield* approve(grant.account).pipe(Effect.forkChild);
        yield* Deferred.await(recorded);
        assert.deepInclude(yield* approve(grant.account).pipe(Effect.flip), {
          _tag: "SecretRequestError",
          reason: "already_answered",
        });
        const ref = Option.getOrThrow(yield* broker.savedRef({ threadId, turnItemId }));
        assert.lengthOf(commands, 1);
        assert.deepInclude(commands[0], {
          threadId,
          turnItemId,
          taggedVault: selected,
          secretStatus: "saved",
        });
        const read = { threadId, ref, operation };
        const wrongFolder = yield* broker
          .consumeGmail(
            { ...read, operation: { ...operation, folder: "inbox" } },
            Effect.succeed(true),
          )
          .pipe(Effect.flip);
        const generic = yield* broker
          .consume({ ref, projectId, targetUrl: login.origin })
          .pipe(Effect.flip);
        assert.lengthOf(http.mock.calls, 0);
        const mcpResult = yield* broker.consumeGmail(read, Effect.succeed(true));
        assert.deepEqual(mcpResult, { status: "displayed", count: 5 });
        const displayed = yield* Fiber.join(answering);
        assert.deepEqual(displayed, { messages: [5, 4, 3, 2, 1].map(summary) });
        const replay = yield* broker.consumeGmail(read, Effect.succeed(true)).pipe(Effect.flip);
        assert.lengthOf(http.mock.calls, 7); // One refresh, one list, five metadata reads; no replay.
        const visible = JSON.stringify({
          commands,
          mcpResult,
          errors: [denied, wrongFolder, generic, replay].map((e) => [e.message, e]),
        });
        for (const value of [
          password,
          pin,
          clientSecret,
          personal.clientSecret,
          personal.refreshToken,
          personal.account,
          grant.refreshToken,
          grant.account,
          accessToken,
          ref,
          ...Object.values(summary(5)),
        ]) {
          assert.notInclude(visible, value);
        }
        // An older client cannot silently switch the next approval to share mailbox rows with the agent.
        turnItemId = TurnItemId.make("turn-item:gmail-read:legacy");
        selected = yield* broker.resolveGmailEntry(title, operation);
        assert.deepEqual(selected, { name, gmail: operation });
        const legacy = yield* client[WS_METHODS.secretsAnswerRequest]({
          threadId,
          turnItemId,
          answer: { ...answer, pin: Redacted.make(pin) },
        }).pipe(Effect.flip);
        assert.deepInclude(legacy, { reason: "vault_access_denied" });
        assert.isTrue(Option.isNone(yield* broker.savedRef({ threadId, turnItemId })));
        assert.lengthOf(http.mock.calls, 7);
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ HYAKKI_GMAIL_REDIRECT_URI: redirectUri }),
          ),
        ),
        Effect.provideService(FetchHttpClient.Fetch, http),
        Effect.provide(
          Layer.merge(
            GmailOAuth.layer,
            SecretRequests.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  thread,
                  Layer.mock(SecretResolver.SecretResolver)({}),
                  Layer.succeed(ServerSecretStore.ServerSecretStore, store),
                ),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
