import * as grafana from "@distilled.cloud/aws/grafana";
import * as Output from "alchemy/Output";
import { toWireSeconds } from "alchemy/Util/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import {
  CreateWorkspaceServiceAccountToken,
  type CreateWorkspaceServiceAccountTokenRequest,
} from "./CreateWorkspaceServiceAccountToken.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Bespoke (not scaffold-built): the runtime request carries a
 * `timeToLive: Duration.Input` that is converted to the wire's
 * `secondsToLive` via the central Duration util.
 */
export const CreateWorkspaceServiceAccountTokenHttp = Layer.effect(
  CreateWorkspaceServiceAccountToken,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(grafana.createWorkspaceServiceAccountToken);

    return Effect.fn(function* (workspace: Workspace) {
      const workspaceId = yield* workspace.workspaceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Grafana.CreateWorkspaceServiceAccountToken(${workspace})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["grafana:CreateWorkspaceServiceAccountToken"],
              Resource: [Output.interpolate`${workspace.workspaceArn}`],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Grafana.CreateWorkspaceServiceAccountToken(${workspace.LogicalId})`)(
        function* (request: CreateWorkspaceServiceAccountTokenRequest) {
          return yield* op({
            name: request.name,
            serviceAccountId: request.serviceAccountId,
            secondsToLive: toWireSeconds(request.timeToLive)!,
            workspaceId: yield* workspaceId,
          });
        },
      );
    });
  }),
);
