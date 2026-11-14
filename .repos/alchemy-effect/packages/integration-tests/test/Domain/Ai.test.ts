import * as Domain from "@alchemy.run/domain";
import * as DomainAi from "@alchemy.run/domain/Ai";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import { McpProtocol, McpServer, Tool } from "effect/ai";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Headers from "effect/http/Headers";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// ---------------------------------------------------------------- a wallet domain

const WalletId = Schema.String.pipe(Schema.brand("WalletId"));

class Owner extends Domain.RequestContext<Owner>()("Test/Owner", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class Session extends RpcMiddleware.Service<Session, { provides: Owner }>()("Test/Session", {
  error: Unauthenticated,
}) {}
/** The owner is the `x-owner` header; no header, no session. */
const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-owner"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (owner) => Effect.provideService(effect, Owner, owner),
  }),
);

class Deposited extends Domain.Event("Deposited", { amount: Schema.Int, balance: Schema.Int }) {}
class OverLimit extends Domain.Rejection("OverLimit", { limit: Schema.Int }) {}
class NotOwner extends Domain.Rejection("NotOwner") {}

class Deposit extends Domain.Command("Deposit", {
  target: WalletId,
  input: { amount: Schema.Int },
  middleware: [Session],
  events: [Deposited],
  rejects: [OverLimit],
  reply: { balance: Schema.Int },
}) {}

class Wallet extends Domain.Aggregate("Wallet", {
  id: WalletId,
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  commands: [Deposit],
  decide: {
    Deposit: (s, cmd) =>
      cmd.amount > 100
        ? new OverLimit({ limit: 100 })
        : [new Deposited({ amount: cmd.amount, balance: s.balance + cmd.amount })],
  },
  evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
  reply: { Deposit: (s) => ({ balance: s.balance }) },
}) {}

/** Only the wallet's owner may read its balance. */
class Balance extends Domain.View("Balance", {
  from: [Wallet],
  key: Wallet,
  middleware: [Session],
  rejects: [NotOwner],
  validate: Effect.fn(function* ({ key }) {
    if (`${yield* Owner}-wallet` !== key.id) return yield* new NotOwner();
  }),
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
}) {}

class Wallets extends Domain.Model("Wallets", { aggregates: [Wallet], views: [Balance] }) {}

class WalletApi extends Domain.Api("WalletApi", { model: Wallets }) {}

const WalletsLive = Layer.mergeAll(Wallets.layer(Layer.empty), SessionLive).pipe(
  Layer.provide(InMemory),
);

/** Who the agent acts for, in this test: the owner its calls carry. */
const ActingFor = Context.Reference<string | undefined>("Test/ActingFor", {
  defaultValue: () => undefined,
});

const walletTools = DomainAi.toToolkit(WalletApi, {
  headers: Effect.map(ActingFor, (owner): Headers.Input => (owner ? { "x-owner": owner } : {})),
});

/** Call a tool as a model would, with JSON, and get its final result. */
const call = (name: string, params: unknown, owner?: string) =>
  Effect.gen(function* () {
    const toolkit = yield* walletTools.toolkit;
    const results = yield* toolkit.handle(name, params as never);
    const last = yield* Stream.runLast(results).pipe(Effect.flatMap(Effect.fromOption));
    return { isFailure: last.isFailure, encoded: last.encodedResult as unknown };
  }).pipe(Effect.provideService(ActingFor, owner));

const ToolsLive = walletTools.layer.pipe(Layer.provideMerge(WalletsLive));

/** The session's client half, as a server that makes its own calls would hold it. */
const ServerCredential = RpcMiddleware.layerClient(Session, ({ request, next }) =>
  next({ ...request, headers: Headers.set(request.headers, "x-owner", "server") }),
);

// ---------------------------------------------------------------- tests

describe("Domain Ai: toToolkit", { tags: ["unit", "local"] }, () => {
  it("has one tool per call that returns once, with the Api's schemas", () => {
    const { toolkit } = DomainAi.toToolkit(WalletApi);
    expect(Object.keys(toolkit.tools)).toEqual([
      "WalletApi_Deposit_send",
      "WalletApi_Balance_get",
      "WalletApi_Balance_list",
      "WalletApi_Balance_snapshot",
    ]);
    /** The JSON Schema of the JSON a schema reads and writes on the wire. */
    const wire = (schema: Schema.Top) => Tool.getJsonSchemaFromSchema(Schema.toCodecJson(schema));
    const depositRpc = WalletApi.group.requests.get("Deposit") as Rpc.AnyWithProps;
    const getRpc = WalletApi.group.requests.get("Balance.get") as Rpc.AnyWithProps;
    const send = toolkit.tools.WalletApi_Deposit_send!;
    // The tool's parameters are the call's own wire payload.
    expect(Tool.getJsonSchema(send)).toEqual(wire(depositRpc.payloadSchema));
    expect(Tool.getJsonSchema(send)).toMatchObject({
      properties: { target: {}, commandId: {}, input: { properties: { amount: {} } } },
    });
    expect(Tool.getJsonSchemaFromSchema(send.successSchema)).toEqual(
      wire(depositRpc.successSchema),
    );
    // Its failure is the command's rejection and its middleware's error.
    const failure = JSON.stringify(Tool.getJsonSchemaFromSchema(send.failureSchema));
    for (const tag of ["OverLimit", "Unauthenticated"]) expect(failure).toContain(tag);
    expect(Tool.getDescription(send)).toBe("Send the Deposit command.");
    // A read is read-only; a command is a write.
    const get = toolkit.tools.WalletApi_Balance_get!;
    expect(Tool.getJsonSchema(get)).toEqual(wire(getRpc.payloadSchema));
    expect(Context.get(get.annotations, Tool.Readonly)).toBe(true);
    expect(Context.get(get.annotations, Tool.Destructive)).toBe(false);
    expect(Context.get(send.annotations, Tool.Readonly)).toBe(false);
    expect(Context.get(send.annotations, Tool.Destructive)).toBe(true);
    // `state | null` is not an object, so the tool returns it as `{ value }`.
    expect(Tool.getJsonSchemaFromSchema(get.successSchema)).toEqual({
      type: "object",
      properties: { value: wire(getRpc.successSchema) },
      required: ["value"],
      additionalProperties: true,
    });
  });

  it.live("a write tool sends the command and returns its receipt", () =>
    Effect.gen(function* () {
      const result = yield* call(
        "WalletApi_Deposit_send",
        { target: "sam-wallet", input: { amount: 30 } },
        "sam",
      );
      expect(result).toEqual({
        isFailure: false,
        encoded: { reply: { balance: 30 }, stream: "Wallet/sam-wallet", version: 1 },
      });
    }).pipe(Effect.provide(ToolsLive)),
  );

  it.live("a rejection comes back as the tool's typed failure", () =>
    Effect.gen(function* () {
      const result = yield* call(
        "WalletApi_Deposit_send",
        { target: "sam-wallet", input: { amount: 500 } },
        "sam",
      );
      expect(result).toEqual({ isFailure: true, encoded: { _tag: "OverLimit", limit: 100 } });
    }).pipe(Effect.provide(ToolsLive)),
  );

  it.live("the call runs the Api's middleware: no session, no command", () =>
    Effect.gen(function* () {
      const result = yield* call("WalletApi_Deposit_send", {
        target: "sam-wallet",
        input: { amount: 5 },
      });
      expect(result).toEqual({ isFailure: true, encoded: { _tag: "Unauthenticated" } });
      // Nothing was recorded.
      const balance = yield* call("WalletApi_Balance_get", { key: "sam-wallet" }, "sam");
      expect(balance.encoded).toEqual({ value: null });
    }).pipe(Effect.provide(ToolsLive)),
  );

  it.live("a middleware's client half never signs the agent in as the server", () =>
    Effect.gen(function* () {
      const result = yield* call("WalletApi_Deposit_send", {
        target: "server-wallet",
        input: { amount: 5 },
      });
      expect(result).toEqual({ isFailure: true, encoded: { _tag: "Unauthenticated" } });
    }).pipe(Effect.provide(ToolsLive.pipe(Layer.provide(ServerCredential)))),
  );

  it.live("a read tool runs the view's validate, and wraps a value that is not an object", () =>
    Effect.gen(function* () {
      const receipt = yield* call(
        "WalletApi_Deposit_send",
        { target: "sam-wallet", input: { amount: 7 } },
        "sam",
      );
      const atLeast = { stream: "Wallet/sam-wallet", version: 1 };
      expect(receipt.isFailure).toBe(false);
      expect(yield* call("WalletApi_Balance_get", { key: "sam-wallet", atLeast }, "sam")).toEqual({
        isFailure: false,
        encoded: { value: { balance: 7 } },
      });
      expect(yield* call("WalletApi_Balance_get", { key: "sam-wallet" }, "kim")).toEqual({
        isFailure: true,
        encoded: { _tag: "NotOwner" },
      });
    }).pipe(Effect.provide(ToolsLive)),
  );

  it.live("a tool name a model provider would refuse fails the Layer with a DefinitionError", () =>
    Effect.gen(function* () {
      class LongApi extends Domain.Api("A".repeat(60), { model: Wallets, views: [] }) {}
      const exit = yield* Layer.build(DomainAi.toToolkit(LongApi).layer).pipe(
        Effect.provide(WalletsLive),
        Effect.scoped,
        Effect.exit,
      );
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toMatchObject({
        _tag: "DefinitionError",
        message: `The tool name ${"A".repeat(60)}_Deposit_send is longer than 64 characters`,
      });
    }),
  );
});

// ---------------------------------------------------------------- MCP

/** An MCP client over the server's web handler, in process. */
const mcpClient = (handler: (request: Request) => Promise<Response>) => {
  let session: string | undefined;
  let id = 0;
  const post = Effect.fn(function* (body: object, headers: Record<string, string> = {}) {
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
            ...(session ? { "mcp-session-id": session } : {}),
            ...headers,
          },
          body: JSON.stringify({ jsonrpc: "2.0", ...body }),
        }),
      ),
    );
    session ??= response.headers.get("mcp-session-id") ?? undefined;
    const text = yield* Effect.promise(() => response.text());
    return text === "" ? undefined : (JSON.parse(text) as { result?: any; error?: any });
  });
  const request = (method: string, params: object, headers?: Record<string, string>) =>
    post({ id: ++id, method, params }, headers);
  const connect = Effect.gen(function* () {
    yield* request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    yield* post({ method: "notifications/initialized" });
  });
  return { connect, request };
};

describe("Domain Ai: toMcp", { tags: ["unit", "local"] }, () => {
  it.live("serves the tools over MCP; a call carries the request's headers to the Api", () =>
    Effect.gen(function* () {
      const { handler, dispose } = HttpRouter.toWebHandler(
        DomainAi.toMcp(WalletApi).pipe(
          Layer.provide(
            McpServer.layerHttp({
              name: "wallet",
              version: "1.0.0",
              path: "/mcp",
              protocols: [McpProtocol.v2025_11_25],
            }),
          ),
          Layer.provide(WalletsLive),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const mcp = mcpClient(handler);
      yield* mcp.connect;

      const listed = yield* mcp.request("tools/list", {});
      const tools = listed!.result.tools as ReadonlyArray<any>;
      expect(tools.map((tool) => tool.name)).toEqual([
        "WalletApi_Deposit_send",
        "WalletApi_Balance_get",
        "WalletApi_Balance_list",
        "WalletApi_Balance_snapshot",
      ]);
      const [send, get] = tools;
      expect(send.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect(get.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      // Every output is an object, as MCP clients require.
      expect(tools.every((tool) => tool.outputSchema.type === "object")).toBe(true);

      const deposit = {
        name: "WalletApi_Deposit_send",
        arguments: { target: "sam-wallet", input: { amount: 30 } },
      };
      const sent = yield* mcp.request("tools/call", deposit, { "x-owner": "sam" });
      expect(sent!.result.isError).toBe(false);
      expect(sent!.result.structuredContent).toEqual({
        reply: { balance: 30 },
        stream: "Wallet/sam-wallet",
        version: 1,
      });

      const anonymous = yield* mcp.request("tools/call", deposit);
      expect(anonymous!.result.isError).toBe(true);
      expect(JSON.parse(anonymous!.result.content[0].text)).toMatchObject({
        _tag: "Unauthenticated",
      });
    }).pipe(Effect.scoped),
  );

  it.live("serves a request-scoped MCP endpoint, as on a Worker", () =>
    Effect.gen(function* () {
      const { handler, dispose } = HttpRouter.toWebHandler(
        DomainAi.toMcp(WalletApi).pipe(
          Layer.provide(
            McpServer.layerHttpRequestScoped({
              name: "wallet",
              version: "1.0.0",
              path: "/mcp",
              protocols: [McpProtocol.v2026_07_28],
            }),
          ),
          Layer.provide(WalletsLive),
        ),
        { disableLogger: true },
      );
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      // A sessionless request carries its protocol and client in `_meta` and headers.
      const deposit = Effect.fn(function* (headers: Record<string, string>) {
        const response = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/mcp", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                "mcp-protocol-version": "2026-07-28",
                "mcp-method": "tools/call",
                "mcp-name": "WalletApi_Deposit_send",
                ...headers,
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  _meta: {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                  name: "WalletApi_Deposit_send",
                  arguments: { target: "sam-wallet", input: { amount: 3 } },
                },
              }),
            }),
          ),
        );
        const body = yield* Effect.promise(() => response.json());
        return (body as { result: any }).result;
      });
      const sent = yield* deposit({ "x-owner": "sam" });
      expect(sent.structuredContent).toEqual({
        reply: { balance: 3 },
        stream: "Wallet/sam-wallet",
        version: 1,
      });
      const anonymous = yield* deposit({});
      expect(anonymous.isError).toBe(true);
      expect(JSON.parse(anonymous.content[0].text)).toEqual({ _tag: "Unauthenticated" });
    }).pipe(Effect.scoped),
  );
});
