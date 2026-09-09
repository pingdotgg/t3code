import * as Hetzner from "alchemy/Hetzner";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";

export const API_PORT = 3001;

/**
 * One cpx12 both the API unit and the Website static server share.
 * Matches `Hetzner.Website` auto-create (`cpx12` / `ubuntu-24.04` / `fsn1`).
 */
export const Box = Hetzner.Server("Box", {
  serverType: "cpx12",
  image: "ubuntu-24.04",
  location: "fsn1",
});

/**
 * Hetzner has no managed Postgres. Neon is the Alchemy-managed database
 * the API Service connects to over HTTPS from the Server.
 */
export const NeonProject = Neon.Project("NotesDb", {
  region: "aws-us-east-1",
});

/**
 * Feature branch of {@link NeonProject}. Yield the project first so
 * Branch reconcile sees a resolved `{ projectId }` — a module-scope
 * `project: NeonProject` is planned in parallel and fails with
 * "Invalid Neon project source".
 */
export const NeonBranch = Effect.gen(function* () {
  const project = yield* NeonProject;
  return yield* Neon.Branch("NotesBranch", { project });
});
