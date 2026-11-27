import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import { IssueTrackerKind, type ProjectId } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IssueTrackerConnections from "./IssueTrackerConnections.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const LINEAR = IssueTrackerKind.make("linear");

describe("IssueTrackerConnections", () => {
  it.effect("keeps each account's key and bindings apart, and no key past its account", () => {
    const secrets = new Map<string, string>();
    const probing = Deferred.makeUnsafe<void>();
    const released = Deferred.makeUnsafe<void>();
    let random = 0;
    const tracker = {
      kind: LINEAR,
      standalone: { tracker: LINEAR, host: "linear.app" },
      probeCredential: (token: string) =>
        token === "bad"
          ? Effect.fail(
              new IssueTrackerError({
                tracker: LINEAR,
                operation: "viewer",
                reason: "unauthenticated",
                detail: "Linear refused the key.",
              }),
            )
          : Effect.as(
              token === "slow"
                ? Effect.andThen(Deferred.succeed(probing, undefined), Deferred.await(released))
                : Effect.void,
              { account: `user-${token}`, scopes: [] },
            ),
    } as unknown as StandaloneIssueTrackerApi;
    const layer = IssueTrackerConnections.layer.pipe(
      Layer.provideMerge(IssueTrackerBindings.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          SqlitePersistence.layerMemory,
          Layer.succeed(
            IssueTrackerRegistry.IssueTrackerRegistry,
            IssueTrackerRegistry.fromTrackers([tracker]),
          ),
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: (name) =>
              Effect.succeed(
                Option.map(Option.fromNullishOr(secrets.get(name)), (value) =>
                  new TextEncoder().encode(value),
                ),
              ),
            set: (name, value) =>
              Effect.sync(() => void secrets.set(name, new TextDecoder().decode(value))),
            remove: (name) => Effect.sync(() => void secrets.delete(name)),
          }),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(++random)),
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const connections = yield* IssueTrackerConnections.IssueTrackerConnections;
      yield* connections.connect({ tracker: LINEAR, token: "work" });
      const { accountId } = yield* connections.connect({
        tracker: LINEAR,
        token: "home",
        addAccount: true,
      });

      // The first account keeps the name it was saved under before accounts existed.
      expect(Object.fromEntries(secrets)).toEqual({
        "issue-tracker-bGluZWFy-token": "work",
        [`issue-tracker-bGluZWFy-account-${accountId}-token`]: "home",
      });
      yield* connections.bindProject({
        projectId: "work" as ProjectId,
        binding: { tracker: LINEAR, scope: "ENG" },
      });
      yield* connections.bindProject({
        projectId: "home" as ProjectId,
        binding: { tracker: LINEAR, accountId, scope: "ENG" },
      });
      // Older clients read `bindings` as the first account's, so the second one's are apart.
      expect(yield* connections.list).toMatchObject({
        accounts: [{ accountId, account: "user-home" }],
        bindings: { work: { tracker: LINEAR, scope: "ENG" } },
        accountBindings: { home: { tracker: LINEAR, accountId, scope: "ENG" } },
      });
      // An older client offers the added account's project as unbound; its unbind leaves it.
      yield* connections.bindProject({ projectId: "home" as ProjectId, binding: null });
      expect((yield* connections.list).accountBindings).toHaveProperty("home");
      yield* Effect.flip(connections.connect({ tracker: LINEAR, token: "bad", addAccount: true }));
      expect(
        yield* Effect.flip(
          connections.connect({ tracker: LINEAR, token: "home", addAccount: true }),
        ),
      ).toMatchObject({ detail: "This credential is already connected as another account." });
      expect(secrets.size).toBe(2);

      // A removal does not wait on a replacement key's probe, and the replacement then finds its
      // account gone instead of storing a key for it.
      const replacing = yield* connections
        .connect({ tracker: LINEAR, accountId, token: "slow" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(probing);
      yield* connections.connect({ tracker: LINEAR, accountId, token: null });
      yield* Deferred.succeed(released, undefined);
      expect(yield* Effect.flip(Fiber.join(replacing))).toMatchObject({
        detail: "This account is not saved on the server.",
      });
      expect([...secrets.keys()]).toEqual(["issue-tracker-bGluZWFy-token"]);
      const after = yield* connections.list;
      expect([after.accounts, after.accountBindings]).toEqual([[], {}]);
      expect(
        yield* Effect.flip(
          connections.bindProject({
            projectId: "home" as ProjectId,
            binding: { tracker: LINEAR, accountId, scope: "ENG" },
          }),
        ),
      ).toMatchObject({ detail: "This account is not saved on the server." });

      // An account that cannot be saved takes its new key with it.
      yield* (yield* SqlClient.SqlClient)`DROP TABLE issue_tracker_accounts`;
      yield* Effect.flip(connections.connect({ tracker: LINEAR, token: "home", addAccount: true }));
      expect(secrets.size).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});
