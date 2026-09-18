/**
 * The pack hasher as an AWS Lambda (DESIGN §22.11): an Effect-native
 * Function that answers {@link HashEvent}s — the same scan the Worker runs
 * inline, on a core several times faster and, above all, on as many cores
 * as there are chunks in flight. Declare it in the same stack as the Git
 * Worker (the stack needs both provider sets) and hand it to
 * {@link HasherLambda}.
 *
 * **Example:** A Git host that hashes pushes on Lambda
 * ```typescript
 * import * as Git from "alchemy/Git";
 * import * as GitHasher from "alchemy/Git/Hasher";
 *
 * const GitLive = Git.ApiLive.pipe(
 *   Layer.provide(Git.ApiHandlersLive),
 *   Layer.provide(Authentication.layer),
 *   Layer.provide(Git.ReposDurableObject),
 *   Layer.provide(Git.RegistryDurableObject),
 *   Layer.provide(GitHasher.HasherLambda(GitHasher.HasherFunction)),
 *   Layer.provide(AWS.Lambda.InvokeFunctionHttp),
 *   Layer.provide(Git.BlobStoreR2(GitObjects)),
 * );
 * ```
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Lambda from "../../AWS/Lambda/Function.ts";
import { handleHashEvent, isHashEvent } from "./LambdaEvent.ts";

export default class HasherFunction extends Lambda.Function<HasherFunction>()(
  "GitHasher",
  {
    main: import.meta.url,
    // CPU scales with memory on Lambda; 3 GB is the fastest single-thread
    // tier and a chunk needs well under that.
    memorySize: 3008,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    const fn = yield* Lambda.Function;
    yield* fn.listen((event: unknown) =>
      isHashEvent(event) ? handleHashEvent(event) : undefined,
    );
    return {};
  }),
) {}
