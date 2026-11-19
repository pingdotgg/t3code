import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
const decoder = new TextDecoder();

const linear: StandaloneIssueTrackerApi = {
  kind: LINEAR,
  capabilities: {
    create: false,
    edit: false,
    comment: false,
    labels: false,
    assignees: false,
    reactions: false,
    templates: false,
    linkedPullRequests: false,
    events: false,
    search: false,
  },
  standalone: {
    tracker: LINEAR,
    displayName: "Linear",
    host: "linear.app",
    scopeNoun: "team",
    credential: { label: "Personal API key", helpUrl: null },
  },
  parseIssueUrl: () => null,
  probeCredential: (token) =>
    token.startsWith("bad")
      ? Effect.fail(
          new IssueTrackerError({
            tracker: LINEAR,
            operation: "viewer",
            reason: "unauthenticated",
            detail: "Linear refused the key.",
          }),
        )
      : Effect.succeed({
          account: `user-${token}`,
          workspace: `workspace-${token}`,
          scopes: [{ key: "ENG", name: "Engineering" }],
        }),
  getViewer: () => Effect.succeed("viewer"),
  listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
  getIssue: () => Effect.die("unused"),
  getComments: () => Effect.die("unused"),
};

function makeConnections() {
  const secrets = new Map<string, Uint8Array>();
  let random = 0;
  const layer = IssueTrackerConnections.layer.pipe(
    Layer.provideMerge(IssueTrackerBindings.layer),
    Layer.provide(
      Layer.mergeAll(
        SqlitePersistence.layerMemory,
        Layer.succeed(
          IssueTrackerRegistry.IssueTrackerRegistry,
          IssueTrackerRegistry.fromTrackers([linear]),
        ),
        Layer.succeed(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
            set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
            create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
            getOrCreateRandom: () => Effect.die("unused"),
            remove: (name) => Effect.sync(() => void secrets.delete(name)),
          }),
        ),
        Layer.succeed(
          SecureRandom.SecureRandom,
          SecureRandom.make((size) => new Uint8Array(size).fill(++random)),
        ),
      ),
    ),
  );
  const storedKeys = () =>
    Object.fromEntries([...secrets].map(([name, value]) => [name, decoder.decode(value)]));
  return { layer, storedKeys };
}

describe("IssueTrackerConnections", () => {
  it.effect("keeps a second account beside the first, each with its own key and bindings", () => {
    const { layer, storedKeys } = makeConnections();
    return Effect.gen(function* () {
      const connections = yield* IssueTrackerConnections.IssueTrackerConnections;
      yield* connections.connect({ tracker: LINEAR, token: "work" });
      const added = yield* connections.connect({
        tracker: LINEAR,
        token: "home",
        addAccount: true,
      });
      const accountId = added.accountId!;
      expect(added).toMatchObject({ account: "user-home", workspace: "workspace-home" });

      // The first account keeps the name it was saved under before accounts existed.
      expect(storedKeys()).toEqual({
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
      const listed = yield* connections.list;
      expect(listed.trackers.map((tracker) => [tracker.accountId, tracker.account])).toEqual([
        [undefined, "user-work"],
      ]);
      expect(listed.accounts?.map((tracker) => [tracker.accountId, tracker.account])).toEqual([
        [accountId, "user-home"],
      ]);
      // Older clients read `bindings` as the first account's, so the second one's are apart.
      expect(listed.bindings).toEqual({ work: { tracker: LINEAR, scope: "ENG" } });
      expect(listed.accountBindings).toEqual({
        home: { tracker: LINEAR, accountId, scope: "ENG" },
      });

      // Replacing the second account's key leaves the first alone, and a refused key saves nothing.
      yield* connections.connect({ tracker: LINEAR, accountId, token: "home-2" });
      const refused = yield* Effect.flip(
        connections.connect({ tracker: LINEAR, token: "bad", addAccount: true }),
      );
      expect(refused).toMatchObject({ reason: "rejected" });
      expect(Object.values(storedKeys()).sort()).toEqual(["home-2", "work"]);

      // Disconnecting one account unbinds only its projects and forgets it.
      yield* connections.connect({ tracker: LINEAR, accountId, token: null });
      const after = yield* connections.list;
      expect(after.accounts).toEqual([]);
      expect(after.bindings).toEqual({ work: { tracker: LINEAR, scope: "ENG" } });
      expect(after.accountBindings).toEqual({});
      expect(storedKeys()).toEqual({ "issue-tracker-bGluZWFy-token": "work" });
      const forgotten = yield* Effect.flip(
        connections.bindProject({
          projectId: "home" as ProjectId,
          binding: { tracker: LINEAR, accountId, scope: "ENG" },
        }),
      );
      expect(forgotten).toMatchObject({ detail: "This account is not saved on the server." });
    }).pipe(Effect.provide(layer));
  });
});
