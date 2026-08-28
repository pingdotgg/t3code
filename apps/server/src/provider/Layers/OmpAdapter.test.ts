import { assert, it } from "@effect/vitest";

import { selectOmpPermissionOptionId } from "./OmpAdapter.ts";

function ompPermissionRequest(
  options: ReadonlyArray<{
    readonly optionId: string;
    readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }>,
) {
  return {
    sessionId: "mock-session-1",
    toolCall: {
      toolCallId: "tool-call-1",
      title: "cat package.json",
      kind: "execute" as const,
      status: "pending" as const,
    },
    options: options.map((option) => ({
      optionId: option.optionId,
      name: option.kind,
      kind: option.kind,
    })),
  };
}

it("prefers allow_always when OMP offers it", () => {
  const request = ompPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "allow-always", kind: "allow_always" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);

  assert.equal(selectOmpPermissionOptionId(request, "acceptForSession"), "allow-always");
  assert.equal(selectOmpPermissionOptionId(request, "acceptAlways"), "allow-always");
  assert.equal(selectOmpPermissionOptionId(request, "accept"), "allow-once");
  assert.equal(selectOmpPermissionOptionId(request, "decline"), "reject-once");
});

it("maps every always-allow decision to allow_once when OMP omits allow_always", () => {
  const request = ompPermissionRequest([
    { optionId: "allow-once", kind: "allow_once" },
    { optionId: "reject-once", kind: "reject_once" },
  ]);

  assert.equal(selectOmpPermissionOptionId(request, "acceptForSession"), "allow-once");
  assert.equal(selectOmpPermissionOptionId(request, "acceptAlways"), "allow-once");
});

it("skips blank option ids instead of cancelling the approval", () => {
  const request = ompPermissionRequest([
    { optionId: "   ", kind: "allow_always" },
    { optionId: "allow-always-2", kind: "allow_always" },
    { optionId: "  ", kind: "reject_once" },
    { optionId: "reject-once-2", kind: "reject_once" },
  ]);

  assert.equal(selectOmpPermissionOptionId(request, "acceptForSession"), "allow-always-2");
  assert.equal(selectOmpPermissionOptionId(request, "decline"), "reject-once-2");
});

it("returns undefined when OMP offers no usable option of any fallback kind", () => {
  const request = ompPermissionRequest([{ optionId: "  ", kind: "allow_once" }]);

  assert.equal(selectOmpPermissionOptionId(request, "accept"), undefined);
  assert.equal(selectOmpPermissionOptionId(request, "acceptAlways"), undefined);
});
