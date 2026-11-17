/**
 * The server's `IssueTrackerHost`: standalone tracker credentials out of the secret store, one
 * per tracker kind. The name is stable across releases so a saved key survives upgrades.
 *
 * @module issue/IssueTrackerHostLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { IssueTrackerKind } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueTrackerCredential,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

export function issueTrackerSecretName(tracker: IssueTrackerKind): string {
  return `issue-tracker-${Buffer.from(tracker, "utf8").toString("base64url")}-token`;
}

const StoredCredential = Schema.fromJsonString(
  Schema.Struct({ token: Schema.String, fields: Schema.Record(Schema.String, Schema.String) }),
);
const decodeStored = Schema.decodeUnknownOption(StoredCredential);
const encodeStored = Schema.encodeSync(StoredCredential);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * A key alone is stored as itself, which is how Linear's was saved before trackers had fields;
 * one with fields is stored as JSON, which no API key reads as.
 */
export function encodeIssueTrackerCredential(credential: IssueTrackerCredential): Uint8Array {
  return encoder.encode(
    Object.keys(credential.fields).length === 0 ? credential.token : encodeStored(credential),
  );
}

export function decodeIssueTrackerCredential(bytes: Uint8Array): IssueTrackerCredential {
  const text = decoder.decode(bytes);
  return Option.getOrElse(decodeStored(text), () => ({ token: text, fields: {} }));
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return IssueTrackerHost.IssueTrackerHost.of({
    credentials: {
      get: (tracker) =>
        secrets.get(issueTrackerSecretName(tracker)).pipe(
          Effect.map(Option.map(decodeIssueTrackerCredential)),
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
