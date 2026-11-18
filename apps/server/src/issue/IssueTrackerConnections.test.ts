import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IssueTrackerKind, ProjectId } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as IssueTrackerConnections from "./IssueTrackerConnections.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const linear = IssueTrackerKind.make("linear");
const projectId = ProjectId.make("project-1");

const listWithProbeFailure = (reason: IssueTrackerError["reason"]) =>
  Effect.gen(function* () {
    const tracker = {
      kind: linear,
      capabilities: {
        create: true,
        edit: true,
        comment: true,
        labels: true,
        assignees: true,
        reactions: true,
        templates: true,
        linkedPullRequests: true,
        events: true,
        search: true,
      },
      standalone: {
        tracker: linear,
        displayName: "Linear",
        host: "linear.app",
        scopeNoun: "team",
        credential: { label: "Personal API key", helpUrl: null },
      },
      getViewer: () => Effect.succeed("wout"),
      listIssues: () => Effect.succeed({ items: [], nextCursor: null }),
      getIssue: () => Effect.die("unused"),
      getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
      probeCredential: () =>
        Effect.fail(
          new IssueTrackerError({
            tracker: linear,
            operation: "viewer",
            reason,
            detail:
              reason === "rate-limited"
                ? "Linear's rate limit was reached."
                : "Linear could not be reached.",
          }),
        ),
    };
    return yield* IssueTrackerConnections.IssueTrackerConnections.pipe(
      Effect.flatMap((service) => service.list),
      Effect.result,
      Effect.provide(
        IssueTrackerConnections.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                IssueTrackerRegistry.IssueTrackerRegistry,
                IssueTrackerRegistry.fromTrackers([tracker]),
              ),
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: () => Effect.succeedSome(new TextEncoder().encode("saved-valid-key")),
              }),
              Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
                list: Effect.succeed(new Map([[projectId, { tracker: linear, scope: "FAC" }]])),
              }),
            ),
          ),
        ),
      ),
    );
  });

describe("IssueTrackerConnections", () => {
  it.effect.each(["rate-limited", "failed"] as const)(
    "lists a %s probe as unavailable, keeping the credential and bound scopes",
    (reason) =>
      Effect.gen(function* () {
        const result = yield* listWithProbeFailure(reason);
        expect(result).toMatchObject({
          _tag: "Success",
          success: {
            trackers: [
              {
                connected: true,
                account: null,
                unavailable: true,
                scopes: [{ key: "FAC", name: "FAC" }],
              },
            ],
            bindings: { [projectId]: { tracker: linear, scope: "FAC" } },
          },
        });
      }),
  );

  it.effect("lists an authentication refusal as a rejected saved credential", () =>
    Effect.gen(function* () {
      const result = yield* listWithProbeFailure("unauthenticated");
      expect(result).toMatchObject({
        _tag: "Success",
        success: { trackers: [{ connected: true, account: null, unavailable: false, scopes: [] }] },
      });
    }),
  );
});
