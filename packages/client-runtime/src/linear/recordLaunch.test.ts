import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { LinearEnvironmentAtoms } from "../state/linear.ts";
import type { RecordLinearLaunchInput } from "./launchPlan.ts";
import { recordLinearLaunch } from "./recordLaunch.ts";

const FALLBACK = "The launch started, but the issue was not linked.";

const launch: RecordLinearLaunchInput = {
  environmentId: "env-1" as EnvironmentId,
  issueId: "issue-1",
  identifier: "ATT-612",
  teamId: "team-1",
  projectId: "project-1",
  target: {
    kind: "thread",
    targetId: "thr-1",
    threadId: "thr-1" as ThreadId,
    title: "Handshake",
  },
  writeBack: { comment: true },
};

function fakeRecordLaunch(run: () => Promise<unknown>) {
  const requests: Array<unknown> = [];
  const command = {
    label: "linear record launch",
    run: (_registry: AtomRegistry.AtomRegistry, request: unknown) => {
      requests.push(request);
      return run();
    },
  } as unknown as LinearEnvironmentAtoms["recordLaunch"];
  return { requests, command };
}

function record(run: () => Promise<unknown>, input: RecordLinearLaunchInput = launch) {
  const fake = fakeRecordLaunch(run);
  const warning = recordLinearLaunch(
    {
      registry: AtomRegistry.make(),
      recordLaunch: fake.command,
      threadOrigin: "https://app.t3.codes/",
    },
    input,
  );
  return { warning, requests: fake.requests };
}

const succeed = (warnings: ReadonlyArray<{ step: string; message: string }>) => () =>
  Promise.resolve(AsyncResult.success({ link: {}, warnings }));

describe("recordLinearLaunch", () => {
  it("sends a fallback launch to the primary with the run's machine and a link to it", async () => {
    const { warning, requests } = record(succeed([]), {
      ...launch,
      environmentId: "env-b" as EnvironmentId,
      recordOn: "env-a" as EnvironmentId,
      remote: { machineName: "Studio", pipelineName: "Ship it" },
    });
    expect(await warning).toBeNull();
    expect(requests).toMatchObject([
      {
        environmentId: "env-a",
        input: {
          remote: { environmentId: "env-b", machineName: "Studio", pipelineName: "Ship it" },
          threadUrl: "https://app.t3.codes/env-b/thr-1",
        },
      },
    ]);
  });

  it("sends what the client knows about the issue and a link to the thread", async () => {
    const { warning, requests } = record(succeed([]));
    expect(await warning).toBeNull();
    expect(requests).toEqual([
      {
        environmentId: "env-1",
        input: {
          issueId: "issue-1",
          target: launch.target,
          writeBack: { comment: true },
          issue: { identifier: "ATT-612", teamId: "team-1", projectId: "project-1" },
          threadUrl: "https://app.t3.codes/env-1/thr-1",
        },
      },
    ]);
  });

  it("sends the issue block only with a team, and its project only when known", async () => {
    const withoutProject = record(succeed([]), { ...launch, projectId: undefined });
    await withoutProject.warning;
    expect(withoutProject.requests[0]).toMatchObject({
      input: { issue: { identifier: "ATT-612", teamId: "team-1" } },
    });
    expect(withoutProject.requests[0]).not.toHaveProperty("input.issue.projectId");

    const withoutTeam = record(succeed([]), { ...launch, teamId: undefined });
    await withoutTeam.warning;
    expect(withoutTeam.requests[0]).not.toHaveProperty("input.issue");
  });

  it("resolves to the first write-back warning", async () => {
    const { warning } = record(
      succeed([
        { step: "move_state", message: "Could not move ATT-612." },
        { step: "comment", message: "Could not comment." },
      ]),
    );
    expect(await warning).toBe("Could not move ATT-612.");
  });

  it("resolves a failure to its message, or the fallback, and never throws", async () => {
    const failWith = (error: unknown) => () =>
      Promise.resolve(AsyncResult.failure(Cause.fail(error)));
    expect(await record(failWith(new Error("Linear is down"))).warning).toBe("Linear is down");
    expect(await record(failWith(new Error(""))).warning).toBe(FALLBACK);
    expect(await record(failWith("nope")).warning).toBe(FALLBACK);
    expect(await record(() => Promise.reject("boom")).warning).toBe(FALLBACK);
  });
});
