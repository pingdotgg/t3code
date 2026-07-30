import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { EnvironmentId, ExecutionEnvironmentDescriptor, TrimmedNonEmptyString } from "./index.ts";

const FrozenUpstreamCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean,
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  threadSnooze: Schema.optionalKey(Schema.Boolean),
});

const FrozenUpstreamDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: Schema.Struct({
    os: Schema.Literals(["darwin", "linux", "windows", "unknown"]),
    arch: Schema.Literals(["arm64", "x64", "other"]),
  }),
  serverVersion: TrimmedNonEmptyString,
  capabilities: FrozenUpstreamCapabilities,
});

describe("execution environment extension compatibility", () => {
  it("accepts an upstream-shaped descriptor with no fork capabilities", () => {
    const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
      environmentId: "00000000-0000-4000-8000-000000000001",
      label: "Upstream",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.31",
      capabilities: { repositoryIdentity: true },
    });

    assert.strictEqual(descriptor.capabilities.componentPreview, undefined);
    assert.strictEqual(descriptor.capabilities.threadExtensions, undefined);
  });

  it("lets a frozen upstream decoder ignore additive capability fields", () => {
    const descriptor = Schema.decodeUnknownSync(FrozenUpstreamDescriptor)({
      environmentId: "00000000-0000-4000-8000-000000000002",
      label: "Forma",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "0.0.31",
      capabilities: {
        repositoryIdentity: true,
        componentPreview: true,
        projectLocalAgents: true,
        versionedProjectFiles: true,
        projectEntryMutations: true,
        threadExtensions: true,
        customAppIcons: true,
      },
    });

    assert.deepStrictEqual(descriptor.capabilities, {
      repositoryIdentity: true,
    });
  });
});
