import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { layer as PullRequestProviderRegistryLive } from "./PullRequestProviderRegistry.ts";

it.effect("builds the production pull-request provider registry", () =>
  Effect.scoped(Layer.build(PullRequestProviderRegistryLive).pipe(Effect.asVoid)),
);
