import * as Domain from "@alchemy.run/domain";
import { CallRejected, toCli } from "@alchemy.run/domain/Cli";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Command from "effect/cli/Command";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Headers from "effect/http/Headers";
import * as HttpEffect from "effect/http/HttpEffect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Terminal from "effect/Terminal";

// ---------------------------------------------------------------- a wallet domain

const WalletId = Schema.String.pipe(Schema.brand("WalletId"));

class Owner extends Domain.RequestContext<Owner>()("Test/Owner", Schema.String) {}
class Unauthenticated extends Domain.Rejection("Unauthenticated") {}
class Session extends RpcMiddleware.Service<Session, { provides: Owner }>()("Test/Session", {
  error: Unauthenticated,
}) {}
/** A bearer token names the owner. */
const SessionLive = Layer.succeed(Session, (effect, { headers }) =>
  Option.match(Headers.get(headers, "authorization"), {
    onNone: () => Effect.fail(new Unauthenticated()),
    onSome: (value) => Effect.provideService(effect, Owner, value.replace(/^Bearer /, "")),
  }),
);

class Deposited extends Domain.Event("Deposited", {
  amount: Schema.Int,
  balance: Schema.Int,
  note: Schema.optional(Schema.String),
}) {}
class OverLimit extends Domain.Rejection("OverLimit", { limit: Schema.Int }) {}

class Deposit extends Domain.Command("Deposit", {
  target: WalletId,
  input: {
    amount: Schema.Int.annotate({ description: "Cents to add" }),
    note: Schema.optional(Schema.String),
    method: Schema.optional(Schema.Literals(["cash", "card"])),
    express: Schema.optional(Schema.Boolean),
    tags: Schema.optional(Schema.Array(Schema.String)),
  },
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
        : [new Deposited({ amount: cmd.amount, balance: s.balance + cmd.amount, note: cmd.note })],
  },
  evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
  reply: { Deposit: (s) => ({ balance: s.balance }) },
  read: { middleware: [Session] },
}) {}

class Balance extends Domain.View("Balance", {
  from: [Wallet],
  key: Wallet,
  middleware: [Session],
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  evolve: { Deposited: (_, e) => ({ balance: e.balance }) },
}) {}

class Wallets extends Domain.Model("Wallets", { aggregates: [Wallet], views: [Balance] }) {}

class WalletApi extends Domain.Api("WalletApi", { model: Wallets, aggregates: ["Wallet"] }) {}

// ---------------------------------------------------------------- the CLI over HTTP

/** The CLI's environment, with no terminal: what a script or an agent runs it in. */
const CliEnvironment = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(120),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("unused")),
  ),
);

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  /** The exit code `runMain` gives the process for this run. */
  readonly code: number;
  readonly exit: Exit.Exit<void, unknown>;
}

/**
 * Serve the Api in process and run the CLI against it over the Api's HTTP
 * protocol: every call is encoded, sent as a request to the Api's `fetch`,
 * and decoded, as it is against a deployed Worker.
 */
const cliOver = Effect.gen(function* () {
  const server = yield* WalletApi;
  const handler = HttpEffect.toWebHandler(server.fetch as never);
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(new Request(input, init))) as typeof globalThis.fetch;
  return (
    cli: ReturnType<typeof toCli<typeof WalletApi>>,
    args: ReadonlyArray<string>,
    transport: typeof globalThis.fetch = fetch,
  ) =>
    Effect.gen(function* () {
      const stdout: Array<string> = [];
      const stderr: Array<string> = [];
      const console: Console.Console = {
        ...globalThis.console,
        log: (...line: ReadonlyArray<unknown>) => void stdout.push(line.join(" ")),
        error: (...line: ReadonlyArray<unknown>) => void stderr.push(line.join(" ")),
      };
      const exit = yield* Command.runWith(cli, { version: "1.0.0" })(args).pipe(
        Effect.provide(Domain.protocolHttp("http://wallet.test/")),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, transport),
        Effect.provide(CliEnvironment),
        Effect.provideService(Console.Console, console),
        Effect.exit,
      );
      let code = -1;
      Runtime.defaultTeardown(exit, (c) => (code = c));
      return { stdout: stdout.join("\n"), stderr: stderr.join("\n"), code, exit } satisfies Run;
    });
});

const WalletsLive = Layer.mergeAll(Wallets.layer(Layer.empty), SessionLive).pipe(
  Layer.provide(InMemory),
);
const hosted = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(WalletsLive)) as Effect.Effect<A, E>;

const asSam = toCli(WalletApi, {
  name: "wallet",
  headers: { authorization: "Bearer sam" },
});

const json = (text: string): unknown => JSON.parse(text);

// ---------------------------------------------------------------- tests

describe("Domain toCli", { tags: ["unit", "local"] }, () => {
  it.live("runs a command from flags and prints its receipt as JSON", () =>
    hosted(
      Effect.gen(function* () {
        const run = yield* cliOver;
        const deposit = yield* run(asSam, [
          "deposit",
          "--target",
          "w-1",
          "--amount",
          "40",
          "--note",
          "rent",
          "--method",
          "card",
        ]);
        expect(deposit.code).toBe(0);
        expect(deposit.stderr).toBe("");
        expect(json(deposit.stdout)).toEqual({
          reply: { balance: 40 },
          stream: "Wallet/w-1",
          version: 1,
        });

        // The write reached the domain: the aggregate and the view read it back.
        const wallets = yield* Wallet;
        expect((yield* wallets.state(Wallet.ref("w-1"))).balance).toBe(40);
        const get = yield* run(asSam, [
          "balance",
          "get",
          "--key",
          "w-1",
          "--at-least",
          JSON.stringify({ stream: "Wallet/w-1", version: 1 }),
        ]);
        expect(get.code).toBe(0);
        expect(json(get.stdout)).toEqual({ balance: 40 });
        const events = yield* run(asSam, ["balance", "list", "--key", "w-1", "--order", "desc"]);
        expect(json(events.stdout)).toMatchObject({
          entries: [{ event: { _tag: "Deposited", amount: 40, note: "rent" } }],
          cursor: null,
        });
      }),
    ),
  );

  it.live("exits non-zero with a typed rejection as JSON on stderr", () =>
    hosted(
      Effect.gen(function* () {
        const run = yield* cliOver;
        const refused = yield* run(asSam, ["deposit", "--target", "w-1", "--amount", "500"]);
        expect(refused.code).toBe(1);
        expect(refused.stdout).toBe("");
        expect(json(refused.stderr)).toEqual({ _tag: "OverLimit", limit: 100 });
        const failure = Exit.isFailure(refused.exit) ? refused.exit.cause : undefined;
        expect(String(failure)).toContain("CallRejected");

        // The middleware's error is typed too: no bearer, no session.
        const anonymous = yield* run(toCli(WalletApi, { name: "wallet" }), [
          "wallet",
          "get",
          "--key",
          "w-1",
        ]);
        expect(anonymous.code).toBe(1);
        expect(json(anonymous.stderr)).toEqual({ _tag: "Unauthenticated" });
      }),
    ),
  );

  it.live("checks input against the schema before it calls the Api", () =>
    hosted(
      Effect.gen(function* () {
        const run = yield* cliOver;
        const fraction = yield* run(asSam, ["deposit", "--target", "w-1", "--amount", "1.5"]);
        expect(fraction.code).toBe(1);
        expect(fraction.stdout).toBe("");
        expect(fraction.stderr).toContain("amount");
        const missing = yield* run(asSam, ["deposit", "--amount", "5"]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain("target");
        const wallets = yield* Wallet;
        expect((yield* wallets.state(Wallet.ref("w-1"))).balance).toBe(0);
      }),
    ),
  );

  it.live("fails as a usage error when the call does not reach the Api", () =>
    hosted(
      Effect.gen(function* () {
        const run = yield* cliOver;
        const offline = (() => Promise.reject(new TypeError("Unable to connect"))) as never;
        const lost = yield* run(asSam, ["wallet", "get", "--key", "w-1"], offline);
        expect(lost.code).toBe(1);
        expect(lost.stdout).toBe("");
        expect(lost.stderr).toContain("Wallet.get did not reach the Api");
      }),
    ),
  );

  it.live("takes the whole input as --json, and flags win over it", () =>
    hosted(
      Effect.gen(function* () {
        const run = yield* cliOver;
        const deposit = yield* run(asSam, [
          "deposit",
          "--json",
          JSON.stringify({ target: "w-2", amount: 7, tags: ["a", "b"] }),
          "--amount",
          "9",
          "--express",
        ]);
        expect(deposit.code).toBe(0);
        expect(json(deposit.stdout)).toMatchObject({ reply: { balance: 9 } });
        // `--json` alone carries the input fields, as the flags do.
        const fromJson = yield* run(asSam, [
          "deposit",
          "--json",
          JSON.stringify({ target: "w-4", amount: 4, note: "from json" }),
        ]);
        expect(fromJson.code).toBe(0);
        expect(json(fromJson.stdout)).toMatchObject({ reply: { balance: 4 } });
        // The call's own wire JSON, with its nested `input`, works too.
        const fromWire = yield* run(asSam, [
          "deposit",
          "--json",
          JSON.stringify({ target: "w-5", input: { amount: 6, note: "wire" } }),
        ]);
        expect(fromWire.code).toBe(0);
        expect(json(fromWire.stdout)).toMatchObject({ reply: { balance: 6 } });
        const bad = yield* run(asSam, ["deposit", "--json", "{not json"]);
        expect(bad.code).toBe(1);
        expect(bad.stderr).toContain("--json");
      }),
    ),
  );

  it.live("reads headers from an Effect on each run", () =>
    hosted(
      Effect.gen(function* () {
        const run = yield* cliOver;
        const fromEnv = toCli(WalletApi, {
          name: "wallet",
          headers: Effect.sync(() => ({ authorization: "Bearer kim" })),
        });
        const deposit = yield* run(fromEnv, ["deposit", "--target", "w-3", "--amount", "3"]);
        expect(deposit.code).toBe(0);
        const wallet = yield* run(fromEnv, ["wallet", "get", "--key", "w-3"]);
        expect(json(wallet.stdout)).toEqual({ balance: 3 });
      }),
    ),
  );

  it.live("lists what the Api serves and its request/response operations in --help", () =>
    hosted(
      Effect.gen(function* () {
        const run = yield* cliOver;
        const root = yield* run(asSam, ["--help"]);
        expect(root.code).toBe(0);
        // One subcommand per entry, in kebab-case, with what it is.
        expect(root.stdout).toMatch(/^\s+deposit\s+Send the Deposit command\.$/m);
        expect(root.stdout).toMatch(/^\s+wallet\s+Read the Wallet aggregate\.$/m);
        expect(root.stdout).toMatch(/^\s+balance\s+Read the Balance view\.$/m);

        const balance = yield* run(asSam, ["balance", "--help"]);
        expect(balance.stdout).toMatch(/^\s+get\s+Print the key's current state\.$/m);
        expect(balance.stdout).toMatch(/^\s+list\s+Print a page of the key's entries\.$/m);
        expect(balance.stdout).toMatch(
          /^\s+snapshot\s+Print the key's current state and the cursor it is valid at\.$/m,
        );
        // Live reads are streams: not commands of the CLI.
        expect(balance.stdout).not.toMatch(/\bwatch\b/);
        expect(balance.stdout).not.toMatch(/\bevents\b/);

        const deposit = yield* run(asSam, ["deposit", "--help"]);
        for (const flag of ["--target", "--amount", "--note", "--method", "--express", "--tags"]) {
          expect(deposit.stdout).toContain(flag);
        }
        expect(deposit.stdout).toContain("--command-id");
        expect(deposit.stdout).toContain("--json");
        expect(deposit.stdout).toContain("Cents to add");
      }),
    ),
  );

  it.live("a command whose input names a field target takes its input as --input JSON", () =>
    hosted(
      Effect.gen(function* () {
        class Rename extends Domain.Command("Rename", {
          target: WalletId,
          // `target` here is the input's own field, not the wallet.
          input: { target: Schema.String },
        }) {}
        class Names extends Domain.Aggregate("Names", {
          id: WalletId,
          state: Schema.Struct({}),
          initial: {},
          commands: [Rename],
          decide: { Rename: () => [] },
          evolve: {},
        }) {}
        class Renames extends Domain.Model("Renames", { aggregates: [Names] }) {}
        class RenameApi extends Domain.Api("RenameApi", { model: Renames }) {}
        const run = yield* cliOver;
        const help = yield* run(toCli(RenameApi, { name: "rename" }) as typeof asSam, [
          "rename",
          "--help",
        ]);
        expect(help.code).toBe(0);
        expect(help.stdout).toContain("--target");
        expect(help.stdout).toContain("--input");
      }),
    ),
  );

  it.live("an Api whose names clash on the command line fails with a DefinitionError", () =>
    hosted(
      Effect.gen(function* () {
        const run = yield* cliOver;
        /** The defect a run of the CLI dies with. */
        const defectOf = (cli: unknown) =>
          run(cli as typeof asSam, []).pipe(
            Effect.map(({ exit }) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
          );
        class Clash extends Domain.Command("deposit", {
          target: WalletId,
          events: [Deposited],
        }) {}
        class Clashing extends Domain.Aggregate("Clashing", {
          id: WalletId,
          state: Schema.Struct({}),
          initial: {},
          commands: [Clash],
          decide: { deposit: () => [] },
          evolve: { Deposited: (s) => s },
        }) {}
        class Clashes extends Domain.Model("Clashes", { aggregates: [Wallet, Clashing] }) {}
        class ClashApi extends Domain.Api("ClashApi", { model: Clashes, views: [] }) {}
        expect(yield* defectOf(toCli(ClashApi, { name: "clash" }))).toMatchObject({
          _tag: "DefinitionError",
          message: "ClashApi: `Deposit` and `deposit` are both the command deposit",
        });
        class Reserved extends Domain.Command("Reserved", {
          target: WalletId,
          input: { json: Schema.String },
        }) {}
        class Reserving extends Domain.Aggregate("Reserving", {
          id: WalletId,
          state: Schema.Struct({}),
          initial: {},
          commands: [Reserved],
          decide: { Reserved: () => [] },
          evolve: {},
        }) {}
        class Reserves extends Domain.Model("Reserves", { aggregates: [Reserving] }) {}
        class ReservedApi extends Domain.Api("ReservedApi", { model: Reserves }) {}
        expect(yield* defectOf(toCli(ReservedApi, { name: "reserved" }))).toMatchObject({
          _tag: "DefinitionError",
          message: expect.stringContaining("--json, which the CLI reserves"),
        });
      }),
    ),
  );

  it("is an Effect CLI command named after the binary", () => {
    expect(asSam.name).toBe("wallet");
    expect(toCli(WalletApi).name).toBe("wallet-api");
    expect(CallRejected).toBeDefined();
  });
});
