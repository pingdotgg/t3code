## v2.0.0-beta.65

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - **sagemaker**: HyperPod — Slurm & EKS clusters, task governance, workload DX &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/924 [<samp>(e13e3)</samp>](https://github.com/alchemy-run/alchemy/commit/e13e36db)
- **cli**:
  - **nuke**: Independent retries and identity/network delete-last tier &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/950 [<samp>(0f291)</samp>](https://github.com/alchemy-run/alchemy/commit/0f2914d9)
- **docker**:
  - Support container labels and stop timeout &nbsp;-&nbsp; by **Gerben Mulder** in https://github.com/alchemy-run/alchemy/issues/931 [<samp>(dd8cf)</samp>](https://github.com/alchemy-run/alchemy/commit/dd8cf40e)
- **test**:
  - Progress counters and a failed-test list in the plain reporter &nbsp;-&nbsp; by **sam** and **Cursor** [<samp>(7e878)</samp>](https://github.com/alchemy-run/alchemy/commit/7e878d56)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **aws**:
  - Destroy converges in one pass with VPC-attached Lambdas &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/937 [<samp>(4b5d7)</samp>](https://github.com/alchemy-run/alchemy/commit/4b5d7ec4)
- **bundle**:
  - Stop purePlugin from deleting route registrations in user code &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/952 [<samp>(1c33d)</samp>](https://github.com/alchemy-run/alchemy/commit/1c33d82b)
- **cloudflare**:
  - **vite**:
    - Workflows not exported correctly in vite dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/933 [<samp>(8fc52)</samp>](https://github.com/alchemy-run/alchemy/commit/8fc526ad)
  - **workers**:
    - Send _redirects/_headers contents to Cloudflare &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/928 [<samp>(2bac5)</samp>](https://github.com/alchemy-run/alchemy/commit/2bac5f7b)
    - Enable strictExecutionOrder to prevent cross-chunk TDZ at startup &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/940 [<samp>(306d1)</samp>](https://github.com/alchemy-run/alchemy/commit/306d15ee)
  - **workflows**:
    - Preserve pause control-flow errors in WorkflowBridge &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/934 [<samp>(5c8a6)</samp>](https://github.com/alchemy-run/alchemy/commit/5c8a6eb8)
- **core**:
  - Keep branded primitives opaque in ToOutput &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/941 [<samp>(1b5d5)</samp>](https://github.com/alchemy-run/alchemy/commit/1b5d5a71)
- **sql**:
  - Replay nested proxyChain fragments against the resolved root &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/951 [<samp>(80441)</samp>](https://github.com/alchemy-run/alchemy/commit/804419c1)
- **test**:
  - Restore alchemy/Test/Vitest harness &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/947 [<samp>(4f675)</samp>](https://github.com/alchemy-run/alchemy/commit/4f6754d3)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.64...HEAD)

---

## v2.0.0-beta.64

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **aws**:
  - Generate 100% AWS Resource & Binding coverage &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/797 [<samp>(532c8)</samp>](https://github.com/alchemy-run/alchemy/commit/532c8118)
  - Unified container platforms — ECS Task/Service, EKS Deployment/Job/Manifest, Dockerfile.inline image composition &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/867 [<samp>(4d713)</samp>](https://github.com/alchemy-run/alchemy/commit/4d7139c6)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - **eks**: HelmChart support &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/891 [<samp>(22de7)</samp>](https://github.com/alchemy-run/alchemy/commit/22de7dd3)
  - **rds**: SkipFinalSnapshot option — final snapshot on deliberate teardown &nbsp;-&nbsp; by **Zé Yuri** in https://github.com/alchemy-run/alchemy/issues/877 [<samp>(28ca6)</samp>](https://github.com/alchemy-run/alchemy/commit/28ca6f43)
- **bundle**:
  - Rewrite pure plugin on rolldown 1.1 native MagicString &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/849 [<samp>(dee6f)</samp>](https://github.com/alchemy-run/alchemy/commit/dee6f91d)
- **cloudflare**:
  - **workers**:
    - Add Workers AI binding (Cloudflare.Workers.AI) &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/850 [<samp>(9ea1d)</samp>](https://github.com/alchemy-run/alchemy/commit/9ea1dbfd)
    - Place a Durable Object in a region with locationHint &nbsp;-&nbsp; by **Matthew Aylward** in https://github.com/alchemy-run/alchemy/issues/851 [<samp>(c3ed7)</samp>](https://github.com/alchemy-run/alchemy/commit/c3ed7403)
    - Python Workers (main: worker.py) &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/861 [<samp>(75952)</samp>](https://github.com/alchemy-run/alchemy/commit/75952e4c)
- **drizzle**:
  - D1 support — Drizzle.D1, alchemy/SQL clients, example, docs &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/887 [<samp>(c6551)</samp>](https://github.com/alchemy-run/alchemy/commit/c65518a2)
- **github**:
  - GitHub Enterprise support + Environment resource &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/845 [<samp>(c954a)</samp>](https://github.com/alchemy-run/alchemy/commit/c954a1c2)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Use distilled auto-paginating streams for multi-page list calls &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/915 [<samp>(2f9da)</samp>](https://github.com/alchemy-run/alchemy/commit/2f9da9df)
- Full-suite convergence — provider fixes, flake hardening, bounded test concurrency &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/916 [<samp>(0259b)</samp>](https://github.com/alchemy-run/alchemy/commit/0259b97c)
- **aws**:
  - AWS_REGION env overrides SSO profile/stored region &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/895 [<samp>(fd9a4)</samp>](https://github.com/alchemy-run/alchemy/commit/fd9a4b3a)
  - **ecs**: Task-definition revision reaping + delete-path family/role sweep &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/902 [<samp>(2a884)</samp>](https://github.com/alchemy-run/alchemy/commit/2a8841a6)
  - **rds**: Fingerprint-guard MasterUserPassword — stop re-sending it on every reconcile &nbsp;-&nbsp; by **Zé Yuri** in https://github.com/alchemy-run/alchemy/issues/876 [<samp>(4ae06)</samp>](https://github.com/alchemy-run/alchemy/commit/4ae06dbe)
- **cloudflare**:
  - Handle wasm in vite dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/881 [<samp>(d7eab)</samp>](https://github.com/alchemy-run/alchemy/commit/d7eabde7)
  - **workers**:
    - Register esmExternalRequirePlugin in direct Worker bundler &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/889 [<samp>(15c7b)</samp>](https://github.com/alchemy-run/alchemy/commit/15c7b8e3)
    - Converge plans with Effect-valued env bindings &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/890 [<samp>(96bb9)</samp>](https://github.com/alchemy-run/alchemy/commit/96bb9138)
    - Rely on rolldown-plugin for esmExternalRequire &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/909 [<samp>(3a7c8)</samp>](https://github.com/alchemy-run/alchemy/commit/3a7c880e)
    - Retry asset upload session when completion JWT is missing &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/914 [<samp>(33830)</samp>](https://github.com/alchemy-run/alchemy/commit/33830297)
    - Queue-consumer wiring lost when Consumer reconciles mid workerd start &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/917 [<samp>(0d4df)</samp>](https://github.com/alchemy-run/alchemy/commit/0d4dfc50)
- **engine**:
  - Destroy no longer orphans physical resources of attr-less creating rows &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/862 [<samp>(26883)</samp>](https://github.com/alchemy-run/alchemy/commit/26883b5b)
  - Preserve name uniqueness when createPhysicalName truncates &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/868 [<samp>(d6317)</samp>](https://github.com/alchemy-run/alchemy/commit/d63173c3)
  - Binding-diff stability — plain-data binding persistence + deterministic sid order &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/898 [<samp>(58cfe)</samp>](https://github.com/alchemy-run/alchemy/commit/58cfe0d7)
  - Destroy robustness — aggregated GC failures + fatal zombie rows &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/899 [<samp>(eb63a)</samp>](https://github.com/alchemy-run/alchemy/commit/eb63af6d)
  - --force refreshes stale bound attrs from the forced reconcile &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/900 [<samp>(99b62)</samp>](https://github.com/alchemy-run/alchemy/commit/99b62998)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.63...HEAD)

---

## v2.0.0-beta.63

### &nbsp;&nbsp;&nbsp;🚀 Features

- **action**:
  - Local bindings + Output accessors in Actions &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/807 [<samp>(0da65)</samp>](https://github.com/alchemy-run/alchemy/commit/0da65a76)
- **cli**:
  - Alchemy login works without an alchemy.run.ts &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/842 [<samp>(422fb)</samp>](https://github.com/alchemy-run/alchemy/commit/422fb83d)
- **cloudflare**:
  - **workers**: Declare Durable Object class transfers between workers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/803 [<samp>(33424)</samp>](https://github.com/alchemy-run/alchemy/commit/334241b8)
- **website**:
  - Serve alchemy.run, redirect v2.alchemy.run to it &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/806 [<samp>(85ed5)</samp>](https://github.com/alchemy-run/alchemy/commit/85ed5e30)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Pack durable object metadata into a single script tag &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/824 [<samp>(9642f)</samp>](https://github.com/alchemy-run/alchemy/commit/9642f816)
  - Signal plugin injection to app vite configs via ALCHEMY_CLOUDFLARE_VITE_INJECTED &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/833 [<samp>(5a6ed)</samp>](https://github.com/alchemy-run/alchemy/commit/5a6edd57)
- **drizzle**:
  - Forward Effect membership checks through proxyChain &nbsp;-&nbsp; by **Julian Archila** in https://github.com/alchemy-run/alchemy/issues/827 [<samp>(31026)</samp>](https://github.com/alchemy-run/alchemy/commit/31026041)
- **engine**:
  - Never persist unresolved Output exprs in resource state &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/835 [<samp>(fd18b)</samp>](https://github.com/alchemy-run/alchemy/commit/fd18bf96)
- **planetscale**:
  - Reconcile MySQL replicas without replacing database &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/825 [<samp>(c8079)</samp>](https://github.com/alchemy-run/alchemy/commit/c8079167)
- **runtime**:
  - Reify auto-bound Config markers at request time &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/829 [<samp>(60eb5)</samp>](https://github.com/alchemy-run/alchemy/commit/60eb5529)
- **vite**:
  - Include workspace packages in input hash &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/822 [<samp>(a5a22)</samp>](https://github.com/alchemy-run/alchemy/commit/a5a22a0c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.62...HEAD)

---

## v2.0.0-beta.62

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **cloudflare**:
  - **workers**: Build layers once per isolate, scope resources per event &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/774 [<samp>(25ed5)</samp>](https://github.com/alchemy-run/alchemy/commit/25ed5171)

### &nbsp;&nbsp;&nbsp;🚀 Features

- Add alchemy action and gh env helper &nbsp;-&nbsp; by **Harry Solovay** in https://github.com/alchemy-run/alchemy/issues/699 [<samp>(80753)</samp>](https://github.com/alchemy-run/alchemy/commit/807535ba)
- **cloudflare**:
  - **website**: Forward a custom worker entry (main) to the Vite plugin &nbsp;-&nbsp; by **Daniel Gangl** in https://github.com/alchemy-run/alchemy/issues/779 [<samp>(c7de7)</samp>](https://github.com/alchemy-run/alchemy/commit/c7de74c5)
- **engine**:
  - Thread resource fqn into provider handler inputs &nbsp;-&nbsp; by **Daniel Gangl** in https://github.com/alchemy-run/alchemy/issues/783 [<samp>(20ed8)</samp>](https://github.com/alchemy-run/alchemy/commit/20ed8d24)
- **planetscale**:
  - OAuth login + shared landing pages &nbsp;-&nbsp; by **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/467 [<samp>(5a0be)</samp>](https://github.com/alchemy-run/alchemy/commit/5a0beb1d)
- **website**:
  - OAuth landing pages &nbsp;-&nbsp; by **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/780 [<samp>(1e9d0)</samp>](https://github.com/alchemy-run/alchemy/commit/1e9d0c11)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Upgrade effect to 4.0.0-beta.97 and migrate removed Schedule APIs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/801 [<samp>(89f2d)</samp>](https://github.com/alchemy-run/alchemy/commit/89f2dff1)
- Update dependencies to support effect 4.0.0-beta.97 &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/813 [<samp>(a644c)</samp>](https://github.com/alchemy-run/alchemy/commit/a644c854)
- **bundle**:
  - Read vite build output after buildApp resolves &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/795 [<samp>(87244)</samp>](https://github.com/alchemy-run/alchemy/commit/87244a57)
- **cli**:
  - Respect ALCHEMY_PROFILE in alchemy state clear &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ba705)</samp>](https://github.com/alchemy-run/alchemy/commit/ba70585f)
- **cloudflare**:
  - Support container environment variables in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/785 [<samp>(ae68c)</samp>](https://github.com/alchemy-run/alchemy/commit/ae68cff7)
  - Persist dev image for containers &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/727 [<samp>(d92af)</samp>](https://github.com/alchemy-run/alchemy/commit/d92af2a8)
  - Preserve dev worker registration on reload &nbsp;-&nbsp; by **utopy** in https://github.com/alchemy-run/alchemy/issues/812 [<samp>(9864c)</samp>](https://github.com/alchemy-run/alchemy/commit/9864c8de)
  - Support remote images and external Dockerfiles in LocalContainerProvider &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/790 [<samp>(c9996)</samp>](https://github.com/alchemy-run/alchemy/commit/c999680e)
  - **state**: Bind cached state-store credentials to the account &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/760 [<samp>(726cf)</samp>](https://github.com/alchemy-run/alchemy/commit/726cf9f0)
  - **workers**: Preserve cron handler requirements &nbsp;-&nbsp; by **Jack Bisceglia** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/791 [<samp>(68b35)</samp>](https://github.com/alchemy-run/alchemy/commit/68b359b6)
- **command**:
  - **dev**: Favor localhost/IP URLs in dev-URL detection &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/787 [<samp>(788f4)</samp>](https://github.com/alchemy-run/alchemy/commit/788f4a41)
- **docker**:
  - Unit-suffix Container healthcheck durations &nbsp;-&nbsp; by **Matthew Aylward** in https://github.com/alchemy-run/alchemy/issues/778 [<samp>(fa2c2)</samp>](https://github.com/alchemy-run/alchemy/commit/fa2c206d)
- **engine**:
  - Stop persisting adopted state during plan construction &nbsp;-&nbsp; by **Daniel Gangl** in https://github.com/alchemy-run/alchemy/issues/794 [<samp>(011d5)</samp>](https://github.com/alchemy-run/alchemy/commit/011d526e)
- **local**:
  - Reuse cached provider RPC session in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/789 [<samp>(819a8)</samp>](https://github.com/alchemy-run/alchemy/commit/819a831a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.61...HEAD)

---

## v2.0.0-beta.61

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **cloudflare**:
  - Expand workflows api &nbsp;-&nbsp; by **Gerben Mulder**, **Sam Goodwin** and **John Royal** in https://github.com/alchemy-run/alchemy/issues/611 [<samp>(4b0c5)</samp>](https://github.com/alchemy-run/alchemy/commit/4b0c527b)
  - **workers**: Workers Cache support + Effect-native ExecutionContext &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Fable 5** in https://github.com/alchemy-run/alchemy/issues/752 [<samp>(ff81b)</samp>](https://github.com/alchemy-run/alchemy/commit/ff81bee4)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - **lambda**: Add event invoke config &nbsp;-&nbsp; by **José Netto** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/627 [<samp>(74754)</samp>](https://github.com/alchemy-run/alchemy/commit/74754b7a)
- **cli**:
  - `alchemy sync` — reconcile state drift via read+reconcile &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/766 [<samp>(dcafc)</samp>](https://github.com/alchemy-run/alchemy/commit/dcafc26a)
- **cloudflare**:
  - **Worker**: Add Zone Routes &nbsp;-&nbsp; by **utopy** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/438 [<samp>(dc871)</samp>](https://github.com/alchemy-run/alchemy/commit/dc8717c9)
  - **ai**: Add AI.ProviderKey BYOK composition helper &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/586 [<samp>(8c9bf)</samp>](https://github.com/alchemy-run/alchemy/commit/8c9bfe78)
  - **r2**: Restore cors prop on Bucket &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/771 [<samp>(14409)</samp>](https://github.com/alchemy-run/alchemy/commit/144090f8)
- **engine**:
  - Resource type aliases for safe type renames &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/765 [<samp>(27138)</samp>](https://github.com/alchemy-run/alchemy/commit/27138721)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Require effect >=4.0.0-beta.93 and migrate UrlParams.makeUrl to Url.make &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/748 [<samp>(94451)</samp>](https://github.com/alchemy-run/alchemy/commit/944510ca)
- Guard read/diff recovery paths against lost Output-valued olds &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/770 [<samp>(29df0)</samp>](https://github.com/alchemy-run/alchemy/commit/29df03eb)
- **aws**:
  - **ecs**: Unwedge plan/deploy/destroy after a half-created Service &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/767 [<samp>(70037)</samp>](https://github.com/alchemy-run/alchemy/commit/70037fe1)
- **cli**:
  - Suppress bun's benign tsconfig-override fd warning in dev &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/768 [<samp>(82692)</samp>](https://github.com/alchemy-run/alchemy/commit/826923a3)
- **cloudflare**:
  - Include worker metadata in the update diff &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/747 [<samp>(26221)</samp>](https://github.com/alchemy-run/alchemy/commit/26221009)
  - Fix state-store errors &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/737 [<samp>(6c9b6)</samp>](https://github.com/alchemy-run/alchemy/commit/6c9b67c5)
  - Preserve explicit globalOutbound: null in WorkerLoader &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/746 [<samp>(52be6)</samp>](https://github.com/alchemy-run/alchemy/commit/52be64e2)
  - Classify Resource.ref values as native Worker env bindings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/756 [<samp>(01b4a)</samp>](https://github.com/alchemy-run/alchemy/commit/01b4ae32)
  - Dispatch for multiple queue consumers &nbsp;-&nbsp; by **Leonardo E. Dominguez** in https://github.com/alchemy-run/alchemy/issues/466 [<samp>(a2367)</samp>](https://github.com/alchemy-run/alchemy/commit/a2367665)
  - **workers**:
    - Retry every binding-target-not-found error on script upload &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/753 [<samp>(958b9)</samp>](https://github.com/alchemy-run/alchemy/commit/958b9294)
    - Declare binding-hosted DO classes in the worker precreate stub &nbsp;-&nbsp; by **Daniel Gangl** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/764 [<samp>(93952)</samp>](https://github.com/alchemy-run/alchemy/commit/93952191)
- **drizzle**:
  - Make proxyChain a real Effect so it composes with combinators &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/750 [<samp>(8015f)</samp>](https://github.com/alchemy-run/alchemy/commit/8015f610)
- **planetscale**:
  - Compare inherited roles by membership &nbsp;-&nbsp; by **Gerben Mulder** in https://github.com/alchemy-run/alchemy/issues/761 [<samp>(6ce15)</samp>](https://github.com/alchemy-run/alchemy/commit/6ce15030)
- **test**:
  - Make the test suite pass on Windows &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/735 [<samp>(3c050)</samp>](https://github.com/alchemy-run/alchemy/commit/3c050fe2)
  - Guard RPC test transports against edge-transient HTML responses &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/773 [<samp>(a8570)</samp>](https://github.com/alchemy-run/alchemy/commit/a85708dc)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.60...HEAD)

---

## v2.0.0-beta.60

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - **ec2**: KeyPair resource + hosted Instance HTTP serving &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/714 [<samp>(62f05)</samp>](https://github.com/alchemy-run/alchemy/commit/62f05d39)
  - **lambda**: MicroVM images and CF vs AWS container benchmarks &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/712 [<samp>(7f238)</samp>](https://github.com/alchemy-run/alchemy/commit/7f238498)
- **cli**:
  - --yes auto-upgrades the Cloudflare state store &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/728 [<samp>(c0ced)</samp>](https://github.com/alchemy-run/alchemy/commit/c0cedf76)
- **cloudflare**:
  - Custom vite environments and rsc &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/685 [<samp>(7b866)</samp>](https://github.com/alchemy-run/alchemy/commit/7b866200)
  - Bind Workflows to async Workers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/707 [<samp>(9c7b8)</samp>](https://github.com/alchemy-run/alchemy/commit/9c7b8232)
  - **workers-for-platforms**: Dispatch namespace binding + deploy workers into namespaces &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/715 [<samp>(c9f89)</samp>](https://github.com/alchemy-run/alchemy/commit/c9f8961d)
- **docker**:
  - Add Docker resources &nbsp;-&nbsp; by **Austin** and **John Royal** in https://github.com/alchemy-run/alchemy/issues/649 [<samp>(968bb)</samp>](https://github.com/alchemy-run/alchemy/commit/968bb10f)
- **neon**:
  - Expose pooled origin &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/718 [<samp>(0b60c)</samp>](https://github.com/alchemy-run/alchemy/commit/0b60c38a)
- **planetscale**:
  - Expose pooledOrigin on PostgresRole &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/717 [<samp>(9641b)</samp>](https://github.com/alchemy-run/alchemy/commit/9641be02)
  - Persist PlanetScale branch replica intent &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/719 [<samp>(cfb72)</samp>](https://github.com/alchemy-run/alchemy/commit/cfb72d01)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **aws**:
  - Remove dead DashboardsNotFound invalid tag handling code &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(86b04)</samp>](https://github.com/alchemy-run/alchemy/commit/86b04fe1)
  - Provide Region to STS GetCallerIdentity during login &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/709 [<samp>(3c3e8)</samp>](https://github.com/alchemy-run/alchemy/commit/3c3e852b)
  - Break Region/AWSEnvironment layer cycle in env auth account-id lookup &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/710 [<samp>(351c3)</samp>](https://github.com/alchemy-run/alchemy/commit/351c3f56)
  - **ecs**: Fix effectful ECS containers and add e2e smoke test that actually deploys &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/713 [<samp>(8cd7a)</samp>](https://github.com/alchemy-run/alchemy/commit/8cd7a2e5)
- **cli**:
  - Load the stack entry via a file:// URL so the CLI works on Windows &nbsp;-&nbsp; by **d3lay** in https://github.com/alchemy-run/alchemy/issues/696 [<samp>(2ced8)</samp>](https://github.com/alchemy-run/alchemy/commit/2ced8e0c)
  - Report retained resources during destroy &nbsp;-&nbsp; by **bjorntechTobbe** in https://github.com/alchemy-run/alchemy/issues/739 [<samp>(48021)</samp>](https://github.com/alchemy-run/alchemy/commit/48021c42)
- **cloudflare**:
  - Detect and recover cf state store partial deploy &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/700 [<samp>(37584)</samp>](https://github.com/alchemy-run/alchemy/commit/3758460f)
  - Adopt durable object classes created outside alchemy &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/495 [<samp>(3d063)</samp>](https://github.com/alchemy-run/alchemy/commit/3d06359e)
  - Fold command + env into the memo hash for StaticSite &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/738 [<samp>(36b49)</samp>](https://github.com/alchemy-run/alchemy/commit/36b494dd)
  - Cold-recovery read for Access Application &nbsp;-&nbsp; by **Andy Jefferson** in https://github.com/alchemy-run/alchemy/issues/742 [<samp>(ed44f)</samp>](https://github.com/alchemy-run/alchemy/commit/ed44f238)
  - **containers**:
    - Wrangler-parity defaults and readiness for fast, reliable starts &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/708 [<samp>(c740f)</samp>](https://github.com/alchemy-run/alchemy/commit/c740f0fb)
    - Auto-restart stopped/crashed containers, fail fast on crash &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/711 [<samp>(c1906)</samp>](https://github.com/alchemy-run/alchemy/commit/c1906298)
- **test**:
  - Deflake live test suite and harden Cloudflare providers &nbsp;-&nbsp; by **Sam Goodwin** and **Cursor** [<samp>(6965b)</samp>](https://github.com/alchemy-run/alchemy/commit/6965bf7e)
- **website**:
  - Collapse the tab-row height on mobile &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/734 [<samp>(c85e2)</samp>](https://github.com/alchemy-run/alchemy/commit/c85e2342)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.59...HEAD)

---

## v2.0.0-beta.59

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **bindings**: Remove Binding.Policy and align all bindings to a single convention &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/690 [<samp>(35b04)</samp>](https://github.com/alchemy-run/alchemy/commit/35b04361)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cli**: Export ALCHEMY_DEV config and fix ALCHEMY_PHASE docs &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/684 [<samp>(5c606)</samp>](https://github.com/alchemy-run/alchemy/commit/5c60600f)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - **worker**: Tolerate legacy custom-domain state in Worker diff &nbsp;-&nbsp; by **Nicolas Fléron** in https://github.com/alchemy-run/alchemy/issues/546 and https://github.com/alchemy-run/alchemy/issues/694 [<samp>(f17fa)</samp>](https://github.com/alchemy-run/alchemy/commit/f17fab02)
- **engine**:
  - Honor deleteFirst on replace &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/692 [<samp>(ef6f8)</samp>](https://github.com/alchemy-run/alchemy/commit/ef6f8e4d)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.58...HEAD)

---

## v2.0.0-beta.58

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- Command provider &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/673 [<samp>(e7127)</samp>](https://github.com/alchemy-run/alchemy/commit/e7127f2e)
- **neon**: Replace branch when project changes &nbsp;-&nbsp; by **Harry Solovay** and **John Royal** in https://github.com/alchemy-run/alchemy/issues/654 [<samp>(b21d2)</samp>](https://github.com/alchemy-run/alchemy/commit/b21d2129)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - Add Lambda function memory size &nbsp;-&nbsp; by **Joaquín Pérez** in https://github.com/alchemy-run/alchemy/issues/676 [<samp>(57ce8)</samp>](https://github.com/alchemy-run/alchemy/commit/57ce8300)
  - **lambda**:
    - Support AWS Lambda function architecture &nbsp;-&nbsp; by **Joaquín Pérez** in https://github.com/alchemy-run/alchemy/issues/662 [<samp>(bfa21)</samp>](https://github.com/alchemy-run/alchemy/commit/bfa2181a)
    - Add build.install for native packages &nbsp;-&nbsp; by **Joaquín Pérez** in https://github.com/alchemy-run/alchemy/issues/682 [<samp>(46e48)</samp>](https://github.com/alchemy-run/alchemy/commit/46e484fd)
- **cloudflare**:
  - Allow DurableObjectState and other DO dependencies at plan level, move Tag Props to Layer &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/650 [<samp>(c0ecf)</samp>](https://github.com/alchemy-run/alchemy/commit/c0ecfbe8)
  - **workers**: Rename DynamicWorkerLoader to WorkerLoader + service tag, layer, typed client &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/653 [<samp>(ef336)</samp>](https://github.com/alchemy-run/alchemy/commit/ef336146)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **all**:
  - Use Effect.fn instead of Effect.fnUntraced for better stack traces &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b9676)</samp>](https://github.com/alchemy-run/alchemy/commit/b9676c58)
- **auth**:
  - Bail when configuring a missing profile non-interactively &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/663 [<samp>(3d2cb)</samp>](https://github.com/alchemy-run/alchemy/commit/3d2cbbe4)
- **aws**:
  - Route53 change ID normalization &nbsp;-&nbsp; by **Joaquín Pérez** in https://github.com/alchemy-run/alchemy/issues/675 [<samp>(acf5f)</samp>](https://github.com/alchemy-run/alchemy/commit/acf5fc3d)
- **build**:
  - Key DevServer instances by instanceId, not logical id &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/665 [<samp>(c33f3)</samp>](https://github.com/alchemy-run/alchemy/commit/c33f3b84)
  - Set dev server process to `detached: false` &nbsp;-&nbsp; by **Harry Solovay** in https://github.com/alchemy-run/alchemy/issues/655 [<samp>(c5500)</samp>](https://github.com/alchemy-run/alchemy/commit/c5500e2b)
- **cloudflare**:
  - Re-export dev container image type &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/666 [<samp>(60c56)</samp>](https://github.com/alchemy-run/alchemy/commit/60c56e15)
  - Update workerd to fix dev container bug &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/664 [<samp>(e8630)</samp>](https://github.com/alchemy-run/alchemy/commit/e8630490)
  - Add Workers Observability write OAuth scope &nbsp;-&nbsp; by **Leonardo Trapani** in https://github.com/alchemy-run/alchemy/issues/660 [<samp>(87ed4)</samp>](https://github.com/alchemy-run/alchemy/commit/87ed4a47)
  - StaticSite precreate fails in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/671 [<samp>(884eb)</samp>](https://github.com/alchemy-run/alchemy/commit/884eb3fd)
  - Retry InvalidRoute when checking if state store available &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(34a07)</samp>](https://github.com/alchemy-run/alchemy/commit/34a0767f)
- **core**:
  - Use persisted FQN when deleting resources &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/669 [<samp>(5ef57)</samp>](https://github.com/alchemy-run/alchemy/commit/5ef57925)
  - Resolve stable attributes of whole-resource references &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/670 [<samp>(933d2)</samp>](https://github.com/alchemy-run/alchemy/commit/933d2a09)
- **drizzle**:
  - Fall back to drizzle-kit CLI &nbsp;-&nbsp; by **utopy** in https://github.com/alchemy-run/alchemy/issues/632 [<samp>(27262)</samp>](https://github.com/alchemy-run/alchemy/commit/27262f5d)
- **github**:
  - Resolve lazy secret values &nbsp;-&nbsp; by **Harry Solovay** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/652 [<samp>(351b9)</samp>](https://github.com/alchemy-run/alchemy/commit/351b9a8d)
- **neon**:
  - Project replaces unexpectedly due to default region mismatch &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/667 [<samp>(55597)</samp>](https://github.com/alchemy-run/alchemy/commit/55597d41)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.57...HEAD)

---

## v2.0.0-beta.57

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - VpcOrigin, ListenerRule, TrustStore, HostedZone, HealthCheck &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/631 [<samp>(6f952)</samp>](https://github.com/alchemy-run/alchemy/commit/6f9528ac)
  - **kms**:
    - Add key and alias resources &nbsp;-&nbsp; by **José Netto** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/641 [<samp>(28f7d)</samp>](https://github.com/alchemy-run/alchemy/commit/28f7d3d0)
  - **lambda**:
    - Add alias resource &nbsp;-&nbsp; by **José Netto** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/625 [<samp>(a9e1c)</samp>](https://github.com/alchemy-run/alchemy/commit/a9e1cc53)
    - Support function concurrency &nbsp;-&nbsp; by **José Netto** in https://github.com/alchemy-run/alchemy/issues/628 [<samp>(6857a)</samp>](https://github.com/alchemy-run/alchemy/commit/6857a3ee)
  - **logs**:
    - Support log group config &nbsp;-&nbsp; by **José Netto** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/630 [<samp>(63172)</samp>](https://github.com/alchemy-run/alchemy/commit/63172cb1)
- **cli**:
  - Support creating user api tokens &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(5d226)</samp>](https://github.com/alchemy-run/alchemy/commit/5d226b30)
- **cloudflare**:
  - Containers in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/636 [<samp>(f3bf2)</samp>](https://github.com/alchemy-run/alchemy/commit/f3bf27c1)
  - **ai-search**: AiSearch, AiSearchInstance and AiSearchNamespace &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/639 [<samp>(6831d)</samp>](https://github.com/alchemy-run/alchemy/commit/6831d0b1)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Upgrade to effect beta.84 and fix ConfigProvider.get -> .load &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(340e4)</samp>](https://github.com/alchemy-run/alchemy/commit/340e4109)
- Upgrade effect beta 84 &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(06a6f)</samp>](https://github.com/alchemy-run/alchemy/commit/06a6fffc)
- **aws**:
  - Fix Scheduler everntual consistency durability &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(763d1)</samp>](https://github.com/alchemy-run/alchemy/commit/763d1b71)
  - Harden Distribution, Table, SecurityGrouip, Rule OIDCConnectionProvider, Policu, SAMLProvider, StreamConsumer and StateStore &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(affe6)</samp>](https://github.com/alchemy-run/alchemy/commit/affe67e3)
  - Harden SQS Queue tests, SNS Topic, Provider network error retries, ELB Target Group tests &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(83b4a)</samp>](https://github.com/alchemy-run/alchemy/commit/83b4a407)
  - Harden SQS QUeue against DLQ eventual consistency &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b2814)</samp>](https://github.com/alchemy-run/alchemy/commit/b2814e7e)
- **build**:
  - Handle relative and absolute paths in Build.Command &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(fd3c0)</samp>](https://github.com/alchemy-run/alchemy/commit/fd3c071e)
- **bundle**:
  - Avoid watching node_modules in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/646 [<samp>(1d72a)</samp>](https://github.com/alchemy-run/alchemy/commit/1d72aa44)
- **cli**:
  - Cloudflare create-token supports selecting permissions &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1674d)</samp>](https://github.com/alchemy-run/alchemy/commit/1674d2cd)
- **cloudflare**:
  - Malformed request promoting queue consumer from dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/647 [<samp>(a2787)</samp>](https://github.com/alchemy-run/alchemy/commit/a278763b)
  - Harden PageRule, SchemaValidation SChema, Images Variant, OiriginPostQuantum, HostnameAssociation, Pages Project &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e8e6f)</samp>](https://github.com/alchemy-run/alchemy/commit/e8e6f059)
  - Remove DispatchNamespaceScript &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(20371)</samp>](https://github.com/alchemy-run/alchemy/commit/20371abb)
  - Retry MnnConfigMissing in MagicNetworkMonitoring Rule &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(75832)</samp>](https://github.com/alchemy-run/alchemy/commit/75832278)
  - **workers**:
    - Support local AI Search bindings &nbsp;-&nbsp; by **Jonathan Beckman** in https://github.com/alchemy-run/alchemy/issues/642 [<samp>(3ee0f)</samp>](https://github.com/alchemy-run/alchemy/commit/3ee0fd3d)
    - Preserve local service entrypoints &nbsp;-&nbsp; by **Jonathan Beckman** in https://github.com/alchemy-run/alchemy/issues/643 [<samp>(6bbcb)</samp>](https://github.com/alchemy-run/alchemy/commit/6bbcb4b4)
- **core**:
  - Make diff.stables override provider.stables &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/635 [<samp>(470a5)</samp>](https://github.com/alchemy-run/alchemy/commit/470a5658)
- **state**:
  - Make writes in LocalState atomic &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1c596)</samp>](https://github.com/alchemy-run/alchemy/commit/1c596afb)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.56...HEAD)

---

## v2.0.0-beta.56

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - S3-backed state store (AWS.state()) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/585 [<samp>(1d664)</samp>](https://github.com/alchemy-run/alchemy/commit/1d6642b1)
  - **lambda**: Support function URL config &nbsp;-&nbsp; by **José Netto** in https://github.com/alchemy-run/alchemy/issues/614 [<samp>(33da7)</samp>](https://github.com/alchemy-run/alchemy/commit/33da7a32)
- **cloudflare**:
  - DnsRecord and Zero Trust resources (TunnelRoute, Access apps/policies/org, Device profile) &nbsp;-&nbsp; by **Andy Jefferson** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/570 [<samp>(e9af0)</samp>](https://github.com/alchemy-run/alchemy/commit/e9af082d)
  - Forward dev.env to the StaticSite dev server &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/587 [<samp>(f5110)</samp>](https://github.com/alchemy-run/alchemy/commit/f5110e55)
  - Generate all missing Cloudflare resources &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/601 [<samp>(89bbb)</samp>](https://github.com/alchemy-run/alchemy/commit/89bbb2d6)
  - Flagship feature flags — resources + worker binding &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/602 [<samp>(f7e1c)</samp>](https://github.com/alchemy-run/alchemy/commit/f7e1c4d3)
  - **worker**: Bundle: false — deploy prebuilt workers without re-bundling &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/592 [<samp>(76fc7)</samp>](https://github.com/alchemy-run/alchemy/commit/76fc7ad2)
- **core**:
  - Provider.list &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/620 [<samp>(b9360)</samp>](https://github.com/alchemy-run/alchemy/commit/b9360147)
  - Alchemy unsafe nuke &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/624 [<samp>(9b052)</samp>](https://github.com/alchemy-run/alchemy/commit/9b052778)
- **github**:
  - Add GitHub Repository resource &nbsp;-&nbsp; by **Justin Bennett** in https://github.com/alchemy-run/alchemy/issues/607 [<samp>(1a48e)</samp>](https://github.com/alchemy-run/alchemy/commit/1a48ef4e)
  - Repository event source for Cloudflare Workers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/619 [<samp>(5ba26)</samp>](https://github.com/alchemy-run/alchemy/commit/5ba26aed)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cli**:
  - Keep alchemy dev alive when an apply fails &nbsp;-&nbsp; by **Matthew Aylward** in https://github.com/alchemy-run/alchemy/issues/582 [<samp>(c2f63)</samp>](https://github.com/alchemy-run/alchemy/commit/c2f635a6)
  - Run state clear in parallel &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(81b9d)</samp>](https://github.com/alchemy-run/alchemy/commit/81b9d8f7)
  - Support different entrypoint file in alchemy state clear command &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7d7f3)</samp>](https://github.com/alchemy-run/alchemy/commit/7d7f33d4)
  - Hide nuke command &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2d57d)</samp>](https://github.com/alchemy-run/alchemy/commit/2d57df42)
- **cloudflare**:
  - Migrate resources to regenerated SDK after spec update &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a8e4e)</samp>](https://github.com/alchemy-run/alchemy/commit/a8e4e8f2)
  - Local assets binding throws 500 error &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/613 [<samp>(dfea3)</samp>](https://github.com/alchemy-run/alchemy/commit/dfea32a1)
  - Broad improvements to new resources and tests &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(17dd2)</samp>](https://github.com/alchemy-run/alchemy/commit/17dd2cc7)
  - **worker**:
    - Keep url stable across updates &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/616 [<samp>(03e71)</samp>](https://github.com/alchemy-run/alchemy/commit/03e71f03)
    - Keep durableObjectNamespaces stable across updates &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/617 [<samp>(f7fcb)</samp>](https://github.com/alchemy-run/alchemy/commit/f7fcb9e0)
- **drizzle**:
  - Cache detectDrift so interactive prompt only runs once &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/597 [<samp>(957a6)</samp>](https://github.com/alchemy-run/alchemy/commit/957a63c3)
- **github**:
  - Implement Webhook Provider.list &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2915a)</samp>](https://github.com/alchemy-run/alchemy/commit/2915a1d5)
- **pr-package**:
  - Unwrap Redacted on both sides of bearer-token auth &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/598 [<samp>(f9314)</samp>](https://github.com/alchemy-run/alchemy/commit/f9314d0a)

### &nbsp;&nbsp;&nbsp;🏎 Performance

- **cli**: Make `alchemy plan` start near-instant (8.2s -> 1.8s) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/618 [<samp>(89ccc)</samp>](https://github.com/alchemy-run/alchemy/commit/89ccc11f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.55...HEAD)

---

## v2.0.0-beta.55

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - **ai-gateway**: Add AiGatewaySpendingLimit (account-level spend cap) &nbsp;-&nbsp; by **Matthew Aylward** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/569 [<samp>(3c550)</samp>](https://github.com/alchemy-run/alchemy/commit/3c550b58)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Dangling process on alchemy deploy/destroy &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/580 [<samp>(67bcc)</samp>](https://github.com/alchemy-run/alchemy/commit/67bcca0f)
- **cloudflare**: Export fetcher utils from alchemy/Cloudflare/Bridge &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/581 [<samp>(77777)</samp>](https://github.com/alchemy-run/alchemy/commit/77777c6a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.54...HEAD)

---

## v2.0.0-beta.54

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Queue consumers in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/571 [<samp>(ecb63)</samp>](https://github.com/alchemy-run/alchemy/commit/ecb63322)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Support lazy credentials in dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/578 [<samp>(b9781)</samp>](https://github.com/alchemy-run/alchemy/commit/b9781c5e)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.53...HEAD)

---

## v2.0.0-beta.53

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Lazily evaluate auth providers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/567 [<samp>(390a6)</samp>](https://github.com/alchemy-run/alchemy/commit/390a6db4)
- **aws**:
  - Actually use AWS Auth provider &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/574 [<samp>(73e62)</samp>](https://github.com/alchemy-run/alchemy/commit/73e62cc1)
  - **s3**: Narrow bucket tag requirements &nbsp;-&nbsp; by **Kilian Cirera Sant** in https://github.com/alchemy-run/alchemy/issues/555 [<samp>(26796)</samp>](https://github.com/alchemy-run/alchemy/commit/26796939)
- **cli**:
  - Always refresh credentials on alchemy login &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/575 [<samp>(75f04)</samp>](https://github.com/alchemy-run/alchemy/commit/75f04495)
  - Avoid login after configure &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8ee28)</samp>](https://github.com/alchemy-run/alchemy/commit/8ee2837b)
- **cloudflare**:
  - Vite handles require of node built-ins incorrectly &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/556 [<samp>(1010a)</samp>](https://github.com/alchemy-run/alchemy/commit/1010a5c3)
  - Use named import for @alchemy.run/node-utils/ignore &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/572 [<samp>(e2926)</samp>](https://github.com/alchemy-run/alchemy/commit/e29265c3)
  - Race condition with >1 workflow in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/573 [<samp>(6cc94)</samp>](https://github.com/alchemy-run/alchemy/commit/6cc9429d)
  - Handle NoSuchBucket eventual consistency when updating bucket domain &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(448ba)</samp>](https://github.com/alchemy-run/alchemy/commit/448ba756)
- **core**:
  - Resolve Config values in input props &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/566 [<samp>(aa584)</samp>](https://github.com/alchemy-run/alchemy/commit/aa5844f5)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.52...HEAD)

---

## v2.0.0-beta.52

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- Bump effect to 4.0.0-beta.78 &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/542 [<samp>(80d50)</samp>](https://github.com/alchemy-run/alchemy/commit/80d50a7e)
- **cloudflare**: Consistent `props.assets` type for Worker, StaticSite, & Vite &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/534 [<samp>(e1ad3)</samp>](https://github.com/alchemy-run/alchemy/commit/e1ad34ad)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - Effect wrapper for Browser quick actions &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/525 [<samp>(e734a)</samp>](https://github.com/alchemy-run/alchemy/commit/e734a2f4)
  - Add Version Metadata binding &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/524 [<samp>(77937)</samp>](https://github.com/alchemy-run/alchemy/commit/77937935)
  - Class form for Vite and StaticSite &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/527 [<samp>(a195c)</samp>](https://github.com/alchemy-run/alchemy/commit/a195c93d)
  - Provide ExecutionContext to Workflow runs &nbsp;-&nbsp; by **Saatvik Arya** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/515 [<samp>(159b9)</samp>](https://github.com/alchemy-run/alchemy/commit/159b9779)
  - Build.DevServer resource used in Cloudflare.StaticSite &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/537 [<samp>(81415)</samp>](https://github.com/alchemy-run/alchemy/commit/81415133)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Bump @distilled.cloud/* to 0.23.1 &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/539 [<samp>(d0afc)</samp>](https://github.com/alchemy-run/alchemy/commit/d0afc986)
- **cloudflare**:
  - Cloudflare.Providers requirement type was any &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4b0ca)</samp>](https://github.com/alchemy-run/alchemy/commit/4b0caa8d)
  - Allow ConfigError in RpcWorker and RpcDurableObjectNamespace &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4e8f4)</samp>](https://github.com/alchemy-run/alchemy/commit/4e8f4e55)
  - **dev**:
    - Improve multi-worker reliability in bun &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/535 [<samp>(cd1af)</samp>](https://github.com/alchemy-run/alchemy/commit/cd1aff7a)
    - Cross-script durable object bindings not working &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/540 [<samp>(40f36)</samp>](https://github.com/alchemy-run/alchemy/commit/40f36355)
    - Populate assets binding for vite websites &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/547 [<samp>(b1504)</samp>](https://github.com/alchemy-run/alchemy/commit/b1504d9d)
- **core**:
  - Trigger updates when a Redacted config/secret value changes &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/549 [<samp>(8b9c2)</samp>](https://github.com/alchemy-run/alchemy/commit/8b9c2415)
  - Honor retain removal policy on replace &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/548 [<samp>(5ac2f)</samp>](https://github.com/alchemy-run/alchemy/commit/5ac2f158)
- **drizzle**:
  - Expose Schema `out` as a cwd-relative path &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/551 [<samp>(0cf52)</samp>](https://github.com/alchemy-run/alchemy/commit/0cf52bb6)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.51...HEAD)

---

## v2.0.0-beta.51

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - Add Ruleset resource &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/240 [<samp>(93d1c)</samp>](https://github.com/alchemy-run/alchemy/commit/93d1cdea)
  - **ai**: Add DurableObjectChatPersistence layer &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/390 [<samp>(f53a2)</samp>](https://github.com/alchemy-run/alchemy/commit/f53a26ff)
- **core**:
  - Allow ConfigError on Alchemy.Stack, Worker and Platform effects &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/487 [<samp>(ce201)</samp>](https://github.com/alchemy-run/alchemy/commit/ce201070)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Honor resource-scoped adopt(...) in the planner &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/521 [<samp>(5736f)</samp>](https://github.com/alchemy-run/alchemy/commit/5736f1c0)
- **aws**: Deliver S3 bucket notifications to Lambda event sources &nbsp;-&nbsp; by **Andrey Konopkov** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/470 [<samp>(04459)</samp>](https://github.com/alchemy-run/alchemy/commit/04459ee4)
- **cloudflare**: Support SecretsStore Secret as async binding &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/475 [<samp>(46010)</samp>](https://github.com/alchemy-run/alchemy/commit/46010c82)
- **core**: Use ExprSymbol to identify Outputs in core to avoid collisions with user data &nbsp;-&nbsp; by **Julius Marminge** in https://github.com/alchemy-run/alchemy/issues/517 [<samp>(c0a6b)</samp>](https://github.com/alchemy-run/alchemy/commit/c0a6bd86)
- **drizzle**: Preserve snapshot lineage &nbsp;-&nbsp; by **Julius Marminge** in https://github.com/alchemy-run/alchemy/issues/519 [<samp>(86d18)</samp>](https://github.com/alchemy-run/alchemy/commit/86d186d8)
- **planetscale**: Remove kind attribute that collides with output proxy discriminator &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/518 [<samp>(bd12d)</samp>](https://github.com/alchemy-run/alchemy/commit/bd12d1c1)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.50...HEAD)

---

## v2.0.0-beta.50

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Worker/vite port conflict in dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/513 [<samp>(f7b9e)</samp>](https://github.com/alchemy-run/alchemy/commit/f7b9ecc5)
  - `RuntimeContext` dependency when binding output values &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/514 [<samp>(d136f)</samp>](https://github.com/alchemy-run/alchemy/commit/d136fb54)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.49...HEAD)

---

## v2.0.0-beta.49

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: DNS record bindings &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/511 [<samp>(fafc9)</samp>](https://github.com/alchemy-run/alchemy/commit/fafc9e9c)
- **output**: Add flatMap and method-style combinators &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/512 [<samp>(00234)</samp>](https://github.com/alchemy-run/alchemy/commit/002343f0)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Don't unwrap unredacted values &nbsp;-&nbsp; by **sam** [<samp>(f4ef0)</samp>](https://github.com/alchemy-run/alchemy/commit/f4ef0381)
- **cloudflare**: Ensure all yielded Config in a Worker to use secret_text &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/510 [<samp>(38c62)</samp>](https://github.com/alchemy-run/alchemy/commit/38c62b6b)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.48...HEAD)

---

## v2.0.0-beta.48

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cli**:
  - Add cloudflare create-token command &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/496 [<samp>(ab886)</samp>](https://github.com/alchemy-run/alchemy/commit/ab8864fe)
- **cloudflare**:
  - Zone &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/493 [<samp>(38b2f)</samp>](https://github.com/alchemy-run/alchemy/commit/38b2f0a8)
  - Rename BrowserRendering to Browser &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/503 [<samp>(1a62d)</samp>](https://github.com/alchemy-run/alchemy/commit/1a62d247)
  - Tunnel Bindings &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/508 [<samp>(86bcf)</samp>](https://github.com/alchemy-run/alchemy/commit/86bcf260)
  - **browser**: Yieldable BrowserRendering marker &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/498 [<samp>(05283)</samp>](https://github.com/alchemy-run/alchemy/commit/052832a8)
  - **images**: Yieldable Images binding &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/501 [<samp>(46c15)</samp>](https://github.com/alchemy-run/alchemy/commit/46c158a6)
  - **ratelimit**: Add RateLimit binding &nbsp;-&nbsp; by **Alex** and **sam** in https://github.com/alchemy-run/alchemy/issues/238 [<samp>(eb8f5)</samp>](https://github.com/alchemy-run/alchemy/commit/eb8f5efc)
  - **workers**: Yieldable DynamicWorkerLoader marker &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/505 [<samp>(362fc)</samp>](https://github.com/alchemy-run/alchemy/commit/362fcdff)
- **docs**:
  - Add Bindings section and refocus Providers on lifecycle interface &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/502 [<samp>(a5fc3)</samp>](https://github.com/alchemy-run/alchemy/commit/a5fc3412)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - **zone**: Use ZoneAlreadyExists tag; bump distilled 0.22.3 &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/507 [<samp>(d948f)</samp>](https://github.com/alchemy-run/alchemy/commit/d948f304)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.47...HEAD)

---

## v2.0.0-beta.47

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - **ai-gateway**: Add LanguageModel + AI Gateway client surface &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/389 [<samp>(51150)</samp>](https://github.com/alchemy-run/alchemy/commit/51150a8c)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cli**:
  - Skip evalStack in login and defer State store init to runtime &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/492 [<samp>(949b3)</samp>](https://github.com/alchemy-run/alchemy/commit/949b3079)
- **cloudflare**:
  - Handle props.env in local workers &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/473 [<samp>(0b779)</samp>](https://github.com/alchemy-run/alchemy/commit/0b779dfe)
  - Stream RPC return values across durable object boundary &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/478 [<samp>(6811d)</samp>](https://github.com/alchemy-run/alchemy/commit/6811de57)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.46...HEAD)

---

## v2.0.0-beta.46

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - **vectorize**: Add Vectorize index as a bindable resource &nbsp;-&nbsp; by **David J. Felix** and **John Royal** in https://github.com/alchemy-run/alchemy/issues/407 [<samp>(2089d)</samp>](https://github.com/alchemy-run/alchemy/commit/2089dbf7)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Use remote state when updating Cloudflare State Store &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/477 [<samp>(a1a81)</samp>](https://github.com/alchemy-run/alchemy/commit/a1a811e1)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.45...HEAD)

---

## v2.0.0-beta.45

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Random**:
  - Add KeyPair resource &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/441 [<samp>(aa776)</samp>](https://github.com/alchemy-run/alchemy/commit/aa776a6d)
- **aws**:
  - **lambda**: Add timeout to FunctionProps &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/440 [<samp>(38a32)</samp>](https://github.com/alchemy-run/alchemy/commit/38a32704)
- **cloudflare**:
  - Add Browser Rendering binding &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/372 [<samp>(88e95)</samp>](https://github.com/alchemy-run/alchemy/commit/88e95867)
  - Cross-script durable object binding &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/435 [<samp>(438fb)</samp>](https://github.com/alchemy-run/alchemy/commit/438fbfe1)
  - RpcWorker &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/387 [<samp>(d15f0)</samp>](https://github.com/alchemy-run/alchemy/commit/d15f0a9f)
  - Add RpcDurableObjectNamespace + modular RpcWorker/DO &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/388 [<samp>(c801d)</samp>](https://github.com/alchemy-run/alchemy/commit/c801dfd3)
  - Workflows in `alchemy dev` &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/449 [<samp>(0351d)</samp>](https://github.com/alchemy-run/alchemy/commit/0351d715)
  - Worker.url now tries to infer canonical url & domain order is preserved &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/432 [<samp>(ae0a1)</samp>](https://github.com/alchemy-run/alchemy/commit/ae0a19a6)
  - AnalyticsEngine and SendEmail bindings in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/460 [<samp>(aa890)</samp>](https://github.com/alchemy-run/alchemy/commit/aa890310)
  - Custom ports in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/469 [<samp>(68ef9)</samp>](https://github.com/alchemy-run/alchemy/commit/68ef90fe)
  - **queue**: Accept Duration.Input for messages() time props &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/443 [<samp>(f15c0)</samp>](https://github.com/alchemy-run/alchemy/commit/f15c0c50)
  - **workers**: Collapse WorkerProps.bindings into WorkerProps.env &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/446 [<samp>(a0358)</samp>](https://github.com/alchemy-run/alchemy/commit/a0358684)
- **core**:
  - Replace Alchemy.Secret and Alchemy.Variable with effect/Config &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/445 [<samp>(53e7b)</samp>](https://github.com/alchemy-run/alchemy/commit/53e7b9c5)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Update Secrets reconcilation logic to update the Secret and update distilled &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(5d2d8)</samp>](https://github.com/alchemy-run/alchemy/commit/5d2d8daf)
  - Wait for queue consumer to be bound &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c74a8)</samp>](https://github.com/alchemy-run/alchemy/commit/c74a871b)
- **better-auth**:
  - Better auth as peer dep &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/434 [<samp>(08244)</samp>](https://github.com/alchemy-run/alchemy/commit/08244a13)
- **cli**:
  - Disable --experimental-transform-types on node.js 26 &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/458 [<samp>(70359)</samp>](https://github.com/alchemy-run/alchemy/commit/703591ba)
  - Import stack via file URL on Windows &nbsp;-&nbsp; by **d3lay** in https://github.com/alchemy-run/alchemy/issues/426 [<samp>(51f6f)</samp>](https://github.com/alchemy-run/alchemy/commit/51f6f9e4)
  - Ensure auth providers don't run in parallel and only run once &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/461 [<samp>(2421c)</samp>](https://github.com/alchemy-run/alchemy/commit/2421cfe4)
- **cloudflare**:
  - Dev hyperdrive binding fails for vite/async workers &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/423 [<samp>(c83ce)</samp>](https://github.com/alchemy-run/alchemy/commit/c83ce2d8)
  - Pass DO scriptName through async bindings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/437 [<samp>(3a8da)</samp>](https://github.com/alchemy-run/alchemy/commit/3a8daa3d)
  - Handle external require calls in vite dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/452 [<samp>(87cc9)</samp>](https://github.com/alchemy-run/alchemy/commit/87cc9f0c)
  - Cloudflare.providers() has `any` in requirements &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/456 [<samp>(81814)</samp>](https://github.com/alchemy-run/alchemy/commit/818147f8)
  - Reconcile Worker preview subdomain state &nbsp;-&nbsp; by **Dawson** and **John Royal** in https://github.com/alchemy-run/alchemy/issues/285 [<samp>(dbd04)</samp>](https://github.com/alchemy-run/alchemy/commit/dbd042e2)
  - Handle websocket upgrade in vite dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/457 [<samp>(67b57)</samp>](https://github.com/alchemy-run/alchemy/commit/67b57f81)
  - Run HttpServer pre-response handlers correctly &nbsp;-&nbsp; by **Lucas Thevenet**, **Sam Goodwin** and **John Royal** in https://github.com/alchemy-run/alchemy/issues/404 [<samp>(2e3d1)</samp>](https://github.com/alchemy-run/alchemy/commit/2e3d176f)
  - Only close Scope if it's not transferred to a Stream &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(bb970)</samp>](https://github.com/alchemy-run/alchemy/commit/bb970abd)
  - Trim bearer token to workaround effect beta.73 regression &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/468 [<samp>(2d08b)</samp>](https://github.com/alchemy-run/alchemy/commit/2d08bcf5)
  - Reduce unnecessary updates in alchemy dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/455 [<samp>(ab7e7)</samp>](https://github.com/alchemy-run/alchemy/commit/ab7e718b)
  - **worker**: Normalize bundle entry path on windows &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/453 [<samp>(5cd26)</samp>](https://github.com/alchemy-run/alchemy/commit/5cd26234)
- **core**:
  - Interrupt deployments when upstream non-cylic dependency fails &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e22ee)</samp>](https://github.com/alchemy-run/alchemy/commit/e22ee4bf)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.44...HEAD)

---

## v2.0.0-beta.44

### &nbsp;&nbsp;&nbsp;🚀 Features

- Bundle analyzer plugin &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/405 [<samp>(28b8c)</samp>](https://github.com/alchemy-run/alchemy/commit/28b8c7a4)
- **cloudflare**:
  - Support Artifacts binding in dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/419 [<samp>(3917e)</samp>](https://github.com/alchemy-run/alchemy/commit/3917ef3a)
  - **zaraz**: Add ZarazConfig resource &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/371 [<samp>(7a232)</samp>](https://github.com/alchemy-run/alchemy/commit/7a232990)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Node.js import resolution error from @alchemy.run/node-utils &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/406 [<samp>(4820d)</samp>](https://github.com/alchemy-run/alchemy/commit/4820da51)
- **bundle**:
  - Support Vite-style ?raw imports &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/411 [<samp>(0e989)</samp>](https://github.com/alchemy-run/alchemy/commit/0e98917c)
- **cli**:
  - Filter bun's "not in project directory" watcher warning &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/124 [<samp>(67370)</samp>](https://github.com/alchemy-run/alchemy/commit/673701e6)
- **cloudflare**:
  - Update cloudflare-tools to 0.6.1 &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/403 [<samp>(cb68e)</samp>](https://github.com/alchemy-run/alchemy/commit/cb68ef48)
  - Remove extraneous logs &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/410 [<samp>(7bb5d)</samp>](https://github.com/alchemy-run/alchemy/commit/7bb5d132)
  - Harden local durable object handling &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/408 [<samp>(19e80)</samp>](https://github.com/alchemy-run/alchemy/commit/19e80aa2)
  - Update cloudflare-tools to 0.6.3 &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/418 [<samp>(60826)</samp>](https://github.com/alchemy-run/alchemy/commit/60826480)
  - Optimize WorkerBridge imports and silence warning &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/420 [<samp>(aa9ee)</samp>](https://github.com/alchemy-run/alchemy/commit/aa9ee151)
- **dev**:
  - Dangling processes after dev server exits &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/382 [<samp>(6a8a0)</samp>](https://github.com/alchemy-run/alchemy/commit/6a8a0258)
- **website**:
  - Extract privacy.mdx style block to css file &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/398 [<samp>(fd72a)</samp>](https://github.com/alchemy-run/alchemy/commit/fd72a9de)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.43...HEAD)

---

## v2.0.0-beta.43

### &nbsp;&nbsp;&nbsp;🚀 Features

- **planetscale**: Add planetscale resources &nbsp;-&nbsp; by **Lucas Thevenet** and **Michael K** in https://github.com/alchemy-run/alchemy/issues/113 [<samp>(ce5ea)</samp>](https://github.com/alchemy-run/alchemy/commit/ce5eabbf)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Move WorkerEnvironment requirement to the Layer instead of the binding API call &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/383 [<samp>(ab3a0)</samp>](https://github.com/alchemy-run/alchemy/commit/ab3a0268)
  - Allow Outputs as input to Cloudflare.Worker &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/394 [<samp>(b9ea9)</samp>](https://github.com/alchemy-run/alchemy/commit/b9ea9315)
- **core**:
  - Remove actions when destroying &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d8551)</samp>](https://github.com/alchemy-run/alchemy/commit/d8551e21)
- **docker**:
  - Proper docker command on windows &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/377 [<samp>(d1c42)</samp>](https://github.com/alchemy-run/alchemy/commit/d1c421af)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.42...HEAD)

---

## v2.0.0-beta.42

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - **Worker**: Defer Platform hook bindings to avoid TDZ from npm &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/378 [<samp>(1b498)</samp>](https://github.com/alchemy-run/alchemy/commit/1b498227)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.41...HEAD)

---

## v2.0.0-beta.41

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Cloudflare**: Include WorkerProps.env in InferEnv &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/351 [<samp>(f157e)</samp>](https://github.com/alchemy-run/alchemy/commit/f157ed89)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Fix RPC and HTTP APIs by scoping runtime effects per request &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/374 [<samp>(b7cdc)</samp>](https://github.com/alchemy-run/alchemy/commit/b7cdca09)
- **cloudflare**:
  - Externalize lightningcss + fsevents in worker bundler &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/363 [<samp>(5dc95)</samp>](https://github.com/alchemy-run/alchemy/commit/5dc95a0e)
  - Provide worker env to do methods &nbsp;-&nbsp; by **Dillon Mulroy** in https://github.com/alchemy-run/alchemy/issues/369 [<samp>(7b5be)</samp>](https://github.com/alchemy-run/alchemy/commit/7b5be8be)
  - Add WorkerExecutionContext and ExecutionContext to worker fetch types &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/358 [<samp>(d2d0f)</samp>](https://github.com/alchemy-run/alchemy/commit/d2d0fa8d)
  - **worker**: Force delete scripts on teardown &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/348 [<samp>(f37d0)</samp>](https://github.com/alchemy-run/alchemy/commit/f37d06cf)
- **core**:
  - Eager terminal status events + pending while waiting on deps &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/376 [<samp>(b307e)</samp>](https://github.com/alchemy-run/alchemy/commit/b307ee5a)
- **sidecar**:
  - Preserve Redacted values across RPC serialization &nbsp;-&nbsp; by **Juliaan** in https://github.com/alchemy-run/alchemy/issues/356 [<samp>(b2334)</samp>](https://github.com/alchemy-run/alchemy/commit/b2334c5e)
- **state**:
  - Remove that one log we don't want, if you know you know &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/347 [<samp>(ab648)</samp>](https://github.com/alchemy-run/alchemy/commit/ab648e16)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.40...HEAD)

---

## v2.0.0-beta.40

### &nbsp;&nbsp;&nbsp;🚀 Features

- **axiom**: Smartfilter chart subtype &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/339 [<samp>(f2650)</samp>](https://github.com/alchemy-run/alchemy/commit/f2650d05)
- **cloudflare**: Vite dev &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/331 [<samp>(1913a)</samp>](https://github.com/alchemy-run/alchemy/commit/1913aafb)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Revert scopeTransferToStream which is causing 415 &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(fe354)</samp>](https://github.com/alchemy-run/alchemy/commit/fe354905)
  - Bump state store version to 5 &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(baddd)</samp>](https://github.com/alchemy-run/alchemy/commit/baddd845)
  - **AiGateway**:
    - Stop reporting update on every deploy &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/332 [<samp>(2a1f7)</samp>](https://github.com/alchemy-run/alchemy/commit/2a1f7232)
    - Align desired-state defaults with API defaults &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/334 [<samp>(0e3dc)</samp>](https://github.com/alchemy-run/alchemy/commit/0e3dcd3b)
  - **Container**:
    - Forward startup options through Cloudflare.start &nbsp;-&nbsp; by **Christopher Yovanovitch** in https://github.com/alchemy-run/alchemy/issues/341 [<samp>(1c72b)</samp>](https://github.com/alchemy-run/alchemy/commit/1c72b9c0)
  - **Worker**:
    - Log full Cause server-side, return generic 500 to client &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/336 [<samp>(ebdbc)</samp>](https://github.com/alchemy-run/alchemy/commit/ebdbc0d5)
- **aws,cloudflare**:
  - Sanitize entrypoint urls &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/353 [<samp>(4cf38)</samp>](https://github.com/alchemy-run/alchemy/commit/4cf3856c)
- **dev**:
  - Use @alchemy.run/node-utils lockfile &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/345 [<samp>(acc8b)</samp>](https://github.com/alchemy-run/alchemy/commit/acc8b885)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.39...HEAD)

---

## v2.0.0-beta.39

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - **Vite**:
    - Inline `env` props as `import.meta.env.*` in the bundle &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/330 [<samp>(c22a1)</samp>](https://github.com/alchemy-run/alchemy/commit/c22a1c7a)
  - **Worker**:
    - Cloudflare Worker HTTP effect lifecycle &nbsp;-&nbsp; by **Will King** in https://github.com/alchemy-run/alchemy/issues/328 [<samp>(a1032)</samp>](https://github.com/alchemy-run/alchemy/commit/a1032c34)
    - Add missing SendEmail worker binding type and meta &nbsp;-&nbsp; by **Gerben Mulder** in https://github.com/alchemy-run/alchemy/issues/326 [<samp>(a7fbb)</samp>](https://github.com/alchemy-run/alchemy/commit/a7fbba51)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.38...HEAD)

---

## v2.0.0-beta.38

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Add Email Routing resources and SendEmail Worker binding &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/314 [<samp>(06dab)</samp>](https://github.com/alchemy-run/alchemy/commit/06dab7c5)
- **core**: Action plan node type (functions that run as part of apply) &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/315 [<samp>(8a66a)</samp>](https://github.com/alchemy-run/alchemy/commit/8a66a896)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Move to effect@4.0.0-beta.66 &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/321 [<samp>(b57f7)</samp>](https://github.com/alchemy-run/alchemy/commit/b57f78cf)
- Improve transport error fault tolerance &nbsp;-&nbsp; by **sam** [<samp>(6d67c)</samp>](https://github.com/alchemy-run/alchemy/commit/6d67c24f)
- **Neon**: Use @distilled.cloud/neon SDK instead of hand-rolled API &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/270 [<samp>(1b9d4)</samp>](https://github.com/alchemy-run/alchemy/commit/1b9d4372)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.37...HEAD)

---

## v2.0.0-beta.37

### &nbsp;&nbsp;&nbsp;🚀 Features

- Cross-stack and cross-stage references &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/300 [<samp>(94ea3)</samp>](https://github.com/alchemy-run/alchemy/commit/94ea3129)
- **Cloudflare**:
  - Empty r2 bucket on destroy &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/276 [<samp>(2412a)</samp>](https://github.com/alchemy-run/alchemy/commit/2412a3c2)
  - Worker to worker binding types and tanstack start bridge example and docs &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/310 [<samp>(30dd9)</samp>](https://github.com/alchemy-run/alchemy/commit/30dd99c9)
  - **Workflow**: Type workflow input and output &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/304 [<samp>(1dafd)</samp>](https://github.com/alchemy-run/alchemy/commit/1dafd77c)
- **cloudflare**:
  - Add Worker cron triggers &nbsp;-&nbsp; by **Dawson** and **sam** in https://github.com/alchemy-run/alchemy/issues/288 [<samp>(cae20)</samp>](https://github.com/alchemy-run/alchemy/commit/cae20c98)
  - Add Analytics Engine binding &nbsp;-&nbsp; by **Dawson** and **sam** in https://github.com/alchemy-run/alchemy/issues/286 [<samp>(ba8b3)</samp>](https://github.com/alchemy-run/alchemy/commit/ba8b3a16)
- **core**:
  - Add Alchemy.Secret and Alchemy.Variable &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/290 [<samp>(88611)</samp>](https://github.com/alchemy-run/alchemy/commit/88611eac)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Remove deprecated libsodium wrapper types &nbsp;-&nbsp; by **齐天大圣** in https://github.com/alchemy-run/alchemy/issues/311 [<samp>(f3f70)</samp>](https://github.com/alchemy-run/alchemy/commit/f3f7079a)
- **Cloudflare**:
  - **D1**: Make prepare/bind synchronous &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/299 [<samp>(6e58d)</samp>](https://github.com/alchemy-run/alchemy/commit/6e58da04)
- **cloudflare**:
  - Include wasm modules in local sidecar bundle &nbsp;-&nbsp; by **Baptiste Arnaud** and **sam** in https://github.com/alchemy-run/alchemy/issues/305 [<samp>(1926d)</samp>](https://github.com/alchemy-run/alchemy/commit/1926d580)
- **core**:
  - Throw on JS string-coercion of unresolved Outputs &nbsp;-&nbsp; by **Zé Yuri** in https://github.com/alchemy-run/alchemy/issues/306 [<samp>(d1b12)</samp>](https://github.com/alchemy-run/alchemy/commit/d1b12ac7)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.36...HEAD)

---

## v2.0.0-beta.36

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Cloudflare**:
  - **Images**: Add Images binding &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/237 [<samp>(b19c3)</samp>](https://github.com/alchemy-run/alchemy/commit/b19c3562)
- **cloudflare**:
  - Support Hyperdrive in Worker bindings &nbsp;-&nbsp; by **Baptiste Arnaud** in https://github.com/alchemy-run/alchemy/issues/282 [<samp>(48381)</samp>](https://github.com/alchemy-run/alchemy/commit/48381a01)
  - **r2**: Add lifecycleRules option to R2Bucket &nbsp;-&nbsp; by **Baptiste Arnaud** in https://github.com/alchemy-run/alchemy/issues/284 [<samp>(ed905)</samp>](https://github.com/alchemy-run/alchemy/commit/ed905d44)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Dev**: Resolve *.localhost via undici dispatcher &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/289 [<samp>(ae6de)</samp>](https://github.com/alchemy-run/alchemy/commit/ae6de171)

### &nbsp;&nbsp;&nbsp;🏎 Performance

- **smoke**: Batch canary install at the workspace root &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/291 [<samp>(90918)</samp>](https://github.com/alchemy-run/alchemy/commit/9091856e)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.35...HEAD)

---

## v2.0.0-beta.35

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Cloudflare**:
  - **R2**: Add bucket custom domains &nbsp;-&nbsp; by **Alex** and **sam** in https://github.com/alchemy-run/alchemy/issues/241 [<samp>(a782a)</samp>](https://github.com/alchemy-run/alchemy/commit/a782a449)
- **Neon**:
  - **Project**: Add enableLogicalReplication option &nbsp;-&nbsp; by **Baptiste Arnaud** in https://github.com/alchemy-run/alchemy/issues/268 [<samp>(c4945)</samp>](https://github.com/alchemy-run/alchemy/commit/c49451c6)
- **cli**:
  - Warn when a newer alchemy version is on npm &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/253 [<samp>(7e701)</samp>](https://github.com/alchemy-run/alchemy/commit/7e701205)
  - Use plain-text renderer in non-interactive terminals &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/258 [<samp>(16485)</samp>](https://github.com/alchemy-run/alchemy/commit/16485403)
  - Cloudflare/aws namespaces + cloudflare state logs &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/256 [<samp>(335ab)</samp>](https://github.com/alchemy-run/alchemy/commit/335ab26c)
- **cloudflare**:
  - Worker support non-string env bindings &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/269 [<samp>(220c3)</samp>](https://github.com/alchemy-run/alchemy/commit/220c358c)
  - **queue**: Cloudflare.messages(queue).subscribe(...) Effect consumer API &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/260 [<samp>(59c01)</samp>](https://github.com/alchemy-run/alchemy/commit/59c01867)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Move Auth Providers into layers to keep requirements never &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/271 [<samp>(38319)</samp>](https://github.com/alchemy-run/alchemy/commit/38319fa0)
- Dev mode node compatibility and profiles &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/273 [<samp>(9f402)</samp>](https://github.com/alchemy-run/alchemy/commit/9f4026b6)
- **Cloudflare**:
  - **QueueConsumer**: Paginate listConsumers, surface conflicts clearly &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/257 [<samp>(11d06)</samp>](https://github.com/alchemy-run/alchemy/commit/11d06201)
  - **R2**: Simplify r2 custom domain interface to just an array &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/259 [<samp>(8953d)</samp>](https://github.com/alchemy-run/alchemy/commit/8953dfc2)
- **Drizzle**:
  - Only flag Schema as updated when migrations actually drift &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/261 [<samp>(8f2e3)</samp>](https://github.com/alchemy-run/alchemy/commit/8f2e33e7)
- **cloudflare**:
  - Disable builder.sharedConfigBuild for vite build &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/176 [<samp>(2fb34)</samp>](https://github.com/alchemy-run/alchemy/commit/2fb34c2b)
  - Update runtime to 0.3.1 &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/278 [<samp>(426e8)</samp>](https://github.com/alchemy-run/alchemy/commit/426e83f6)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.34...HEAD)

---

## v2.0.0-beta.34

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Upgrade to distilled 0.17.0 consistently &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d681f)</samp>](https://github.com/alchemy-run/alchemy/commit/d681f72f)
- **cli**: Correct args for dev command in node &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/250 [<samp>(4859d)</samp>](https://github.com/alchemy-run/alchemy/commit/4859dc95)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.33...HEAD)

---

## v2.0.0-beta.33

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**: Fix I/O error in state store &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/251 [<samp>(ec430)</samp>](https://github.com/alchemy-run/alchemy/commit/ec430ad2)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.32...HEAD)

---

## v2.0.0-beta.32

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Log cf state store version mismatch &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/245 [<samp>(75f52)</samp>](https://github.com/alchemy-run/alchemy/commit/75f5220d)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Remove debug log statements &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(64414)</samp>](https://github.com/alchemy-run/alchemy/commit/64414547)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.31...HEAD)

---

## v2.0.0-beta.31

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Cloudflare**:
  - **StateStore**: Wire OTLP traces, metrics, and logs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/181 [<samp>(14b8a)</samp>](https://github.com/alchemy-run/alchemy/commit/14b8ab8c)
- **aws**:
  - Harden ApiGateway REST resources (bindings, retries, stage patches) &nbsp;-&nbsp; by **Sam Goodwin** and **Adrian Witaszak** in https://github.com/alchemy-run/alchemy/issues/169 [<samp>(e4b84)</samp>](https://github.com/alchemy-run/alchemy/commit/e4b84a51)
- **cloudflare**:
  - Add Tunnel, VpcService, and VpcServiceRef &nbsp;-&nbsp; by **Kotkoroid** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/123 [<samp>(090c1)</samp>](https://github.com/alchemy-run/alchemy/commit/090c14db)
  - Expose raw durable object sql storage &nbsp;-&nbsp; by **m@s** in https://github.com/alchemy-run/alchemy/issues/188 [<samp>(20c03)</samp>](https://github.com/alchemy-run/alchemy/commit/20c0301b)
  - Add Hyperdrive resource with dev-mode local DB support &nbsp;-&nbsp; by **Julian Archila** in https://github.com/alchemy-run/alchemy/issues/158 [<samp>(8e651)</samp>](https://github.com/alchemy-run/alchemy/commit/8e651091)
  - Workers observability traces &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/244 [<samp>(ae531)</samp>](https://github.com/alchemy-run/alchemy/commit/ae5319cd)
- **core**:
  - Support for adoption in the core engine (using read) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/167 [<samp>(9914e)</samp>](https://github.com/alchemy-run/alchemy/commit/9914ec03)
  - Replace create+update with one `reconcile` function &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/179 [<samp>(bfd4f)</samp>](https://github.com/alchemy-run/alchemy/commit/bfd4f386)
- **neon**:
  - Add Neon serverless Postgres provider &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/134 [<samp>(3b5e8)</samp>](https://github.com/alchemy-run/alchemy/commit/3b5e88a8)
- **test**:
  - Add dev flag to test harness, toggleable via ALCHEMY_DEV &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/183 [<samp>(7856a)</samp>](https://github.com/alchemy-run/alchemy/commit/7856afbb)
- **website**:
  - Generate llms.txt from page frontmatter &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/170 [<samp>(9ad47)</samp>](https://github.com/alchemy-run/alchemy/commit/9ad47381)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Dedupe Container DO bindings by namespaceId &nbsp;-&nbsp; by **Christopher Yovanovitch** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/172 [<samp>(a2c54)</samp>](https://github.com/alchemy-run/alchemy/commit/a2c54999)
  - **SecretsStore**: Adoption opt-in by default &nbsp;-&nbsp; by **Stibbs** in https://github.com/alchemy-run/alchemy/issues/163 [<samp>(d9f22)</samp>](https://github.com/alchemy-run/alchemy/commit/d9f22752)
- **aws**:
  - **lambda**:
    - Scope public url invokes &nbsp;-&nbsp; by **José Netto** in https://github.com/alchemy-run/alchemy/issues/162 [<samp>(1e092)</samp>](https://github.com/alchemy-run/alchemy/commit/1e092912)
    - Pass invoked via url permission &nbsp;-&nbsp; by **José Netto** in https://github.com/alchemy-run/alchemy/issues/161 [<samp>(3e978)</samp>](https://github.com/alchemy-run/alchemy/commit/3e978ff7)
- **cloudflare**:
  - Enable hyperdrive in dev mode &nbsp;-&nbsp; by **John Royal** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/242 [<samp>(86623)</samp>](https://github.com/alchemy-run/alchemy/commit/8662373d)
  - **worker**: Make asset hash path-independent and reuse manifest when unchanged &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/165 [<samp>(e1669)</samp>](https://github.com/alchemy-run/alchemy/commit/e1669a77)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.30...HEAD)

---

## v2.0.0-beta.30

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**: Apply Cloudflare Access headers to HTTP requests &nbsp;-&nbsp; by **jacobiajohnson** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/160 [<samp>(fd329)</samp>](https://github.com/alchemy-run/alchemy/commit/fd329e7)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.29...HEAD)

---

## v2.0.0-beta.29

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Cloudflare**: Add AiGateway resource &nbsp;-&nbsp; by **Jan Henning** in https://github.com/alchemy-run/alchemy/issues/130 [<samp>(b0361)</samp>](https://github.com/alchemy-run/alchemy/commit/b036165)
- **cloudflare/state-store**: Version-gate the deployed worker &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/156 [<samp>(bdc37)</samp>](https://github.com/alchemy-run/alchemy/commit/bdc37df)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Don't run update out of order for strict DAGs &nbsp;-&nbsp; by **sam** and **John Royal** in https://github.com/alchemy-run/alchemy/issues/144 [<samp>(fcae5)</samp>](https://github.com/alchemy-run/alchemy/commit/fcae571)
  - Run state-store secret probe under the deployed script name &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/150 [<samp>(061f8)</samp>](https://github.com/alchemy-run/alchemy/commit/061f86b)
- **cloudflare**:
  - Handle cloudflare access for edge preview workers &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/155 [<samp>(09d01)</samp>](https://github.com/alchemy-run/alchemy/commit/09d0130)
- **core**:
  - Handle failed resource gracefully &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/119 [<samp>(94d4b)</samp>](https://github.com/alchemy-run/alchemy/commit/94d4b3f)
- **website**:
  - Mobile dark hero, theme reactivity, brighter beta badge, OG host &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/146 [<samp>(05eae)</samp>](https://github.com/alchemy-run/alchemy/commit/05eae4d)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.28...HEAD)

---

## v2.0.0-beta.28

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Remove PlatformServices from Util barrel &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/137 [<samp>(f85dd)</samp>](https://github.com/alchemy-run/alchemy/commit/f85ddfe)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.27...HEAD)

---

## v2.0.0-beta.27

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**: Don't bundle CLI with tsdown because it messes with import.meta.filename &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/135 [<samp>(2796c)</samp>](https://github.com/alchemy-run/alchemy/commit/2796c33)
- **pr-package**: Use `bun add <name>@<url>` to dodge bun DependencyLoop bug &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/132 [<samp>(989e2)</samp>](https://github.com/alchemy-run/alchemy/commit/989e254)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.26...HEAD)

---

## v2.0.0-beta.26

### &nbsp;&nbsp;&nbsp;🚀 Features

- **test**: Align vitest and bun test helpers and integrate with profiles &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/129 [<samp>(07e83)</samp>](https://github.com/alchemy-run/alchemy/commit/07e83f3)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Export types as lib/.d.ts &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/121 [<samp>(a000c)</samp>](https://github.com/alchemy-run/alchemy/commit/a000c26)
- Resolve bin/exec.ts via package name so devs modes bundled CLI works &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/128 [<samp>(303da)</samp>](https://github.com/alchemy-run/alchemy/commit/303daeb)
- **cli**:
  - Parallelize alchemy state tree &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/126 [<samp>(f3e8f)</samp>](https://github.com/alchemy-run/alchemy/commit/f3e8fef)
- **cloudflare**:
  - Bootstrap regressions in SecretsStore and StateStore &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/131 [<samp>(37db0)</samp>](https://github.com/alchemy-run/alchemy/commit/37db01a)
- **core**:
  - Fix broken url in error message and add state store guide &nbsp;-&nbsp; by **sam** [<samp>(4b991)</samp>](https://github.com/alchemy-run/alchemy/commit/4b991e7)
  - Treat raw Resource refs as upstream dependencies &nbsp;-&nbsp; by **Mathieu Post** and **sam** in https://github.com/alchemy-run/alchemy/issues/122 [<samp>(416f1)</samp>](https://github.com/alchemy-run/alchemy/commit/416f19c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.25...HEAD)

---

## v2.0.0-beta.25

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**: Remove broken keepAssets optimization &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(845a7)</samp>](https://github.com/alchemy-run/alchemy/commit/845a7b7)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.24...HEAD)

---

## v2.0.0-beta.24

### &nbsp;&nbsp;&nbsp;🚀 Features

- Dev mode for cloudflare workers &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/88 [<samp>(5a0d7)</samp>](https://github.com/alchemy-run/alchemy/commit/5a0d779)
- **core**: --adopt &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2af88)</samp>](https://github.com/alchemy-run/alchemy/commit/2af8851)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Add bootstrap command and harden bootstrap process of cloudflare &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/118 [<samp>(0858d)</samp>](https://github.com/alchemy-run/alchemy/commit/0858dd8)
  - Hoist stack non-destructively &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c9621)</samp>](https://github.com/alchemy-run/alchemy/commit/c9621d1)
  - Don't fail on broken paths in state &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(05f16)</samp>](https://github.com/alchemy-run/alchemy/commit/05f16c8)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.23...HEAD)

---

## v2.0.0-beta.23

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **AWS**: Various bugs in Lambda Function &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(92611)</samp>](https://github.com/alchemy-run/alchemy/commit/92611cd)
- **cli**: Logs and tail command read state from right place &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/114 [<samp>(00163)</samp>](https://github.com/alchemy-run/alchemy/commit/0016361)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.22...HEAD)

---

## v2.0.0-beta.22

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Cloudflare**: D1Database migrationsDir, importFiles, and clone &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/111 [<samp>(555e8)</samp>](https://github.com/alchemy-run/alchemy/commit/555e8ff)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.21...HEAD)

---

## v2.0.0-beta.21

### &nbsp;&nbsp;&nbsp;🚀 Features

- **pr-pkg**: Pr-package package &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/110 [<samp>(9442d)</samp>](https://github.com/alchemy-run/alchemy/commit/9442d42)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Update to distilled 0.13.1 &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b0407)</samp>](https://github.com/alchemy-run/alchemy/commit/b040783)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.20...HEAD)

---

## v2.0.0-beta.20

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Update to effect beta.58 & distilled 0.13 &nbsp;-&nbsp; by **Michael (Pear)** [<samp>(d6f4e)</samp>](https://github.com/alchemy-run/alchemy/commit/d6f4e53)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.19...HEAD)

---

## v2.0.0-beta.19

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Axiom**:
  - Axiom resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f2ffd)</samp>](https://github.com/alchemy-run/alchemy/commit/f2ffde1)
  - Type-safe dashboard charts &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(46f05)</samp>](https://github.com/alchemy-run/alchemy/commit/46f051d)
- **Bundle**:
  - Auto-detect entry package for pure annotations &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ce5f3)</samp>](https://github.com/alchemy-run/alchemy/commit/ce5f35b)
- **core**:
  - Annotate pure calls to optimize tree shaking &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e21a6)</samp>](https://github.com/alchemy-run/alchemy/commit/e21a605)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Axiom**:
  - Ensure token is always present and handle missing token error in ApiTokenProvider &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(da86a)</samp>](https://github.com/alchemy-run/alchemy/commit/da86abb)
  - Don't replace token when props don't cange &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ac655)</samp>](https://github.com/alchemy-run/alchemy/commit/ac65581)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.18...v2.0.0-beta.19)

---

## v2.0.0-beta.18

### &nbsp;&nbsp;&nbsp;🚀 Features

- **CloudFront**: CachePolicy, OriginRequestPolicy, ResponseHeadersPolicy, PublicKey, KeyGroup &nbsp;-&nbsp; by **Jordan** and **Claude Opus 4.7** in https://github.com/alchemy-run/alchemy/issues/106 [<samp>(70201)</samp>](https://github.com/alchemy-run/alchemy/commit/7020108)
- **GitHub**: Secrets helper for creating many secrets &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7be53)</samp>](https://github.com/alchemy-run/alchemy/commit/7be536a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.17...v2.0.0-beta.18)

---

## v2.0.0-beta.17

### &nbsp;&nbsp;&nbsp;🚀 Features

- **ECS**:
  - Add CapacityProvider resource &nbsp;-&nbsp; by **Jordan** in https://github.com/alchemy-run/alchemy/issues/103 [<samp>(cb218)</samp>](https://github.com/alchemy-run/alchemy/commit/cb2183e)
- **cli**:
  - Add alchemy profile clear command &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/104 [<samp>(9dde9)</samp>](https://github.com/alchemy-run/alchemy/commit/9dde996)
  - Add `alchemy state clear` command &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/105 [<samp>(26bf5)</samp>](https://github.com/alchemy-run/alchemy/commit/26bf5e4)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Don't modify ApiToken policies, let user write explicitly. &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/102 [<samp>(5c31b)</samp>](https://github.com/alchemy-run/alchemy/commit/5c31b1f)
- **GitHub**:
  - Place Comment in the GitHub.Providers collection &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3ad95)</samp>](https://github.com/alchemy-run/alchemy/commit/3ad95cb)
- **cli**:
  - Don't prompt for approval if plan has no changes &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(891cf)</samp>](https://github.com/alchemy-run/alchemy/commit/891cf1c)
  - Dont print undefined outputs &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(31ade)</samp>](https://github.com/alchemy-run/alchemy/commit/31ade04)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.16...v2.0.0-beta.17)

---

## v2.0.0-beta.16

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Cloudflare**:
  - Artifacts Store &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e531f)</samp>](https://github.com/alchemy-run/alchemy/commit/e531fbe)
  - Allow account ID to be passed into AccountApiToken and UserApiToken &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(0f8ac)</samp>](https://github.com/alchemy-run/alchemy/commit/0f8ac88)
- **GitHub**:
  - Auth provider for github supporting env, PAT and gh cli &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1de51)</samp>](https://github.com/alchemy-run/alchemy/commit/1de5180)
- **cli**:
  - Alchemy profile show &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f83e2)</samp>](https://github.com/alchemy-run/alchemy/commit/f83e216)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**: Remove InstanceId from Artifact store requirement &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(de489)</samp>](https://github.com/alchemy-run/alchemy/commit/de489c7)
- **cli**: Don't fail on broken profiles when logging in &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d8296)</samp>](https://github.com/alchemy-run/alchemy/commit/d829616)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.15...v2.0.0-beta.16)

---

## v2.0.0-beta.15

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Cloudflare**: UserApiToken and AccountApiToken &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(56e0f)</samp>](https://github.com/alchemy-run/alchemy/commit/56e0f79)
- **GitHub**: Export a providers() Layer &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e5cd4)</samp>](https://github.com/alchemy-run/alchemy/commit/e5cd471)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Properly handle redacted outputs &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/101 [<samp>(0d049)</samp>](https://github.com/alchemy-run/alchemy/commit/0d049aa)
- **Cloudflare**:
  - Prefix State Store secrets with Alchemy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e2533)</samp>](https://github.com/alchemy-run/alchemy/commit/e25338e)
- **core**:
  - Clearer error when Stack is missing state or providers &nbsp;-&nbsp; by **Michael K** [<samp>(52cf4)</samp>](https://github.com/alchemy-run/alchemy/commit/52cf431)
  - Core no longer requires cli &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/100 [<samp>(aba0e)</samp>](https://github.com/alchemy-run/alchemy/commit/aba0ea4)
  - Handle Redacted values in Plan &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4fc48)</samp>](https://github.com/alchemy-run/alchemy/commit/4fc4874)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.14...v2.0.0-beta.15)

---

## v2.0.0-beta.14

### &nbsp;&nbsp;&nbsp;🚀 Features

- **Cloudflare**: Cloudflare State Store &nbsp;-&nbsp; by **Sam Goodwin** and **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/94 [<samp>(d3b12)</samp>](https://github.com/alchemy-run/alchemy/commit/d3b1298)
- **cli**: Alchemy state command &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b4a1d)</samp>](https://github.com/alchemy-run/alchemy/commit/b4a1d94)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**: Set rolldown resolve.conditionNames for bun/node in container bundle &nbsp;-&nbsp; by **Christopher Yovanovitch** in https://github.com/alchemy-run/alchemy/issues/86 [<samp>(779bb)</samp>](https://github.com/alchemy-run/alchemy/commit/779bbd1)
- **cli**: Use a cli.js shim to support node/bun and make effect a non-optional peer &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/92 [<samp>(9b69b)</samp>](https://github.com/alchemy-run/alchemy/commit/9b69ba3)
- **core**: Harden HttpStateStore to transient errors &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4071e)</samp>](https://github.com/alchemy-run/alchemy/commit/4071e8a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.13...v2.0.0-beta.14)

---

## v2.0.0-beta.13

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cli**: Cli ships correct platform versions &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/91 [<samp>(e3597)</samp>](https://github.com/alchemy-run/alchemy/commit/e3597ab)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.12...v2.0.0-beta.13)

---

## v2.0.0-beta.12

### &nbsp;&nbsp;&nbsp;🚀 Features

- **AWS**: Use account-regional S3 bucket names for assets &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6ab3f)</samp>](https://github.com/alchemy-run/alchemy/commit/6ab3fba)
- **cloudflare**: Secret store resources &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/64 [<samp>(9b107)</samp>](https://github.com/alchemy-run/alchemy/commit/9b10769)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Providers not inheriting parent scope &nbsp;-&nbsp; by **John Royal** [<samp>(8317b)</samp>](https://github.com/alchemy-run/alchemy/commit/8317bcc)
- Include WebSocketConstructor in PlatformServices &nbsp;-&nbsp; by **John Royal** [<samp>(2dfb0)</samp>](https://github.com/alchemy-run/alchemy/commit/2dfb06e)

### &nbsp;&nbsp;&nbsp;🏎 Performance

- Use subpath imports for PlatformServices &nbsp;-&nbsp; by **John Royal** [<samp>(1867a)</samp>](https://github.com/alchemy-run/alchemy/commit/1867a42)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.11...v2.0.0-beta.12)

---

## v2.0.0-beta.11

### &nbsp;&nbsp;&nbsp;🚀 Features

- Support vite 7 &nbsp;-&nbsp; by **John Royal** and **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/68 [<samp>(28d0e)</samp>](https://github.com/alchemy-run/alchemy/commit/28d0ef2)
- **Cloudflare**:
  - Install external deps in container Dockerfile &nbsp;-&nbsp; by **Christopher Yovanovitch** and **Sisyphus** in https://github.com/alchemy-run/alchemy/issues/75 [<samp>(f8493)</samp>](https://github.com/alchemy-run/alchemy/commit/f84934f)
  - Add Queue, QueueBinding, and QueueConsumer resources &nbsp;-&nbsp; by **Christopher Yovanovitch** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/69 [<samp>(09e97)</samp>](https://github.com/alchemy-run/alchemy/commit/09e971b)
- **cli**:
  - Alchemy login &nbsp;-&nbsp; by **Sam Goodwin** and **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/67 [<samp>(fc57d)</samp>](https://github.com/alchemy-run/alchemy/commit/fc57db8)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Provide WorkerEnvironment to Workflow body, not wrapper &nbsp;-&nbsp; by **Christopher Yovanovitch** in https://github.com/alchemy-run/alchemy/issues/71 [<samp>(a0ae1)</samp>](https://github.com/alchemy-run/alchemy/commit/a0ae1d6)
  - Write all bundle chunks to container image context &nbsp;-&nbsp; by **Christopher Yovanovitch** in https://github.com/alchemy-run/alchemy/issues/78 [<samp>(03306)</samp>](https://github.com/alchemy-run/alchemy/commit/0330605)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.10...v2.0.0-beta.11)

---

## v2.0.0-beta.10

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Cloudflare**:
  - Reduce readiness retry schedule from 104s to 30s &nbsp;-&nbsp; by **Christopher Yovanovitch** and **Sisyphus** in https://github.com/alchemy-run/alchemy/issues/76 [<samp>(bb2bf)</samp>](https://github.com/alchemy-run/alchemy/commit/bb2bff2)
  - Await monitor() Promise instead of discarding it &nbsp;-&nbsp; by **Christopher Yovanovitch** and **Sisyphus** in https://github.com/alchemy-run/alchemy/issues/74 [<samp>(d75e6)</samp>](https://github.com/alchemy-run/alchemy/commit/d75e6dd)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.9...v2.0.0-beta.10)

---

## v2.0.0-beta.9

### &nbsp;&nbsp;&nbsp;🚀 Features

- CLI packages &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/66 [<samp>(73e2a)</samp>](https://github.com/alchemy-run/alchemy/commit/73e2a45)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.8...v2.0.0-beta.9)

---

## v2.0.0-beta.8

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Add stack export to package.json &nbsp;-&nbsp; by **John Royal** [<samp>(0ede2)</samp>](https://github.com/alchemy-run/alchemy/commit/0ede2c3)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.7...v2.0.0-beta.8)

---

## v2.0.0-beta.7

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Use consistent comaptibility date and flags in Worker &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(deda3)</samp>](https://github.com/alchemy-run/alchemy/commit/deda381)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.6...v2.0.0-beta.7)

---

## v2.0.0-beta.6

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Set nodejs_compat by default for Effect Workers &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ff780)</samp>](https://github.com/alchemy-run/alchemy/commit/ff780f3)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.5...v2.0.0-beta.6)

---

## v2.0.0-beta.5

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Running with bun no longer runs unbundled alchemy bin &nbsp;-&nbsp; by **Michael (Pear)** [<samp>(61198)</samp>](https://github.com/alchemy-run/alchemy/commit/61198ca)
- **core**: Use Provider collection as requirements &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f81cc)</samp>](https://github.com/alchemy-run/alchemy/commit/f81cccb)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.4...v2.0.0-beta.5)

---

## v2.0.0-beta.4

### &nbsp;&nbsp;&nbsp;🚀 Features

- Pr-package service &nbsp;-&nbsp; by **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/54 [<samp>(6edd8)</samp>](https://github.com/alchemy-run/alchemy/commit/6edd8dd)
- **cloudflare**:
  - Async DurableObjetNamespace binding &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(25b90)</samp>](https://github.com/alchemy-run/alchemy/commit/25b9012)
  - Async Assets binding &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f1a3c)</samp>](https://github.com/alchemy-run/alchemy/commit/f1a3c6f)
  - Alarms and ScheduledEvents &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1f183)</samp>](https://github.com/alchemy-run/alchemy/commit/1f183c0)
  - Worker Custom Domains &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(670c5)</samp>](https://github.com/alchemy-run/alchemy/commit/670c575)
- **core**:
  - AuthProvider &nbsp;-&nbsp; by **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/61 [<samp>(bac01)</samp>](https://github.com/alchemy-run/alchemy/commit/bac01b7)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Rename cli binary from "alchemy-effect" to "alchemy" &nbsp;-&nbsp; by **John Royal** [<samp>(b8b3a)</samp>](https://github.com/alchemy-run/alchemy/commit/b8b3a8c)
- Fix exports &nbsp;-&nbsp; by **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/62 [<samp>(903c2)</samp>](https://github.com/alchemy-run/alchemy/commit/903c262)
- **aws**: Fix VpcEndpoint resource bad state checks &nbsp;-&nbsp; by **Michael (Pear)** and **Marc MacLeod** in https://github.com/alchemy-run/alchemy/issues/63 [<samp>(f1fd2)</samp>](https://github.com/alchemy-run/alchemy/commit/f1fd20b)
- **core**: Use platform-bun when running in bun, otherwise platform-node &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3b0d6)</samp>](https://github.com/alchemy-run/alchemy/commit/3b0d6b0)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.3...v2.0.0-beta.4)

---

## v2.0.0-beta.test-export-fix-4

_No significant changes_

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.test-export-fix-3...v2.0.0-beta.test-export-fix-4)

---

## v2.0.0-beta.test-export-fix-3

_No significant changes_

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.test-export-fix-2...v2.0.0-beta.test-export-fix-3)

---

## v2.0.0-beta.test-export-fix-2

_No significant changes_

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.test-export-fix...v2.0.0-beta.test-export-fix-2)

---

## v2.0.0-beta.test-export-fix

### &nbsp;&nbsp;&nbsp;🚀 Features

- Pr-package service &nbsp;-&nbsp; by **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/54 [<samp>(6edd8)</samp>](https://github.com/alchemy-run/alchemy/commit/6edd8dd)
- **cloudflare**:
  - Async DurableObjetNamespace binding &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(25b90)</samp>](https://github.com/alchemy-run/alchemy/commit/25b9012)
  - Async Assets binding &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f1a3c)</samp>](https://github.com/alchemy-run/alchemy/commit/f1a3c6f)
  - Alarms and ScheduledEvents &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1f183)</samp>](https://github.com/alchemy-run/alchemy/commit/1f183c0)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Rename cli binary from "alchemy-effect" to "alchemy" &nbsp;-&nbsp; by **John Royal** [<samp>(b8b3a)</samp>](https://github.com/alchemy-run/alchemy/commit/b8b3a8c)
- Fix export order &nbsp;-&nbsp; by **Michael (Pear)** [<samp>(7bea9)</samp>](https://github.com/alchemy-run/alchemy/commit/7bea945)
- **core**: Use platform-bun when running in bun, otherwise platform-node &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3b0d6)</samp>](https://github.com/alchemy-run/alchemy/commit/3b0d6b0)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.3...v2.0.0-beta.test-export-fix)

---

## v2.0.0-beta.3

### &nbsp;&nbsp;&nbsp;🚀 Features

- **GitHub**:
  - Comment Resource and CI guide &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(5e938)</samp>](https://github.com/alchemy-run/alchemy/commit/5e93857)
  - Secret and Variable &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(0f620)</samp>](https://github.com/alchemy-run/alchemy/commit/0f620bd)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **core**: Fix undefined Provider in plan &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e0143)</samp>](https://github.com/alchemy-run/alchemy/commit/e01431f)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.2...v2.0.0-beta.3)

---

## v2.0.0-beta.2

### &nbsp;&nbsp;&nbsp;🚀 Features

- ProviderCollections reduce number of Provider types polluting user's types &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9f76b)</samp>](https://github.com/alchemy-run/alchemy/commit/9f76b91)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.1...v2.0.0-beta.2)

---

## v2.0.0-beta.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- Migrate to effect@4.0.0-beta.48 &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8674e)</samp>](https://github.com/alchemy-run/alchemy/commit/8674e8f)
- **cloudflare**: Support R2Bucket.bind instead of R2BucketBinding.bind for all CF resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(12b50)</samp>](https://github.com/alchemy-run/alchemy/commit/12b50d3)
- **core**: Alchemy.Stack &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(68e66)</samp>](https://github.com/alchemy-run/alchemy/commit/68e6622)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Release to alchemy package &nbsp;-&nbsp; by **Michael (Pear)** in https://github.com/alchemy-run/alchemy/issues/55 [<samp>(217c5)</samp>](https://github.com/alchemy-run/alchemy/commit/217c5c9)
- **cloudflare**:
  - Require Content Length in R2.put and use raw ReadableStream if available &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1cd6b)</samp>](https://github.com/alchemy-run/alchemy/commit/1cd6bda)
  - Bundle properly formats windows paths &nbsp;-&nbsp; by **Michael (Pear)** [<samp>(5156c)</samp>](https://github.com/alchemy-run/alchemy/commit/5156c6c)
- **test**:
  - Infer and resolve Output types in Test/Bun &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9853d)</samp>](https://github.com/alchemy-run/alchemy/commit/9853d92)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.11.0...v2.0.0-beta.1)

---

## v0.11.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **test**: Add skipIf to bun testing harness &nbsp;-&nbsp; by **Michael (Pear)** [<samp>(6021c)</samp>](https://github.com/alchemy-run/alchemy/commit/6021c3d)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **Http**: Lazy-import platform-node to avoid crash on Bun &nbsp;-&nbsp; by **Christopher Yovanovitch** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/48 [<samp>(85224)</samp>](https://github.com/alchemy-run/alchemy/commit/852243b)
- **cloudflare**: Bindings resolve Effect<Resource> and remove KV per-operation bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(61e02)</samp>](https://github.com/alchemy-run/alchemy/commit/61e0244)
- **core**: Migrate to Provider.effect so that providers are tree-shakable &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/53 [<samp>(73029)</samp>](https://github.com/alchemy-run/alchemy/commit/7302911)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.10.0...v0.11.0)

---

## v0.10.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - Accept Output<T> in Worker env + Vite props &nbsp;-&nbsp; by **cooper** in https://github.com/alchemy-run/alchemy/issues/51 [<samp>(9560b)</samp>](https://github.com/alchemy-run/alchemy/commit/9560bed)
  - Allow bindings to be undefined &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(15c8c)</samp>](https://github.com/alchemy-run/alchemy/commit/15c8c6e)
  - Rename DynamicWorker to DynamicWorkerLoader &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(39f89)</samp>](https://github.com/alchemy-run/alchemy/commit/39f89d5)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.9.1...v0.10.0)

---

## v0.9.1

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Environment variables silently dropped &nbsp;-&nbsp; by **cooper** in https://github.com/alchemy-run/alchemy/issues/49 [<samp>(847f0)</samp>](https://github.com/alchemy-run/alchemy/commit/847f0c2)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.9.0...v0.9.1)

---

## v0.9.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **core**: Bun test helpers &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(40af3)</samp>](https://github.com/alchemy-run/alchemy/commit/40af3f4)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Delay WorkerEnvironment resolution for R2Bucket binding until inside Worker &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b41b1)</samp>](https://github.com/alchemy-run/alchemy/commit/b41b1c3)
  - Precreate Worker with tags and resolve DO namespace IDs as Worker output attributes &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c6b2a)</samp>](https://github.com/alchemy-run/alchemy/commit/c6b2add)
  - Retry eventually consistent ContainerApplicationNotFound error &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(90d75)</samp>](https://github.com/alchemy-run/alchemy/commit/90d7524)
  - Resolve Durable Object namespace IDs in precreate &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(cd1e2)</samp>](https://github.com/alchemy-run/alchemy/commit/cd1e25d)
  - Use Sonda to generate bundle report &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a7a9c)</samp>](https://github.com/alchemy-run/alchemy/commit/a7a9c5f)
  - Recover from partial ContainerApplication failure &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(04890)</samp>](https://github.com/alchemy-run/alchemy/commit/04890d3)
- **core**:
  - Use a Deferred to support parallel caching &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ca693)</samp>](https://github.com/alchemy-run/alchemy/commit/ca693b5)
  - Exclude Artifacts from provider requirements &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a0aec)</samp>](https://github.com/alchemy-run/alchemy/commit/a0aec34)
  - Resolve Effects in Binding.Sevice.bind &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b82f2)</samp>](https://github.com/alchemy-run/alchemy/commit/b82f262)
- **test**:
  - Return output of deploying stack in a test &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6d354)</samp>](https://github.com/alchemy-run/alchemy/commit/6d354a1)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.8.0...v0.9.0)

---

## v0.8.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**: Async-alchemy style bindings and R2 wrapper &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4c4ca)</samp>](https://github.com/alchemy-run/alchemy/commit/4c4ca91)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.7.1...v0.8.0)

---

## v0.7.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- **core**: Support deploy --force &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/43 [<samp>(06b88)</samp>](https://github.com/alchemy-run/alchemy/commit/06b881a)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.7.0...v0.7.1)

---

## v0.7.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **cloudflare**:
  - Vite integration &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/41 [<samp>(e3c16)</samp>](https://github.com/alchemy-run/alchemy/commit/e3c160c)
- **core**:
  - Add Output.as<T>() &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(33186)</samp>](https://github.com/alchemy-run/alchemy/commit/33186ef)
  - Artifact service for caching build artifacts across plan and apply &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(dc60e)</samp>](https://github.com/alchemy-run/alchemy/commit/dc60e9e)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.4...v0.7.0)

---

## v0.6.4

_No significant changes_

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.3...v0.6.4)

---

## v0.6.3

### &nbsp;&nbsp;&nbsp;🚀 Features

- **better-auth**:
  - Add @alchemy.run/better-auth packag with D1 support &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9dc0f)</samp>](https://github.com/alchemy-run/alchemy/commit/9dc0ff6)
- **cloudflare**:
  - D1Database resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(48fd4)</samp>](https://github.com/alchemy-run/alchemy/commit/48fd499)
  - Expose raw Cloudflare.Request as a Tag &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(67998)</samp>](https://github.com/alchemy-run/alchemy/commit/67998cd)
- **core**:
  - Random resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(71527)</samp>](https://github.com/alchemy-run/alchemy/commit/715278e)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Replace Schedule.compose with Schedule.both &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(46195)</samp>](https://github.com/alchemy-run/alchemy/commit/461951d)
- **cli**:
  - Simplify logs query to latest hour &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b4a47)</samp>](https://github.com/alchemy-run/alchemy/commit/b4a4733)
  - Used TaggedError in Daemon &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(77a78)</samp>](https://github.com/alchemy-run/alchemy/commit/77a788a)
- **cloudflare**:
  - Export D1 resources and bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d9e94)</samp>](https://github.com/alchemy-run/alchemy/commit/d9e9447)
  - Export D1 resources and bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(bcd43)</samp>](https://github.com/alchemy-run/alchemy/commit/bcd436d)
- **core**:
  - Support updating downstream to unlink and delete a binding &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6bdf8)</samp>](https://github.com/alchemy-run/alchemy/commit/6bdf8e9)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.2...v0.6.3)

---

## v0.6.2

_No significant changes_

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.1...v0.6.2)

---

## v0.6.1

### &nbsp;&nbsp;&nbsp;🚀 Features

- Move to distilled-aws &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e12f2)</samp>](https://github.com/alchemy-run/alchemy/commit/e12f2a6)
- Add S3 data plane APIs &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Haiku 4.5** in https://github.com/alchemy-run/alchemy/issues/34 [<samp>(f2986)</samp>](https://github.com/alchemy-run/alchemy/commit/f2986ab)
- Bootstrap CLI command &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3a79a)</samp>](https://github.com/alchemy-run/alchemy/commit/3a79a04)
- Lambda.consumeTable &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(420c1)</samp>](https://github.com/alchemy-run/alchemy/commit/420c124)
- Remove ExecutionContext from Policy requirements &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(867ef)</samp>](https://github.com/alchemy-run/alchemy/commit/867ef28)
- Implement HttpServer for Lambda and Cloudflare &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(655df)</samp>](https://github.com/alchemy-run/alchemy/commit/655dfd1)
- Namespaces &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(46050)</samp>](https://github.com/alchemy-run/alchemy/commit/4605092)
- Implement Host, Self and make Lambda entrypoint &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1d9a2)</samp>](https://github.com/alchemy-run/alchemy/commit/1d9a218)
- Generalize bundler and end to end deployment working &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(65353)</samp>](https://github.com/alchemy-run/alchemy/commit/65353fc)
- Namespace tree for organizing Resources and Bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3b937)</samp>](https://github.com/alchemy-run/alchemy/commit/3b93785)
- Default AWS StageConfig &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(45152)</samp>](https://github.com/alchemy-run/alchemy/commit/4515245)
- Bind Outputs to environment variables &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9ff75)</samp>](https://github.com/alchemy-run/alchemy/commit/9ff7587)
- End-to-end bundling, bindings and IAM policies &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d2fef)</samp>](https://github.com/alchemy-run/alchemy/commit/d2fef7a)
- Migrate to @distilled.cloud (v2) &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(75151)</samp>](https://github.com/alchemy-run/alchemy/commit/75151e7)
- Support external platforms &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7ed9f)</samp>](https://github.com/alchemy-run/alchemy/commit/7ed9ffb)
- **aws**:
  - DynamoDB Bindings and an AI process for implementing an aws service &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(cdfd4)</samp>](https://github.com/alchemy-run/alchemy/commit/cdfd45b)
  - DynamoDB Table Stream &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ec61a)</samp>](https://github.com/alchemy-run/alchemy/commit/ec61a6d)
  - SNS Topic, Subscription, TopicSink and EventSource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4d3af)</samp>](https://github.com/alchemy-run/alchemy/commit/4d3af74)
  - Cloudwatch Resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(30544)</samp>](https://github.com/alchemy-run/alchemy/commit/3054413)
  - Add logs and tail for Lambda Functions &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8403c)</samp>](https://github.com/alchemy-run/alchemy/commit/8403cda)
- **aws, dynamodb**:
  - Add Batch and Transact Operations &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(73a01)</samp>](https://github.com/alchemy-run/alchemy/commit/73a0134)
- **aws, eventbridge**:
  - EventBrdige Resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4809c)</samp>](https://github.com/alchemy-run/alchemy/commit/4809c8e)
- **aws,acm**:
  - Certificate &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c082f)</samp>](https://github.com/alchemy-run/alchemy/commit/c082f83)
- **aws,autoscaling**:
  - AutoScalingGroup, LaunchTemplate, ScalingPolicy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d7878)</samp>](https://github.com/alchemy-run/alchemy/commit/d787847)
- **aws,cloudfront**:
  - Distribution, Function, Invalidation, KeyValueStore, OriginAccessControl &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2d2e5)</samp>](https://github.com/alchemy-run/alchemy/commit/2d2e528)
- **aws,ec2**:
  - EC2 Network and Instance &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8e686)</samp>](https://github.com/alchemy-run/alchemy/commit/8e686d7)
  - Share Hsot logic across EC2 Instance and LaunchTemplate &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(691e2)</samp>](https://github.com/alchemy-run/alchemy/commit/691e20b)
- **aws,ecr**:
  - Repository Resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(0af1e)</samp>](https://github.com/alchemy-run/alchemy/commit/0af1ec1)
- **aws,ecs**:
  - ECS Cluster, Task and Service Resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(11c74)</samp>](https://github.com/alchemy-run/alchemy/commit/11c7438)
- **aws,eks**:
  - AWS Auto EKS Cluster resoruces &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9b4f9)</samp>](https://github.com/alchemy-run/alchemy/commit/9b4f96f)
- **aws,elbv2**:
  - Listener, LoadBalancer, TargetGroup &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8486e)</samp>](https://github.com/alchemy-run/alchemy/commit/8486e65)
  - Support TCP protocol in Listener, LoadBalancer &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b5128)</samp>](https://github.com/alchemy-run/alchemy/commit/b5128d7)
- **aws,http**:
  - Handle unrecoverable Http errors, fix GetObject IAM policy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(39e5c)</samp>](https://github.com/alchemy-run/alchemy/commit/39e5c6c)
- **aws,iam**:
  - AWS IAM Resources, Operations and Tests &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8638a)</samp>](https://github.com/alchemy-run/alchemy/commit/8638abe)
- **aws,iamidentitycenter**:
  - AccountAssignment, Group, Instance, PermissionSet &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3f864)</samp>](https://github.com/alchemy-run/alchemy/commit/3f86467)
- **aws,kinesiss**:
  - Operations for Kinesis Streams, including EventSource and Sinks &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8b40c)</samp>](https://github.com/alchemy-run/alchemy/commit/8b40c72)
- **aws,lambda**:
  - EventBridge and Stream Event Sources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(311a0)</samp>](https://github.com/alchemy-run/alchemy/commit/311a04b)
- **aws,logs**:
  - LogGroup Resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ff7e2)</samp>](https://github.com/alchemy-run/alchemy/commit/ff7e2de)
- **aws,organizations**:
  - Account, DelegatedAdministrator, Organization, OrganizationalUnit, OrganizationResourcePolicy, Policy, PolicyAttachment, Root, RootPolicyType, TrustedServiceAccess &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ed86a)</samp>](https://github.com/alchemy-run/alchemy/commit/ed86a76)
  - TenantRoot &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b6f7b)</samp>](https://github.com/alchemy-run/alchemy/commit/b6f7b21)
- **aws,pipes**:
  - Pipe resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(38af3)</samp>](https://github.com/alchemy-run/alchemy/commit/38af3e0)
- **aws,rds**:
  - DB\* Resources, Aurora, Connect and RDSData &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9742b)</samp>](https://github.com/alchemy-run/alchemy/commit/9742b8c)
- **aws,route53**:
  - Record &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(71d88)</samp>](https://github.com/alchemy-run/alchemy/commit/71d88cd)
- **aws,scheduler**:
  - Schedule, ScheduleGroup resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3be73)</samp>](https://github.com/alchemy-run/alchemy/commit/3be73bd)
- **aws,secretsmanager**:
  - Secret Resource and Bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a8a39)</samp>](https://github.com/alchemy-run/alchemy/commit/a8a39bd)
- **aws,sqs**:
  - Allow DeleteMessageBatch, ReceiveMessage and SendMessage on EC2 &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(bddb4)</samp>](https://github.com/alchemy-run/alchemy/commit/bddb4bb)
- **aws,website**:
  - SsrSite, StaticSite, Router &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d4f14)</samp>](https://github.com/alchemy-run/alchemy/commit/d4f14c3)
  - Bring StaticSite up to par with SST &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6aaac)</samp>](https://github.com/alchemy-run/alchemy/commit/6aaace9)
- **build**:
  - Docker commands &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d12cf)</samp>](https://github.com/alchemy-run/alchemy/commit/d12cf9f)
- **cli**:
  - Tail and logs &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(b0a06)</samp>](https://github.com/alchemy-run/alchemy/commit/b0a061e)
  - Filter logs and tail by resource ID &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a6514)</samp>](https://github.com/alchemy-run/alchemy/commit/a6514c7)
  - Process Manager daemon &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c0fd1)</samp>](https://github.com/alchemy-run/alchemy/commit/c0fd148)
- **cloudflare**:
  - Durable Objects and Worker entrypoint/exports &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(aa6d3)</samp>](https://github.com/alchemy-run/alchemy/commit/aa6d3a0)
  - Durable Objects and Containers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/37 [<samp>(ccade)</samp>](https://github.com/alchemy-run/alchemy/commit/ccade21)
  - DynamicWorker &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8c5d2)</samp>](https://github.com/alchemy-run/alchemy/commit/8c5d205)
  - Workflows &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(874cc)</samp>](https://github.com/alchemy-run/alchemy/commit/874cc9a)
- **core**:
  - Handle circular binding cycles &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6d843)</samp>](https://github.com/alchemy-run/alchemy/commit/6d843c4)
  - Construct.fn and two-phase apply &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(7c8bd)</samp>](https://github.com/alchemy-run/alchemy/commit/7c8bd2b)
  - Enhance convrergence of circularity in alchemy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(fbfbf)</samp>](https://github.com/alchemy-run/alchemy/commit/fbfbf2a)
  - Allow replace on top of a partially replaced resurce &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(3c630)</samp>](https://github.com/alchemy-run/alchemy/commit/3c63096)
- **k8s**:
  - Kubernetes Manifest, Service, ServiceAccount, etc. &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8d2d1)</samp>](https://github.com/alchemy-run/alchemy/commit/8d2d133)
- **kinesis**:
  - Add AWS Kinesis Stream resource and capabilities &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Haiku 4.5** in https://github.com/alchemy-run/alchemy/issues/30 [<samp>(3f30b)</samp>](https://github.com/alchemy-run/alchemy/commit/3f30b79)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Improve deletion of ec2 resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c5bf6)</samp>](https://github.com/alchemy-run/alchemy/commit/c5bf62f)
- Stack.make to capture providers and re-implement binding diffs in Plan &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(94e40)</samp>](https://github.com/alchemy-run/alchemy/commit/94e401c)
- Use error.\_tag instead of error.name &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(87cbf)</samp>](https://github.com/alchemy-run/alchemy/commit/87cbfa3)
- Handle undefined props &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(63f08)</samp>](https://github.com/alchemy-run/alchemy/commit/63f0869)
- Write bundle temp files to .alchemy/tmp &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(0b491)</samp>](https://github.com/alchemy-run/alchemy/commit/0b49156)
- Write temporary bundle file inside .alchemy within the correct module &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6d678)</samp>](https://github.com/alchemy-run/alchemy/commit/6d678c8)
- Resource Service inherits call-site Context &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(07511)</samp>](https://github.com/alchemy-run/alchemy/commit/0751195)
- **aws**:
  - Provide stack, stage and phase at runtime &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(befb4)</samp>](https://github.com/alchemy-run/alchemy/commit/befb4ff)
  - Add missing Provider and Binding layers &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f41c1)</samp>](https://github.com/alchemy-run/alchemy/commit/f41c13b)
  - Add missing Providers &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(82f51)</samp>](https://github.com/alchemy-run/alchemy/commit/82f51ef)
  - Bootstrap command creates and tags the bucket &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(5a36f)</samp>](https://github.com/alchemy-run/alchemy/commit/5a36fab)
  - EC2 and LaunchTemplate host now provide ExecutionContext.Server &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e2f01)</samp>](https://github.com/alchemy-run/alchemy/commit/e2f0100)
  - Avoid redundant updates when source map changes &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(48fe5)</samp>](https://github.com/alchemy-run/alchemy/commit/48fe5cd)
- **aws,cloudflare**:
  - Fix AnomalyDetector and bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2d47e)</samp>](https://github.com/alchemy-run/alchemy/commit/2d47e71)
- **aws,sns**:
  - ReadSubscription returns undefined if topicArn is unknown &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4e25c)</samp>](https://github.com/alchemy-run/alchemy/commit/4e25c3d)
- **aws,website**:
  - Include stack, stage and FQN in kv namespace &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(e971c)</samp>](https://github.com/alchemy-run/alchemy/commit/e971ca7)
  - End-to-end deployment of StaticSite &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1dea3)</samp>](https://github.com/alchemy-run/alchemy/commit/1dea3ec)
- **cli**:
  - Support running in node and load .env with ConfigProvider &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9b15b)</samp>](https://github.com/alchemy-run/alchemy/commit/9b15b39)
  - Support node and bun for globs &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2bcb6)</samp>](https://github.com/alchemy-run/alchemy/commit/2bcb6d0)
  - Respect caller's node runtime &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6396c)</samp>](https://github.com/alchemy-run/alchemy/commit/6396cd6)
- **cloudflare**:
  - Migrate to distilled-cloudflare and rolldown &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a4184)</samp>](https://github.com/alchemy-run/alchemy/commit/a4184ec)
  - Distilled 0.4.0 pagination apis &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(4bffe)</samp>](https://github.com/alchemy-run/alchemy/commit/4bffe41)
  - Hard-code all exported handler methods instead of Proxy &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(289b9)</samp>](https://github.com/alchemy-run/alchemy/commit/289b92f)
  - Detect changes to Container and Bundle &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(924ff)</samp>](https://github.com/alchemy-run/alchemy/commit/924ffb5)
  - Pass assetsConfig in TanstackStart and StaticSite &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(42832)</samp>](https://github.com/alchemy-run/alchemy/commit/428329f)
  - Get HTTP server plumbing working for containers &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(cf058)</samp>](https://github.com/alchemy-run/alchemy/commit/cf05888)
- **cloudflare,assets**:
  - Pass jwtToken to createAssetUpload &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(26228)</samp>](https://github.com/alchemy-run/alchemy/commit/262289d)
- **core**:
  - Accept Input<T> in Host props &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(09edc)</samp>](https://github.com/alchemy-run/alchemy/commit/09edccf)
  - Add asEffect to Output &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(5ec8d)</samp>](https://github.com/alchemy-run/alchemy/commit/5ec8d27)
- **ec2**:
  - Query attachments when deleting IGW &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ced7f)</samp>](https://github.com/alchemy-run/alchemy/commit/ced7f85)
- **process**:
  - Export Process module &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1600d)</samp>](https://github.com/alchemy-run/alchemy/commit/1600d3c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.6.0...v0.6.1)

---

## v0.6.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **ec2**: NAT Gateway, EIP, Egress IGW, SecurityGroups &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/24 [<samp>(ff04d)</samp>](https://github.com/alchemy-run/alchemy/commit/ff04d57)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.5.0...v0.6.0)

---

## v0.5.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Standardize physical name generation &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(91199)</samp>](https://github.com/alchemy-run/alchemy/commit/9119967)
- **cloudflare**:
  - Rename worker.id and name workerId and workerName &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(273cb)</samp>](https://github.com/alchemy-run/alchemy/commit/273cb26)
  - Rename Bucket.name to Bucket.bucketName and constraint name length &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(a0733)</samp>](https://github.com/alchemy-run/alchemy/commit/a0733a6)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.4.0...v0.5.0)

---

## v0.4.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **ec2**: Add IGW, Route, Route Table, Route Table Assoication &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/23 [<samp>(0eeb6)</samp>](https://github.com/alchemy-run/alchemy/commit/0eeb613)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.3.0...v0.4.0)

---

## v0.3.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- **core**:
  - Inputs and Outputs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/19 [<samp>(fa8b8)</samp>](https://github.com/alchemy-run/alchemy/commit/fa8b893)
  - DefineStack, defineStages and alchemy CLI &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/21 [<samp>(d30da)</samp>](https://github.com/alchemy-run/alchemy/commit/d30da72)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Make props optional in KV Namespace and R2 Bucket &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(dbfbe)</samp>](https://github.com/alchemy-run/alchemy/commit/dbfbe40)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.2.0...v0.3.0)

---

## v0.2.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Diff bindings + Queue Event Source &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/12 [<samp>(f0ba8)</samp>](https://github.com/alchemy-run/alchemy/commit/f0ba897)
- **aws**:
  - DynamoDB Table and getItem &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/10 [<samp>(877ba)</samp>](https://github.com/alchemy-run/alchemy/commit/877ba8f)
  - VPC &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/16 [<samp>(cda86)</samp>](https://github.com/alchemy-run/alchemy/commit/cda86ce)
- **cloudflare**:
  - Worker, Assets, R2, KV &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/13 [<samp>(6e5b1)</samp>](https://github.com/alchemy-run/alchemy/commit/6e5b107)
- **test**:
  - Add test utility &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/15 [<samp>(7a9e1)</samp>](https://github.com/alchemy-run/alchemy/commit/7a9e10f)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Properly type the Resource Provider Layers and use Layer.merge &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(77d69)</samp>](https://github.com/alchemy-run/alchemy/commit/77d69be)
- **core**: Exclude bindings from props diff and include attributes in no-op bind &nbsp;-&nbsp; by **John Royal** in https://github.com/alchemy-run/alchemy/issues/17 [<samp>(6408d)</samp>](https://github.com/alchemy-run/alchemy/commit/6408d2b)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v0.1.0...v0.2.0)

---

## v0.1.0

### &nbsp;&nbsp;&nbsp;🚀 Features

- Adopt currying pattern across codebase to deal with NoInfer and Extract limitations &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9a319)</samp>](https://github.com/alchemy-run/alchemy/commit/9a3193c)
- Remove HKTs from capability and resource &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(88a59)</samp>](https://github.com/alchemy-run/alchemy/commit/88a594a)
- Use triples in Policy to support overriden tags for bindings &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9e8fc)</samp>](https://github.com/alchemy-run/alchemy/commit/9e8fc77)
- Introduce BindingTag to map Binding -> BindingService &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c59b7)</samp>](https://github.com/alchemy-run/alchemy/commit/c59b76c)
- Capture Capability ID in Binding declaration &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(742c2)</samp>](https://github.com/alchemy-run/alchemy/commit/742c205)
- Standardize .provider builder pattern and add 'binding' integration contract type to Runtime &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6afdd)</samp>](https://github.com/alchemy-run/alchemy/commit/6afdd33)
- Include Phase in the Plan and properly type the output of Apply &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1eade)</samp>](https://github.com/alchemy-run/alchemy/commit/1eade78)
- Add provider: { effect, succeed } to Resources &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c4233)</samp>](https://github.com/alchemy-run/alchemy/commit/c42336f)
- Thread BindNode through state and fix the planner &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(c1bb3)</samp>](https://github.com/alchemy-run/alchemy/commit/c1bb313)
- Apply bindings in the generic apply functions instead of each provider &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(f0f34)</samp>](https://github.com/alchemy-run/alchemy/commit/f0f348a)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Bind types &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(d11c7)</samp>](https://github.com/alchemy-run/alchemy/commit/d11c774)
- Update Instance<T> to handle the resource types like Queue &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(6adca)</samp>](https://github.com/alchemy-run/alchemy/commit/6adca3c)
- Re-work simpler types for plan and apply &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(1d08d)</samp>](https://github.com/alchemy-run/alchemy/commit/1d08d19)
- Instance<Queue> maps to Queue instead of Resource<..> &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(aa18f)</samp>](https://github.com/alchemy-run/alchemy/commit/aa18f3a)
- Pass-through of the Props and Bindings to the Service type &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(9784e)</samp>](https://github.com/alchemy-run/alchemy/commit/9784eca)
- Remove Resource from Binding tag construction and implement layer builders &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ada7c)</samp>](https://github.com/alchemy-run/alchemy/commit/ada7cba)
- Plumb through new Plan structure to apply and CLI &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8c057)</samp>](https://github.com/alchemy-run/alchemy/commit/8c0570b)
- Missing props in Capability, Bindingm, Resource and Service &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(aaec3)</samp>](https://github.com/alchemy-run/alchemy/commit/aaec377)
- Include bindings in the plan, fix papercuts, remove node:util usage &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(0a5f4)</samp>](https://github.com/alchemy-run/alchemy/commit/0a5f4d3)
- Log message when SSO token has expired &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(8a7a7)</samp>](https://github.com/alchemy-run/alchemy/commit/8a7a72f)
- Infer return type of Resource.provider.effect &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2093f)</samp>](https://github.com/alchemy-run/alchemy/commit/2093f17)
- Serialize classes properly and rename packages &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(2bf72)</samp>](https://github.com/alchemy-run/alchemy/commit/2bf7290)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/c46b447ca0d46a9e4dbf08a6789770a420d90be5...v0.1.0)

---
