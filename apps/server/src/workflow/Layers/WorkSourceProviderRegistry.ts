import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { WorkSourceProviderName } from "@t3tools/contracts/workSource";

import {
  AsanaProvider,
  GithubIssuesProvider,
  JiraProvider,
  WorkSourceProviderRegistry,
  type WorkSourceProviderRegistryShape,
} from "../Services/WorkSourceProvider.ts";

const make = Effect.gen(function* () {
  const github = yield* GithubIssuesProvider;
  const asana = yield* AsanaProvider;
  const jira = yield* JiraProvider;

  return {
    // Exhaustive dispatch: a `default` that returns asana would silently
    // misroute any future provider literal (e.g. 'linear') added to
    // WorkSourceProviderName but not wired here. Fail fast instead so the gap
    // is loud at runtime, and let the `never` assignment make it a compile
    // error too once the union grows.
    get: (provider: WorkSourceProviderName) => {
      switch (provider) {
        case "github":
          return github;
        case "asana":
          return asana;
        case "jira":
          return jira;
        default: {
          const unknown: never = provider;
          throw new Error(`Unknown work-source provider: ${String(unknown)}`);
        }
      }
    },
  } satisfies WorkSourceProviderRegistryShape;
});

export const WorkSourceProviderRegistryLive = Layer.effect(WorkSourceProviderRegistry, make);
