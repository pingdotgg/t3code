import {
  EnvironmentHttpCommonError,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2Checkpoint,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { HttpClientError } from "effect/http";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_HISTORY_TIMEOUT_MS = 6_000;

const decodeEnvelope = Schema.decodeUnknownEffect(
  Schema.toCodecJson(
    OrchestrationV2ThreadHistoryPage.mapFields((fields) => ({
      ...fields,
      items: Schema.Array(Schema.Unknown),
      support: Schema.optionalKey(
        Schema.Struct({
          nodes: Schema.Array(Schema.Unknown),
          checkpoints: Schema.Array(Schema.Unknown),
          runs: Schema.Array(Schema.Unknown),
          attempts: Schema.Array(Schema.Unknown),
        }),
      ),
    })),
  ),
);
const decodeItems = Schema.toCodecJson(OrchestrationV2ThreadHistoryPage.fields.items);
const decodeNodes = Schema.toCodecJson(Schema.Array(OrchestrationV2ExecutionNode));
const decodeCheckpoints = Schema.toCodecJson(Schema.Array(OrchestrationV2Checkpoint));
const decodeRuns = Schema.toCodecJson(Schema.Array(OrchestrationV2Run));
const decodeAttempts = Schema.toCodecJson(Schema.Array(OrchestrationV2RunAttempt));

// Chained timers are clamped in browsers and delay the completed page. A host
// task yields to input and painting without adding a timer to every slice.
const yieldHistoryDecode = Effect.suspend(() =>
  typeof MessageChannel === "undefined"
    ? Effect.sleep("1 millis")
    : Effect.callback<void>((resume) => {
        const channel = new MessageChannel();
        const close = () => {
          channel.port1.close();
          channel.port2.close();
        };
        channel.port1.onmessage = () => {
          close();
          resume(Effect.void);
        };
        channel.port2.postMessage(null);
        return Effect.sync(close);
      }),
);

/** Validate the entire page before merging, yielding host tasks between bounded slices. */
const decodeHistoryArray = Effect.fnUntraced(function* <A>(
  schema: Schema.Decoder<ReadonlyArray<A>>,
  rows: ReadonlyArray<unknown>,
) {
  const decode = Schema.decodeUnknownEffect(schema);
  const decoded: A[] = [];
  let sliceStarted = performance.now();
  for (let offset = 0; offset < rows.length; offset += 32) {
    if (performance.now() - sliceStarted >= 4) {
      yield* yieldHistoryDecode;
      sliceStarted = performance.now();
    }
    decoded.push(...(yield* decode(rows.slice(offset, offset + 32))));
  }
  return decoded;
});

const decodeHistoryPage = Effect.fnUntraced(function* (json: unknown) {
  const { items: rawItems, support, ...page } = yield* decodeEnvelope(json);
  const items = yield* decodeHistoryArray(decodeItems, rawItems);
  return {
    ...page,
    items,
    ...(support === undefined
      ? {}
      : {
          support: {
            nodes: yield* decodeHistoryArray(decodeNodes, support.nodes),
            checkpoints: yield* decodeHistoryArray(decodeCheckpoints, support.checkpoints),
            runs: yield* decodeHistoryArray(decodeRuns, support.runs),
            attempts: yield* decodeHistoryArray(decodeAttempts, support.attempts),
          },
        }),
  };
});

export const fetchEnvironmentThreadHistoryPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly throughEntryId?: string | undefined;
  readonly view?: "conversation" | "activity" | undefined;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  const endpoint = {
    params: { threadId: input.threadId },
    query: {
      cursor: input.cursor,
      includeSupport: "1",
      ...(input.view === undefined ? {} : { view: input.view }),
      ...(input.throughEntryId === undefined ? {} : { throughEntryId: input.throughEntryId }),
    },
  };
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadHistoryPage(endpoint),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      Effect.gen(function* () {
        const response = yield* client.threadHistoryPage({
          ...endpoint,
          headers: withOrchestrationProtocolHeader(headers),
          responseMode: "response-only",
        });
        if (response.status !== 200) {
          const errors = EnvironmentHttpCommonError.members.filter(
            (schema) =>
              SchemaAST.resolveAt<number>("httpApiStatus")(schema.ast) === response.status,
          );
          if (errors.length > 0) {
            return yield* Effect.fail(
              yield* Schema.decodeUnknownEffect(Schema.toCodecJson(Schema.Union(errors)))(
                yield* response.json,
              ),
            );
          }
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.StatusCodeError({ request: response.request, response }),
          });
        }
        return yield* decodeHistoryPage(yield* response.json);
      }),
  });
});
