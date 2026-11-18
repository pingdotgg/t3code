import { AIGateway } from "@alchemy.run/neon/AIGateway";
import type { Branch } from "@alchemy.run/neon/Branch";
import type { Credential } from "@alchemy.run/neon/Credential";
import type { Project } from "@alchemy.run/neon/Project";
import { QueryAIGateway } from "@alchemy.run/neon/QueryAIGateway";
import { expect, test } from "@alchemy.run/test";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type { LanguageModel } from "effect/ai/LanguageModel";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

const typeCases = (project: Project, branch: Branch, credential: Credential) =>
  Effect.gen(function* () {
    const gateway = yield* AIGateway("ExplicitOutputs", {
      branch: { projectId: project.projectId, branchId: branch.branchId },
      credential,
    });
    yield* AIGateway("BranchRef", { branch, credential });
    yield* AIGateway("ProjectRef", { project, credential });
    yield* AIGateway("ProjectOutput", { project: { projectId: project.projectId }, credential });
    yield* AIGateway("Literal", { branch: { projectId: "project", branchId: "branch" } });
    // @ts-expect-error Exactly one scope is required.
    yield* AIGateway("Both", { branch, project });
    // @ts-expect-error Scope cannot be omitted.
    yield* AIGateway("Neither", { credential });
    const ai = yield* QueryAIGateway(gateway);
    const model: Layer.Layer<LanguageModel, never, RuntimeContext> = ai.model({
      model: "gpt-5-mini",
    });
    const token: Effect.Effect<Redacted.Redacted<string>, never, RuntimeContext> = ai.token;
    // @ts-expect-error Model construction retains its runtime-only requirement.
    const deploymentModel: Layer.Layer<LanguageModel> = ai.model({ model: "gpt-5-mini" });
    // @ts-expect-error Credentials cannot be consumed as plaintext strings.
    const plaintext: Effect.Effect<string, never, RuntimeContext> = ai.token;
    return { model, token, deploymentModel, plaintext };
  });

test.effect(
  "model and construct type assertions are compiled by the workspace check",
  () =>
    Effect.sync(() => {
      expect(typeof typeCases).toBe("function");
    }),
  {
    tags: [
      "unit",
      "provider:neon",
      "provider:neon:aigateway",
      "provider:neon:branch",
      "provider:neon:credential",
      "provider:neon:languagemodel",
      "provider:neon:project",
      "local",
    ],
  },
);
