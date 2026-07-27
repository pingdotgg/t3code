import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { Self } from "../../Self.ts";
import { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { PermissionGroupRef } from "../ApiToken/Common.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import type { Queue } from "./Queue.ts";
import { SendError } from "./QueueTypes.ts";

/**
 * Injectable auth used by the Queue HTTP client builder. Both the
 * scoped-token HTTP variant ({@link makeWriteQueueHttpClient}) and the
 * current-credentials Local variant build this so they share the exact
 * same request path — only the way credentials reach the SDK op differs.
 *
 * - `authorize` runs a raw distilled op (which needs
 *   `Credentials | HttpClient`) and discharges those requirements down to
 *   {@link RuntimeContext}. The HTTP variant provides a minted token; the
 *   Local variant provides the ambient current-credentials context.
 * - `accountId` resolves the Cloudflare account the queue lives in.
 */
export interface QueueAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
  accountId: Effect.Effect<string>;
}

/**
 * Shared scaffolding for the HTTP-backed Queue services.
 *
 * Creates a scoped {@link AccountApiToken}, binds its `value` /
 * `accountId` into the host Worker at deploy time, then delegates to
 * `makeClient` with the bound token and the queue's `queueId`.
 */
export const makeHttpQueueBinding = <Client>(options: {
  permissionGroups: PermissionGroup[];
  makeClient: (token: HttpToken, queueId: Effect.Effect<string>) => Client;
}) =>
  Effect.gen(function* () {
    const Token = yield* AccountApiToken;
    const self = yield* Self;
    const env = yield* CloudflareEnvironment;

    return Effect.fn(function* (queue: Queue) {
      const { accountId } = yield* env;
      const token = yield* Token(`${self.LogicalId}Token`);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* token.bind`${queue.LogicalId}`({
          policies: [
            {
              effect: "allow",
              permissionGroups: options.permissionGroups,
              resources: {
                [`com.cloudflare.api.account.${accountId}`]: "*",
              },
            },
          ],
        });
      }
      const bound = {
        value: yield* token.value,
        accountId: yield* token.accountId,
      } satisfies HttpToken;
      const queueId = yield* queue.queueId;
      return options.makeClient(bound, queueId);
    });
  });

/** Resolve the account and queue id once per operation. */
export const makeQueueHttpScope = (
  auth: QueueAuth,
  queueId: Effect.Effect<string>,
): Effect.Effect<HttpScope> =>
  Effect.gen(function* () {
    const accountId = yield* auth.accountId;
    const id = yield* queueId;
    return { accountId, queueId: id };
  });

export const toQueueSendError = (error: unknown): SendError =>
  new SendError({
    message:
      typeof error === "object" && error !== null && "message" in error
        ? String((error as { message: unknown }).message)
        : "Unknown queue error",
    cause: error,
  });

export interface HttpToken {
  value: Effect.Effect<Redacted.Redacted<string>>;
  accountId: Effect.Effect<string>;
}

export interface HttpScope {
  accountId: string;
  queueId: string;
}

const QUEUE_HTTP_PERMISSION_GROUPS: PermissionGroupRef[] = [
  "Queues Read",
  "Queues Write",
];

type PermissionGroup = (typeof QUEUE_HTTP_PERMISSION_GROUPS)[number];
