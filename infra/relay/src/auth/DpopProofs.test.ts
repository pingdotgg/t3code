import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { RelayDb, type RelayDatabase } from "../db.ts";
import { relayDpopProofs } from "../persistence/schema.ts";
import * as DpopProofs from "./DpopProofs.ts";

describe("DpopProofReplay", () => {
  it.effect("consumes proof ids without pruning expired rows on the request path", () => {
    const calls: Array<string> = [];
    const insertedValues: Array<{
      readonly thumbprint: string;
      readonly jti: string;
      readonly iat: number;
      readonly expiresAt: string;
      readonly createdAt: string;
    }> = [];
    const fakeDb = {
      insert: (table: unknown) => {
        expect(table).toBe(relayDpopProofs);
        calls.push("insert");
        return {
          values: (values: (typeof insertedValues)[number]) => {
            insertedValues.push(values);
            calls.push("insert.values");
            return {
              onConflictDoNothing: () => {
                calls.push("insert.onConflictDoNothing");
                return {
                  returning: (selection: unknown) => {
                    expect(selection).toBeDefined();
                    calls.push("insert.returning");
                    return Effect.succeed([{ jti: values.jti }]);
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as RelayDatabase;

    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      const consumed = yield* replay.consume({
        thumbprint: "thumbprint",
        jti: "jti",
        iat: 1_771_000_000,
        expiresAt: Option.getOrThrow(DateTime.make("2026-05-25T12:00:00.000Z")),
      });

      expect(consumed).toBe(true);
      expect(calls).toEqual([
        "insert",
        "insert.values",
        "insert.onConflictDoNothing",
        "insert.returning",
      ]);
      expect(insertedValues).toMatchObject([
        {
          thumbprint: "thumbprint",
          jti: "jti",
          iat: 1_771_000_000,
          expiresAt: "2026-05-25T12:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(DpopProofs.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))));
  });

  it.effect("prunes expired proof rows from the maintenance path", () => {
    const calls: Array<string> = [];
    const fakeDb = {
      delete: (table: unknown) => {
        expect(table).toBe(relayDpopProofs);
        calls.push("delete");
        return {
          where: (condition: unknown) => {
            expect(condition).toBeDefined();
            calls.push("delete.where");
            return Effect.void;
          },
        };
      },
    } as unknown as RelayDatabase;

    return Effect.gen(function* () {
      const replay = yield* DpopProofs.DpopProofReplay;
      yield* replay.pruneExpired;
      expect(calls).toEqual(["delete", "delete.where"]);
    }).pipe(Effect.provide(DpopProofs.layer.pipe(Layer.provide(Layer.succeed(RelayDb, fakeDb)))));
  });
});
