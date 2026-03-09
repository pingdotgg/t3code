import { Effect, Layer } from "effect";

import { VcsCore } from "../Services/VcsCore.ts";
import { VcsManager, type VcsManagerShape } from "../Services/VcsManager.ts";

const makeVcsManager = Effect.gen(function* () {
  const vcsCore = yield* VcsCore;
  return {
    status: vcsCore.status,
    listRefs: vcsCore.listRefs,
    createWorkspace: vcsCore.createWorkspace,
    removeWorkspace: vcsCore.removeWorkspace,
    createRef: vcsCore.createRef,
    checkoutRef: vcsCore.checkoutRef,
    init: vcsCore.init,
  } satisfies VcsManagerShape;
});

export const VcsManagerLive = Layer.effect(VcsManager, makeVcsManager);
