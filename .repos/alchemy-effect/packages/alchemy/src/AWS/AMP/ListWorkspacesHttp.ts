import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  ListWorkspaces,
  type ListWorkspacesRequest,
} from "./ListWorkspaces.ts";

export const ListWorkspacesHttp = Layer.effect(
  ListWorkspaces,
  Effect.gen(function* () {
    const listWorkspaces = yield* amp.listWorkspaces;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.AMP.ListWorkspaces())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["aps:ListWorkspaces"],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn("AWS.AMP.ListWorkspaces")(function* (
        request?: ListWorkspacesRequest,
      ) {
        return yield* listWorkspaces(request ?? {});
      });
    });
  }),
);
