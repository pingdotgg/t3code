/**
 * The server's `IssueTrackerHost`: standalone tracker credentials out of the secret store, one
 * per account. Legacy default names stay stable so saved keys survive upgrades.
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

export function issueTrackerSecretName(tracker: IssueTrackerKind, connectionId?: string): string {
  const key = `issue-tracker-${Buffer.from(tracker, "utf8").toString("base64url")}`;
  return connectionId === undefined
    ? `${key}-token`
    : `${key}-${Buffer.from(connectionId, "utf8").toString("base64url")}-token`;
}

const decoder = new TextDecoder();

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return IssueTrackerHost.IssueTrackerHost.of({
    credentials: {
      get: (tracker, connectionId) =>
        Effect.flatMap(IssueTrackerHost.ConnectionId, (selected) =>
          secrets.get(issueTrackerSecretName(tracker, connectionId ?? selected)),
        ).pipe(
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
