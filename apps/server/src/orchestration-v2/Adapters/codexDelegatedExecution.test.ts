import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type DelegatedExecution } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { captureDelegatedExecution, withinDelegatedExecution } from "./codexDelegatedExecution.ts";
import { buildCodexTurnStartParams } from "./CodexAdapterV2.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const ceiling = {
  providerInstanceId,
  cwd: "/workspace",
  sandboxPolicy: {
    type: "workspaceWrite",
    networkAccess: false,
    writableRoots: ["/approved"],
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true,
  },
} satisfies DelegatedExecution;

it.effect("captures exact legacy limits and refuses policies it cannot reproduce", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const capture = (sandboxPolicy: unknown, activePermissionProfile: unknown = null) =>
      captureDelegatedExecution(
        providerInstanceId,
        { cwd: "/workspace", sandboxPolicy, activePermissionProfile },
        path.isAbsolute,
      );
    assert.deepEqual(capture(ceiling.sandboxPolicy), ceiling);
    assert.isUndefined(capture({ type: "externalSandbox" }));
    assert.isUndefined(capture({ type: "dangerFullAccess" }));
    const full = {
      cwd: "/workspace",
      sandboxPolicy: { type: "dangerFullAccess" },
      activePermissionProfile: null,
    };
    assert.deepEqual(captureDelegatedExecution(providerInstanceId, full, path.isAbsolute, "grok"), {
      providerInstanceId,
      cwd: "/workspace",
      sandboxPolicy: { type: "dangerFullAccess", networkAccess: true },
    });
    assert.isUndefined(
      captureDelegatedExecution(
        providerInstanceId,
        { ...full, activePermissionProfile: { id: "custom" } },
        path.isAbsolute,
        "grok",
      ),
    );
    assert.isUndefined(
      captureDelegatedExecution(
        providerInstanceId,
        { ...full, sandboxPolicy: { type: "externalSandbox" } },
        path.isAbsolute,
        "grok",
      ),
    );

    assert.isUndefined(capture(ceiling.sandboxPolicy, { id: "custom" }));
    assert.isUndefined(capture({ ...ceiling.sandboxPolicy, writableRoots: ["relative"] }));
    assert.isUndefined(capture({ type: "readOnly", networkAccess: true }));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("rejects broader network, roots, temp access, cwd and provider", () => {
  assert.isTrue(withinDelegatedExecution(ceiling, ceiling));
  for (const sandboxPolicy of [
    { ...ceiling.sandboxPolicy, networkAccess: true },
    { ...ceiling.sandboxPolicy, writableRoots: ["/"] },
    { ...ceiling.sandboxPolicy, excludeSlashTmp: false },
    { ...ceiling.sandboxPolicy, excludeTmpdirEnvVar: false },
  ])
    assert.isFalse(withinDelegatedExecution({ ...ceiling, sandboxPolicy }, ceiling));
  assert.isFalse(withinDelegatedExecution({ ...ceiling, cwd: "/other" }, ceiling));
  assert.isFalse(
    withinDelegatedExecution(
      { ...ceiling, providerInstanceId: ProviderInstanceId.make("other") },
      ceiling,
    ),
  );
  assert.isTrue(
    withinDelegatedExecution(
      { ...ceiling, sandboxPolicy: { type: "readOnly", networkAccess: false } },
      ceiling,
    ),
  );
});

it.effect("applies the durable ceiling after runtime defaults and overrides", () =>
  Effect.gen(function* () {
    const params = yield* buildCodexTurnStartParams({
      nativeThreadId: "bounded",
      codexInput: [],
      modelSelection: { instanceId: providerInstanceId, model: "gpt-6.1-sol" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/other",
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "dangerFullAccess" },
        delegatedExecution: ceiling,
      },
    });
    assert.equal(params.approvalPolicy, "never");
    assert.equal(params.approvalsReviewer, "user");
    assert.equal(params.cwd, ceiling.cwd);
    assert.deepEqual(params.sandboxPolicy, ceiling.sandboxPolicy);
  }),
);
