import { Project } from "@/Neon/Project";
import { Branch } from "@/Neon/Branch";
import { Function } from "@/Neon/Function";
import { FunctionTrigger } from "@/Neon/FunctionTrigger";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import * as Api from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const { test } = Test.make({ providers: providers() });
test.provider(
  "schedule lifecycle, inherited disabled state and spoofed attestation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (cron: string, enabled: boolean, child = false) =>
        stack.deploy(
          Effect.gen(function* () {
            const project = yield* Project("TriggerProject", {
              region: "aws-us-east-2",
            });
            const api = yield* Function("Api", {
              project,
              main: new URL("./fixtures/function-trigger.ts", import.meta.url)
                .href,
            });
            const trigger = yield* FunctionTrigger("Schedule", {
              function: api,
              type: "schedule",
              schedule: { cron },
              path: "/jobs",
              enabled,
            });
            const preview = child
              ? yield* Branch("Preview", { project })
              : undefined;
            return { project, api, trigger, preview };
          }),
        );
      const first = yield* deploy("0 2 * * *", false);
      expect(first.trigger.enabled).toBe(false);
      const changed = yield* deploy("0 3 * * *", true, true);
      expect(changed.trigger.triggerId).toBe(first.trigger.triggerId);
      expect(changed.trigger.version).toBeGreaterThan(first.trigger.version);
      const observed = yield* Api.getProjectBranchTrigger({
        project_id: changed.trigger.projectId,
        branch_id: changed.trigger.branchId,
        trigger_id: changed.trigger.triggerId,
      });
      expect(observed.trigger).toMatchObject({
        enabled: true,
        type: "schedule",
        schedule: { cron: "0 3 * * *" },
      });
      const inherited = yield* Api.getProjectBranchTrigger({
        project_id: changed.project.projectId,
        branch_id: changed.preview!.branchId,
        trigger_id: changed.trigger.triggerId,
      });
      expect(inherited.trigger).toMatchObject({
        inherited: true,
        enabled: false,
        next_run_at: null,
      });
      const client = yield* HttpClient.HttpClient;
      const spoof = yield* client.execute(
        HttpClientRequest.post(`${changed.api.url}jobs`).pipe(
          HttpClientRequest.setHeader("x-neon-trigger-invocation-id", "spoof"),
          HttpClientRequest.bodyJsonUnsafe({
            version: 1,
            invocation_id: "spoof",
            trigger: { type: "schedule" },
            data: {},
          }),
        ),
      );
      expect(spoof.status).toBe(403);
      yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("TriggerProject", {
            region: "aws-us-east-2",
          });
          yield* Function("Api", {
            project,
            main: new URL("./fixtures/function-trigger.ts", import.meta.url)
              .href,
          });
          yield* Branch("Preview", { project });
        }),
      );
      expect(
        yield* Api.getProjectBranchTrigger({
          project_id: changed.trigger.projectId,
          branch_id: changed.trigger.branchId,
          trigger_id: changed.trigger.triggerId,
        }).pipe(
          Effect.as(false),
          Effect.catchTag("NotFound", () => Effect.succeed(true)),
        ),
      ).toBe(true);
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:branch",
      "provider:neon:function",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
