# @alchemy.run/git

A pluggable, self-hostable git server for [Alchemy](https://alchemy.run), built on Cloudflare Workers, Durable Objects, and R2. It serves smart HTTP to any git client, plus a typed REST API with pull requests and a GitHub-compatible surface.

```sh
npm install alchemy @alchemy.run/git @alchemy.run/cloudflare effect
```

A git host behind one shared secret:

```typescript
// src/git.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Git from "@alchemy.run/git";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

export const GitObjects = Cloudflare.R2.Bucket("GitObjects");
export const GitSecret = Effect.gen(function* () {
  const Random = yield* Alchemy.Random;
  return yield* Random("GitSecret");
});

/** The shared secret, sent as the HTTP Basic password. */
export const Authentication = HttpRouter.middleware(
  Effect.gen(function* () {
    const secret = yield* (yield* GitSecret).text;
    return (httpEffect) =>
      Effect.gen(function* () {
        const { password } = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.basic);
        if (Redacted.value(password) === Redacted.value(yield* secret)) {
          return yield* httpEffect;
        }
        return HttpServerResponse.empty({
          status: 401,
          headers: { "www-authenticate": 'Basic realm="git"' },
        });
      }).pipe(Effect.provide(Alchemy.RuntimeContext.phantom));
  }),
);

const GitLive = Layer.mergeAll(
  Git.ApiLive.pipe(Layer.provide(Authentication.layer)),
  Git.InternalApiLive,
).pipe(
  Layer.provide(Git.ApiHandlersLive),
  Layer.provide(Git.ReposDurableObject), // refs, objects, pull requests
  Layer.provide(Git.RegistryDurableObject), // owner/name → repo
  Layer.provide(Git.HasherInline), // push verification
  Layer.provide(Git.BlobStoreR2(GitObjects)), // packs and large pushes
  Layer.provide(Http.Platform),
);

export default class GitHost extends Cloudflare.Worker<GitHost>()(
  "Git",
  { main: import.meta.url, ...Git.GIT_WORKER_OPTIONS },
  Effect.gen(function* () {
    const fetch = yield* HttpRouter.toHttpEffect(GitLive);
    return { fetch };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
) {}
```

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import GitHost, { GitSecret } from "./src/git.ts";

export default Alchemy.Stack(
  "GitService",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const git = yield* GitHost;
    const secret = yield* GitSecret;
    return {
      url: git.url.as<string>(),
      secret: Output.map(secret.text, Redacted.value),
    };
  }),
);
```

After `alchemy deploy`, `git clone` and `git push` work against the printed URL.

## Learn more

- [Git on alchemy.run](https://alchemy.run/git)
- [Getting started](https://alchemy.run/git/getting-started)
- [Tutorial](https://alchemy.run/git/tutorial/part-1)
