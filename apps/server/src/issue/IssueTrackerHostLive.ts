/**
 * The server's `IssueTrackerHost`: standalone tracker credentials out of the secret store, one
 * per tracker kind. The name is stable across releases so a saved key survives upgrades.
 *
 * @module issue/IssueTrackerHostLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { IssueTrackerKind } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/issue-tracker-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/issue-tracker-core/server/IssueTrackerHost";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export function issueTrackerSecretName(tracker: IssueTrackerKind): string {
  return `issue-tracker-${Buffer.from(tracker, "utf8").toString("base64url")}-token`;
}

const decoder = new TextDecoder();

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return IssueTrackerHost.IssueTrackerHost.of({
    credentials: {
      get: (tracker) =>
        secrets.get(issueTrackerSecretName(tracker)).pipe(
          Effect.map(Option.map((bytes) => decoder.decode(bytes))),
          Effect.mapError(
            (cause) =>
              new IssueTrackerError({
                tracker,
                operation: "readCredential",
                reason: "failed",
                detail: "The stored credential could not be read.",
                cause,
              }),
          ),
        ),
    },
  });
});

export const layer = Layer.effect(IssueTrackerHost.IssueTrackerHost, make);
