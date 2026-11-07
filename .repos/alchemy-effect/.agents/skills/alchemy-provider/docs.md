# Provider docs

A provider ships two kinds of docs, and both have a bar:

- **The API reference**, generated from JSDoc by `pnpm docs:gen` into
  `website/src/content/docs/providers/<P>/`. Never edit it by hand.
- **The hub**, hand-written pages under
  `website/src/content/docs/<provider>/`.

## API reference (JSDoc)

The generated reference page is the first thing a user reads about a
resource, and it is only as good as the JSDoc on the source. The bar
depends on how much the resource is used. Compare every runtime and
fat-head resource side by side with its AWS or Cloudflare counterpart
before you call it done.

Azure missed this bar. `Azure.Functions.Function` shipped with two
examples, an HTTP handler and a schedule, while `AWS.Lambda.Function`
has 21 across eleven sections. Its fat-head resources had 2–5 examples
each, against 10–21 for S3 Bucket, SQS Queue and R2 Bucket.

### Runtimes

Copy the shape of `packages/aws/src/Lambda/Function.ts` and
`packages/cloudflare/src/Workers/Worker.ts`. A runtime's JSDoc has:

- **An intro** that says what the runtime is, what Alchemy creates and
  owns for you (role or identity, registry, plan), what it does not own,
  and the forms it takes (async, Effect, image). Link to the hub's
  compute page.
- **`:::caution` callouts** for platform behavior that will bite
  (finalizers and response timing, cold starts, read-only file systems,
  size limits), each with a link to the hub page that explains it.
- **One section per form**: `### Async …` with the stack declaration and
  the handler file, `### Effect …` with a construction/runtime split, and
  a section for container images if the runtime takes them.
- **`### Configuration`**: one example per common setup (public URL and
  its auth, networking, scaling and concurrency, retries and failure
  destinations, architecture, environment).
- **Packaging**: bundling options and native packages, or the Dockerfile
  contract.
- **One `### <Service> Bindings` section per service** with bindings the
  runtime uses (storage, database, queue, topic, secrets), each showing
  the binding in construction and its call at runtime.
- **`### Event Sources`**: one example per trigger the runtime supports.
- **Storage mounts, networking, and other attachments** the runtime
  supports, one section each.

Aim for ten or more examples. If you have fewer, find which section is
missing.

### Fat-head resources

The 10–20 resources most apps use (see the PR description in step 10).
Copy `packages/aws/src/S3/Bucket.ts`, `packages/aws/src/SQS/Queue.ts`
and `packages/cloudflare/src/R2/Bucket.ts`:

- **An intro**: what it is in user terms, the secure defaults Alchemy
  applies, and what replacing it costs (data loss, downtime).
- **`### Creating …`**: the minimal declaration, then the common
  variants (sizes, tiers, regions, serverless vs provisioned).
- **One section per feature users configure**: encryption, lifecycle or
  retention, CORS, dead-letter queues, custom domains, networking,
  backups, scaling. Each is a heading with one or more examples.
- **`### Binding to a runtime`**: the binding inside a host, with its
  `Effect.provide(...)` layer, and the role or grant it gives.
- **`### Runtime operations`**: the calls users make through the binding.
- **`### Event sources`** when the resource triggers runtimes.
- **Adoption and deletion** when they behave in a way users must know
  (`forceDestroy`, retained data, soft delete, name reuse windows).

Aim for five sections or more.

### Long tail

Everything else gets, at minimum:

- An intro naming the cloud's resource type (the ARM type, API resource,
  or console name), what it's for, and a docs link.
- One realistic creation example that declares or names every value it
  uses.
- A `:::caution` for each prop whose change replaces the resource, and
  for each prerequisite a fresh account trips on (a feature to register,
  a quota, a parent resource that must exist).

### Every page

- Every prop and attribute has JSDoc with its unit, allowed values,
  `@default`, and whether changing it replaces the resource.
- Every snippet either declares what it uses or is clearly a fragment
  inside a host (`// init` and `// runtime` comments, as on Lambda).
- Every `@binding` example shows the host and its `Effect.provide(...)`
  layer.
- Section headings are `###`, examples are `**Example:**`, and the
  generator tags (`@resource`, `@binding`, `@category`, …) come last;
  run `pnpm docs:check-jsdoc`.

## The hub

The hub copies the AWS hub (`website/src/content/docs/aws/`), not the
order the provider was built in. GCP's first hub was four long "guides"
that walked the examples end to end. It had no tutorial, no per-service
pages, prose that narrated internals, and snippets without imports. It
was rebuilt to match AWS in alchemy-run/alchemy#2374. Use the rebuilt
GCP hub (`website/src/content/docs/gcp/`) as the model, and compare each
page with its AWS sibling before you write it.

### Structure

```
<P>
├─ Overview · Setup
├─ Tutorial       Part 1–5: first resource → first runtime → Testing → Stages → CI/CD
├─ Compute        Choosing a runtime · one page per runtime
├─ Frontend       Overview (websites) + one page per framework
├─ APIs           Effect HTTP · Effect RPC
├─ Data           one page per database / storage service
├─ AI             one page per AI service
├─ Messaging      one page per queue / topic / event source
├─ Security       IAM & bindings · secrets and keys
├─ Observability  logging and monitoring
└─ Networking     networks, private services, custom domains
```

Leave out a section only when the provider has nothing for it, and pick
section names that fit the provider: a section name must tell its pages
apart from the rest of the hub, so a database-only provider has no
"Data" section. Every page except Overview and Setup sits in a section.
There is no `guides/` directory.

| Path | Content |
| --- | --- |
| `index.mdx` | Overview: one sentence on what the user gets, one complete runtime-plus-binding snippet, links to Setup and the tutorial, then a link list per section |
| `setup.mdx` | credentials, the profile command, CI env vars |
| `tutorial/part-1.mdx` … `part-5.mdx` | the same five parts as AWS: "Your First Stack" (one storage resource), "Add a <Runtime>" (bind it, GET/PUT routes), "Testing", "Stages", "CI/CD" (the cloud's keyless CI auth, e.g. OIDC or Workload Identity Federation) |
| `compute/choosing-a-runtime.mdx` | one line per runtime, then a table comparing entry point, triggers, cost, packaging, and deploy time |
| `compute/<runtime>.mdx` | one per runtime the provider hosts |
| `frontend/websites.mdx` + `frontend/<framework>.mdx` | one per `<P>.Website.<Framework>` (step 7), same file names as `aws/frontend/` |
| `apis/effect-http-api.mdx`, `apis/effect-rpc.mdx` | Effect HTTP and RPC servers on the default runtime |
| `<section>/<service>.mdx` | one page per service a user builds with |

### Every hub page

- **Code comes from what's tested**: the `examples/<provider>-*` projects
  and the resource JSDoc examples. If a page needs code no example has,
  add it to an example and deploy it first.
- **Whole files.** Every block with `import` lines is a complete file
  with a `// path` comment on its first line. No `...` elisions, no
  `yield*` at module scope. Declare resources as module-scope consts and
  pass the declaration straight to bindings and props.
- **Small steps.** Each `##` heading does one thing: one or two short
  lines, then the snippet. A follow-up change is a `diff lang="typescript"`
  block whose first line is a column-0 context line (the `// path`
  comment), or the website build rejects it.
- **Talk to the reader.** Second person, present tense, an instruction or
  something they'll see: "Run `alchemy deploy`. `site.url` is the service
  URL." Don't narrate what Alchemy does inside, why a limitation exists,
  or the docs' own structure ("this page", "Part 3 is where"). Use plain
  words: create, not mint/provision.
- **State the grant.** Every binding section says which role it grants
  and that it only covers the bound resource.
- **No dumps.** No "three ideas" framing, no bullet lists explaining one
  snippet (split it into headings), no whole-file embeds as explanation.
  Tables only where they map things, like the runtime comparison.
- **Frontmatter**: `title` and a one-sentence `description` that says
  what the reader does on the page. Tutorial parts add `sidebar.order`.

A data or messaging page follows `gcp/data/firestore.mdx`: create the
resource, bind it to a service with the Read/Write/ReadWrite choice and
the role it grants, then one heading per operation (read, write, update,
query, delete), each a short block inside the handler.

A framework page follows `gcp/frontend/astro.mdx`: install the build
integration as a dev dependency (`<PackageManagers dev=… />`), deploy the
site from `alchemy.run.ts`, then one heading per option (env, assets,
domain, `alchemy dev`).

### Wiring

- `website/astro.config.ts`: the hub's sidebar. Overview, Setup,
  `Tutorial` (autogenerated from `<provider>/tutorial`), one group per
  section, `sortFrontendItems([...])` for Frontend, and
  `providerResourcesEntry("<P>")` last.
- `website/src/docs-icons.ts`: every new section label has an icon in
  `GROUP_ICONS`.
- `website/src/docs-tabs.ts` and
  `website/src/components/ProviderDirectory.astro`: the hub's tab and its
  card.
- `website/scripts/generate-llms-txt.ts`: a "start here" section
  (`<provider>/index`, `<provider>/setup`), then one
  `{ heading: "<P> — <Section>", pages: { directory: "<provider>/<section>" } }`
  per section.
- `website/src/worker.ts` `REDIRECTS`: when a page moves or is removed,
  map the old path to its closest new page.

## Check

```sh
pnpm docs:check-jsdoc && pnpm docs:gen
pnpm docs:check   # builds the website, including the diff-block and link checks
```

Then read the hub next to AWS's sidebar: every AWS section either has a
`<P>` counterpart or the provider has nothing for it.
