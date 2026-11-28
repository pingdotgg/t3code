import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);

const UNPUBLISHED_SERVER_REASON =
  "Hyakki does not publish its server yet; install it on that machine from source.";

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(() =>
  Effect.succeed(
    NpmRelease.of({
      get: Effect.fn("NpmRelease.get")(function* (input) {
        yield* decodeInput(input).pipe(
          Effect.mapError(
            () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
          ),
        );
        return yield* new ServerNpmReleaseError({ reason: UNPUBLISHED_SERVER_REASON });
      }),
    }),
  ),
);

export const layer = Layer.effect(NpmRelease, make());
