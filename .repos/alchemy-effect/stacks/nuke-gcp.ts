import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";

// GCP-only teardown stack: building only the GCP providers keeps
// `pnpm nuke:gcp` from needing (or touching) any other cloud's credentials.
export default Alchemy.Stack(
  "NukeGcp",
  {
    providers: GCP.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {}),
);
