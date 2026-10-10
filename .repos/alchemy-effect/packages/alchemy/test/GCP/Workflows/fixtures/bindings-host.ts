import * as GCP from "@/GCP";
import * as Effect from "effect/Effect";
import { serveProbes } from "../../bindingHost.ts";

/** Workflow that echoes its `name` argument. */
export const Greet = GCP.Workflows.Workflow("Greet", {
  location: "us-central1",
  sourceContents: `main:
  params: [args]
  steps:
    - done:
        return: \${"hello " + args.name}
`,
});

/**
 * Effect-native Cloud Run service exercising the Workflows binding as its
 * own runtime service account. Deployed from {@link ../Bindings.test.ts}.
 */
export default class WorkflowsBindingsHost extends GCP.Function<WorkflowsBindingsHost>()(
  "WorkflowsBindingsHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const createExecution = yield* GCP.Workflows.CreateExecution(Greet);

    return {
      fetch: serveProbes({
        createExecution: createExecution({
          body: { argument: JSON.stringify({ name: "alchemy" }) },
        }),
      }),
    };
  }).pipe(Effect.provide(GCP.Workflows.CreateExecutionHttp)),
) {}
