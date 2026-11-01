import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Effect from "effect/Effect";
import Notes from "./src/Notes.ts";
import { NotesDb } from "./src/resources.ts";

export default Alchemy.Stack(
  "GcpCloudFunctionExample",
  { providers: GCP.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const db = yield* NotesDb;
    const notes = yield* Notes;

    // A 2nd-gen function is served by a Cloud Run service. Granting
    // `roles/run.invoker` to `allUsers` on that service makes the API
    // public; drop this and callers need a Google identity token.
    yield* GCP.IAM.Member("PublicInvoker", {
      kind: "run.service",
      name: notes.service.as<string>(),
      role: "roles/run.invoker",
      member: "allUsers",
    });

    return {
      url: notes.url,
      functionName: notes.name,
      serviceName: notes.service,
      databaseName: db.name,
    };
  }),
);
