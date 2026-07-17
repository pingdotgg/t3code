import type { KiroSettings } from "@t3tools/contracts";

import { makeKiroAcpRuntime, resolveKiroAcpModelId } from "../provider/acp/KiroAcpSupport.ts";
import { makeGrokTextGeneration } from "./GrokTextGeneration.ts";

export const makeKiroTextGeneration = (
  settings: KiroSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  makeGrokTextGeneration(settings, environment, {
    providerDisplayName: "Kiro",
    resolveModelId: resolveKiroAcpModelId,
    makeAcpRuntime: ({ grokSettings: _grokSettings, ...input }) =>
      makeKiroAcpRuntime({
        ...input,
        kiroSettings: settings,
      }),
  });
