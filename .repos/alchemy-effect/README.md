<div align="center">

<a href="https://alchemy.run">
  <img src="https://raw.githubusercontent.com/alchemy-run/alchemy/main/images/readme-hero.webp" alt="Alchemy — Infrastructure as Effects" width="360" />
</a>

<br />

[![npm](https://img.shields.io/npm/v/alchemy?style=flat-square&color=3f5a2a&label=alchemy)](https://www.npmjs.com/package/alchemy)
[![license](https://img.shields.io/badge/license-Apache%202.0-3f5a2a?style=flat-square)](./LICENSE)
[![discord](https://img.shields.io/badge/discord-join-3f5a2a?style=flat-square&logo=discord&logoColor=white)](https://alchemy.run/discord)

**Infrastructure-as-Effects** — cloud infrastructure and application logic as a single, type-safe [Effect](https://effect.website) program.

[Docs](https://alchemy.run) · [Tutorial](https://alchemy.run/cloudflare/tutorial/part-1) · [Examples](./examples) · [Discord](https://alchemy.run/discord)

</div>

---

An R2 Bucket, and a Worker that serves files from it:

```typescript
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Uploads = Cloudflare.R2.Bucket("Uploads");

export default Cloudflare.Worker(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Uploads);

    return {
      fetch: Effect.gen(function* () {
        const obj = yield* bucket.get("hello.txt");
        return obj
          ? HttpServerResponse.text(yield* obj.text())
          : HttpServerResponse.text("Not found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketBinding)),
);
```

One `ReadWriteBucket(Uploads)` call adds the Worker binding at deploy time and hands back a typed client at runtime.

---

- **One program, one language.** Resources, Lambdas/Workers, IAM, and SDKs live in the same Effect program — no YAML, no second runtime.
- **Bindings, not glue code.** `AWS.S3.GetObject(bucket)` wires the IAM policy, env var, and a typed SDK call in a single line.
- **Errors in the type system.** Every cloud API failure is a tagged Effect error you handle — or don't — on purpose.
- **Many clouds, one model.** AWS, Cloudflare, GCP, Fly, Hetzner, Kubernetes, Railway, Neon, PlanetScale, Stripe, and more.
- **Same code, every stage.** Local dev, `plan` / `deploy`, smoke tests, and CI all share one mental model.

```sh
pnpm add alchemy@latest effect @effect/platform-bun @effect/platform-node
```

## GitHub Action

Use the root action to deploy `prod` from `main`, deploy PR previews as
`staging-{number}`, and destroy PR previews when the PR closes:

```yaml
- uses: alchemy-run/alchemy@main
  env:
    CLOUDFLARE_ACCOUNT_ID: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The workflow must install the `alchemy` CLI before this action runs.

## Bootstrap with an AI coding agent

Paste this into Claude Code, Cursor, or any agent that can fetch a URL:

```
You are an Alchemy expert. Read https://alchemy.run/llms.txt to load the
full documentation index, then act as my pair on this project.

Goal: help me set up, build, test, and deploy a cloud application with
`alchemy` (Infrastructure-as-Effects, powered by Effect).

Follow the patterns from the docs and the /examples folder. Stay idiomatic
to Effect: use Layers for wiring, return Effects from lifecycle code, and
keep infra and runtime in the same program. Ask before introducing new
dependencies or breaking conventions.
```

## Learn more

- [What is Alchemy?](https://alchemy.run/what-is-alchemy) — the framework in 2 minutes
- [Getting Started](https://alchemy.run/getting-started) — your first Stack
- [Tutorial](https://alchemy.run/cloudflare/tutorial/part-1) — build, test, and deploy a Cloudflare app step by step
- [Examples](./examples) — runnable projects on AWS and Cloudflare
- [llms.txt](https://alchemy.run/llms.txt) — agent-ready documentation index

> **alchemy** v2 is in beta. Expect breaking changes. Come hang in our [Discord](https://alchemy.run/discord).

## Credits

### Blacksmith

Thanks to [Blacksmith](https://blacksmith.sh/?ref=alchemy.run) for sponsoring our CI runners. Their fast Linux, macOS, and Windows runners help us test our packages across platforms and deploy our content-heavy website in mere minutes.

## License

Licensed under the [Apache License 2.0](./LICENSE). See
[Third-Party Licenses](./THIRD_PARTY_LICENSES.md) for code incorporated from
upstream projects.
