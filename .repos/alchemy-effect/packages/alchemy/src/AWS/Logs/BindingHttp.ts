import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { LogGroup } from "./LogGroup.ts";

/**
 * Shared scaffolding for CloudWatch Logs HTTP bindings.
 *
 * NOT exported from `index.ts` — every single-operation `{Op}Http.ts` in this
 * service is a thin `Layer.effect(Cap, makeLogGroupHttpBinding({ … }))` over
 * this builder. Everything except the operation, the IAM action(s), and the
 * IAM resource shape is boilerplate:
 *
 * - the deploy-time half registers `Allow(host, tag(logGroup))` with the
 *   requested actions on the bound group's ARN (and/or its `:*` log-stream
 *   wildcard, per `iamResources`);
 * - the runtime callable injects the resolved `logGroupName` into the request
 *   (unless `injectLogGroupName: false` — for query-id / record-pointer
 *   scoped operations like `GetQueryResults`, `StopQuery`, `GetLogRecord`).
 *
 * Genuinely-different bindings stay bespoke: `LogEventSink` (a batching sink
 * over the `PutLogEvents` capability).
 */
export const makeLogGroupHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Logs.FilterLogEvents`. */
  tag: string;
  /**
   * The distilled operation the runtime callable invokes.
   *
   * Typed as distilled's `OperationMethod` intersection (yieldable Effect +
   * direct call signature) so `I` is inferred from the call signature — the
   * Effect half alone defeats inference for requests without `logGroupName`
   * (e.g. `GetLogRecord`, `GetQueryResults`, `StopQuery`).
   */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R> &
    ((input: I) => Effect.Effect<A, E, R>);
  /** IAM actions granted on the bound log group. */
  actions: readonly string[];
  /**
   * Which ARNs the actions are granted on:
   * - `"group-and-streams"` (default): the log-group ARN plus `${arn}:*`;
   * - `"streams"`: only `${arn}:*` — for actions that authorize against the
   *   log-stream resource (`PutLogEvents`, `DeleteLogStream`);
   * - `"all"`: `*` — for actions that do not support resource-level
   *   permissions (`StopQuery`).
   */
  iamResources?: "group-and-streams" | "streams" | "all";
  /**
   * Inject the bound group's name under `logGroupName` (default `true`).
   * Disable for operations scoped by a query id or record pointer.
   */
  injectLogGroupName?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;
    const inject = options.injectLogGroupName ?? true;

    return Effect.fn(function* <G extends LogGroup>(logGroup: G) {
      const LogGroupName = yield* logGroup.logGroupName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${logGroup}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource:
                  options.iamResources === "all"
                    ? ["*"]
                    : options.iamResources === "streams"
                      ? [Output.interpolate`${logGroup.logGroupArn}:*`]
                      : [
                          logGroup.logGroupArn,
                          Output.interpolate`${logGroup.logGroupArn}:*`,
                        ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${logGroup.LogicalId})`)(function* (
        request?: Omit<I, "logGroupName">,
      ) {
        const input: Record<string, unknown> = { ...request };
        if (inject) {
          input.logGroupName = yield* LogGroupName;
        }
        return yield* op(input as unknown as I);
      });
    });
  });
