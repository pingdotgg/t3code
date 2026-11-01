import { ServerPrepareTriageError, type ServerPrepareTriageInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * [fork:lockdown] Upstream's in-app triage seeds an agent to read the database and logs and file
 * a public issue upstream. That evidence is proprietary here, so every request is refused with no
 * disk or network access, and the capability is not advertised. Tripwire: TriageService.test.ts.
 */ export class TriageService extends Context.Service<
  TriageService,
  {
    readonly prepare: (
      input: ServerPrepareTriageInput,
    ) => Effect.Effect<never, ServerPrepareTriageError>;
  }
>()("t3/triage/TriageService") {}

export const layer = Layer.succeed(
  TriageService,
  TriageService.of({
    prepare: Effect.fn("TriageService.prepare")(function* () {
      return yield* new ServerPrepareTriageError({});
    }),
  }),
);
