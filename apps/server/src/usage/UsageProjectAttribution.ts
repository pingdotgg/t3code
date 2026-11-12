import type { UsageProject } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export class UsageProjectAttributionReadError extends Schema.TaggedError<UsageProjectAttributionReadError>()(
  "UsageProjectAttributionReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read provider session projects for usage.";
  }
}

export const sessionKey = ProjectStore.usageProjectSessionKey;

export class UsageProjectAttribution extends Context.Service<
  UsageProjectAttribution,
  {
    readonly read: Effect.Effect<
      ReadonlyMap<string, UsageProject>,
      UsageProjectAttributionReadError
    >;
  }
>()("t3/usage/UsageProjectAttribution") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const read = projects.listUsageProjectAttributions().pipe(
    Effect.mapError((cause) => new UsageProjectAttributionReadError({ cause })),
    Effect.withSpan("UsageProjectAttribution.read"),
  );
  return UsageProjectAttribution.of({ read });
});

export const layer = Layer.effect(UsageProjectAttribution, make);
