import { AccountId } from "@bank/domain/Account/Account.id";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as RpcClientError from "effect/rpc/RpcClientError";
import { Deliver } from "../src/Bank.ts";
import { Client } from "./Domain.ts";

const accountId = AccountId.make("c-1-main");
it.live("retries only the unknown intent with its original id and queues the rest", () =>
  Effect.gen(function* () {
    const client = yield* CustomerApi.Client;
    const ids: Array<string | undefined> = [];
    const result = yield* Deliver({
      accountId,
      intents: [
        { commandId: "page:0", kind: "deposit", amount: 100 },
        { commandId: "page:1", kind: "deposit", amount: 200 },
      ],
    }).effect.pipe(
      Effect.provideService(CustomerApi.Client, {
        ...client,
        // The server applies each send; every reply is lost on the way back.
        DepositMoney: (target, input, options) =>
          Effect.suspend(() => {
            ids.push(options?.commandId);
            return client.DepositMoney(target, input, options);
          }).pipe(
            Effect.exit,
            Effect.andThen(
              Effect.fail(
                RpcClientError.RpcClientError.make({
                  reason: RpcClientError.RpcClientDefect.make({
                    cause: "lost reply",
                    message: "lost reply",
                  }),
                }),
              ),
            ),
          ),
      }),
    );
    expect(ids).toEqual(["page:0", "page:0", "page:0", "page:0"]);
    expect(result.outcomes).toEqual([
      { commandId: "page:0", result: "Queued", reason: Option.none() },
      { commandId: "page:1", result: "Queued", reason: Option.none() },
    ]);
  }).pipe(Effect.provide(Client)),
);

it.live("does not retry middleware denial and sends later intents", () =>
  Effect.gen(function* () {
    const result = yield* Deliver({
      accountId,
      intents: [
        { commandId: "page:0", kind: "withdrawal", amount: 100 },
        { commandId: "page:1", kind: "deposit", amount: 200 },
      ],
    }).effect;
    expect(result.outcomes).toEqual([
      { commandId: "page:0", result: "Denied", reason: Option.some("MfaRequired") },
      { commandId: "page:1", result: "Rejected", reason: Option.some("NotOpen") },
    ]);
  }).pipe(Effect.provide(Client)),
);
