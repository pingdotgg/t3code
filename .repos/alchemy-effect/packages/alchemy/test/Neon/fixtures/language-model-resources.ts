import * as Neon from "@/Neon";
import * as Effect from "effect/Effect";

export const languageModelProject = Neon.Project("LanguageModelProject", {
  region: "aws-us-east-2",
});
export const languageModelBranch = Effect.gen(function* () {
  return yield* Neon.Branch("LanguageModelBranch", {
    project: yield* languageModelProject,
  });
});
export const languageModelGateway = Effect.gen(function* () {
  const branch = yield* languageModelBranch;
  return yield* Neon.AIGateway("LanguageModelGateway", {
    branch,
  });
});
export const languageModelManagedGateway = Effect.gen(function* () {
  const branch = yield* languageModelBranch;
  const credential = yield* Neon.Credential("LanguageModelCredential", {
    branch,
    scopes: ["ai_gateway:invoke"],
  });
  return yield* Neon.AIGateway("LanguageModelManagedGateway", {
    branch,
    credential,
  });
});
