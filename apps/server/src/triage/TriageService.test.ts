import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as TriageService from "./TriageService.ts";

// [fork:lockdown] Tripwire: in-app triage must refuse, so no playbook, source
// clone or diagnostic session is ever prepared. Invariant 4 in AGENTS.md.
it.effect("refuses to prepare a triage session", () =>
  Effect.gen(function* () {
    const triage = yield* TriageService.TriageService;
    const error = yield* triage.prepare({ client: {} }).pipe(Effect.flip);
    assert.equal(error._tag, "ServerPrepareTriageError");
  }).pipe(Effect.provide(TriageService.layer)),
);
