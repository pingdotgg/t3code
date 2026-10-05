import { resolveBranchScope, type BranchScope } from "@/Neon/BranchScope";
import { providers } from "@/Neon/Providers";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: providers() });

test.provider(
  "explicit branch scope and conflicting-scope rejection",
  () =>
    Effect.gen(function* () {
      expect(
        yield* resolveBranchScope({
          branch: { projectId: "project", branchId: "branch" },
        }),
      ).toEqual({ projectId: "project", branchId: "branch" });
      // @ts-expect-error Scope alternatives are mutually exclusive, including for JavaScript callers at runtime.
      const conflict: BranchScope = {
        project: { projectId: "project" },
        branch: { projectId: "project", branchId: "branch" },
      };
      expect(
        Result.isFailure(
          yield* resolveBranchScope(conflict).pipe(Effect.result),
        ),
      ).toBe(true);
      expect(
        // @ts-expect-error A scope declaration is required.
        Result.isFailure(yield* resolveBranchScope({}).pipe(Effect.result)),
      ).toBe(true);
    }),
  { tags: ["provider:neon", "provider:neon:branch", "live"] },
);
