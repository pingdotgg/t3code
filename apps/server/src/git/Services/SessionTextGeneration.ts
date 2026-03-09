import { ServiceMap } from "effect";

import type { TextGenerationShape } from "./TextGeneration.ts";

export interface SessionTextGenerationShape extends TextGenerationShape {}

export class SessionTextGeneration extends ServiceMap.Service<
  SessionTextGeneration,
  SessionTextGenerationShape
>()("t3/git/Services/SessionTextGeneration") {}
