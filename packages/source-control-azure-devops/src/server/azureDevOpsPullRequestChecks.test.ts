import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { decodeBuildPolicyChecksJson } from "./azureDevOpsPullRequestChecks.ts";

const configuration = {
  id: 12,
  isEnabled: true,
  isBlocking: true,
  isDeleted: null,
  type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" },
  settings: { displayName: "Tests" },
};

describe("Azure build policy checks", () => {
  it.each([
    ["queued", "pending"],
    ["running", "pending"],
    ["approved", "success"],
    ["rejected", "failure"],
    ["broken", "failure"],
    ["future-state", "pending"],
  ] as const)("maps %s to %s using the current policy evaluation", (status, expected) => {
    const result = decodeBuildPolicyChecksJson(
      JSON.stringify([{ configuration, status, context: { buildId: 200 } }]),
    );
    assert.isTrue(Result.isSuccess(result));
    if (Result.isFailure(result)) return;
    assert.deepEqual(result.success.checks, [
      {
        name: "Tests (#12)",
        status: expected,
        required: true,
        description: null,
        url: null,
      },
    ]);
  });

  it("omits unrelated, disabled, deleted and inapplicable policies while counting raw rows", () => {
    const result = decodeBuildPolicyChecksJson(
      JSON.stringify([
        { status: "approved", configuration: { ...configuration, type: { id: "reviewers" } } },
        { status: "rejected", configuration: { ...configuration, isEnabled: false } },
        { status: "rejected", configuration: { ...configuration, isDeleted: true } },
        { status: "notApplicable", configuration },
      ]),
    );
    assert.isTrue(Result.isSuccess(result));
    if (Result.isFailure(result)) return;
    assert.deepEqual(result.success, { checks: [], rawCount: 4 });
  });

  it("distinguishes same-named policies and retains optional builds", () => {
    const result = decodeBuildPolicyChecksJson(
      JSON.stringify([
        { status: "approved", configuration },
        { status: "running", configuration: { ...configuration, id: 13, isBlocking: false } },
        { status: "queued", configuration: { ...configuration, id: 14, settings: null } },
      ]),
    );
    assert.isTrue(Result.isSuccess(result));
    if (Result.isFailure(result)) return;
    assert.deepEqual(
      result.success.checks.map(({ name, required }) => ({ name, required })),
      [
        { name: "Tests (#12)", required: true },
        { name: "Tests (#13)", required: false },
        { name: "Build validation (#14)", required: true },
      ],
    );
  });

  it("rejects malformed responses and partial lists instead of dropping unreadable checks", () => {
    for (const raw of [
      "",
      "{}",
      '{"value":[]}',
      JSON.stringify([{ configuration, status: "approved" }, { status: "queued" }]),
      JSON.stringify([{ configuration: { ...configuration, isBlocking: null }, status: "queued" }]),
    ]) {
      assert.isTrue(Result.isFailure(decodeBuildPolicyChecksJson(raw)));
    }
    const empty = decodeBuildPolicyChecksJson("[]");
    assert.isTrue(Result.isSuccess(empty));
    if (Result.isFailure(empty)) return;
    assert.deepEqual(empty.success, { checks: [], rawCount: 0 });
  });
});
