import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IssueTrackerKind } from "@t3tools/contracts";
import { make as makeJira } from "@t3tools/issue-tracker-jira/server/JiraIssueTracker";
import { SourceControlHost } from "@t3tools/source-control-core/server/SourceControlHost";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { IssueTrackerBindingsRepository } from "../persistence/IssueTrackerBindings.ts";
import { IssueTrackerRegistry, fromTrackers } from "./IssueTrackerRegistry.ts";
import { IssueTrackerConnections, layer } from "./IssueTrackerConnections.ts";

it.effect("uses the environment login without reading or storing a tracker token", () =>
  Effect.gen(function* () {
    const jira = yield* makeJira.pipe(
      Effect.provide(
        Layer.mock(SourceControlHost)({
          settings: {} as never,
          git: {} as never,
          process: {
            run: (input) =>
              Effect.succeed({
                exitCode: ExitCode(0),
                stdout: JSON.stringify(
                  input.args.includes("whoami")
                    ? { data: { accountId: "a", name: "Demo" } }
                    : {
                        request: { site: "demo.atlassian.net" },
                        data: { projects: [{ id: "1", key: "DEMO", name: "Demo" }] },
                      },
                ),
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          },
        }),
      ),
    );
    const connections = yield* IssueTrackerConnections.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ServerSecretStore)({}),
              Layer.mock(IssueTrackerBindingsRepository)({ list: Effect.succeed(new Map()) }),
              Layer.succeed(IssueTrackerRegistry, fromTrackers([jira])),
            ),
          ),
        ),
      ),
    );
    assert.deepStrictEqual((yield* connections.list).trackers[0]?.scopes, [
      { key: "demo.atlassian.net/DEMO", name: "Demo" },
    ]);
    assert.strictEqual(
      (yield* Effect.flip(
        connections.connect({ tracker: IssueTrackerKind.make("jira"), token: "unused" }),
      )).reason,
      "rejected",
    );
  }),
);
