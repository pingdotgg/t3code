import { ServiceMap } from "effect";

import type { TextGenerationShape } from "./TextGeneration.ts";

export class CodexTextGenerationBackend extends ServiceMap.Service<
  CodexTextGenerationBackend,
  TextGenerationShape
>()("t3/git/Services/TextGenerationBackends/CodexTextGenerationBackend") {}

export class ClaudeTextGenerationBackend extends ServiceMap.Service<
  ClaudeTextGenerationBackend,
  TextGenerationShape
>()("t3/git/Services/TextGenerationBackends/ClaudeTextGenerationBackend") {}
