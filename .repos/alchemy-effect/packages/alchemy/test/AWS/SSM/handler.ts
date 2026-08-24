import * as Lambda from "@/AWS/Lambda";
import * as SSM from "@/AWS/SSM";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

export class SSMTestFunction extends Lambda.Function<Lambda.Function>()(
  "SSMTestFunction",
) {}

export default SSMTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const stringParameter = yield* SSM.Parameter("TestStringParameter", {
      value: "plain-config-value",
      tags: { Environment: "test" },
    });
    const secureParameter = yield* SSM.Parameter("TestSecureParameter", {
      type: "SecureString",
      value: Redacted.make("bound-secret-value"),
    });
    // A parameter the write-plane bindings mutate at runtime (put, label,
    // unlabel, history). Runtime writes drift the value; the next deploy
    // converges it back to "v1".
    const mutableParameter = yield* SSM.Parameter("TestMutableParameter", {
      value: "v1",
    });
    // A hierarchical subtree for GetParametersByPath: the root parameter is
    // the bound subtree marker, the child lives under the root's name.
    const pathRoot = yield* SSM.Parameter("TestPathRoot", {
      name: "/alchemy-test/ssm-bindings/root",
      value: "root-value",
    });
    yield* SSM.Parameter("TestPathChild", {
      name: "/alchemy-test/ssm-bindings/root/child",
      value: "child-value",
    });

    // Event source: subscribe the host to Parameter Store change events. The
    // deploy proves the EventBridge rule + invoke permission wiring.
    yield* SSM.consumeParameterEvents(
      {
        kinds: ["change"],
        names: [
          "/alchemy-test/ssm-bindings/root",
          "/alchemy-test/ssm-bindings/root/child",
        ],
      },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(
            `parameter ${event.detail.operation}: ${event.detail.name}`,
          ),
        ),
    );

    const getStringParameter = yield* SSM.GetParameter(stringParameter);
    const getSecureParameter = yield* SSM.GetParameter(secureParameter);
    const getParameters = yield* SSM.GetParameters(
      stringParameter,
      secureParameter,
    );
    const putParameter = yield* SSM.PutParameter(mutableParameter);
    const getHistory = yield* SSM.GetParameterHistory(mutableParameter);
    const labelVersion = yield* SSM.LabelParameterVersion(mutableParameter);
    const unlabelVersion = yield* SSM.UnlabelParameterVersion(mutableParameter);
    const getByPath = yield* SSM.GetParametersByPath(pathRoot);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/get-string") {
          const result = yield* getStringParameter();
          return yield* HttpServerResponse.json({
            name: result.Parameter?.Name,
            type: result.Parameter?.Type,
            value: plain(result.Parameter?.Value),
          });
        }

        if (request.method === "GET" && pathname === "/get-secure") {
          const result = yield* getSecureParameter({ WithDecryption: true });
          return yield* HttpServerResponse.json({
            name: result.Parameter?.Name,
            type: result.Parameter?.Type,
            value: plain(result.Parameter?.Value),
          });
        }

        if (request.method === "GET" && pathname === "/get-many") {
          const result = yield* getParameters({ WithDecryption: true });
          return yield* HttpServerResponse.json({
            parameters: (result.Parameters ?? []).map((parameter) => ({
              name: parameter.Name,
              type: parameter.Type,
              value: plain(parameter.Value),
            })),
            invalidParameters: result.InvalidParameters ?? [],
          });
        }

        // Write a new version of the mutable parameter, then read it back.
        if (request.method === "POST" && pathname === "/put") {
          const put = yield* putParameter({
            Value: "v2-runtime",
            Overwrite: true,
          });
          const history = yield* getHistory();
          return yield* HttpServerResponse.json({
            version: put.Version,
            latest: plain(history.Parameters?.at(-1)?.Value),
          });
        }

        // The mutable parameter's full change history.
        if (request.method === "GET" && pathname === "/history") {
          const result = yield* getHistory();
          return yield* HttpServerResponse.json({
            count: (result.Parameters ?? []).length,
            values: (result.Parameters ?? []).map((version) =>
              plain(version.Value),
            ),
          });
        }

        // Label the latest version, then unlabel the same version. The label
        // attach is eventually consistent, so retry the unlabel until the
        // label is visible (RemovedLabels non-empty), bounded at 8 attempts.
        if (request.method === "POST" && pathname === "/label-cycle") {
          const labeled = yield* labelVersion({ Labels: ["current"] });
          const unlabeled = yield* unlabelVersion({
            ParameterVersion: labeled.ParameterVersion!,
            Labels: ["current"],
          }).pipe(
            Effect.repeat({
              until: (result): boolean =>
                (result.RemovedLabels ?? []).length > 0,
              schedule: Schedule.spaced("1 second"),
              times: 8,
            }),
          );
          return yield* HttpServerResponse.json({
            labeledVersion: labeled.ParameterVersion,
            invalidLabels: labeled.InvalidLabels ?? [],
            removedLabels: unlabeled.RemovedLabels ?? [],
          });
        }

        // Read the subtree under the bound path-root parameter's name.
        if (request.method === "GET" && pathname === "/by-path") {
          const result = yield* getByPath({ Recursive: true });
          return yield* HttpServerResponse.json({
            parameters: (result.Parameters ?? []).map((parameter) => ({
              name: parameter.Name,
              value: plain(parameter.Value),
            })),
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Lambda.EventSource,
        SSM.GetParameterHttp,
        SSM.GetParametersHttp,
        SSM.GetParameterHistoryHttp,
        SSM.GetParametersByPathHttp,
        SSM.PutParameterHttp,
        SSM.LabelParameterVersionHttp,
        SSM.UnlabelParameterVersionHttp,
      ),
    ),
  ),
);
