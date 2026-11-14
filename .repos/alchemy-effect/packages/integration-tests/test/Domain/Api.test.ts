import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

class Deposited extends Domain.Event("Deposited", { amount: Schema.Number }) {}
class Withdrawn extends Domain.Event("Withdrawn", { amount: Schema.Number }) {}
class Closed extends Domain.Event("Closed") {}

class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
  balance: Schema.Number,
  requested: Schema.Number,
}) {}
class AccountClosed extends Domain.Rejection("AccountClosed") {}

class Deposit extends Domain.Command("Deposit", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Deposited],
  rejects: [AccountClosed],
}) {}
class Withdraw extends Domain.Command("Withdraw", {
  target: Schema.String,
  input: { amount: Schema.Number },
  events: [Withdrawn],
  rejects: [InsufficientFunds, AccountClosed],
}) {}
class Close extends Domain.Command("Close", { target: Schema.String, events: [Closed] }) {}

class Account extends Domain.Aggregate("Account", {
  id: Schema.String,
  state: Schema.Struct({ balance: Schema.Number, closed: Schema.Boolean }),
  initial: { balance: 0, closed: false },
  commands: [Deposit, Withdraw, Close],
  decide: {
    Deposit: (s, { amount }) => (s.closed ? new AccountClosed() : [new Deposited({ amount })]),
    Withdraw: (s, { amount }) =>
      s.closed
        ? new AccountClosed()
        : amount > s.balance
          ? new InsufficientFunds({ balance: s.balance, requested: amount })
          : [new Withdrawn({ amount })],
    Close: (s) => (s.closed ? [] : [new Closed()]),
  },
  evolve: {
    Deposited: (s, e) => ({ ...s, balance: s.balance + e.amount }),
    Withdrawn: (s, e) => ({ ...s, balance: s.balance - e.amount }),
    Closed: (s) => ({ ...s, closed: true }),
  },
  read: {},
}) {}

class Bank extends Domain.Model("Bank", { aggregates: [Account] }) {}

class BankApi extends Domain.Api("BankApi", {
  model: Bank,
  commands: ["Deposit", "Withdraw"],
  aggregates: ["Account"],
}) {}
class CloseApi extends Domain.Api("CloseApi", {
  model: Bank,
  commands: ["Close"],
  aggregates: ["Account"],
}) {}

/** A helper written once for every Api: the tags of its commands. */
const tagsOf = <A extends Domain.Api.Any>(api: A): ReadonlyArray<Domain.Api.CommandsOf<A>["tag"]> =>
  api.commands.map((command) => command.tag);

describe("Domain Api", { tags: ["unit", "local"] }, () => {
  it.effect("a concrete Api is an Api.Any", () =>
    Effect.sync(() => {
      const any: Domain.Api.Any = BankApi;
      const tags: ReadonlyArray<"Deposit" | "Withdraw"> = tagsOf(BankApi);
      expect(any.apiName).toBe("BankApi");
      expect(tags).toEqual(["Deposit", "Withdraw"]);
    }),
  );

  it.effect("commands are the command classes, in the order the Api lists them", () =>
    Effect.sync(() => {
      expect(BankApi.commands).toEqual([Deposit, Withdraw]);
      expect(CloseApi.commands).toEqual([Close]);
    }),
  );

  it.effect("rejections decodes every declared rejection to its class", () =>
    Effect.sync(() => {
      const Rejection = BankApi.rejections;
      const decoded = Schema.decodeUnknownSync(Rejection)({
        _tag: "InsufficientFunds",
        balance: 1,
        requested: 5,
      });
      const typed: InsufficientFunds | AccountClosed = decoded;
      // @ts-expect-error a union member is not one rejection
      const narrow: InsufficientFunds = decoded;
      expect(narrow).toBe(typed);
      expect(decoded).toBeInstanceOf(InsufficientFunds);
      expect(decoded).toMatchObject({ balance: 1, requested: 5 });
      expect(Schema.decodeUnknownSync(Rejection)({ _tag: "AccountClosed" })).toBeInstanceOf(
        AccountClosed,
      );
      // AccountClosed is declared by two commands, and is in the union once.
      expect((Rejection as unknown as Schema.Union<ReadonlyArray<Schema.Top>>).members).toEqual([
        AccountClosed,
        InsufficientFunds,
      ]);
      expect(() => Schema.decodeUnknownSync(Rejection)({ _tag: "Closed" })).toThrow();
    }),
  );

  it.effect("an Api whose commands never reject has Schema.Never rejections", () =>
    Effect.sync(() => {
      const Rejection: typeof Schema.Never = CloseApi.rejections;
      expect(Rejection).toBe(Schema.Never);
    }),
  );

  it.live("a rejection from the client is a member of the schema", () =>
    Effect.gen(function* () {
      const bank: Domain.Api.ClientOf<typeof BankApi> = yield* BankApi.Client;
      const isRejection = Schema.is(BankApi.rejections);
      const refused = yield* bank.Withdraw("a-1", { amount: 5 }).pipe(Effect.flip);
      expect(isRejection(refused)).toBe(true);
      expect(refused).toBeInstanceOf(InsufficientFunds);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        BankApi.layerClientInProcess.pipe(
          Layer.provide(Bank.layer(Layer.empty).pipe(Layer.provide(InMemory))),
        ),
      ),
    ),
  );

  it.effect("an Api serves everything of a kind it does not list", () =>
    Effect.sync(() => {
      class Everything extends Domain.Api("Everything", { model: Bank }) {}
      expect(Bank.commands).toEqual([Deposit, Withdraw, Close]);
      expect(Everything.commands).toEqual([Deposit, Withdraw, Close]);
      expect(Everything.serves).toEqual([Deposit, Withdraw, Close, Account]);
    }),
  );

  it.effect("by default an Api serves only the aggregates that declare read", () =>
    Effect.sync(() => {
      // Vault declares no `read`, so the Api serves its commands and not its state.
      class VaultsApi extends Domain.Api("VaultsApi", { model: Vaults }) {}
      expect(VaultsApi.serves).toEqual([Store]);
    }),
  );

  it.effect("naming an aggregate without read is a type error", () =>
    Effect.sync(() => {
      // @ts-expect-error Vault declares no `read`, so it is not a name `aggregates` takes.
      Domain.Api("VaultReads", { model: Vaults, aggregates: ["Vault"] });
      // Account declares one.
      Domain.Api("AccountReads", { model: Bank, aggregates: ["Account"] });
    }),
  );

  it.effect("an Api serves none of a kind it lists as empty", () =>
    Effect.sync(() => {
      class Reads extends Domain.Api("Reads", {
        model: Bank,
        commands: [],
        aggregates: ["Account"],
      }) {}
      expect(Reads.commands).toEqual([]);
      expect(Reads.serves).toEqual([Account]);
    }),
  );

  it.effect("naming something its model does not hold is a type error", () =>
    Effect.sync(() => {
      class Vaulted extends Domain.Model("Vaulted", { aggregates: [Vault] }) {}
      // @ts-expect-error Deposit is not a command of the Vaulted model
      const api = Domain.Api("Wrong", { model: Vaulted, commands: ["Deposit"] });
      expect(api.serves).toEqual([]);
      // @ts-expect-error Account is an aggregate, not a command
      Domain.Api("Mixed", { model: Bank, commands: ["Account"] });
    }),
  );

  it.live("naming something its model does not hold dies with a DefinitionError", () =>
    Effect.gen(function* () {
      // Typed as any model, so only serving it can tell.
      const model: Domain.Model.Any = Vaults;
      class LooseApi extends Domain.Api("LooseApi", { model, commands: ["Deposit"] }) {}
      const exit = yield* LooseApi.clientInProcess.pipe(Effect.scoped, Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag !== "Failure") return;
      expect(Cause.squash(exit.cause)).toMatchObject({
        _tag: "DefinitionError",
        message: "Deposit is not part of the Vaults model",
      });
    }).pipe(Effect.provide(Bank.layer(Layer.empty).pipe(Layer.provide(InMemory)))),
  );
});

// ---------------------------------------------------------------- rejections

/** A plain Effect tagged error, and a Domain shorthand with Effect's annotations. */
class Frozen extends Schema.TaggedError<Frozen>()("Frozen", { until: Schema.String }) {}
class NotOwner extends Domain.Rejection(
  "NotOwner",
  {},
  { httpApiStatus: 403, description: "Only the vault's owner may do this." },
) {}

class Stored extends Domain.Event("Stored", { item: Schema.String }) {}
class Store extends Domain.Command("Store", {
  target: Schema.String,
  input: { item: Schema.String },
  events: [Stored],
  // Any tagged error class can be a rejection, Effect's own HttpApiError included.
  rejects: [Frozen, NotOwner, HttpApiError.Forbidden],
}) {}
class Vault extends Domain.Aggregate("Vault", {
  id: Schema.String,
  state: Schema.Struct({ items: Schema.Array(Schema.String) }),
  initial: { items: [] },
  commands: [Store],
  decide: {
    Store: (_, { item }) =>
      item === "ice"
        ? new Frozen({ until: "spring" })
        : item === "gold"
          ? new HttpApiError.Forbidden()
          : item === "keys"
            ? new NotOwner()
            : [new Stored({ item })],
  },
  evolve: { Stored: (s, e) => ({ items: [...s.items, e.item] }) },
}) {}
class Vaults extends Domain.Model("Vaults", { aggregates: [Vault] }) {}
class VaultApi extends Domain.Api("VaultApi", { model: Vaults, commands: ["Store"] }) {}
// Vault declares no `read`, so its state is not for clients: naming it is a
// type error, and serving it anyway dies.
// @ts-expect-error Vault declares no `read`, so it is not a name `aggregates` takes.
class VaultStateApi extends Domain.Api("VaultStateApi", { model: Vaults, aggregates: ["Vault"] }) {}

describe("Domain Rejection", { tags: ["unit", "local"] }, () => {
  it.live("a command rejects with any tagged error class, and the client gets it typed", () =>
    Effect.gen(function* () {
      const vaults = yield* VaultApi.clientInProcess;
      const frozen = yield* vaults.Store("v-1", { item: "ice" }).pipe(Effect.flip);
      expect(frozen).toBeInstanceOf(Frozen);
      expect(frozen).toMatchObject({ until: "spring" });
      const forbidden = yield* vaults.Store("v-1", { item: "gold" }).pipe(Effect.flip);
      expect(forbidden).toBeInstanceOf(HttpApiError.Forbidden);
      expect((yield* vaults.Store("v-1", { item: "keys" }).pipe(Effect.flip))._tag).toBe(
        "NotOwner",
      );
      const { reply } = yield* vaults.Store("v-1", { item: "coat" });
      expect(reply).toBeUndefined();
      // The Api's rejections decode every one of them.
      expect(Schema.decodeUnknownSync(VaultApi.rejections)({ _tag: "Forbidden" })).toBeInstanceOf(
        HttpApiError.Forbidden,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(Vaults.layer(Layer.empty).pipe(Layer.provideMerge(InMemory))),
    ),
  );

  it.effect(
    "a Domain.Rejection takes Schema.TaggedError's annotations, read as Effect reads them",
    () =>
      Effect.sync(() => {
        // An Effect HttpApi endpoint that declares the rejection gives it its status and description.
        const api = HttpApi.make("Vaults").add(
          HttpApiGroup.make("vaults").add(
            HttpApiEndpoint.post("store", "/store", { error: [NotOwner, Frozen] }),
          ),
        );
        const responses = OpenApi.fromApi(api).paths["/store"]!.post!.responses;
        expect(Object.keys(responses).sort()).toEqual(["204", "403", "500"]);
        expect(responses["403"]!.description).toBe("Only the vault's owner may do this.");
      }),
  );
});

// ---------------------------------------------------------------- calling in process

// ---------------------------------------------------------------- a notes domain

/** Who sent the request. The middleware provides it; `decide` and `validate` read it. */
class Author extends Domain.RequestContext<Author>()("Test/Author", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class NotYours extends Domain.Rejection("NotYours") {}

/** Authenticates every call from an `x-author` header. */
class AuthorSession extends RpcMiddleware.Service<AuthorSession, { provides: Author }>()(
  "Test/AuthorSession",
  { error: Unauthenticated },
) {}
const AuthorSessionLive = Layer.succeed(AuthorSession, (effect, { headers }) =>
  Option.match(Headers.get(headers, "x-author"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (name) => Effect.provideService(effect, Author, name),
  }),
);
/** Code that already knows who the caller is: provide it without checking a header. */
const trustedAuthor = (name: string) =>
  Layer.succeed(AuthorSession, (effect) => Effect.provideService(effect, Author, name));

class Written extends Domain.Event("Written", { text: Schema.String, by: Schema.String }) {}
class Write extends Domain.Command("Write", {
  target: Schema.String,
  middleware: [AuthorSession],
  input: { text: Schema.String },
  events: [Written],
  reply: { by: Schema.String },
}) {}
class Note extends Domain.Aggregate("Note", {
  id: Schema.String,
  state: Schema.Struct({ text: Schema.String, by: Schema.NullOr(Schema.String) }),
  initial: { text: "", by: null },
  commands: [Write],
  decide: {
    Write: Effect.fn(function* (_, cmd) {
      return [new Written({ text: cmd.text, by: yield* Author })];
    }),
  },
  evolve: { Written: (_, e) => ({ text: e.text, by: e.by }) },
  reply: { Write: (s) => ({ by: s.by ?? "" }) },
  read: {
    middleware: [AuthorSession],
    rejects: [NotYours],
    validate: Effect.fn(function* (_request, s) {
      if (s.by !== null && s.by !== (yield* Author)) return yield* new NotYours();
    }),
  },
}) {}

class Notes extends Domain.Model("Notes", { aggregates: [Note] }) {}
class NotesApi extends Domain.Api("NotesApi", {
  model: Notes,
  commands: ["Write"],
  aggregates: ["Note"],
}) {}

const World = Notes.layer(Layer.empty).pipe(Layer.provideMerge(InMemory));

describe("Domain Api in process", { tags: ["unit", "local"] }, () => {
  it.live("clientInProcess calls an Api in process, through every entry's middleware", () =>
    Effect.gen(function* () {
      const notes = yield* NotesApi.clientInProcess;
      const asSam = { headers: { "x-author": "sam" } };

      const refused = yield* notes.Write("n-1", { text: "hi" }).pipe(Effect.flip);
      expect(refused._tag).toBe("Unauthenticated");

      const { reply } = yield* notes.Write("n-1", { text: "hi" }, asSam);
      expect(reply).toEqual({ by: "sam" });
      expect(yield* notes.Note.get("n-1", asSam)).toEqual({ text: "hi", by: "sam" });

      const notYours = yield* notes.Note.get("n-1", { headers: { "x-author": "kim" } }).pipe(
        Effect.flip,
      );
      expect(notYours._tag).toBe("NotYours");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(World, AuthorSessionLive))),
  );

  it.live("a trusted caller provides its principal with its own middleware Layer", () =>
    Effect.gen(function* () {
      // The served Api keeps checking headers; only this client trusts its caller.
      const asKim = yield* NotesApi.clientInProcess.pipe(Effect.provide(trustedAuthor("kim")));
      const { reply } = yield* asKim.Write("n-2", { text: "from a webhook" });
      expect(reply).toEqual({ by: "kim" });

      const anonymous = yield* NotesApi.clientInProcess;
      const refused = yield* anonymous.Note.get("n-2").pipe(Effect.flip);
      expect(refused._tag).toBe("Unauthenticated");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(World, AuthorSessionLive))),
  );

  it.live("layerClientInProcess provides the Api's Client in process", () => {
    // Written against `NotesApi.Client`, so it runs remotely (layerClient) or in process (layerClientInProcess).
    const writeAs = Effect.fn(function* (author: string) {
      const notes = yield* NotesApi.Client;
      return yield* notes.Write(
        "n-3",
        { text: "shared code" },
        { headers: { "x-author": author } },
      );
    });
    return writeAs("sam").pipe(
      Effect.map(({ reply }) => expect(reply).toEqual({ by: "sam" })),
      Effect.provide(
        NotesApi.layerClientInProcess.pipe(
          Layer.provideMerge(Layer.mergeAll(World, AuthorSessionLive)),
        ),
      ),
    );
  });

  it.live("client runs over Domain.protocolInProcess", () =>
    Effect.gen(function* () {
      const notes = yield* NotesApi.client;
      const asSam = { headers: { "x-author": "sam" } };
      const { reply } = yield* notes.Write("n-4", { text: "over a protocol" }, asSam);
      expect(reply).toEqual({ by: "sam" });
      expect(yield* notes.Note.get("n-4", asSam)).toEqual({ text: "over a protocol", by: "sam" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Domain.protocolInProcess(NotesApi).pipe(
          Layer.provideMerge(Layer.mergeAll(World, AuthorSessionLive)),
        ),
      ),
    ),
  );
});

describe("Domain Api exposing an aggregate", () => {
  it.live("an aggregate without a read contract is never served", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(VaultStateApi.clientInProcess);
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toMatchObject({
        _tag: "DefinitionError",
        reason: { _tag: "Unreadable", aggregate: "Vault" },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Vaults.layer(Layer.empty).pipe(Layer.provideMerge(InMemory))),
    ),
  );
});
