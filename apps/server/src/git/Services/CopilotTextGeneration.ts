import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { TextGenerationError } from "../Errors.ts";
import type {
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
} from "./TextGeneration.ts";

export interface CopilotTextGenerationShape {
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;
  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;
}

export class CopilotTextGeneration extends ServiceMap.Service<
  CopilotTextGeneration,
  CopilotTextGenerationShape
>()("t3/git/Services/CopilotTextGeneration") {}
