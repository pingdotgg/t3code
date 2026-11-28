import { expect, it } from "vite-plus/test";

import { resolveSpeechPresentation } from "./ComposerSpeechButton";

it("keeps a model download below 100 percent while preparing", () => {
  const state = { phase: "preparing", error: null, errorAction: null } as const;
  expect(resolveSpeechPresentation(state, { downloaded: 995, total: 1_000 }).status).toBe(
    "Downloading model 99%",
  );
});
