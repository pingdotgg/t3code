import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { ListWorkspaces, type ListWorkspacesRequest } from "./ListWorkspaces.ts";

export const ListWorkspacesHttp = Layer.effect(
  ListWorkspaces,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const listWorkspaces = yield* AWSBindings.withCredentials(amp.listWorkspaces);

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.AMP.ListWorkspaces()`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["aps:ListWorkspaces"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn("AWS.AMP.ListWorkspaces")(function* (request?: ListWorkspacesRequest) {
        return yield* listWorkspaces(request ?? {});
      });
    });
  }),
);
