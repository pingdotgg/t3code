import * as AWS from "@/AWS";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class QAppsTestFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "QAppsTestFunction",
) {}

/**
 * Every route answers `{ …fields }` on success or `{ errorTag }` when the
 * operation fails with a TYPED error — the test asserts on concrete fields
 * (or a typed tag), which proves the binding wiring, the instance-id/app-id
 * injection, and the IAM grants (app-ARN-scoped for the session/permission
 * bindings, account-level for the instance-level bindings). An untyped
 * error crashes into a 500.
 */
const errorTagged = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | { errorTag: string }, never, R> =>
  effect.pipe(
    Effect.map((a): A | { errorTag: string } => a),
    Effect.catch((e) => Effect.succeed({ errorTag: e._tag })),
  );

const TEXT_CARD_ID = "11111111-1111-4111-8111-111111111111";
const QUERY_CARD_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Q App binding fixture: deploys a Q App into the Q Business application
 * environment instance named by QAPPS_INSTANCE_ID plus a Lambda bound to a
 * representative set of Q Apps bindings (both builders: app/session-scoped
 * and instance-level). Only deployed behind the AWS_TEST_QAPPS gate — the
 * QApp resource itself cannot exist without an entitled Q Business instance.
 */
export default QAppsTestFunction.make(
  { main: import.meta.url, url: true },
  Effect.gen(function* () {
    const instanceId = yield* Effect.sync(
      () => process.env.QAPPS_INSTANCE_ID ?? "",
    );

    const app = yield* AWS.QApps.QApp("BindingsQApp", {
      instanceId,
      description: "alchemy QApps bindings fixture",
      appDefinition: {
        cards: [
          {
            textInput: {
              id: TEXT_CARD_ID,
              title: "Source Text",
              type: "text-input",
            },
          },
          {
            qQuery: {
              id: QUERY_CARD_ID,
              title: "Summary",
              type: "q-query",
              prompt: "Summarize the following text: @Source Text",
            },
          },
        ],
      },
      tags: { fixture: "qapps-bindings" },
    });

    const appVersion = yield* app.appVersion;

    const startQAppSession = yield* AWS.QApps.StartQAppSession(app);
    const getQAppSession = yield* AWS.QApps.GetQAppSession(app);
    const stopQAppSession = yield* AWS.QApps.StopQAppSession(app);
    const describeQAppPermissions =
      yield* AWS.QApps.DescribeQAppPermissions(app);
    const listQApps = yield* AWS.QApps.ListQApps(app);
    const listCategories = yield* AWS.QApps.ListCategories(app);

    const bound = {
      startQAppSession,
      getQAppSession,
      stopQAppSession,
      describeQAppPermissions,
      listQApps,
      listCategories,
    };

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl ?? request.url, "http://x");
        const pathname = url.pathname;

        if (pathname === "/bindings") {
          return yield* HttpServerResponse.json({ bound: Object.keys(bound) });
        }

        if (pathname === "/session") {
          // start → get → stop, proving app-id injection and the session
          // sub-resource grant end-to-end.
          const started = yield* errorTagged(
            startQAppSession({ appVersion: yield* appVersion }),
          );
          if ("errorTag" in started) {
            return yield* HttpServerResponse.json(started);
          }
          const state = yield* errorTagged(
            getQAppSession({ sessionId: started.sessionId }),
          );
          const stopped = yield* errorTagged(
            stopQAppSession({ sessionId: started.sessionId }),
          );
          return yield* HttpServerResponse.json({
            sessionId: started.sessionId,
            status: "errorTag" in state ? undefined : state.status,
            getErrorTag: "errorTag" in state ? state.errorTag : undefined,
            stopErrorTag: "errorTag" in stopped ? stopped.errorTag : undefined,
          });
        }

        if (pathname === "/apps") {
          const result = yield* errorTagged(listQApps({ limit: 10 }));
          return yield* HttpServerResponse.json(
            "errorTag" in result ? result : { count: result.apps.length },
          );
        }

        if (pathname === "/categories") {
          const result = yield* errorTagged(listCategories());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : { count: result.categories?.length ?? 0 },
          );
        }

        if (pathname === "/permissions") {
          const result = yield* errorTagged(describeQAppPermissions());
          return yield* HttpServerResponse.json(
            "errorTag" in result
              ? result
              : {
                  resourceArn: result.resourceArn,
                  count: result.permissions?.length ?? 0,
                },
          );
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        AWS.QApps.StartQAppSessionHttp,
        AWS.QApps.GetQAppSessionHttp,
        AWS.QApps.StopQAppSessionHttp,
        AWS.QApps.DescribeQAppPermissionsHttp,
        AWS.QApps.ListQAppsHttp,
        AWS.QApps.ListCategoriesHttp,
      ),
    ),
  ),
);
