import * as Domain from "@alchemy.run/domain";
import { customer } from "@bank/domain/Actor";
import { Bank, BankHandlers } from "@bank/domain/Bank.model";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { CustomerDashboard } from "@bank/domain/Customer/CustomerDashboard.view";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { MemoryLedgerStore } from "@bank/domain/Ledger/LedgerStore";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpServer from "effect/http/HttpServer";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { SiftFraudCheck } from "../src/Fraud/SiftFraudCheck.ts";
import { MfaChallengeLive } from "../src/MfaChallenge.ts";
import { SessionLive } from "../src/Session.ts";
import { StripePayments } from "../src/Settlement/StripePayments.ts";
import { register } from "./flows.ts";
import { SessionKeyTest, signedInAs } from "./session.ts";

// The Worker's HTTP surface (`yield* CustomerApi`, its `fetch`) on a real HTTP server, over the in-memory platform.
const Ports = Layer.mergeAll(SiftFraudCheck, StripePayments, MemoryLedgerStore);
const World = Layer.mergeAll(SessionLive, MfaChallengeLive).pipe(
  Layer.provideMerge(
    Bank.layer(BankHandlers).pipe(Layer.provide(Layer.mergeAll(Ports, Domain.InMemory))),
  ),
  Layer.provideMerge(SessionKeyTest),
);

// A test server on a random port, plus an HttpClient pointed at it.
const Served = Layer.unwrap(Effect.map(CustomerApi, (api) => HttpServer.serve()(api.fetch))).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(World),
);

// The test server serves the Api at its root; its HttpClient already targets the server.
const Client = Layer.mergeAll(Domain.protocolHttp(""), signedInAs(customer("c-1"))).pipe(
  Layer.provide(SessionKeyTest),
);

it.live("the CustomerApi round-trips over HTTP, including a streamed watch", () =>
  Effect.gen(function* () {
    const sam = yield* CustomerApi.client;
    const accountId = yield* register(sam, "c-1", "sam");
    yield* sam.DepositMoney(accountId, { amount: 70 });
    const dashboard = yield* sam.CustomerDashboard.watch(CustomerId.make("c-1")).pipe(
      Stream.map(({ state }) => state),
      Stream.filter((d) => d !== null && CustomerDashboard.computed.totalBalance(d) === 70),
      Stream.runHead,
    );
    expect(accountId as string).toBe("c-1-main");
    expect(Option.getOrThrow(dashboard)).toMatchObject({ name: "sam" });
  }).pipe(Effect.provide(Client.pipe(Layer.provideMerge(Served))), Effect.scoped),
);
