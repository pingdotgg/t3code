---
title: "Part 1: Your First Stack"
description: Install Alchemy, create a Stack with a Cloudflare R2 Bucket, and deploy it.
sidebar:
  order: 1
---

import Terminal from "../../../components/Terminal.astro";
import StateStoreBootstrap from "../../../components/marketing-islands/StateStoreBootstrap.tsx";
import { Code, Tabs, TabItem } from "@astrojs/starlight/components";
import { effectVersion } from "../../../versions";

export const pkgs = `"alchemy@next" "effect@${effectVersion}" "@effect/platform-bun@${effectVersion}" "@effect/platform-node@${effectVersion}"`;

In this first part you'll install Alchemy and Effect, create a Stack
with a Cloudflare R2 Bucket, and deploy it — all in under five
minutes.

## Prerequisites

- [Bun](https://bun.sh) (recommended) or Node.js 22+
- A [Cloudflare](https://dash.cloudflare.com/sign-up) account

## Create a project

Start with an empty directory and initialize a `package.json`:

<Tabs syncKey="pkgManager">
  <TabItem label="bun" icon="bun">
    <Code code="mkdir my-app && cd my-app && bun init -y" lang="sh" />
  </TabItem>
  <TabItem label="npm" icon="npm">
    <Code code="mkdir my-app && cd my-app && npm init -y" lang="sh" />
  </TabItem>
  <TabItem label="pnpm" icon="pnpm">
    <Code code="mkdir my-app && cd my-app && pnpm init" lang="sh" />
  </TabItem>
  <TabItem label="yarn" icon="seti:yarn">
    <Code code="mkdir my-app && cd my-app && yarn init -y" lang="sh" />
  </TabItem>
</Tabs>

## Install dependencies

Install <code>alchemy@next</code> and <code>effect@{effectVersion}</code>:

<Tabs syncKey="pkgManager">
  <TabItem label="bun" icon="bun">
    <Code code={`bun add ${pkgs}`} lang="sh" />
  </TabItem>
  <TabItem label="npm" icon="npm">
    <Code code={`npm install ${pkgs}`} lang="sh" />
  </TabItem>
  <TabItem label="pnpm" icon="pnpm">
    <Code code={`pnpm add ${pkgs}`} lang="sh" />
  </TabItem>
  <TabItem label="yarn" icon="seti:yarn">
    <Code code={`yarn add ${pkgs}`} lang="sh" />
  </TabItem>
</Tabs>

:::tip
We recommend Bun for the best development experience, but Node.js
works too.
:::

## Create the Stack

Every Alchemy program starts with a `Stack` — a collection of
Resources managed by Providers with state tracked between deploys.

Create an `alchemy.run.ts` file:

```typescript twoslash
// @errors: 2345
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
  },
  Effect.gen(function* () {
    // we'll add resources here next
  }),
);
```

TypeScript is unhappy: the `state` property is required. Every Stack
needs a **state store** so Alchemy can persist resource state between
deploys and compute diffs against your infrastructure.

## Configure state

For this tutorial we'll use `Cloudflare.state()`, which persists state
in a Cloudflare-hosted Worker backed by a Durable Object:

```typescript twoslash
// alchemy.run.ts
import * as Alchemy from "alchemy";
+import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
+   state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    // we'll add resources here next
  }),
);
```

The first time you run `alchemy deploy`, `plan`, or `dev`, Alchemy
will prompt for permission and bootstrap the state-store Worker into
your Cloudflare account. It looks like this:

<StateStoreBootstrap client:visible />

This is a one-time event — the state-store Worker, its Durable
Object, and the Secrets Store entries holding its auth token and
encryption key are reused across every stack and stage on this
Cloudflare account. See [State Store](/concepts/state-store) for
the full picture.

:::note[Other state stores]
Don't want to deploy a Worker just for state? Swap `Cloudflare.state()`
for `State.localState()` from `alchemy/State` to keep state on disk
under `.alchemy/`, or [write your own](/concepts/state-store).
:::

## Add a Resource

Resources represent cloud infrastructure — buckets, queues, functions,
databases, and so on. Each resource is `yield*`-ed inside the Stack's
Effect generator.

Let's add a Cloudflare R2 Bucket to our Stack and observe the type error:

```typescript twoslash errorReplace='ProviderCollectionShape<"Cloudflare">::Cloudflare.Providers'
// @errors: 2322
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Layer.empty,
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
+   const bucket = yield* Cloudflare.R2Bucket("Bucket");
  }),
);
```

TypeScript is telling us that `Layer.empty` doesn't provide
`Cloudflare.Providers` — the layer required by `R2Bucket`.

## Fix the Providers

Replace `Layer.empty` with `Cloudflare.providers()` to resolve the
type error:

```typescript twoslash
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
-import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "MyApp",
  {
+   providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket("Bucket");
  }),
);
```

Now the program type-checks. The providers layer tells Alchemy how to
talk to Cloudflare's APIs, and the type system ensures you never
forget to wire it up.

## Return Stack outputs

Stack outputs let you see important values after a deploy. Return an
object from the generator to expose them:

```typescript twoslash
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket("Bucket");

+   return {
+     bucketName: bucket.bucketName,
+     //    ^?
    };
  }),
);
```

## Deploy

Run `alchemy deploy` to create the Bucket on Cloudflare:

<Tabs syncKey="pkgManager">
  <TabItem label="bun" icon="bun">
    <Code code="bun alchemy deploy" lang="sh" />
  </TabItem>
  <TabItem label="npm" icon="npm">
    <Code code="npm run alchemy deploy" lang="sh" />
  </TabItem>
  <TabItem label="pnpm" icon="pnpm">
    <Code code="pnpm alchemy deploy" lang="sh" />
  </TabItem>
  <TabItem label="yarn" icon="seti:yarn">
    <Code code="yarn alchemy deploy" lang="sh" />
  </TabItem>
</Tabs>

The first time you deploy, Alchemy walks each provider in your stack
through an interactive login and saves the credentials to your
**`default`** [profile](/concepts/profiles) at
`~/.alchemy/profiles.json`. For Cloudflare you can sign in with
OAuth in the browser or paste an API token — no environment
variables or `wrangler login` required.

:::tip
To re-run the credential prompt later (e.g. to switch from OAuth to
an API token, or to add a `prod` profile) use
`alchemy login --configure` or
`alchemy login --profile prod --configure`.
:::

<Terminal content={`[u]Plan[/u]: [g]1 to create[/g]
[g]+[/g] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d]

Proceed?
◉ Yes ○ No
[g]✓[/g] [b]Bucket[/b] [d](Cloudflare.R2Bucket)[/d] [g]created[/g]
{
[s2]bucketName: "myapp-bucket-a1b2c3d4e5",
}`} />

Alchemy shows a plan, asks for confirmation, creates the resource,
and prints the stack outputs. Your bucket is live on Cloudflare.

:::tip
By convention, Alchemy looks for `alchemy.run.ts` at the root of your
project. You can specify a different file with
`alchemy deploy <file>`.
:::

## Verify it worked

Your newly created R2 bucket will be listed on the [Cloudflare R2 Object Storage Dashboard](https://dash.cloudflare.com/?to=/:account/r2/overview).

Run `alchemy deploy` again. Because nothing changed, the bucket shows
as a no-op:

<Terminal content={`[u]Plan[/u]: [d]no changes[/d]

{
[s2]bucketName: "myapp-bucket-a1b2c3d4e5",
}`} />

This is the core loop — declare resources in code, deploy, and
Alchemy figures out what changed.

## Recap

You now have:

- An `alchemy.run.ts` with a Stack and a Cloudflare R2 Bucket
- A live bucket deployed to your Cloudflare account
- Stack outputs showing the bucket name

In [Part 2](/tutorial/part-2), you'll add a Cloudflare Worker that
uses this bucket to serve HTTP requests.
