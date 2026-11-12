## v2.0.0-beta.85

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **aws**:
  - DynamoDB is the default AWS.state(), with alchemy state migrate from S3 &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2691 [<samp>(1e5fb)</samp>](https://github.com/alchemy-run/alchemy/commit/1e5fbafec)
  - **lambda**: Event-source handlers return Lambda's batch response for partial failures &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2508 [<samp>(64896)</samp>](https://github.com/alchemy-run/alchemy/commit/648964886)
- **cloudflare**:
  - Durable Object jurisdiction for the Domain platform and workflow engine &nbsp;-&nbsp; by **wikirik-agent** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2601 [<samp>(5959e)</samp>](https://github.com/alchemy-run/alchemy/commit/5959edd30)
  - Cloudflare.state takes workerName only &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2945 [<samp>(02100)</samp>](https://github.com/alchemy-run/alchemy/commit/021002c19)
  - **dns**: Replace foundationDns with nameservers.type cloudflare.advanced &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2501 [<samp>(1e938)</samp>](https://github.com/alchemy-run/alchemy/commit/1e938052b)
- **domain**:
  - A command client takes the target, the input, then call options &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2561 [<samp>(bfc97)</samp>](https://github.com/alchemy-run/alchemy/commit/bfc9765a4)
- **gcp**:
  - **sql**: Private networking, SSL and backup settings on Instance &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2642 [<samp>(7970c)</samp>](https://github.com/alchemy-run/alchemy/commit/7970c8779)
- **github**:
  - Move Ruleset rules to top-level props &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2582 [<samp>(10ed4)</samp>](https://github.com/alchemy-run/alchemy/commit/10ed43bfe)
- **test**:
  - Move Test.make into @alchemy.run/test &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2621 [<samp>(ea988)</samp>](https://github.com/alchemy-run/alchemy/commit/ea9884080)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **alchemist**:
  - Scriptable CLI operations and centralised structured logs &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2765 [<samp>(972f2)</samp>](https://github.com/alchemy-run/alchemy/commit/972f294ae)
- **alchemy-test**:
  - Add --stage; document worktrees and all three test runners &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2613 [<samp>(a9255)</samp>](https://github.com/alchemy-run/alchemy/commit/a925573a6)
- **astro**:
  - Custom Worker entry via main &nbsp;-&nbsp; by **DivMode** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1841 [<samp>(7399a)</samp>](https://github.com/alchemy-run/alchemy/commit/7399a5b4a)
- **aws**:
  - GCP hosts assume AWS roles with Google ID tokens &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2645 [<samp>(d358b)</samp>](https://github.com/alchemy-run/alchemy/commit/d358b653c)
  - DynamoDB state store &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2683 [<samp>(b25f9)</samp>](https://github.com/alchemy-run/alchemy/commit/b25f9d1ad)
  - **autoscaling**:
    - InstanceRequirements and availabilityZoneDistribution on AutoScalingGroup &nbsp;-&nbsp; by **Sam Goodwin** and **Henry Marks** in https://github.com/alchemy-run/alchemy/issues/2817 [<samp>(b4bd9)</samp>](https://github.com/alchemy-run/alchemy/commit/b4bd90c40)
  - **ec2**:
    - Support regional NAT gateways &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2498 [<samp>(f2914)</samp>](https://github.com/alchemy-run/alchemy/commit/f29140a2e)
  - **eventbridge**:
    - Global Endpoint resource, PutEvents through endpoints &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2507 [<samp>(7438a)</samp>](https://github.com/alchemy-run/alchemy/commit/7438a9351)
  - **lambda**:
    - Route event sources, URLs and integrations through a Function alias &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2504 [<samp>(24389)</samp>](https://github.com/alchemy-run/alchemy/commit/24389fbb9)
    - Stream Effect responses through RESPONSE_STREAM function URLs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2502 [<samp>(f038e)</samp>](https://github.com/alchemy-run/alchemy/commit/f038e905e)
    - Start durable executions on the Function alias &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2528 [<samp>(ecca7)</samp>](https://github.com/alchemy-run/alchemy/commit/ecca79955)
    - Interrupt the handler at its timeout &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2682 [<samp>(86bfa)</samp>](https://github.com/alchemy-run/alchemy/commit/86bfa0edd)
- **cli**:
  - Make distilled lazy stubs opt-in with --fast-distilled &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/2677 [<samp>(2bfe5)</samp>](https://github.com/alchemy-run/alchemy/commit/2bfe597d9)
- **cloudflare**:
  - Emulate Flagship locally in alchemy dev &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2746 [<samp>(383d8)</samp>](https://github.com/alchemy-run/alchemy/commit/383d8e8fc)
  - Workflow jurisdiction &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2734 [<samp>(db74f)</samp>](https://github.com/alchemy-run/alchemy/commit/db74fa1b4)
  - Email.Routing subaddressing and Email.RoutingSubdomain &nbsp;-&nbsp; by **Leonardo E. Dominguez** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2762 [<samp>(7d70c)</samp>](https://github.com/alchemy-run/alchemy/commit/7d70cf8d4)
  - Configure workerd options with dev.workerd and env vars &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2791 [<samp>(5b8a2)</samp>](https://github.com/alchemy-run/alchemy/commit/5b8a27a05)
  - Interrupt the Worker handler on client abort &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1638 [<samp>(f3df9)</samp>](https://github.com/alchemy-run/alchemy/commit/f3df92192)
  - **access**: Declare every Access organization setting; accept Redacted IdP client secrets &nbsp;-&nbsp; by **Dillion Verma** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2291 [<samp>(7568f)</samp>](https://github.com/alchemy-run/alchemy/commit/7568f56fd)
  - **alerting**: ConsumeNotifications event source &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2519 [<samp>(2ac47)</samp>](https://github.com/alchemy-run/alchemy/commit/2ac4702a0)
  - **artifacts**: Read repo history and files through the binding &nbsp;-&nbsp; by **Matthew Aylward** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1916 [<samp>(60506)</samp>](https://github.com/alchemy-run/alchemy/commit/60506c838)
  - **queues**: Queue settings and jurisdiction &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2538 [<samp>(399bf)</samp>](https://github.com/alchemy-run/alchemy/commit/399bfca41)
  - **r2**: Us jurisdiction &nbsp;-&nbsp; by **Thijs Koerselman** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2758 [<samp>(45b41)</samp>](https://github.com/alchemy-run/alchemy/commit/45b41d17a)
  - **state-store**: Deploy the state store with direct API calls &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2385 [<samp>(14121)</samp>](https://github.com/alchemy-run/alchemy/commit/14121b4c2)
  - **workers**: CodeUpdateStrategy for Durable Object code updates &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2863 [<samp>(0a26c)</samp>](https://github.com/alchemy-run/alchemy/commit/0a26c00a3)
- **cloudflare-runtime**:
  - Update workerd and sync workers-sdk &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2673 [<samp>(3bb45)</samp>](https://github.com/alchemy-run/alchemy/commit/3bb45b0f0)
- **command**:
  - Command.Dev can wait for a required URL &nbsp;-&nbsp; by **Jason Kuhrt** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2735 [<samp>(955e0)</samp>](https://github.com/alchemy-run/alchemy/commit/955e001c9)
  - Command.Dev can be told its port &nbsp;-&nbsp; by **Jason Kuhrt** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2750 [<samp>(7855e)</samp>](https://github.com/alchemy-run/alchemy/commit/7855ee4fe)
- **dns**:
  - Serializable DNS adapters for custom domains on every platform &nbsp;-&nbsp; by **Sam Goodwin** and **Dan Myles** in https://github.com/alchemy-run/alchemy/issues/1888 [<samp>(ab270)</samp>](https://github.com/alchemy-run/alchemy/commit/ab270fb16)
- **docker**:
  - Build args and BuildKit secrets on every Dockerfile build &nbsp;-&nbsp; by **Jordan** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2225 [<samp>(f5737)</samp>](https://github.com/alchemy-run/alchemy/commit/f57379333)
  - Support container runtime hardening options &nbsp;-&nbsp; by **Yuzu** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2623 [<samp>(6541f)</samp>](https://github.com/alchemy-run/alchemy/commit/6541f316f)
- **domain**:
  - A failed story shows every step and the events so far &nbsp;-&nbsp; by **Taras Kornichuk** in https://github.com/alchemy-run/alchemy/issues/2475 [<samp>(08387)</samp>](https://github.com/alchemy-run/alchemy/commit/083873dda)
  - Stories assert real external calls and fail stubbed ones &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2477 [<samp>(1cb5b)</samp>](https://github.com/alchemy-run/alchemy/commit/1cb5b1b00)
  - Story.call and Story.succeed &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2481 [<samp>(876b1)</samp>](https://github.com/alchemy-run/alchemy/commit/876b15e19)
  - A story's clock only moves forward &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2564 [<samp>(f1771)</samp>](https://github.com/alchemy-run/alchemy/commit/f177114c5)
  - An external system operation can declare several errors &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2553 [<samp>(ce4db)</samp>](https://github.com/alchemy-run/alchemy/commit/ce4db1851)
  - Story.state takes a partial state; fix the hosting skill's Api example &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2549 [<samp>(5d56d)</samp>](https://github.com/alchemy-run/alchemy/commit/5d56d7192)
  - Api.Any, Api.commands and Api.rejections &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2566 [<samp>(82ea9)</samp>](https://github.com/alchemy-run/alchemy/commit/82ea997f0)
  - Key views, projections, streams and policies by a Schema value &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2554 [<samp>(fc143)</samp>](https://github.com/alchemy-run/alchemy/commit/fc143e4a5)
  - Domain.protocolInProcess and client shortcuts per protocol &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2550 [<samp>(efea3)</samp>](https://github.com/alchemy-run/alchemy/commit/efea3df2e)
  - Unschedule a pending scheduled command &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2547 [<samp>(b666b)</samp>](https://github.com/alchemy-run/alchemy/commit/b666ba355)
  - View.snapshot gives state and cursor together; list takes atLeast &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2567 [<samp>(bc3bd)</samp>](https://github.com/alchemy-run/alchemy/commit/bc3bdce63)
  - Aggregate.predict and View.evolve &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2568 [<samp>(1b7ad)</samp>](https://github.com/alchemy-run/alchemy/commit/1b7add810)
  - A command's target must be its aggregate's id schema &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2563 [<samp>(a39a1)</samp>](https://github.com/alchemy-run/alchemy/commit/a39a126bd)
  - Story.advance moves the clock forward by a duration &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2629 [<samp>(b0b85)</samp>](https://github.com/alchemy-run/alchemy/commit/b0b851384)
  - Every live read carries cursors and marks the end of its history &nbsp;-&nbsp; by **Sam Goodwin** and **Taras Kornichuk** in https://github.com/alchemy-run/alchemy/issues/2579 [<samp>(ce983)</samp>](https://github.com/alchemy-run/alchemy/commit/ce983b2ae)
  - Story steps type-check against the last command &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2559 [<samp>(28b92)</samp>](https://github.com/alchemy-run/alchemy/commit/28b923be1)
  - A story fails on committed events no step asserts &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2551 [<samp>(e6f35)</samp>](https://github.com/alchemy-run/alchemy/commit/e6f355831)
  - Add a Foldkit adapter &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2700 [<samp>(a2b39)</samp>](https://github.com/alchemy-run/alchemy/commit/a2b392510)
  - Expose native decision metadata &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2575 [<samp>(f1b40)</samp>](https://github.com/alchemy-run/alchemy/commit/f1b40e1f4)
  - Check external system calls against their schemas &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2548 [<samp>(c365c)</samp>](https://github.com/alchemy-run/alchemy/commit/c365ce2fc)
  - Rejection takes Schema.TaggedError's annotations; rejects takes any tagged error &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2780 [<samp>(5ec8e)</samp>](https://github.com/alchemy-run/alchemy/commit/5ec8e8a7b)
  - Domain.Api names what of its Model it serves, all by default &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2820 [<samp>(27edb)</samp>](https://github.com/alchemy-run/alchemy/commit/27edbc456)
  - ToHttpApi publishes an Api, live reads included, as an HttpApi with OpenAPI &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2587 [<samp>(6ead5)</samp>](https://github.com/alchemy-run/alchemy/commit/6ead50720)
  - @alchemy.run/domain/Ai serves an Api as Effect AI tools and an MCP server &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2586 [<samp>(130ff)</samp>](https://github.com/alchemy-run/alchemy/commit/130ff571d)
  - ToCli runs an Api's calls from a terminal &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2588 [<samp>(269ab)</samp>](https://github.com/alchemy-run/alchemy/commit/269ab9ba8)
  - Backfill and rebuild views and projections in timestamp order &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2725 [<samp>(3700f)</samp>](https://github.com/alchemy-run/alchemy/commit/3700f7eb6)
  - An Api serves every aggregate that declares read, and only those &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2865 [<samp>(4098c)</samp>](https://github.com/alchemy-run/alchemy/commit/4098c2e71)
  - Give each model its own storage and keep deployed data on upgrade &nbsp;-&nbsp; by **Taras Kornichuk** in https://github.com/alchemy-run/alchemy/issues/2560 [<samp>(55e34)</samp>](https://github.com/alchemy-run/alchemy/commit/55e34d027)
  - Bump a view's version to rebuild it, in place when keyed by its aggregate; lazy views &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2875 [<samp>(42adb)</samp>](https://github.com/alchemy-run/alchemy/commit/42adb8656)
- **drizzle**:
  - Drizzle 1.0.0-rc.5 and better schema migrations &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2433 [<samp>(099e8)</samp>](https://github.com/alchemy-run/alchemy/commit/099e8b218)
- **engine**:
  - Observe hook checks ownership before a cyclic precreate &nbsp;-&nbsp; by **Nacho Vazquez** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2195 [<samp>(e993d)</samp>](https://github.com/alchemy-run/alchemy/commit/e993dce80)
- **frontend-frameworks**:
  - Support the latest Astro, Octane, Waku, React Router and Vite releases &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2676 [<samp>(09098)</samp>](https://github.com/alchemy-run/alchemy/commit/090985849)
- **gcp**:
  - Support BigQuery subscriptions on PubSub.Subscription &nbsp;-&nbsp; by **Lucas Duailibe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2213 [<samp>(e3763)</samp>](https://github.com/alchemy-run/alchemy/commit/e3763b844)
  - Gcloud login auth method &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2635 [<samp>(ebedd)</samp>](https://github.com/alchemy-run/alchemy/commit/ebedd6384)
  - AWS hosts reach GCP through workload identity federation &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2648 [<samp>(12da0)</samp>](https://github.com/alchemy-run/alchemy/commit/12da0e2fe)
  - Sign in with named gcloud configurations &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2680 [<samp>(4a846)</samp>](https://github.com/alchemy-run/alchemy/commit/4a8464e15)
  - Deploy-time SQL migrations on Cloud SQL, AlloyDB, and Spanner &nbsp;-&nbsp; by **Sam Goodwin** and **Claude** in https://github.com/alchemy-run/alchemy/issues/2651 [<samp>(ac6a6)</samp>](https://github.com/alchemy-run/alchemy/commit/ac6a63a1b)
  - **iam**:
    - Add WorkloadIdentityPool and WorkloadIdentityProvider &nbsp;-&nbsp; by **fullflexer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2130 [<samp>(c3239)</samp>](https://github.com/alchemy-run/alchemy/commit/c3239516a)
  - **run**:
    - Startup probes, liveness probes and dependsOn on Service containers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2644 [<samp>(3cdc4)</samp>](https://github.com/alchemy-run/alchemy/commit/3cdc47c0c)
    - Container sidecars with bindContainer and bindPort &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2652 [<samp>(ccb13)</samp>](https://github.com/alchemy-run/alchemy/commit/ccb13263f)
    - InvokeService calls RPC methods on private services &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2653 [<samp>(8c1eb)</samp>](https://github.com/alchemy-run/alchemy/commit/8c1eb6c05)
    - Typed Effect RPC and HttpApi clients for sidecars and services &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2654 [<samp>(96b0c)</samp>](https://github.com/alchemy-run/alchemy/commit/96b0ca5c2)
    - List a Container in a Service's template &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2657 [<samp>(31841)</samp>](https://github.com/alchemy-run/alchemy/commit/31841418e)
- **github**:
  - Runtime bindings for issues and pull requests &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2529 [<samp>(6c36e)</samp>](https://github.com/alchemy-run/alchemy/commit/6c36e67fd)
  - Add mergeQueue rule to GitHub.Ruleset &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2577 [<samp>(d1e46)</samp>](https://github.com/alchemy-run/alchemy/commit/d1e460740)
  - Replace Octokit with the distilled GitHub SDK &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2530 [<samp>(e0682)</samp>](https://github.com/alchemy-run/alchemy/commit/e0682c051)
- **sql**:
  - Shared connection and import helpers &nbsp;-&nbsp; by **Sam Goodwin** and **Claude** in https://github.com/alchemy-run/alchemy/issues/2662 [<samp>(4cddc)</samp>](https://github.com/alchemy-run/alchemy/commit/4cddc0b4c)
- **stack**:
  - Typed Stack stages &nbsp;-&nbsp; by **Patt O'Brien** in https://github.com/alchemy-run/alchemy/issues/2131 [<samp>(00a4f)</samp>](https://github.com/alchemy-run/alchemy/commit/00a4f3e73)
- **test**:
  - Publish alchemy-test as @alchemy.run/test &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2452 [<samp>(ac1ae)</samp>](https://github.com/alchemy-run/alchemy/commit/ac1ae2b45)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Support effect 4.1 &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2754 [<samp>(9d070)</samp>](https://github.com/alchemy-run/alchemy/commit/9d0709d22)
- Upgrade foldkit to 0.170 for effect 4.1 &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2790 [<samp>(68e87)</samp>](https://github.com/alchemy-run/alchemy/commit/68e87588f)
- Remove child process logs annotation on every line &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2832 [<samp>(c78e1)</samp>](https://github.com/alchemy-run/alchemy/commit/c78e1c9e0)
- Release hardening (2026-10-31) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2866 [<samp>(13e6a)</samp>](https://github.com/alchemy-run/alchemy/commit/13e6afb46)
- **auth**:
  - Resolve deferred credentials with the build-time ConfigProvider &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2490 [<samp>(d341e)</samp>](https://github.com/alchemy-run/alchemy/commit/d341e85c9)
  - Consistent missing-credential errors across providers &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2610 [<samp>(a3fa7)</samp>](https://github.com/alchemy-run/alchemy/commit/a3fa7ec4e)
  - Resolve credentials with the caller's config instead of the last deploy's &nbsp;-&nbsp; by **mattespapier** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2139 [<samp>(1b121)</samp>](https://github.com/alchemy-run/alchemy/commit/1b121790b)
  - Every OAuth refresh re-reads stored config under the credentials lock &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1923 [<samp>(29537)</samp>](https://github.com/alchemy-run/alchemy/commit/29537a8f4)
- **aws**:
  - Let ECR images hash only what .dockerignore keeps &nbsp;-&nbsp; by **Dan Myles** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2351 [<samp>(1d27e)</samp>](https://github.com/alchemy-run/alchemy/commit/1d27e8134)
  - Stop reporting untouched resources as drifted &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2496 [<samp>(ac234)</samp>](https://github.com/alchemy-run/alchemy/commit/ac2343160)
  - Detect out-of-band config drift on Lambda, DynamoDB and S3 &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2661 [<samp>(00695)</samp>](https://github.com/alchemy-run/alchemy/commit/006959383)
  - Observe managed configuration so drift detects out-of-band changes &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2705 [<samp>(4f4c1)</samp>](https://github.com/alchemy-run/alchemy/commit/4f4c133cd)
  - **cloudfront**:
    - KvEntries delete removes only its own keys &nbsp;-&nbsp; by **Dan Myles** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1910 [<samp>(e91a0)</samp>](https://github.com/alchemy-run/alchemy/commit/e91a0f29a)
  - **ec2**:
    - Idempotent Instance and Volume creates &nbsp;-&nbsp; by **Ahmed Hesham Abdelkader** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2598 [<samp>(e0642)</samp>](https://github.com/alchemy-run/alchemy/commit/e0642654e)
  - **ecs**:
    - Attach cluster capacity providers before the ECS service-linked role propagates &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2487 [<samp>(7609c)</samp>](https://github.com/alchemy-run/alchemy/commit/7609cc881)
    - Skip the dev Service watcher's reconcile when the image content is unchanged &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2097 [<samp>(801dc)</samp>](https://github.com/alchemy-run/alchemy/commit/801dc3238)
  - **eks**:
    - Keep unchanged AccessEntry policies on reconcile &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2489 [<samp>(b8636)</samp>](https://github.com/alchemy-run/alchemy/commit/b863623e5)
    - Skip no-op AccessEntry group and username updates &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2506 [<samp>(d993e)</samp>](https://github.com/alchemy-run/alchemy/commit/d993e265f)
  - **elbv2**:
    - Detect and repair load balancer, target group and listener attribute drift &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2488 [<samp>(ba642)</samp>](https://github.com/alchemy-run/alchemy/commit/ba642ddca)
  - **lambda**:
    - Replace an EventSourceMapping when its event source is replaced &nbsp;-&nbsp; by **Jason Hassold** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2535 [<samp>(9e94a)</samp>](https://github.com/alchemy-run/alchemy/commit/9e94a90bf)
  - **rds**:
    - Resend DBInstance modifies that reach a busy instance &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2493 [<samp>(6ec10)</samp>](https://github.com/alchemy-run/alchemy/commit/6ec106c90)
    - RDS.Connect supports DBInstance and managed master secrets &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2756 [<samp>(238b2)</samp>](https://github.com/alchemy-run/alchemy/commit/238b2f58b)
  - **route53**:
    - Keep records another resource took over when names swap &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2486 [<samp>(bd4be)</samp>](https://github.com/alchemy-run/alchemy/commit/bd4be49e6)
- **axiom**:
  - Accept the already-redacted token distilled now returns &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2858 [<samp>(0d8a1)</samp>](https://github.com/alchemy-run/alchemy/commit/0d8a17c18)
  - Keep the API token redacted once &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2859 [<samp>(76cef)</samp>](https://github.com/alchemy-run/alchemy/commit/76cef5315)
- **bundle**:
  - Smaller, cheaper runtime bundles &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2492 [<samp>(5d9fe)</samp>](https://github.com/alchemy-run/alchemy/commit/5d9fe4e83)
- **cli**:
  - Destroy plans from state without evaluating the stack program &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2491 [<samp>(3380b)</samp>](https://github.com/alchemy-run/alchemy/commit/3380bff09)
- **cloudflare**:
  - Use correct loader for ViteChild under bun &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2525 [<samp>(a6831)</samp>](https://github.com/alchemy-run/alchemy/commit/a68310036)
  - Unbind a secret removed from a Worker's env &nbsp;-&nbsp; by **DivMode** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2327 [<samp>(6cbce)</samp>](https://github.com/alchemy-run/alchemy/commit/6cbce4981)
  - Declare Container's network shape, and correct the documented example &nbsp;-&nbsp; by **Cyberistic** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1763 [<samp>(917b3)</samp>](https://github.com/alchemy-run/alchemy/commit/917b39067)
  - Set error span status on failed Effect spans in the native tracer &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2687 [<samp>(5e084)</samp>](https://github.com/alchemy-run/alchemy/commit/5e0844039)
  - Async Workers can bind each other without recursing to OOM &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2681 [<samp>(517e5)</samp>](https://github.com/alchemy-run/alchemy/commit/517e57472)
  - Worker and D1 read keep the persisted shape so drift ignores unchanged resources &nbsp;-&nbsp; by **DivMode** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2169 [<samp>(1e23f)</samp>](https://github.com/alchemy-run/alchemy/commit/1e23ff748)
  - Bundled Workers can import files via `rules` &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2792 [<samp>(9900c)</samp>](https://github.com/alchemy-run/alchemy/commit/9900c929e)
  - Stop Vite dev containers when the Worker is deleted &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2827 [<samp>(5c04a)</samp>](https://github.com/alchemy-run/alchemy/commit/5c04abd50)
  - List every account in the login picker &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2902 [<samp>(7cadc)</samp>](https://github.com/alchemy-run/alchemy/commit/7cadcb7f6)
  - Wake-ups from alarm callbacks run on time &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2916 [<samp>(d08dc)</samp>](https://github.com/alchemy-run/alchemy/commit/d08dc6056)
  - Use a local-only Container image when it can't be pulled &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2922 [<samp>(90d41)</samp>](https://github.com/alchemy-run/alchemy/commit/90d416ddf)
  - **container**:
    - Link bundle copies and retry stalled image builds &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2733 [<samp>(6f5e5)</samp>](https://github.com/alchemy-run/alchemy/commit/6f5e5534c)
  - **containers**:
    - Keep transport error cause on registry digest lookup &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2576 [<samp>(443b4)</samp>](https://github.com/alchemy-run/alchemy/commit/443b4100a)
    - Create a new class's container application in the same deploy &nbsp;-&nbsp; by **Drew Powers** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2342 [<samp>(6448b)</samp>](https://github.com/alchemy-run/alchemy/commit/6448b26f0)
    - Save the rolled-out application so drift matches read &nbsp;-&nbsp; by **Gjermund Garaba** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2647 [<samp>(413c1)</samp>](https://github.com/alchemy-run/alchemy/commit/413c18a52)
  - **d1**:
    - Accept cached uploads and completed ingestion in D1 import &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2509 [<samp>(03cbc)</samp>](https://github.com/alchemy-run/alchemy/commit/03cbcd9be)
  - **hyperdrive**:
    - Skip updateConfig when the live config already matches &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2503 [<samp>(cc1aa)</samp>](https://github.com/alchemy-run/alchemy/commit/cc1aa41a8)
  - **queues**:
    - Accept a Queue as deadLetterQueue and document consuming it &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2510 [<samp>(2b39d)</samp>](https://github.com/alchemy-run/alchemy/commit/2b39dd54f)
  - **r2**:
    - ForceDestroy aborts incomplete multipart uploads with the API token &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2537 [<samp>(c1271)</samp>](https://github.com/alchemy-run/alchemy/commit/c1271bc06)
  - **secretsstore**:
    - Find a Secret by name with the store's search filter &nbsp;-&nbsp; by **Andoni Enriquez** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2443 [<samp>(7d495)</samp>](https://github.com/alchemy-run/alchemy/commit/7d4950eb0)
  - **state**:
    - Ship typed StateStoreFailure to deployed stores and route long FQNs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2512 [<samp>(a333b)</samp>](https://github.com/alchemy-run/alchemy/commit/a333bb491)
  - **statestore**:
    - Fail instead of bootstrapping when the store's existence is unknown &nbsp;-&nbsp; by **apostoli** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2605 [<samp>(59fd1)</samp>](https://github.com/alchemy-run/alchemy/commit/59fd1170e)
  - **website**:
    - Support Astro route caching with cacheCloudflare() &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2539 [<samp>(ab920)</samp>](https://github.com/alchemy-run/alchemy/commit/ab920e35f)
  - **workers**:
    - WorkerExecutionContext in HttpApi handlers built at init &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2461 [<samp>(6f739)</samp>](https://github.com/alchemy-run/alchemy/commit/6f7395579)
    - Never delete an account Worker from an unscoped precreate stub &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2534 [<samp>(bd58d)</samp>](https://github.com/alchemy-run/alchemy/commit/bd58d1a93)
    - Typed Worker.ref from a declaration &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2609 [<samp>(224f1)</samp>](https://github.com/alchemy-run/alchemy/commit/224f1436f)
    - Pass json binding payloads through verbatim in Preview deploys &nbsp;-&nbsp; by **Patt O'Brien** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2127 [<samp>(70f6a)</samp>](https://github.com/alchemy-run/alchemy/commit/70f6ab8a6)
    - Provide workerd-safe runtime services &nbsp;-&nbsp; by **Harry Solovay** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1403 [<samp>(7e7dd)</samp>](https://github.com/alchemy-run/alchemy/commit/7e7dd3428)
    - Carry trace context through Durable Object RPC &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2783 [<samp>(cc9da)</samp>](https://github.com/alchemy-run/alchemy/commit/cc9da9b9e)
    - Update redirect rules when the canonical name changes &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2761 [<samp>(842b5)</samp>](https://github.com/alchemy-run/alchemy/commit/842b53edc)
- **cloudflare-runtime**:
  - Never resolve Vite dev ASSETS against a disabled publicDir &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2615 [<samp>(50c12)</samp>](https://github.com/alchemy-run/alchemy/commit/50c122c3e)
  - Keep the response tail when the upstream closes cleanly &nbsp;-&nbsp; by **Yanqi Zong** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2841 [<samp>(b3aba)</samp>](https://github.com/alchemy-run/alchemy/commit/b3aba191c)
  - Only contact Docker when a Worker has containers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2784 [<samp>(49a66)</samp>](https://github.com/alchemy-run/alchemy/commit/49a66949b)
  - **vite**: Leave WebSocket upgrades other plugins accept to them &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2516 [<samp>(81ffa)</samp>](https://github.com/alchemy-run/alchemy/commit/81ffa4b72)
- **dns**:
  - Preserve deferred zone inputs &nbsp;-&nbsp; by **bjorntechTobbe** in https://github.com/alchemy-run/alchemy/issues/2861 [<samp>(bc58c)</samp>](https://github.com/alchemy-run/alchemy/commit/bc58cabcc)
- **docker**:
  - Update Docker.Service in place so rolling updates and rollbacks apply &nbsp;-&nbsp; by **Mycael Dias** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2536 [<samp>(6f7e5)</samp>](https://github.com/alchemy-run/alchemy/commit/6f7e5c334)
- **domain**:
  - Evolve never throws; definition problems fail the Layer with a tagged error &nbsp;-&nbsp; by **Sam Goodwin** and **Taras Kornichuk** in https://github.com/alchemy-run/alchemy/issues/2612 [<samp>(1ac27)</samp>](https://github.com/alchemy-run/alchemy/commit/1ac2761e3)
  - Keep an envelope's correlationId on the wire &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2565 [<samp>(74886)</samp>](https://github.com/alchemy-run/alchemy/commit/74886e87a)
  - Decode filters and live reads with schemas &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2639 [<samp>(57798)</samp>](https://github.com/alchemy-run/alchemy/commit/57798414a)
  - Read middleware errors from the middleware's Identifier &nbsp;-&nbsp; by **Taras Kornichuk** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2591 [<samp>(e000f)</samp>](https://github.com/alchemy-run/alchemy/commit/e000fc800)
  - Export captureContext from Platform so the Cloudflare host loads &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2721 [<samp>(a8081)</samp>](https://github.com/alchemy-run/alchemy/commit/a80811f28)
  - DefinitionError reasons instead of thrown messages &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2818 [<samp>(14eae)</samp>](https://github.com/alchemy-run/alchemy/commit/14eaeb1fe)
  - **cli**: --json takes a command's wire payload with its nested input &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2857 [<samp>(fa757)</samp>](https://github.com/alchemy-run/alchemy/commit/fa75750b9)
- **drift**:
  - Recreate deleted resources in dependency order &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2495 [<samp>(c7f65)</samp>](https://github.com/alchemy-run/alchemy/commit/c7f65c768)
- **engine**:
  - Admit Worker replacements before mutation &nbsp;-&nbsp; by **Nacho Vazquez** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2200 [<samp>(44e9e)</samp>](https://github.com/alchemy-run/alchemy/commit/44e9e1e92)
  - Never recover an interrupted create from stripped props &nbsp;-&nbsp; by **Nacho Vazquez** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2199 [<samp>(be81d)</samp>](https://github.com/alchemy-run/alchemy/commit/be81df3fd)
  - Check ownership of identities that resolve during apply &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2620 [<samp>(67975)</samp>](https://github.com/alchemy-run/alchemy/commit/6797535cb)
  - Recover interrupted creates whose props hold Effect values &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2686 [<samp>(7abde)</samp>](https://github.com/alchemy-run/alchemy/commit/7abdef938)
  - Resolve a cycle's props from outside it before precreate &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2643 [<samp>(52419)</samp>](https://github.com/alchemy-run/alchemy/commit/52419745b)
  - A ref to a resource in the same stack is a dependency &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2913 [<samp>(45070)</samp>](https://github.com/alchemy-run/alchemy/commit/450702936)
- **gcp**:
  - Set the node service account on Autopilot Container clusters &nbsp;-&nbsp; by **Stefan W** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2597 [<samp>(c65ab)</samp>](https://github.com/alchemy-run/alchemy/commit/c65ab7ce0)
  - Support standalone projects without hierarchy parents &nbsp;-&nbsp; by **Sam Goodwin** and **Johannes Schickling** in https://github.com/alchemy-run/alchemy/issues/2616 [<samp>(4f91e)</samp>](https://github.com/alchemy-run/alchemy/commit/4f91e639b)
  - Move AIPlatform Agent to aiplatform v1beta1 in the global location &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/2808 [<samp>(71830)</samp>](https://github.com/alchemy-run/alchemy/commit/718305674)
  - **iam**: Workload identity pool name carries the project number &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2641 [<samp>(9f185)</samp>](https://github.com/alchemy-run/alchemy/commit/9f185a395)
  - **resourcemanager**: Project removes labels dropped from props &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2636 [<samp>(b1daa)</samp>](https://github.com/alchemy-run/alchemy/commit/b1daa79ca)
- **local**:
  - Bind the Bun RPC sidecar to loopback &nbsp;-&nbsp; by **Yanqi Zong** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/2845 [<samp>(cc32f)</samp>](https://github.com/alchemy-run/alchemy/commit/cc32f105a)
- **pkg**:
  - Wait for GitHub to report the publishing run as in progress &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2824 [<samp>(97505)</samp>](https://github.com/alchemy-run/alchemy/commit/975053134)
- **platform**:
  - Runtime Config decodes JSON-looking env strings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2619 [<samp>(85476)</samp>](https://github.com/alchemy-run/alchemy/commit/854769db6)
- **prisma**:
  - Custom domains attach to apps on any branch &nbsp;-&nbsp; by **Will Madden** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2696 [<samp>(2ab65)</samp>](https://github.com/alchemy-run/alchemy/commit/2ab65fd5f)
  - Update @prisma/dev to ^0.25.2 &nbsp;-&nbsp; by **Aman Varshney** in https://github.com/alchemy-run/alchemy/issues/2730 [<samp>(04a6f)</samp>](https://github.com/alchemy-run/alchemy/commit/04a6fed5b)
- **skills**:
  - Link alchemy-domain into .agents/skills so `npx skills add` finds it &nbsp;-&nbsp; by **Artisann** in https://github.com/alchemy-run/alchemy/issues/2595 [<samp>(25abd)</samp>](https://github.com/alchemy-run/alchemy/commit/25abd26cd)
- **sql**:
  - Migrate docs, examples, and tests to effect-native SQL drivers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2439 [<samp>(5f21a)</samp>](https://github.com/alchemy-run/alchemy/commit/5f21ac58a)
  - **migrations**: Check the ledger before resending a failed migration batch &nbsp;-&nbsp; by **Ahmed Hesham Abdelkader** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2720 [<samp>(e292b)</samp>](https://github.com/alchemy-run/alchemy/commit/e292b1a5e)
- **state**:
  - Take back a bucket-store lease that lapsed while still held &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2693 [<samp>(46458)</samp>](https://github.com/alchemy-run/alchemy/commit/464585c32)
- **test**:
  - Release a stack's state lease after each harness deploy/destroy &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2494 [<samp>(a2fff)</samp>](https://github.com/alchemy-run/alchemy/commit/a2fff1c5d)
  - Read dev Worker output through Test.resourceLog &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2821 [<samp>(d8248)</samp>](https://github.com/alchemy-run/alchemy/commit/d82487415)
- **website**:
  - Honor a config-file Astro output in Website.Astro &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2505 [<samp>(e2cef)</samp>](https://github.com/alchemy-run/alchemy/commit/e2cefc4bb)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.84...HEAD)

---

## v2.0.0-beta.84

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- Enforce package boundaries ahead of the provider split &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2244 [<samp>(97073)</samp>](https://github.com/alchemy-run/alchemy/commit/970737e9a)
- Providers contribute auth, state stores and CLI through Contributions &nbsp;-&nbsp; by **Rahul Mishra** and **Claude Opus 5.5** in https://github.com/alchemy-run/alchemy/issues/2288 [<samp>(cef7f)</samp>](https://github.com/alchemy-run/alchemy/commit/cef7fe62d)
- Move Git, ACME, Drizzle and SQLite into their own packages &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2309 [<samp>(6f330)</samp>](https://github.com/alchemy-run/alchemy/commit/6f3302c3d)
- Move Axiom, Doppler and Infisical into their own packages &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2311 [<samp>(da104)</samp>](https://github.com/alchemy-run/alchemy/commit/da10408b5)
- Move runtime bootstraps and integrations into their providers &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2312 [<samp>(24081)</samp>](https://github.com/alchemy-run/alchemy/commit/24081c359)
- Move drizzle, fly, github, hetzner, neon, planbetscale, prisma, railway, stripe & turso into their own packages &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2313 [<samp>(49e22)</samp>](https://github.com/alchemy-run/alchemy/commit/49e2244e1)
- Stripe, GitHub and Domain stop importing Cloudflare &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2315 [<samp>(c1a79)</samp>](https://github.com/alchemy-run/alchemy/commit/c1a79c8f9)
- Move Cloudflare into its own package &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2316 [<samp>(10849)</samp>](https://github.com/alchemy-run/alchemy/commit/10849d066)
- Move AWS, GCP, SQL, Docker, Kubernetes, Domain and Redis into their own packages &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Opus 5.5** in https://github.com/alchemy-run/alchemy/issues/2348 [<samp>(2f226)</samp>](https://github.com/alchemy-run/alchemy/commit/2f226d998)
- **aws**: AWS bindings reach native and external hosts through AWSBindings &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2260 [<samp>(032af)</samp>](https://github.com/alchemy-run/alchemy/commit/032afc22a)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **alchemy-test**:
  - Exclusive labels and writer-preferring exclusive lock &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2467 [<samp>(ccead)</samp>](https://github.com/alchemy-run/alchemy/commit/ccead75fd)
- **aws**:
  - Register Floci-supported resources and green test:aws:floci &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1803 [<samp>(4f658)</samp>](https://github.com/alchemy-run/alchemy/commit/4f6586453)
  - **bedrockagentcore**:
    - Runtime platformVersion for AgentCore V2 &nbsp;-&nbsp; by **Henry Marks** in https://github.com/alchemy-run/alchemy/issues/2301 [<samp>(0554a)</samp>](https://github.com/alchemy-run/alchemy/commit/0554adb48)
  - **ec2**:
    - Expose instance metadata options &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2426 [<samp>(0f112)</samp>](https://github.com/alchemy-run/alchemy/commit/0f1124958)
  - **lambda**:
    - Lambda Web Functions &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2243 [<samp>(54537)</samp>](https://github.com/alchemy-run/alchemy/commit/545373830)
    - Canary deploys for Web Functions &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2280 [<samp>(59cc2)</samp>](https://github.com/alchemy-run/alchemy/commit/59cc24d72)
  - **rds**:
    - Apply SQL migrations on Aurora over the Data API &nbsp;-&nbsp; by **gegi ⏾** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2125 [<samp>(66554)</samp>](https://github.com/alchemy-run/alchemy/commit/6655489c8)
    - Direct and in-VPC Lambda transports for RDS migrations &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2289 [<samp>(e89ca)</samp>](https://github.com/alchemy-run/alchemy/commit/e89caa8e7)
  - **website**:
    - Serve framework sites from Lambda Web Functions &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2282 [<samp>(66c28)</samp>](https://github.com/alchemy-run/alchemy/commit/66c287228)
    - Next.js on Web Functions as its standalone server, without OpenNext &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2300 [<samp>(f7d49)</samp>](https://github.com/alchemy-run/alchemy/commit/f7d4934de)
- **aws,gcp**:
  - Bindings reach any host through effectful Bind constructors &nbsp;-&nbsp; by **Sam Goodwin** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/2347 [<samp>(aaa27)</samp>](https://github.com/alchemy-run/alchemy/commit/aaa27a0ea)
- **cli**:
  - Opt in to distilled's lazy service stubs under Node &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/2440 [<samp>(7391c)</samp>](https://github.com/alchemy-run/alchemy/commit/7391cdf38)
- **cloudflare**:
  - Alerting.CustomAlert and Workers.IssueAutomation &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2453 [<samp>(443cf)</samp>](https://github.com/alchemy-run/alchemy/commit/443cf2b69)
  - **apitoken**:
    - Granular Worker role permission groups &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2458 [<samp>(26240)</samp>](https://github.com/alchemy-run/alchemy/commit/262407bd3)
  - **auth**:
    - Log in via device auth &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2444 [<samp>(76394)</samp>](https://github.com/alchemy-run/alchemy/commit/763948a2c)
  - **containers**:
    - Type jurisdiction and regions placement constraints &nbsp;-&nbsp; by **Jakub Sieczczyński** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2253 [<samp>(bf0ce)</samp>](https://github.com/alchemy-run/alchemy/commit/bf0cedc85)
  - **email**:
    - Add DmarcReports resource &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2455 [<samp>(e6389)</samp>](https://github.com/alchemy-run/alchemy/commit/e6389dea3)
  - **hyperdrive**:
    - Look up existing configurations with Hyperdrive.lookup &nbsp;-&nbsp; by **Franz Rebaza** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1345 [<samp>(891d5)</samp>](https://github.com/alchemy-run/alchemy/commit/891d58726)
  - **r2**:
    - Add localUploads to Bucket &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2424 [<samp>(94b5b)</samp>](https://github.com/alchemy-run/alchemy/commit/94b5b0ead)
  - **workers**:
    - Ctx.props and self entrypoint stubs in the Effect DX &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2251 [<samp>(1c146)</samp>](https://github.com/alchemy-run/alchemy/commit/1c1461cb8)
    - Pass hibernation tags through upgrade() &nbsp;-&nbsp; by **gegi ⏾** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2265 [<samp>(52bdd)</samp>](https://github.com/alchemy-run/alchemy/commit/52bdd33fe)
- **cloudflare-runtime**:
  - Grant local containers FUSE privileges &nbsp;-&nbsp; by **Jonathan Beckman** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2362 [<samp>(853a3)</samp>](https://github.com/alchemy-run/alchemy/commit/853a364a6)
- **domain**:
  - Domain modelling with aggregates, views, policies and stories &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2176 [<samp>(8d4f4)</samp>](https://github.com/alchemy-run/alchemy/commit/8d4f437b0)
- **fly**:
  - Build Service images on Fly's remote builders &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2472 [<samp>(bb18a)</samp>](https://github.com/alchemy-run/alchemy/commit/bb18acb76)
- **foldkit**:
  - Support SSR and prerendering across website providers &nbsp;-&nbsp; by **Filip Falcon** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1313 [<samp>(da563)</samp>](https://github.com/alchemy-run/alchemy/commit/da5634c78)
- **gcp**:
  - Cloud Storage state store (GCP.state()) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2379 [<samp>(f1c15)</samp>](https://github.com/alchemy-run/alchemy/commit/f1c157ac9)
- **github**:
  - Ruleset pullRequest allowedMergeMethods and requireExtraApprovalForUnattributedChanges &nbsp;-&nbsp; by **Jason Kuhrt** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2397 [<samp>(ab712)</samp>](https://github.com/alchemy-run/alchemy/commit/ab7120b20)
  - Generate a webhook secret when consumeRepositoryEvents omits one &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1932 [<samp>(6b8a3)</samp>](https://github.com/alchemy-run/alchemy/commit/6b8a341f8)
- **railway**:
  - Support ephemeral project environments &nbsp;-&nbsp; by **Mikkel** in https://github.com/alchemy-run/alchemy/issues/2117 [<samp>(b6d86)</samp>](https://github.com/alchemy-run/alchemy/commit/b6d86c752)
- **workflow**:
  - Effect workflow engines for Durable Objects, Cloudflare Workflows and Lambda durable functions &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2252 [<samp>(36699)</samp>](https://github.com/alchemy-run/alchemy/commit/36699686d)
- **workflows**:
  - Alchemy/Workflows with run handles, plain-Layer engines and AWS.Lambda.WorkflowFunction &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2268 [<samp>(85d4a)</samp>](https://github.com/alchemy-run/alchemy/commit/85d4a460e)
  - Workflows.layer accepts an Effect that builds the handler &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2390 [<samp>(40e99)</samp>](https://github.com/alchemy-run/alchemy/commit/40e9903ca)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **aws**:
  - Lease the S3 state store per stack and stage &nbsp;-&nbsp; by **Arman Charan** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2145 [<samp>(79d47)</samp>](https://github.com/alchemy-run/alchemy/commit/79d47d0c3)
  - Don't replace Root/Instance when a lookup id matches the adopted object &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2454 [<samp>(e9c91)</samp>](https://github.com/alchemy-run/alchemy/commit/e9c910e0a)
  - Delete DataZone-retained Glue databases &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2470 [<samp>(5da7d)</samp>](https://github.com/alchemy-run/alchemy/commit/5da7d13b2)
  - **cloudfront**:
    - Drop rollout status from Function attributes &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2462 [<samp>(c9164)</samp>](https://github.com/alchemy-run/alchemy/commit/c91643dec)
  - **datazone**:
    - Blueprint configuration removes the Lake Formation admins DataZone added &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2411 [<samp>(9fe51)</samp>](https://github.com/alchemy-run/alchemy/commit/9fe51a1f8)
  - **ec2**:
    - Recover a VPC created before its state was persisted &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2416 [<samp>(a7c13)</samp>](https://github.com/alchemy-run/alchemy/commit/a7c1309cf)
    - Accept Redacted userData on Instance &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2421 [<samp>(a4bf0)</samp>](https://github.com/alchemy-run/alchemy/commit/a4bf0ff04)
  - **ecs**:
    - Re-check the dev watcher's image staleness under the per-id lock &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2091 [<samp>(9e3c0)</samp>](https://github.com/alchemy-run/alchemy/commit/9e3c05843)
  - **emr-containers**:
    - Retry VirtualCluster create while the EKS connection is updating &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2412 [<samp>(e7a53)</samp>](https://github.com/alchemy-run/alchemy/commit/e7a536a65)
  - **iam**:
    - Don't rewrite equivalent Role trust and inline policies &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2451 [<samp>(fd770)</samp>](https://github.com/alchemy-run/alchemy/commit/fd770300e)
  - **lambda**:
    - KafkaEventSource grants the EC2 VPC permissions MSK mappings require &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2401 [<samp>(2668d)</samp>](https://github.com/alchemy-run/alchemy/commit/2668d4c9a)
    - Detect out-of-band memorySize and timeout drift &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2446 [<samp>(cdff7)</samp>](https://github.com/alchemy-run/alchemy/commit/cdff7b2e4)
  - **rds**:
    - Accept Input for Aurora kmsKeyId and migrations &nbsp;-&nbsp; by **gegi ⏾** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2364 [<samp>(bff5d)</samp>](https://github.com/alchemy-run/alchemy/commit/bff5de874)
- **cli**:
  - Put ProfileDashboard's JSX pragmas back in its leading comments &nbsp;-&nbsp; by **0xMilkEnjoyer** in https://github.com/alchemy-run/alchemy/issues/2295 [<samp>(c078a)</samp>](https://github.com/alchemy-run/alchemy/commit/c078a134e)
  - Accept node 22.22.3+ &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2403 [<samp>(885f8)</samp>](https://github.com/alchemy-run/alchemy/commit/885f819e9)
  - Match profile refresh --provider case-insensitively &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2410 [<samp>(3dc1e)</samp>](https://github.com/alchemy-run/alchemy/commit/3dc1e79cc)
- **cloudflare**:
  - Force HTTP/1.1 for API calls on Node 26 (undici 8) &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2155 [<samp>(851fb)</samp>](https://github.com/alchemy-run/alchemy/commit/851fb5758)
  - *Http bindings on hosts outside Cloudflare, explicit error in dev &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2267 [<samp>(5c99e)</samp>](https://github.com/alchemy-run/alchemy/commit/5c99e3b87)
  - Return full deployment identities &nbsp;-&nbsp; by **Kevin** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2241 [<samp>(68a04)</samp>](https://github.com/alchemy-run/alchemy/commit/68a04c07f)
  - Match @cloudflare/vite-plugin's asset handling in deploy and dev &nbsp;-&nbsp; by **Arman Charan** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2144 [<samp>(bbfa3)</samp>](https://github.com/alchemy-run/alchemy/commit/bbfa3a859)
  - Batch statements for local D1 importFiles &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2258 [<samp>(f191c)</samp>](https://github.com/alchemy-run/alchemy/commit/f191c8cfa)
  - Run Worker runtime features in Vite dev like @cloudflare/vite-plugin &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2367 [<samp>(10585)</samp>](https://github.com/alchemy-run/alchemy/commit/10585fa1e)
  - Bound durable callback retries and self-rearms &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/1908 [<samp>(3a540)</samp>](https://github.com/alchemy-run/alchemy/commit/3a540449a)
  - Vinext custom main, dev tail consumers, per-Worker Cache store &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2383 [<samp>(0d24f)</samp>](https://github.com/alchemy-run/alchemy/commit/0d24ff903)
  - Expose Docker from Cloudflare.providers() &nbsp;-&nbsp; by **Drew Powers** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2341 [<samp>(ff58d)</samp>](https://github.com/alchemy-run/alchemy/commit/ff58d05d6)
  - **containers**:
    - Don't replace an adopted application whose first reconcile failed &nbsp;-&nbsp; by **Yannic Charlon** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2283 [<samp>(94599)</samp>](https://github.com/alchemy-run/alchemy/commit/945992f10)
    - Re-attach a detached container application &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2378 [<samp>(a0930)</samp>](https://github.com/alchemy-run/alchemy/commit/a0930824d)
    - Classify start failures reported by monitor() &nbsp;-&nbsp; by **Drew Powers** in https://github.com/alchemy-run/alchemy/issues/2340 [<samp>(9b985)</samp>](https://github.com/alchemy-run/alchemy/commit/9b985eb06)
    - Narrow per-policy Container application types &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2423 [<samp>(c7ce2)</samp>](https://github.com/alchemy-run/alchemy/commit/c7ce2bbf2)
  - **d1**:
    - Apply large migration files locally &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2380 [<samp>(c6e53)</samp>](https://github.com/alchemy-run/alchemy/commit/c6e5355ec)
  - **hyperdrive**:
    - Replace on rename with unresolved props and on dropped mTLS certs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2429 [<samp>(cc5e9)</samp>](https://github.com/alchemy-run/alchemy/commit/cc5e9b06e)
  - **mtls**:
    - Upload the new PEM when a named certificate is replaced &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2428 [<samp>(68aa3)</samp>](https://github.com/alchemy-run/alchemy/commit/68aa3ccbc)
  - **website**:
    - StaticSite forwards dev.port, strictPort and host to its local Worker &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2331 [<samp>(6135c)</samp>](https://github.com/alchemy-run/alchemy/commit/6135c22d6)
  - **workers**:
    - Ride out deploy propagation in RPC calls and live tests &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2294 [<samp>(f816d)</samp>](https://github.com/alchemy-run/alchemy/commit/f816d96e0)
    - Worker read returns deploymentId so drift detection is accurate &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2387 [<samp>(d4b61)</samp>](https://github.com/alchemy-run/alchemy/commit/d4b61a742)
    - ObservabilityDestination handles masked header values &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2388 [<samp>(2efb7)</samp>](https://github.com/alchemy-run/alchemy/commit/2efb78aa5)
    - Don't read a failed zone ruleset read as empty &nbsp;-&nbsp; by **Drew Powers** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2339 [<samp>(73ccc)</samp>](https://github.com/alchemy-run/alchemy/commit/73cccdd5b)
    - WorkerEntrypoint targets a cross-stack Worker.ref &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2414 [<samp>(1b7f0)</samp>](https://github.com/alchemy-run/alchemy/commit/1b7f0bff0)
- **cloudflare-runtime**:
  - Serve Vite publicDir files through ASSETS in dev &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2290 [<samp>(d8cbd)</samp>](https://github.com/alchemy-run/alchemy/commit/d8cbd92d9)
  - Probe loopback ports only &nbsp;-&nbsp; by **Kevin** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2237 [<samp>(32ad0)</samp>](https://github.com/alchemy-run/alchemy/commit/32ad0df31)
  - Route Vite dev requests like @cloudflare/vite-plugin &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2365 [<samp>(e0e19)</samp>](https://github.com/alchemy-run/alchemy/commit/e0e196831)
  - Never forward dev requests to a host named in the path &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2381 [<samp>(7e7bc)</samp>](https://github.com/alchemy-run/alchemy/commit/7e7bcea83)
  - Serve assets inside dot-directories in local dev &nbsp;-&nbsp; by **Altay** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2212 [<samp>(2a1e7)</samp>](https://github.com/alchemy-run/alchemy/commit/2a1e7b6e0)
  - Reconnect cross-script Durable Objects after a restart &nbsp;-&nbsp; by **Juliaan** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2325 [<samp>(cb3d2)</samp>](https://github.com/alchemy-run/alchemy/commit/cb3d2393b)
  - **vite**: Keep connections usable when the Worker answers before reading the body &nbsp;-&nbsp; by **Matthew Ruiters** in https://github.com/alchemy-run/alchemy/issues/2242 [<samp>(584c5)</samp>](https://github.com/alchemy-run/alchemy/commit/584c56a33)
- **core**:
  - Read Stack from StackContext to slim Worker bundles &nbsp;-&nbsp; by **Juliaan** in https://github.com/alchemy-run/alchemy/issues/2240 [<samp>(f2191)</samp>](https://github.com/alchemy-run/alchemy/commit/f2191825b)
  - Reject a logical id already registered as another type &nbsp;-&nbsp; by **Arman Charan** in https://github.com/alchemy-run/alchemy/issues/2063 [<samp>(c96b2)</samp>](https://github.com/alchemy-run/alchemy/commit/c96b22400)
- **docker**:
  - Re-create a Docker.Context missing from the local engine &nbsp;-&nbsp; by **Patt O'Brien** in https://github.com/alchemy-run/alchemy/issues/2187 [<samp>(8615d)</samp>](https://github.com/alchemy-run/alchemy/commit/8615de775)
  - Reuse local RemoteImage when alwaysPull is false &nbsp;-&nbsp; by **Yannic Charlon** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2323 [<samp>(47d3e)</samp>](https://github.com/alchemy-run/alchemy/commit/47d3e394b)
- **engine**:
  - Make apply and plan linear in resource count &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2419 [<samp>(a9de3)</samp>](https://github.com/alchemy-run/alchemy/commit/a9de3ec22)
- **frontend-frameworks**:
  - Forward the site env into Cloudflare framework builds &nbsp;-&nbsp; by **Kevin** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2238 [<samp>(15cb7)</samp>](https://github.com/alchemy-run/alchemy/commit/15cb7fb54)
  - **vinext**: Pin worker entry and collect post-build server modules &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2373 [<samp>(95f15)</samp>](https://github.com/alchemy-run/alchemy/commit/95f158134)
- **github**:
  - Send branch protection checks without contexts &nbsp;-&nbsp; by **Arman Charan** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2076 [<samp>(d46a7)</samp>](https://github.com/alchemy-run/alchemy/commit/d46a7ea27)
  - Ruleset adopts an existing ruleset by name &nbsp;-&nbsp; by **Patt O'Brien** in https://github.com/alchemy-run/alchemy/issues/2129 [<samp>(e9d2b)</samp>](https://github.com/alchemy-run/alchemy/commit/e9d2b664e)
- **prisma**:
  - Raise compute upload cap to 768 MiB &nbsp;-&nbsp; by **Aman Varshney** in https://github.com/alchemy-run/alchemy/issues/2257 [<samp>(891c4)</samp>](https://github.com/alchemy-run/alchemy/commit/891c46f23)
- **rpc**:
  - Retain source scopes until response streams close &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/2273 [<samp>(00044)</samp>](https://github.com/alchemy-run/alchemy/commit/0004479bb)
- **state**:
  - Allow ResourceState under exactOptionalPropertyTypes &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2413 [<samp>(8d673)</samp>](https://github.com/alchemy-run/alchemy/commit/8d673e9d1)
- **test**:
  - Close the Vitest sidecar after user afterAll hooks &nbsp;-&nbsp; by **Arman Charan** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2142 [<samp>(0469e)</samp>](https://github.com/alchemy-run/alchemy/commit/0469e44aa)
- **util**:
  - Measure tar name fields in UTF-8 bytes &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2420 [<samp>(5654d)</samp>](https://github.com/alchemy-run/alchemy/commit/5654db575)
  - RedactStream leaks a secret's tail when a shorter secret is its prefix &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2418 [<samp>(b9bd7)</samp>](https://github.com/alchemy-run/alchemy/commit/b9bd75dee)
- **website**:
  - Add GCP and ACME tab icons &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2292 [<samp>(dfe11)</samp>](https://github.com/alchemy-run/alchemy/commit/dfe114193)
  - Categorized docs nav dropdowns &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2296 [<samp>(e9841)</samp>](https://github.com/alchemy-run/alchemy/commit/e98418253)
  - Open docs nav dropdowns on hover &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2297 [<samp>(59d4f)</samp>](https://github.com/alchemy-run/alchemy/commit/59d4f7b17)

### &nbsp;&nbsp;&nbsp;🏎 Performance

- **cloudflare**:
  - **ai**:
    - Reuse tool schemas and native image encoding &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/2274 [<samp>(eb503)</samp>](https://github.com/alchemy-run/alchemy/commit/eb5035a95)
  - **queues**:
    - Avoid allocating UTF-8 sizing buffers &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/2275 [<samp>(8f845)</samp>](https://github.com/alchemy-run/alchemy/commit/8f845e47d)
  - **r2**:
    - Forward native object bodies without chunk copies &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/2276 [<samp>(8823a)</samp>](https://github.com/alchemy-run/alchemy/commit/8823a5d6e)
  - **workers**:
    - Defer unused SQL cursor allocations &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/2281 [<samp>(2e2b9)</samp>](https://github.com/alchemy-run/alchemy/commit/2e2b952f3)
    - Batch due scheduled-event mutations &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/2277 [<samp>(e3487)</samp>](https://github.com/alchemy-run/alchemy/commit/e348777e6)
- **rpc**:
  - Use native typed-array base64 codecs &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/2272 [<samp>(59818)</samp>](https://github.com/alchemy-run/alchemy/commit/59818e264)
- **runtime**:
  - Skip JSON parsing for plain env strings &nbsp;-&nbsp; by **Dan van der Merwe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2279 [<samp>(c75e1)</samp>](https://github.com/alchemy-run/alchemy/commit/c75e148ac)
- **workflows**:
  - Cache result codecs by schema identity &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/2271 [<samp>(5a625)</samp>](https://github.com/alchemy-run/alchemy/commit/5a6251b8e)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.83...HEAD)

---

## v2.0.0-beta.83

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **cloudflare**:
  - **containers**: One Durable Object Container is one image; beta.83 release notes &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/2223 [<samp>(e3fd8)</samp>](https://github.com/alchemy-run/alchemy/commit/e3fd86053)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.82...HEAD)

---

## v2.0.0-beta.82

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **cloudflare**:
  - K2 streams and Basin (Pipelines, Catalog, Tables) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2010 [<samp>(992d4)</samp>](https://github.com/alchemy-run/alchemy/commit/992d49d1a)
  - Durable Object-managed containers; start containers explicitly &nbsp;-&nbsp; by **Dan van der Merwe**, **BlankParticle** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1905 [<samp>(62c28)</samp>](https://github.com/alchemy-run/alchemy/commit/62c288659)
- **engine**:
  - Replace the InstanceId service with ResourceContext &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2160 [<samp>(add85)</samp>](https://github.com/alchemy-run/alchemy/commit/add85a984)
- **gcp**:
  - Bump distilled to main and drop the removed Dataplex Data Taxonomy resources &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2024 [<samp>(97c8d)</samp>](https://github.com/alchemy-run/alchemy/commit/97c8da8bd)
  - Bump distilled to main and remove deleted TasksPushNotificationConfig &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2159 [<samp>(f8d7a)</samp>](https://github.com/alchemy-run/alchemy/commit/f8d7a6704)
- **git**:
  - BlobStoreR2 requires ReadWriteBucket instead of providing the binding &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2102 [<samp>(212e7)</samp>](https://github.com/alchemy-run/alchemy/commit/212e7afed)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - Inject the AWS environment into providers() and state() &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1933 [<samp>(e6487)</samp>](https://github.com/alchemy-run/alchemy/commit/e6487ae44)
  - Support console login via aws login &nbsp;-&nbsp; by **Joaquín Pérez** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1759 [<samp>(a82f9)</samp>](https://github.com/alchemy-run/alchemy/commit/a82f986b3)
  - **budgets**: Add costTypes to Budget &nbsp;-&nbsp; by **arth** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2055 [<samp>(7e941)</samp>](https://github.com/alchemy-run/alchemy/commit/7e941809d)
  - **dsql**: Apply SQL migrations during cluster deploy &nbsp;-&nbsp; by **Carl Ulsøe Christensen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1544 [<samp>(a72d1)</samp>](https://github.com/alchemy-run/alchemy/commit/a72d1e3de)
  - **dynamodb**: Support Cloudflare Worker hosts in HTTP bindings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1782 [<samp>(15bc4)</samp>](https://github.com/alchemy-run/alchemy/commit/15bc4bcae)
  - **ecs,lambda**: Add logging.retention to Task and Function &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2042 [<samp>(270fe)</samp>](https://github.com/alchemy-run/alchemy/commit/270fe8160)
  - **secretsmanager**: Opt-in recovery window for Secret deletion &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2053 [<samp>(21436)</samp>](https://github.com/alchemy-run/alchemy/commit/21436fe22)
- **cloudflare**:
  - Support Workers Issues observability &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1992 [<samp>(1431e)</samp>](https://github.com/alchemy-run/alchemy/commit/1431ef2e1)
  - BotManagement manages the AI search, agent and training crawler policies &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1911 [<samp>(d5b6f)</samp>](https://github.com/alchemy-run/alchemy/commit/d5b6ff1a0)
  - R2 bucket lock rules &nbsp;-&nbsp; by **Alessandro Cheli** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1984 [<samp>(5fbb1)</samp>](https://github.com/alchemy-run/alchemy/commit/5fbb1161f)
  - Federated APIs — emulate zone routes in alchemy dev &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2088 [<samp>(fcb93)</samp>](https://github.com/alchemy-run/alchemy/commit/fcb936cdc)
  - SendingSubdomain previewEnabled and email.sending queue subscriptions &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1914 [<samp>(dc461)</samp>](https://github.com/alchemy-run/alchemy/commit/dc4615f3c)
  - Instant KV namespaces &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2027 [<samp>(41a0a)</samp>](https://github.com/alchemy-run/alchemy/commit/41a0a4e74)
  - **access**:
    - Adopt Applications by id, SaaS apps, Policy connectionRules &nbsp;-&nbsp; by **Damjan Znidarsic** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1848 [<samp>(0dcab)</samp>](https://github.com/alchemy-run/alchemy/commit/0dcab7d0d)
  - **ai**:
    - Report Workers AI neurons on finish parts &nbsp;-&nbsp; by **Jordan** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1724 [<samp>(1f76d)</samp>](https://github.com/alchemy-run/alchemy/commit/1f76d326a)
  - **hyperdrive**:
    - Connect to private databases through Workers VPC &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2218 [<samp>(a286a)</samp>](https://github.com/alchemy-run/alchemy/commit/a286a0792)
  - **mtls**:
    - Bind an MtlsCertificate to a Worker (env and Effect Fetch) &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2051 [<samp>(73cf8)</samp>](https://github.com/alchemy-run/alchemy/commit/73cf8993c)
  - **queues**:
    - Add QueueSink &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1781 [<samp>(01618)</samp>](https://github.com/alchemy-run/alchemy/commit/01618ef40)
  - **ssl**:
    - Add Ssl.CertificateTransparencyAlerting &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1913 [<samp>(50a48)</samp>](https://github.com/alchemy-run/alchemy/commit/50a487d15)
  - **workers**:
    - Bind an Effect Worker to itself through ctx.exports &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2161 [<samp>(ee413)</samp>](https://github.com/alchemy-run/alchemy/commit/ee413f965)
    - Deploy Durable Objects with declarative exports &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2135 [<samp>(74beb)</samp>](https://github.com/alchemy-run/alchemy/commit/74beb7f1a)
    - Bind a Worker's own named entrypoint &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2115 [<samp>(0dc42)</samp>](https://github.com/alchemy-run/alchemy/commit/0dc429224)
    - Per-entrypoint Workers Cache &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2216 [<samp>(19748)</samp>](https://github.com/alchemy-run/alchemy/commit/197481686)
- **cloudflare-runtime**:
  - Update workerd and sync upstream SDK &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2028 [<samp>(1a789)</samp>](https://github.com/alchemy-run/alchemy/commit/1a789a3cc)
- **docker**:
  - Add container runtime options &nbsp;-&nbsp; by **bjorntechTobbe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1946 [<samp>(09145)</samp>](https://github.com/alchemy-run/alchemy/commit/0914511d0)
  - Support ordered env files &nbsp;-&nbsp; by **bjorntechTobbe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1947 [<samp>(59c0a)</samp>](https://github.com/alchemy-run/alchemy/commit/59c0a8acf)
- **drizzle**:
  - Pass @effect/sql-pg options through Drizzle.Postgres &nbsp;-&nbsp; by **Julius Marminge**, **Claude Opus 5.5 (1M context)** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1994 [<samp>(2b597)</samp>](https://github.com/alchemy-run/alchemy/commit/2b5971e89)
- **frontend-frameworks**:
  - Support vinext 1.0 &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2025 [<samp>(6dc41)</samp>](https://github.com/alchemy-run/alchemy/commit/6dc416811)
  - Support SvelteKit 3.0 stable &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2060 [<samp>(0a746)</samp>](https://github.com/alchemy-run/alchemy/commit/0a746c7c2)
- **gcp**:
  - Support views and external tables on BigQuery.Table &nbsp;-&nbsp; by **Bartek** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2082 [<samp>(51682)</samp>](https://github.com/alchemy-run/alchemy/commit/516829b06)
  - Add IAM ServiceAccount, ServiceUsage ProjectService, and GKE/Compute/NAT props &nbsp;-&nbsp; by **Connor Hindley** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1995 [<samp>(11d3b)</samp>](https://github.com/alchemy-run/alchemy/commit/11d3b8d05)
- **kubernetes,neon**:
  - Accept resource Effects for Deployment cluster and Function branch/project &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2005 [<samp>(d6eec)</samp>](https://github.com/alchemy-run/alchemy/commit/d6eec8fc7)
- **neon**:
  - Add Neon.Role for Postgres roles on a branch &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2078 [<samp>(1ac62)</samp>](https://github.com/alchemy-run/alchemy/commit/1ac62ec71)
- **pkg**:
  - Auto-discover transitive workspace dependencies &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2108 [<samp>(0dd1b)</samp>](https://github.com/alchemy-run/alchemy/commit/0dd1b37ad)
- **planetscale**:
  - Add deletionProtection to MySQLDatabase and PostgresDatabase &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1861 [<samp>(3c323)</samp>](https://github.com/alchemy-run/alchemy/commit/3c32367c2)
- **prisma**:
  - Identify App, Database, and Bucket by logicalId &nbsp;-&nbsp; by **Kristof Siket** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1849 [<samp>(05b92)</samp>](https://github.com/alchemy-run/alchemy/commit/05b92b518)
- **turso**:
  - Turso provider with libSQL bindings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2138 [<samp>(6af75)</samp>](https://github.com/alchemy-run/alchemy/commit/6af758c17)
- **website**:
  - Geometrically correct Sri Yantra patterns and OG cards &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/2006 [<samp>(2ed8f)</samp>](https://github.com/alchemy-run/alchemy/commit/2ed8fc371)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Faster Oxc loader and a simpler CLI launcher &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2151 [<samp>(cdd6e)</samp>](https://github.com/alchemy-run/alchemy/commit/cdd6e2291)
- Resource leaks, slow deletes and flaky live tests across AWS, Cloudflare and GCP &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2174 [<samp>(31c28)</samp>](https://github.com/alchemy-run/alchemy/commit/31c284685)
- **alchemy-test**:
  - Collect test files without AsyncLocalStorage through import() &nbsp;-&nbsp; by **arth** in https://github.com/alchemy-run/alchemy/issues/2058 [<samp>(95d23)</samp>](https://github.com/alchemy-run/alchemy/commit/95d23e36c)
- **aws**:
  - Detect Effect-native Lambda source changes &nbsp;-&nbsp; by **elijah smith** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1809 [<samp>(edc93)</samp>](https://github.com/alchemy-run/alchemy/commit/edc930403)
  - **acm**:
    - Dedupe dns validation records for a name and its wildcard &nbsp;-&nbsp; by **Alex Godfrey** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1821 [<samp>(d7e01)</samp>](https://github.com/alchemy-run/alchemy/commit/d7e01ae84)
  - **autoscaling**:
    - Converge ASG and capacity provider with ECS managed scaling &nbsp;-&nbsp; by **Makisuo** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2009 [<samp>(2f11a)</samp>](https://github.com/alchemy-run/alchemy/commit/2f11a194e)
  - **chatbot**:
    - Route API calls to a supported region &nbsp;-&nbsp; by **ryo kishida** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2085 [<samp>(cf166)</samp>](https://github.com/alchemy-run/alchemy/commit/cf1665cd3)
  - **cloudcontrol**:
    - Normalize SSM Document desired state before diffing &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1934 [<samp>(02cc0)</samp>](https://github.com/alchemy-run/alchemy/commit/02cc0e911)
  - **cloudfront**:
    - Re-issue Invalidation when its version changes &nbsp;-&nbsp; by **Ethan Shumate** in https://github.com/alchemy-run/alchemy/issues/1854 [<samp>(579e5)</samp>](https://github.com/alchemy-run/alchemy/commit/579e5949d)
  - **ec2**:
    - Retry Client VPN endpoint creates blocked by another create &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2086 [<samp>(47d37)</samp>](https://github.com/alchemy-run/alchemy/commit/47d37cf08)
    - Delete Client VPN endpoints that still have target networks &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2089 [<samp>(6ac7c)</samp>](https://github.com/alchemy-run/alchemy/commit/6ac7c8a95)
    - Replace on unresolved userData and serve a reachable local url &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1471 [<samp>(8dff5)</samp>](https://github.com/alchemy-run/alchemy/commit/8dff59950)
    - Wait up to 5 minutes for a deleted InternetGateway to disappear &nbsp;-&nbsp; by **TBIQ007** in https://github.com/alchemy-run/alchemy/issues/2106 [<samp>(227f0)</samp>](https://github.com/alchemy-run/alchemy/commit/227f0f097)
  - **ecs**:
    - Support host and bridge network modes on Service &nbsp;-&nbsp; by **Makisuo** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2008 [<samp>(0bebe)</samp>](https://github.com/alchemy-run/alchemy/commit/0bebef201)
  - **iam**:
    - Accept string principals in PolicyStatement &nbsp;-&nbsp; by **Ethan Shumate** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1856 [<samp>(831c9)</samp>](https://github.com/alchemy-run/alchemy/commit/831c9d1e5)
  - **lambda**:
    - Inline Lambda.Function implementations may require the Function host (event sources) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1931 [<samp>(519eb)</samp>](https://github.com/alchemy-run/alchemy/commit/519eb5de8)
    - Durable function bodies can call runtime binding clients (provide RuntimeContext per invocation) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1930 [<samp>(54783)</samp>](https://github.com/alchemy-run/alchemy/commit/5478379bc)
    - Return nothing from Version/Alias recovery read when the parent ref was stripped &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2003 [<samp>(d97fe)</samp>](https://github.com/alchemy-run/alchemy/commit/d97fe8a4d)
    - Delete the log group when destroying a local function &nbsp;-&nbsp; by **TBIQ007** in https://github.com/alchemy-run/alchemy/issues/2054 [<samp>(4ea52)</samp>](https://github.com/alchemy-run/alchemy/commit/4ea521db2)
    - Flush telemetry before a Lambda timeout &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1494 [<samp>(a9b56)</samp>](https://github.com/alchemy-run/alchemy/commit/a9b56ecae)
  - **rds**:
    - Validate the master secret policy against the known secret &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1936 [<samp>(78ac3)</samp>](https://github.com/alchemy-run/alchemy/commit/78ac31970)
    - Refresh a DBInstance whose identifier now names another physical instance &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2017 [<samp>(2d753)</samp>](https://github.com/alchemy-run/alchemy/commit/2d75359c7)
  - **route53**:
    - Match wildcard record names returned as \052 &nbsp;-&nbsp; by **Alex Godfrey** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1822 [<samp>(b28a4)</samp>](https://github.com/alchemy-run/alchemy/commit/b28a4fd86)
  - **ses**:
    - Retry receipt rule IAM role propagation &nbsp;-&nbsp; by **elijah smith** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1896 [<samp>(90f31)</samp>](https://github.com/alchemy-run/alchemy/commit/90f319dfe)
  - **state**:
    - Keep state contents out of Debug logs &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2074 [<samp>(fbbfb)</samp>](https://github.com/alchemy-run/alchemy/commit/fbbfbf644)
  - **website**:
    - Resolve inline Router route metadata &nbsp;-&nbsp; by **William Blazer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1819 [<samp>(8248b)</samp>](https://github.com/alchemy-run/alchemy/commit/8248bcc46)
- **axiom**:
  - Deliver OTLP metrics as protobuf with X-Axiom-Metrics-Dataset &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2043 [<samp>(507c6)</samp>](https://github.com/alchemy-run/alchemy/commit/507c6d53b)
- **bundle**:
  - Read pnpm 12 multi-document lockfiles &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2020 [<samp>(aadaf)</samp>](https://github.com/alchemy-run/alchemy/commit/aadaf903d)
  - Write each resource's bundle to .alchemy/bundles instead of dist/ &nbsp;-&nbsp; by **Juliaan** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2133 [<samp>(47c08)</samp>](https://github.com/alchemy-run/alchemy/commit/47c08f963)
- **cli**:
  - Detect bun launches from npm_execpath only &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2031 [<samp>(bdf6e)</samp>](https://github.com/alchemy-run/alchemy/commit/bdf6e15ee)
  - Accept --env-file /dev/null &nbsp;-&nbsp; by **arth** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2104 [<samp>(e7d0b)</samp>](https://github.com/alchemy-run/alchemy/commit/e7d0b7253)
  - Keep default stages valid when $USER has unsafe characters &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2113 [<samp>(e71cc)</samp>](https://github.com/alchemy-run/alchemy/commit/e71cc0cf0)
  - Cloudflare token --all-permissions splits policies over 300 groups &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2186 [<samp>(a8bd9)</samp>](https://github.com/alchemy-run/alchemy/commit/a8bd9fc7f)
- **cloudflare**:
  - Export Workers and R2 leaf modules &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/1959 [<samp>(49d64)</samp>](https://github.com/alchemy-run/alchemy/commit/49d6491d5)
  - Keep toRpcAsync views from being mistaken for thenables &nbsp;-&nbsp; by **Alex**, **agcty** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1506 [<samp>(26583)</samp>](https://github.com/alchemy-run/alchemy/commit/26583eaaa)
  - Expose Worker URLs during precreate &nbsp;-&nbsp; by **Aman Varshney** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1200 [<samp>(e1f2e)</samp>](https://github.com/alchemy-run/alchemy/commit/e1f2e1e31)
  - Fail Durable Object RPC calls to undefined members &nbsp;-&nbsp; by **Dan van der Merwe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1957 [<samp>(fdf6f)</samp>](https://github.com/alchemy-run/alchemy/commit/fdf6f2c1f)
  - Interrupt synchronous storage transaction callbacks &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/1958 [<samp>(31ec9)</samp>](https://github.com/alchemy-run/alchemy/commit/31ec93839)
  - Preserve verified gradual-rollout upload receipts &nbsp;-&nbsp; by **Orlando Barboza** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1901 [<samp>(b6552)</samp>](https://github.com/alchemy-run/alchemy/commit/b6552d403)
  - Report vite build child's stderr on failure &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2036 [<samp>(6d5e6)</samp>](https://github.com/alchemy-run/alchemy/commit/6d5e6f600)
  - Scope S3Credentials tokens to the bucket &nbsp;-&nbsp; by **Alessandro Cheli** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1985 [<samp>(14875)</samp>](https://github.com/alchemy-run/alchemy/commit/14875dec5)
  - Register container outbound interception with the native Fetcher &nbsp;-&nbsp; by **apostoli** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/2062 [<samp>(a7dd0)</samp>](https://github.com/alchemy-run/alchemy/commit/a7dd0b37a)
  - Redact observability destination credentials &nbsp;-&nbsp; by **Clemens Stolle** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1964 [<samp>(db7fe)</samp>](https://github.com/alchemy-run/alchemy/commit/db7fe1537)
  - Close request scopes for bodyless responses &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1649 [<samp>(8defa)</samp>](https://github.com/alchemy-run/alchemy/commit/8defa495a)
  - Keep running dev containers working across Worker reloads &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2158 [<samp>(b8bf3)</samp>](https://github.com/alchemy-run/alchemy/commit/b8bf35ab8)
  - Reset Durable Objects stuck on the pre-create placeholder &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2162 [<samp>(61251)</samp>](https://github.com/alchemy-run/alchemy/commit/612518dda)
  - Type-check the placeholder Durable Object test &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2164 [<samp>(927af)</samp>](https://github.com/alchemy-run/alchemy/commit/927af80f0)
  - Retry container creates until the Durable Object namespace is visible &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2167 [<samp>(7d872)</samp>](https://github.com/alchemy-run/alchemy/commit/7d8728438)
  - **ai**:
    - Fix streamed text, tool calls, and reasoning in Workers AI LanguageModel &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2064 [<samp>(7c97c)</samp>](https://github.com/alchemy-run/alchemy/commit/7c97c55bc)
  - **d1**:
    - Delete first when a replacement keeps the database name &nbsp;-&nbsp; by **Florian Bienefelt** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1867 [<samp>(452d7)</samp>](https://github.com/alchemy-run/alchemy/commit/452d71c1c)
  - **email**:
    - Refuse catch-all Email.Rule and adopt matching rules &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1539 [<samp>(d75bc)</samp>](https://github.com/alchemy-run/alchemy/commit/d75bc5bdd)
  - **hyperdrive**:
    - Only contribute the dev origin to local hosts &nbsp;-&nbsp; by **DivMode** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1839 [<samp>(4fa29)</samp>](https://github.com/alchemy-run/alchemy/commit/4fa290bf1)
  - **mtls-certificate**:
    - Retry delete while the certificate is still in use &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2081 [<samp>(cdd74)</samp>](https://github.com/alchemy-run/alchemy/commit/cdd741c9c)
  - **ruleset**:
    - Delete only the rules a Ruleset deployed &nbsp;-&nbsp; by **Damjan Znidarsic** in https://github.com/alchemy-run/alchemy/issues/1847 [<samp>(c7215)</samp>](https://github.com/alchemy-run/alchemy/commit/c7215c119)
  - **workers**:
    - Order observed routes like state so drift ignores listing order &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1826 [<samp>(bd954)</samp>](https://github.com/alchemy-run/alchemy/commit/bd954cbac)
    - Implement DurableObject jurisdiction &nbsp;-&nbsp; by **Makisuo** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2007 [<samp>(93181)</samp>](https://github.com/alchemy-run/alchemy/commit/93181c944)
    - Record main relative to the working directory so drift repair survives a moved checkout &nbsp;-&nbsp; by **0xMilkEnjoyer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1828 [<samp>(45ccb)</samp>](https://github.com/alchemy-run/alchemy/commit/45ccb40c8)
    - Preserve DO migration state after precreate &nbsp;-&nbsp; by **Stephen Shkeda** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1297 [<samp>(302df)</samp>](https://github.com/alchemy-run/alchemy/commit/302dff89c)
    - Implement DurableObject get, idFromName, idFromString, newUniqueId &nbsp;-&nbsp; by **Matthew Aylward** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/852 [<samp>(e07cd)</samp>](https://github.com/alchemy-run/alchemy/commit/e07cd9477)
- **cloudflare-runtime**:
  - Forward Linux host services through Docker &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2059 [<samp>(b13db)</samp>](https://github.com/alchemy-run/alchemy/commit/b13db2bf2)
  - **vite**:
    - Relay a worker's non-upgrade response &nbsp;-&nbsp; by **Daniel Gangl** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1680 [<samp>(4d9f3)</samp>](https://github.com/alchemy-run/alchemy/commit/4d9f308e7)
    - Cancel the Worker request when the client hangs up &nbsp;-&nbsp; by **Florian Bienefelt** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2111 [<samp>(454ee)</samp>](https://github.com/alchemy-run/alchemy/commit/454eebe17)
- **docker**:
  - Preserve image source push platform &nbsp;-&nbsp; by **bjorntechTobbe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1944 [<samp>(af547)</samp>](https://github.com/alchemy-run/alchemy/commit/af547c381)
  - Prune ignored build context directories &nbsp;-&nbsp; by **bjorntechTobbe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1945 [<samp>(fed67)</samp>](https://github.com/alchemy-run/alchemy/commit/fed6772ee)
  - Deploy Volume and Context declared without props &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2084 [<samp>(2dda6)</samp>](https://github.com/alchemy-run/alchemy/commit/2dda61f9c)
  - Authenticate Image builds with the registry credentials &nbsp;-&nbsp; by **Ethan Shumate** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1858 [<samp>(0a7f1)</samp>](https://github.com/alchemy-run/alchemy/commit/0a7f1e852)
  - Report why a build failed, not just its exit code &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1675 [<samp>(2ad57)</samp>](https://github.com/alchemy-run/alchemy/commit/2ad57fdc0)
  - Honor CMD, CMD-SHELL and NONE in healthcheck cmd &nbsp;-&nbsp; by **TBIQ007** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2049 [<samp>(b0bc2)</samp>](https://github.com/alchemy-run/alchemy/commit/b0bc2fac6)
  - Accept Podman missing images and push digests &nbsp;-&nbsp; by **Arman Charan** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2095 [<samp>(db744)</samp>](https://github.com/alchemy-run/alchemy/commit/db7442f03)
  - **container**: Configuration change does not result in update/replacement &nbsp;-&nbsp; by **Gerben Mulder** in https://github.com/alchemy-run/alchemy/issues/1397 [<samp>(ae5a5)</samp>](https://github.com/alchemy-run/alchemy/commit/ae5a53610)
- **engine,cloudflare**:
  - **workers**: Only precreate dependency-cycle members &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2015 [<samp>(1123d)</samp>](https://github.com/alchemy-run/alchemy/commit/1123d418c)
- **floci**:
  - Recover when Docker can't publish optional ports &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2215 [<samp>(61569)</samp>](https://github.com/alchemy-run/alchemy/commit/615690bae)
  - Drop any port Docker refuses; recreate only on port-request change &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2217 [<samp>(7fddf)</samp>](https://github.com/alchemy-run/alchemy/commit/7fddfae26)
- **fly**:
  - Repair blue/green live tests (PATCH metadata stamps, read-after-lease 404) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2120 [<samp>(26213)</samp>](https://github.com/alchemy-run/alchemy/commit/26213d927)
- **frontend-frameworks**:
  - Prevent astro cold-start dependency optimization errors &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/2037 [<samp>(20063)</samp>](https://github.com/alchemy-run/alchemy/commit/2006384ab)
  - Forward site env to AWS target builds &nbsp;-&nbsp; by **Ethan Shumate** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1855 [<samp>(0f49f)</samp>](https://github.com/alchemy-run/alchemy/commit/0f49fd133)
  - Normalize server module names to "/" on Windows &nbsp;-&nbsp; by **jarrednorris** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2071 [<samp>(b1fff)</samp>](https://github.com/alchemy-run/alchemy/commit/b1fff75af)
- **gcp**:
  - **sql**: Upgrade databaseVersion in place and honor deletion protection &nbsp;-&nbsp; by **fullflexer** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2029 [<samp>(449af)</samp>](https://github.com/alchemy-run/alchemy/commit/449afb2d0)
- **github**:
  - Only send environment protection rules when set &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2040 [<samp>(ce800)</samp>](https://github.com/alchemy-run/alchemy/commit/ce80078bb)
- **kubernetes**:
  - Stop applying redacted placeholders and silent failures &nbsp;-&nbsp; by **Théo Pomies** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1948 [<samp>(fe1b4)</samp>](https://github.com/alchemy-run/alchemy/commit/fe1b40ebd)
- **neon**:
  - Replace a branch whose fork point is unknown until apply &nbsp;-&nbsp; by **Gianmarco** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1878 [<samp>(8127c)</samp>](https://github.com/alchemy-run/alchemy/commit/8127c2591)
  - Leave a project's root or default branch to project deletion &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2075 [<samp>(7ecea)</samp>](https://github.com/alchemy-run/alchemy/commit/7eceae155)
- **planetscale**:
  - Derive Postgres branch cluster arch from parent &nbsp;-&nbsp; by **Austin** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2093 [<samp>(778cb)</samp>](https://github.com/alchemy-run/alchemy/commit/778cb0b17)
  - Replace or fail on rewritten branch migration history &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1489 [<samp>(a0e1a)</samp>](https://github.com/alchemy-run/alchemy/commit/a0e1a59df)
  - Drift no longer flags unchanged Postgres branches &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2107 [<samp>(ee208)</samp>](https://github.com/alchemy-run/alchemy/commit/ee2080521)
  - --force no longer replaces unchanged roles &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2103 [<samp>(833a0)</samp>](https://github.com/alchemy-run/alchemy/commit/833a0e754)
- **prisma**:
  - Don't fail a replacement while the old deployment drains &nbsp;-&nbsp; by **Kristof Siket** in https://github.com/alchemy-run/alchemy/issues/1920 [<samp>(e900e)</samp>](https://github.com/alchemy-run/alchemy/commit/e900e9909)
  - Migrate prisma-tanstack-start to Prisma ORM v8 and ungate live Prisma tests &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2038 [<samp>(be919)</samp>](https://github.com/alchemy-run/alchemy/commit/be919dbe5)
  - Inherit database region from the project's default region &nbsp;-&nbsp; by **Kristof Siket** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2026 [<samp>(6768a)</samp>](https://github.com/alchemy-run/alchemy/commit/6768a4a7d)
  - Publish prisma peer dependencies as version ranges &nbsp;-&nbsp; by **Will Madden** in https://github.com/alchemy-run/alchemy/issues/2154 [<samp>(cf833)</samp>](https://github.com/alchemy-run/alchemy/commit/cf83342a3)
- **railway**:
  - Scope Service delete to its environment &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/2184 [<samp>(7755f)</samp>](https://github.com/alchemy-run/alchemy/commit/7755fb9b8)
- **runtime**:
  - Reduce per-event telemetry configuration overhead &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/1960 [<samp>(f0bc7)</samp>](https://github.com/alchemy-run/alchemy/commit/f0bc70126)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.81...HEAD)

---

## v2.0.0-beta.81

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**: Sync OAuth scopes with registered client &nbsp;-&nbsp; by **Rahul Mishra** and **Benjamin Tang** in https://github.com/alchemy-run/alchemy/issues/1983 [<samp>(33716)</samp>](https://github.com/alchemy-run/alchemy/commit/33716211d)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.80...HEAD)

---

## v2.0.0-beta.80

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **better-auth**:
  - Support direct upgrades to 1.7.5 &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1732 [<samp>(c9400)</samp>](https://github.com/alchemy-run/alchemy/commit/c9400e4d4)
- **cloudflare**:
  - Add durable callbacks with transactional alarms &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1668 [<samp>(258f6)</samp>](https://github.com/alchemy-run/alchemy/commit/258f63b13)
  - Support resource references in queue subscriptions &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1722 [<samp>(85955)</samp>](https://github.com/alchemy-run/alchemy/commit/85955dbf3)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **acme**:
  - Add independent certificates and Fly runtime management &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1702 [<samp>(a1a58)</samp>](https://github.com/alchemy-run/alchemy/commit/a1a58ac19)
- **aws**:
  - Manage VPC default security group rules &nbsp;-&nbsp; by **Henning Pokriefke** and **sam** in https://github.com/alchemy-run/alchemy/issues/1630 [<samp>(8efa5)</samp>](https://github.com/alchemy-run/alchemy/commit/8efa50a45)
  - **ec2**: Add Client VPN resources &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1714 [<samp>(fdec4)</samp>](https://github.com/alchemy-run/alchemy/commit/fdec4ccf8)
  - **rds**: Manage the RDS master secret resource policy &nbsp;-&nbsp; by **Bjorn Pagen** and **sam** in https://github.com/alchemy-run/alchemy/issues/1598 [<samp>(95711)</samp>](https://github.com/alchemy-run/alchemy/commit/9571121c4)
- **cloudflare**:
  - Reuse shared container images across deployments &nbsp;-&nbsp; by **Dan van der Merwe** and **sam** in https://github.com/alchemy-run/alchemy/issues/1692 [<samp>(20790)</samp>](https://github.com/alchemy-run/alchemy/commit/20790b3b0)
  - Default to new module registry and sync upstream runtime &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1663 [<samp>(631ca)</samp>](https://github.com/alchemy-run/alchemy/commit/631ca932c)
  - Support hibernating WebSocket Effect RPC &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1705 [<samp>(da5df)</samp>](https://github.com/alchemy-run/alchemy/commit/da5df5c79)
  - Preserve workflow errors and validate socket attachments &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1723 [<samp>(e24fd)</samp>](https://github.com/alchemy-run/alchemy/commit/e24fd61e9)
  - Load Durable Object SQL migrations at construction &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1736 [<samp>(34637)</samp>](https://github.com/alchemy-run/alchemy/commit/3463790dd)
  - Support credential-less local development &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1801 [<samp>(98022)</samp>](https://github.com/alchemy-run/alchemy/commit/9802260db)
  - **access**:
    - Add McpServer resource &nbsp;-&nbsp; by **Dillion Verma** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1658 [<samp>(1ad29)</samp>](https://github.com/alchemy-run/alchemy/commit/1ad293d85)
  - **r2**:
    - Presigned URLs with a local S3 endpoint in dev &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1793 [<samp>(0a3a4)</samp>](https://github.com/alchemy-run/alchemy/commit/0a3a41974)
  - **workflows**:
    - Support explicit physical names &nbsp;-&nbsp; by **Odysseas Papadimas** and **sam** in https://github.com/alchemy-run/alchemy/issues/1460 [<samp>(341e6)</samp>](https://github.com/alchemy-run/alchemy/commit/341e6a7fc)
    - Expose the Workflow's physical name on the binding output &nbsp;-&nbsp; by **Alex** and **sam** in https://github.com/alchemy-run/alchemy/issues/1505 [<samp>(1fd93)</samp>](https://github.com/alchemy-run/alchemy/commit/1fd93e143)
- **cloudflare-runtime**:
  - Pass V8 flags to workerd &nbsp;-&nbsp; by **Alex** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1771 [<samp>(4264a)</samp>](https://github.com/alchemy-run/alchemy/commit/4264a1b73)
  - Restart workerd when it crashes after startup &nbsp;-&nbsp; by **Alex** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1772 [<samp>(de830)</samp>](https://github.com/alchemy-run/alchemy/commit/de83011fa)
- **core**:
  - Filter stack reconciliation with include/exclude &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1757 [<samp>(45c9b)</samp>](https://github.com/alchemy-run/alchemy/commit/45c9bb945)
- **fly**:
  - Wait for service checks before the next replica &nbsp;-&nbsp; by **Florian Bienefelt** and **sam** in https://github.com/alchemy-run/alchemy/issues/1670 [<samp>(023f9)</samp>](https://github.com/alchemy-run/alchemy/commit/023f96531)
  - Add blue/green deployments and graceful shutdown &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1706 [<samp>(3b5c9)</samp>](https://github.com/alchemy-run/alchemy/commit/3b5c9e24c)
  - Support native multi-container Machines &nbsp;-&nbsp; by **Florian Bienefelt** and **sam** in https://github.com/alchemy-run/alchemy/issues/1768 [<samp>(4eae8)</samp>](https://github.com/alchemy-run/alchemy/commit/4eae83e93)
  - Support blue/green multi-container Machines &nbsp;-&nbsp; by **Florian Bienefelt** and **sam** in https://github.com/alchemy-run/alchemy/issues/1769 [<samp>(1c369)</samp>](https://github.com/alchemy-run/alchemy/commit/1c369afba)
  - Allocate Flycast private addresses &nbsp;-&nbsp; by **Florian Bienefelt** and **sam** in https://github.com/alchemy-run/alchemy/issues/1749 [<samp>(7214e)</samp>](https://github.com/alchemy-run/alchemy/commit/7214e7b10)
  - A Service owns its App &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1794 [<samp>(76cde)</samp>](https://github.com/alchemy-run/alchemy/commit/76cde9ad8)
- **frontend-frameworks**:
  - Build Cloudflare Octane without an adapter &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1755 [<samp>(1dc1d)</samp>](https://github.com/alchemy-run/alchemy/commit/1dc1d75a0)
- **gcp**:
  - Add GCP resource providers, HTTP bindings, and nuke &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1336 [<samp>(e32ba)</samp>](https://github.com/alchemy-run/alchemy/commit/e32ba7fba)
- **kubernetes**:
  - LocalCluster, connection registries, and a docs hub &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1779 [<samp>(a1ef6)</samp>](https://github.com/alchemy-run/alchemy/commit/a1ef6ba2f)
- **neon**:
  - Add backend resources, Effect runtimes and websites &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1695 [<samp>(bcd41)</samp>](https://github.com/alchemy-run/alchemy/commit/bcd410418)
- **pkg**:
  - Publish affected packages and their dependencies &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1727 [<samp>(16a0a)</samp>](https://github.com/alchemy-run/alchemy/commit/16a0a829b)
- **planetscale**:
  - Add `withReplication` on PostgresRole &nbsp;-&nbsp; by **Makisuo** in https://github.com/alchemy-run/alchemy/issues/1777 [<samp>(8a284)</samp>](https://github.com/alchemy-run/alchemy/commit/8a284d039)
- **prisma**:
  - Add Effect-native Prisma ORM v8 support &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1198 [<samp>(3b82f)</samp>](https://github.com/alchemy-run/alchemy/commit/3b82f222d)
- **secrets**:
  - Stack secret providers with dotenv, Doppler, and Infisical &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1728 [<samp>(0f712)</samp>](https://github.com/alchemy-run/alchemy/commit/0f712f844)
- **website**:
  - Add standardized vinext support across providers &nbsp;-&nbsp; by **Ray** and **sam** in https://github.com/alchemy-run/alchemy/issues/1515 [<samp>(c6779)</samp>](https://github.com/alchemy-run/alchemy/commit/c6779e86e)
  - Landing refresh, PR lifecycle benchmark, in-browser copy editing &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1797 [<samp>(9fbd6)</samp>](https://github.com/alchemy-run/alchemy/commit/9fbd6a2ba)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Honor configured Alchemy runtime directories &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1726 [<samp>(4453c)</samp>](https://github.com/alchemy-run/alchemy/commit/4453c9b50)
- Expose Stack and Worker declaration metadata &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1490 [<samp>(a42c2)</samp>](https://github.com/alchemy-run/alchemy/commit/a42c2e55a)
- Upgrade Effect to 2.0.0-rc.117 and type constructors &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1758 [<samp>(1f251)</samp>](https://github.com/alchemy-run/alchemy/commit/1f251fa6a)
- Catch and remove any/unknown leaks in providers() requirements &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1895 [<samp>(5bd17)</samp>](https://github.com/alchemy-run/alchemy/commit/5bd1711b4)
- Provider test failures and Effect 4 stable compatibility &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1899 [<samp>(8cbd3)</samp>](https://github.com/alchemy-run/alchemy/commit/8cbd3ff4a)
- **alchemy**:
  - Make @effect/vitest an optional peer again &nbsp;-&nbsp; by **Aman Varshney** in https://github.com/alchemy-run/alchemy/issues/1816 [<samp>(e2906)</samp>](https://github.com/alchemy-run/alchemy/commit/e2906a727)
- **apply**:
  - Wait for cyclic upstream reconciliation outside cycles &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1921 [<samp>(9eb28)</samp>](https://github.com/alchemy-run/alchemy/commit/9eb28c9ea)
- **auth**:
  - Defer provider credentials and fail with CredentialsRequired &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1902 [<samp>(1d13b)</samp>](https://github.com/alchemy-run/alchemy/commit/1d13bddb8)
- **aws**:
  - Deploy ECS service after a previous deployment failed &nbsp;-&nbsp; by **Henning Pokriefke** and **sam** in https://github.com/alchemy-run/alchemy/issues/1650 [<samp>(9b642)</samp>](https://github.com/alchemy-run/alchemy/commit/9b6426e93)
  - Grant exact runtime capability actions &nbsp;-&nbsp; by **Saatvik Arya** and **sam** in https://github.com/alchemy-run/alchemy/issues/1357 [<samp>(e1d26)</samp>](https://github.com/alchemy-run/alchemy/commit/e1d26f85d)
  - **rds**:
    - Distinguish pending and blocked instance readiness &nbsp;-&nbsp; by **Bjorn Pagen** and **sam** in https://github.com/alchemy-run/alchemy/issues/1597 [<samp>(6236d)</samp>](https://github.com/alchemy-run/alchemy/commit/6236d078b)
    - Observe instance security drift and application state &nbsp;-&nbsp; by **Bjorn Pagen** and **sam** in https://github.com/alchemy-run/alchemy/issues/1599 [<samp>(ea601)</samp>](https://github.com/alchemy-run/alchemy/commit/ea60154e5)
- **aws-sqs**:
  - Reconcile adoption and queue Standrd/FIFO changes &nbsp;-&nbsp; by **Saatvik Arya** and **sam** [<samp>(1b3d6)</samp>](https://github.com/alchemy-run/alchemy/commit/1b3d60dd1)
- **cli**:
  - Simplify entrypoints and generate publish exports &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1707 [<samp>(c2e3b)</samp>](https://github.com/alchemy-run/alchemy/commit/c2e3bad1f)
  - Accept --adopt on alchemy plan &nbsp;-&nbsp; by **Pedro Toledo** in https://github.com/alchemy-run/alchemy/issues/1811 [<samp>(0b576)</samp>](https://github.com/alchemy-run/alchemy/commit/0b5761721)
- **cloudflare**:
  - Support Worker aliases through Rolldown input options &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1700 [<samp>(020de)</samp>](https://github.com/alchemy-run/alchemy/commit/020de393d)
  - Scope Workflow attempts and batch alarm updates &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1701 [<samp>(04ad9)</samp>](https://github.com/alchemy-run/alchemy/commit/04ad9facc)
  - Preserve explicit prebuilt Worker compatibility flags &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1725 [<samp>(3281a)</samp>](https://github.com/alchemy-run/alchemy/commit/3281a6e7c)
  - Preserve version annotations on full deployments &nbsp;-&nbsp; by **Luke O'Malley** in https://github.com/alchemy-run/alchemy/issues/1754 [<samp>(a4a75)</samp>](https://github.com/alchemy-run/alchemy/commit/a4a755878)
  - Register website dev servers for service bindings &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1798 [<samp>(b2618)</samp>](https://github.com/alchemy-run/alchemy/commit/b261867f1)
  - Bypass assets for Vite module runner initialization &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1799 [<samp>(d14b4)</samp>](https://github.com/alchemy-run/alchemy/commit/d14b4a485)
  - Only ignore missing DNS record errors &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1800 [<samp>(36a27)</samp>](https://github.com/alchemy-run/alchemy/commit/36a278d7c)
  - Preserve asset rules in Workers-for-Platforms uploads &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1802 [<samp>(dc22a)</samp>](https://github.com/alchemy-run/alchemy/commit/dc22aa240)
  - Expose ref on Container so another stack can reference it &nbsp;-&nbsp; by **Cyberistic** and **sam** in https://github.com/alchemy-run/alchemy/issues/1750 [<samp>(2745d)</samp>](https://github.com/alchemy-run/alchemy/commit/2745d7943)
  - Prevent partial registry writes from breaking service discovery &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1924 [<samp>(a12d5)</samp>](https://github.com/alchemy-run/alchemy/commit/a12d5b8c7)
  - **workflows**: Omit step-config keys with no value &nbsp;-&nbsp; by **apostoli** and **sam** in https://github.com/alchemy-run/alchemy/issues/1142 [<samp>(1c28c)</samp>](https://github.com/alchemy-run/alchemy/commit/1c28c06ef)
- **cloudflare-runtime**:
  - Prune the module runner callback maps &nbsp;-&nbsp; by **Alex** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1770 [<samp>(318c4)</samp>](https://github.com/alchemy-run/alchemy/commit/318c442ad)
- **command**:
  - Gracefully clean up wrapper processes &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1760 [<samp>(d3e71)</samp>](https://github.com/alchemy-run/alchemy/commit/d3e7132e2)
- **core**:
  - Reuse pure Action outputs when inputs are unchanged &nbsp;-&nbsp; by **Leonardo E. Dominguez** and **sam** in https://github.com/alchemy-run/alchemy/issues/1379 [<samp>(b7b65)</samp>](https://github.com/alchemy-run/alchemy/commit/b7b656e63)
  - Plan an update when an Init-captured value changes &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1837 [<samp>(467e1)</samp>](https://github.com/alchemy-run/alchemy/commit/467e1728a)
- **deps**:
  - Bump distilled for Fly IP assignment networks &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1784 [<samp>(31400)</samp>](https://github.com/alchemy-run/alchemy/commit/31400f4d6)
- **effect**:
  - Move to Effect 4.0.0-rc.118's flattened module layout &nbsp;-&nbsp; by **Rahul Mishra** and **Agustí Fernandez Pardo** in https://github.com/alchemy-run/alchemy/issues/1894 [<samp>(8e062)</samp>](https://github.com/alchemy-run/alchemy/commit/8e06298e2)
- **engine**:
  - Clean up interrupted replacement generations &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1704 [<samp>(5edbe)</samp>](https://github.com/alchemy-run/alchemy/commit/5edbe41e3)
- **fly**:
  - Transport binding values via RuntimeContext, not host.bind env &nbsp;-&nbsp; by **Michael K** and **sam** in https://github.com/alchemy-run/alchemy/issues/1554 [<samp>(124af)</samp>](https://github.com/alchemy-run/alchemy/commit/124af3d35)
- **frontend-frameworks**:
  - Bump sveltekit to 3.0.0-next.27 &nbsp;-&nbsp; by **Cameron McEvenue** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1709 [<samp>(08354)</samp>](https://github.com/alchemy-run/alchemy/commit/08354d70d)
- **gcp**:
  - Deployed-host binding tests, GCP.Website, and full-suite fixes &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1898 [<samp>(e354a)</samp>](https://github.com/alchemy-run/alchemy/commit/e354a4555)
- **nextjs**:
  - Use shared built config to serve in node/neon &nbsp;-&nbsp; by **Aman Varshney** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1805 [<samp>(08110)</samp>](https://github.com/alchemy-run/alchemy/commit/081109293)
- **pkg**:
  - Support fork previews and PR revision URLs &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1681 [<samp>(d6a6b)</samp>](https://github.com/alchemy-run/alchemy/commit/d6a6be1e8)
- **prisma**:
  - Default dev commands to development mode &nbsp;-&nbsp; by **Aman Varshney** in https://github.com/alchemy-run/alchemy/issues/1703 [<samp>(dc750)</samp>](https://github.com/alchemy-run/alchemy/commit/dc75059b0)
- **railway**:
  - Apply Service region through multiRegionConfig &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1766 [<samp>(3101a)</samp>](https://github.com/alchemy-run/alchemy/commit/3101aff24)
- **sveltekit**:
  - Complete regression test build output &nbsp;-&nbsp; by **BlankParticle** [<samp>(c37b8)</samp>](https://github.com/alchemy-run/alchemy/commit/c37b8c37d)
  - Load Playwright tsconfig before fixture config &nbsp;-&nbsp; by **BlankParticle** [<samp>(547d2)</samp>](https://github.com/alchemy-run/alchemy/commit/547d2b4ee)
- **website**:
  - Make OpenNext config and Node-hosted Octane adapters optional &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1747 [<samp>(7c1c6)</samp>](https://github.com/alchemy-run/alchemy/commit/7c1c6d2e0)
  - Consolidate generated reference pages &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1767 [<samp>(ed12d)</samp>](https://github.com/alchemy-run/alchemy/commit/ed12d29fb)
  - Organize API reference navigation by service and product &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1774 [<samp>(93c70)</samp>](https://github.com/alchemy-run/alchemy/commit/93c70aa0d)
  - Load frontend-frameworks lazily &nbsp;-&nbsp; by **Aman Varshney** and **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1815 [<samp>(08f84)</samp>](https://github.com/alchemy-run/alchemy/commit/08f84a57d)
  - Commit copy-editor virtual module types &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1824 [<samp>(983a8)</samp>](https://github.com/alchemy-run/alchemy/commit/983a8fbff)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.79...HEAD)

---

## v2.0.0-beta.79

### &nbsp;&nbsp;&nbsp;🚀 Features

- **prisma**: Add Website framework support &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1683 [<samp>(530a2)</samp>](https://github.com/alchemy-run/alchemy/commit/530a201e4)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cli**: Start Bun with production JSX settings &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1694 [<samp>(eef2a)</samp>](https://github.com/alchemy-run/alchemy/commit/eef2a9123)
- **cloudflare**: Infer env for external Worker classes &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1697 [<samp>(233da)</samp>](https://github.com/alchemy-run/alchemy/commit/233da74ef)
- **cloudflare-runtime**: Declare mime as a dependency &nbsp;-&nbsp; by **Matthew Aylward** in https://github.com/alchemy-run/alchemy/issues/1690 [<samp>(85991)</samp>](https://github.com/alchemy-run/alchemy/commit/859911c14)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.78...HEAD)

---

## v2.0.0-beta.78

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **aws**: Preserve explicit security group egress intent &nbsp;-&nbsp; by **Henning Pokriefke** in https://github.com/alchemy-run/alchemy/issues/1623 [<samp>(d438b)</samp>](https://github.com/alchemy-run/alchemy/commit/d438b9d8b)
- **git**: Expose Git operations for native Effect APIs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1621 [<samp>(bd021)</samp>](https://github.com/alchemy-run/alchemy/commit/bd0211912)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - **s3**: Manage blocked encryption types &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1588 [<samp>(3f97d)</samp>](https://github.com/alchemy-run/alchemy/commit/3f97df5f2)
- **cloudflare**:
  - **workers**: Worker Previews &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1563 [<samp>(eae69)</samp>](https://github.com/alchemy-run/alchemy/commit/eae693613)
- **cloudflare-runtime**:
  - Replace the workerd proxy with a layer-4 relay &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1612 [<samp>(9a9b6)</samp>](https://github.com/alchemy-run/alchemy/commit/9a9b60179)
- **core**:
  - Keep engine/AWS/distilled out of dev processes &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1614 [<samp>(bad83)</samp>](https://github.com/alchemy-run/alchemy/commit/bad831409)
- **dev**:
  - Serve every local provider group from one sidecar &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1613 [<samp>(38f27)</samp>](https://github.com/alchemy-run/alchemy/commit/38f2714f7)
- **git**:
  - Git hosting on Workers, Durable Objects, and R2 &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1187 [<samp>(9e2f8)</samp>](https://github.com/alchemy-run/alchemy/commit/9e2f88577)
- **github**:
  - Add Label resource &nbsp;-&nbsp; by **Agusti F.** in https://github.com/alchemy-run/alchemy/issues/1565 [<samp>(d49c2)</samp>](https://github.com/alchemy-run/alchemy/commit/d49c25853)
  - Add Milestone resource &nbsp;-&nbsp; by **Agusti F.** in https://github.com/alchemy-run/alchemy/issues/1566 [<samp>(4c911)</samp>](https://github.com/alchemy-run/alchemy/commit/4c911a504)
  - Add Issue resource &nbsp;-&nbsp; by **Agusti F.** in https://github.com/alchemy-run/alchemy/issues/1568 [<samp>(6911c)</samp>](https://github.com/alchemy-run/alchemy/commit/6911c4090)
  - Add PullRequest resource &nbsp;-&nbsp; by **Agusti F.** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1569 [<samp>(19c1b)</samp>](https://github.com/alchemy-run/alchemy/commit/19c1bf400)
  - Add Release resource &nbsp;-&nbsp; by **Agusti F.** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1577 [<samp>(87801)</samp>](https://github.com/alchemy-run/alchemy/commit/87801a9c4)
  - Add TeamAccess resource &nbsp;-&nbsp; by **Agusti F.** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1572 [<samp>(9585e)</samp>](https://github.com/alchemy-run/alchemy/commit/9585ed6ff)
  - Add BranchProtection resource &nbsp;-&nbsp; by **99andytang** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1514 [<samp>(527e7)</samp>](https://github.com/alchemy-run/alchemy/commit/527e7c4bb)
  - Add Ruleset resource &nbsp;-&nbsp; by **Agusti F.** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1570 [<samp>(113f5)</samp>](https://github.com/alchemy-run/alchemy/commit/113f5c194)
  - Add Collaborator resource &nbsp;-&nbsp; by **Agusti F.** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1571 [<samp>(16847)</samp>](https://github.com/alchemy-run/alchemy/commit/168470bcd)
  - Add WikiPage resource &nbsp;-&nbsp; by **Agusti F.** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1578 [<samp>(8d617)</samp>](https://github.com/alchemy-run/alchemy/commit/8d617fca2)
- **node-utils**:
  - Cache oxc transforms and run the CLI launcher in place &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1615 [<samp>(6087e)</samp>](https://github.com/alchemy-run/alchemy/commit/6087e5289)
- **pkg**:
  - Preview package registry verified against GitHub Actions runs &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1516 [<samp>(b7fc7)</samp>](https://github.com/alchemy-run/alchemy/commit/b7fc701fe)
- **prisma**:
  - Consume @distilled.cloud/prisma-postgres instead of the hand-rolled client &nbsp;-&nbsp; by **Will Madden** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1290 [<samp>(f7340)</samp>](https://github.com/alchemy-run/alchemy/commit/f73403bc0)
  - Deploy static apps with Compute &nbsp;-&nbsp; by **Aman Varshney** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1208 [<samp>(35193)</samp>](https://github.com/alchemy-run/alchemy/commit/351932777)
- **railway**:
  - Migrate reconcilers to selective GraphQL &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1604 [<samp>(d0b83)</samp>](https://github.com/alchemy-run/alchemy/commit/d0b83b2e0)
  - Add sandbox domains, sizing, forks, and checkpoints &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1661 [<samp>(41cdf)</samp>](https://github.com/alchemy-run/alchemy/commit/41cdf897d)
- **stripe**:
  - Add Stripe resources, auth, and nuke wiring &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1298 [<samp>(0d9a5)</samp>](https://github.com/alchemy-run/alchemy/commit/0d9a58c85)
- **test**:
  - Default Test.make stage to test_$USER &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1579 [<samp>(d2185)</samp>](https://github.com/alchemy-run/alchemy/commit/d218541b2)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Effect rc.113 proxyChain/BunHttpServer regressions; AWS destroy after drifted state &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1576 [<samp>(9ee79)</samp>](https://github.com/alchemy-run/alchemy/commit/9ee794539)
- DSQL SNI (sql-pg rc.113), ECS Service delete on a draining service, Nextjs preview proxy secret &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1580 [<samp>(92d04)</samp>](https://github.com/alchemy-run/alchemy/commit/92d0480ad)
- Sql-pg rc.113 sslmode=prefer, Prisma.Database branch attachment &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1582 [<samp>(42c3f)</samp>](https://github.com/alchemy-run/alchemy/commit/42c3ffc47)
- Resolve provider modes and repair integration test failures &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1646 [<samp>(c6c58)</samp>](https://github.com/alchemy-run/alchemy/commit/c6c58baa5)
- Outdated tests and regressions &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1659 [<samp>(d05b2)</samp>](https://github.com/alchemy-run/alchemy/commit/d05b217cb)
- Resolve dev sidecar through package exports &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1678 [<samp>(6d803)</samp>](https://github.com/alchemy-run/alchemy/commit/6d8030273)
- Resolve release validation failures &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1671 [<samp>(5bd89)</samp>](https://github.com/alchemy-run/alchemy/commit/5bd8968b7)
- Align distilled pnpm version for CI builds &nbsp;-&nbsp; by **BlankParticle** [<samp>(edb81)</samp>](https://github.com/alchemy-run/alchemy/commit/edb8192a6)
- **aws**:
  - Restore missing ownership tags in AWS Organizations &nbsp;-&nbsp; by **Henning Pokriefke** in https://github.com/alchemy-run/alchemy/issues/1637 [<samp>(b66be)</samp>](https://github.com/alchemy-run/alchemy/commit/b66bef23b)
  - Preserve standalone security group rules &nbsp;-&nbsp; by **Henning Pokriefke** in https://github.com/alchemy-run/alchemy/issues/1624 [<samp>(3cbc9)</samp>](https://github.com/alchemy-run/alchemy/commit/3cbc9b3dc)
  - Enforce S3 and security group desired state &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1664 [<samp>(66c94)</samp>](https://github.com/alchemy-run/alchemy/commit/66c944949)
  - Replace fixed-IP EC2 instances delete-first &nbsp;-&nbsp; by **Sam Goodwin** and **dawson** in https://github.com/alchemy-run/alchemy/issues/1667 [<samp>(2a615)</samp>](https://github.com/alchemy-run/alchemy/commit/2a61544e2)
  - **ec2**:
    - Reconcile security-group rule deltas &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1592 [<samp>(fae76)</samp>](https://github.com/alchemy-run/alchemy/commit/fae766993)
  - **ecr**:
    - Skip updates for relocated image contexts &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1591 [<samp>(bb4be)</samp>](https://github.com/alchemy-run/alchemy/commit/bb4be0f11)
  - **logs**:
    - Normalize log group ARN from state before tagging calls &nbsp;-&nbsp; by **Evan Spaeder** in https://github.com/alchemy-run/alchemy/issues/1575 [<samp>(c17cb)</samp>](https://github.com/alchemy-run/alchemy/commit/c17cb45c7)
  - **rds**:
    - Enforce desired parameter group values &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1589 [<samp>(461a5)</samp>](https://github.com/alchemy-run/alchemy/commit/461a5c574)
    - Repair parameter group drift with desired defaults &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1590 [<samp>(7c8fc)</samp>](https://github.com/alchemy-run/alchemy/commit/7c8fc7bf0)
    - Reconcile storage autoscaling defaults &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1593 [<samp>(076ef)</samp>](https://github.com/alchemy-run/alchemy/commit/076eff8b4)
    - Include coupled storage modification fields &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1594 [<samp>(d2c06)</samp>](https://github.com/alchemy-run/alchemy/commit/d2c0699ca)
    - Compare the observed endpoint port &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1595 [<samp>(7c3eb)</samp>](https://github.com/alchemy-run/alchemy/commit/7c3ebed5c)
    - Skip unchanged instance associations &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1596 [<samp>(82e82)</samp>](https://github.com/alchemy-run/alchemy/commit/82e829ffa)
  - **s3**:
    - Check bucket ownership with GetBucketLocation &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1585 [<samp>(8ac81)</samp>](https://github.com/alchemy-run/alchemy/commit/8ac81b2c1)
    - Propagate configuration read failures &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1586 [<samp>(640c6)</samp>](https://github.com/alchemy-run/alchemy/commit/640c65b7c)
    - Compare decoded encryption key values &nbsp;-&nbsp; by **Bjorn Pagen** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1587 [<samp>(899bc)</samp>](https://github.com/alchemy-run/alchemy/commit/899bc357e)
- **cli**:
  - Preserve js extension for exec bundle &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1625 [<samp>(88339)</samp>](https://github.com/alchemy-run/alchemy/commit/883398af5)
  - Isolate the React renderer from consumer dependencies &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1636 [<samp>(c83b4)</samp>](https://github.com/alchemy-run/alchemy/commit/c83b45421)
  - Respect detected terminal color support &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1679 [<samp>(75f93)</samp>](https://github.com/alchemy-run/alchemy/commit/75f93a4ee)
- **cloudflare**:
  - Forward crons to Vite dev workers &nbsp;-&nbsp; by **zawaki** in https://github.com/alchemy-run/alchemy/issues/1641 [<samp>(0aab5)</samp>](https://github.com/alchemy-run/alchemy/commit/0aab5723d)
  - Forward container memoryMib &nbsp;-&nbsp; by **Dan van der Merwe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1521 [<samp>(b96d4)</samp>](https://github.com/alchemy-run/alchemy/commit/b96d494e2)
  - Plan replacements for cached container identity mismatches &nbsp;-&nbsp; by **Dan van der Merwe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1523 [<samp>(0f26a)</samp>](https://github.com/alchemy-run/alchemy/commit/0f26aa54b)
  - Export container builds directly to registries &nbsp;-&nbsp; by **Dan van der Merwe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1524 [<samp>(c74a3)</samp>](https://github.com/alchemy-run/alchemy/commit/c74a3833a)
  - Deduplicate container image publication &nbsp;-&nbsp; by **Dan van der Merwe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1525 [<samp>(27536)</samp>](https://github.com/alchemy-run/alchemy/commit/275361dfe)
  - Preserve unresolved container attachments &nbsp;-&nbsp; by **Dan van der Merwe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1150 [<samp>(d9d7f)</samp>](https://github.com/alchemy-run/alchemy/commit/d9d7fa234)
  - Expose the Worker bridge from a runtime-only entry &nbsp;-&nbsp; by **Alex** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1643 [<samp>(fc0a2)</samp>](https://github.com/alchemy-run/alchemy/commit/fc0a24130)
  - Recover interrupted creates by generated identity &nbsp;-&nbsp; by **Dan van der Merwe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1526 [<samp>(bd83d)</samp>](https://github.com/alchemy-run/alchemy/commit/bd83dd948)
  - **r2**: Forward put options on the stream path &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1602 [<samp>(34917)</samp>](https://github.com/alchemy-run/alchemy/commit/34917080f)
  - **worker**: Restore request URL through trusted proxy &nbsp;-&nbsp; by **BlankParticle** in https://github.com/alchemy-run/alchemy/issues/1573 [<samp>(da987)</samp>](https://github.com/alchemy-run/alchemy/commit/da987815e)
  - **workers**: Type named entrypoint bindings with their RPC surface &nbsp;-&nbsp; by **Michael K** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1415 [<samp>(8d3f9)</samp>](https://github.com/alchemy-run/alchemy/commit/8d3f92ea2)
- **cloudflare-runtime**:
  - Read registry mtime with node:fs.stat &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1564 [<samp>(ca421)</samp>](https://github.com/alchemy-run/alchemy/commit/ca4216f00)
  - Pull the egress interceptor host-native &nbsp;-&nbsp; by **Erik Müller** in https://github.com/alchemy-run/alchemy/issues/1459 [<samp>(b7505)</samp>](https://github.com/alchemy-run/alchemy/commit/b7505d5e6)
- **deps**:
  - Update to effect 4.0.0-rc.113 &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1562 [<samp>(4340a)</samp>](https://github.com/alchemy-run/alchemy/commit/4340adad4)
  - Effect 4.0.0-rc.115; drop the sql-pg SNI shim &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1601 [<samp>(ba30b)</samp>](https://github.com/alchemy-run/alchemy/commit/ba30b9efc)
  - Upgrade Foldkit for Effect RC 115 &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1618 [<samp>(4343f)</samp>](https://github.com/alchemy-run/alchemy/commit/4343fc985)
- **docker**:
  - Fall back to build + push on Buildx < 0.26 registry exports &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1685 [<samp>(c37b0)</samp>](https://github.com/alchemy-run/alchemy/commit/c37b0414f)
- **hetzner**:
  - Recover cleanup after interrupted server creation &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1662 [<samp>(fca23)</samp>](https://github.com/alchemy-run/alchemy/commit/fca232564)
- **node-utils**:
  - Exclude the root's own node_modules from the Bun dev probe &nbsp;-&nbsp; by **Austin** in https://github.com/alchemy-run/alchemy/issues/1617 [<samp>(80c71)</samp>](https://github.com/alchemy-run/alchemy/commit/80c71fe8d)
- **railway**:
  - Mount volumes and wait for the uploaded Service deploy &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1584 [<samp>(361f5)</samp>](https://github.com/alchemy-run/alchemy/commit/361f53df7)
  - Import the native SDK from the package root &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1620 [<samp>(18156)</samp>](https://github.com/alchemy-run/alchemy/commit/18156acbc)
  - Use environment-managed private networking &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1682 [<samp>(c197c)</samp>](https://github.com/alchemy-run/alchemy/commit/c197cd0a5)
- **state**:
  - Keep HTTP state payloads out of errors &nbsp;-&nbsp; by **Dan van der Merwe** in https://github.com/alchemy-run/alchemy/issues/1522 [<samp>(f8954)</samp>](https://github.com/alchemy-run/alchemy/commit/f8954086d)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.77...HEAD)

---

## v2.0.0-beta.77

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- Profiles overhaul &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1234 [<samp>(af2b9)</samp>](https://github.com/alchemy-run/alchemy/commit/af2b9f338)
- Overhaul the Alchemy CLI &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1235 [<samp>(04b83)</samp>](https://github.com/alchemy-run/alchemy/commit/04b8366ac)
- **cli**:
  - Breaking change, default deploy stage is live_$USER &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1421 [<samp>(df6be)</samp>](https://github.com/alchemy-run/alchemy/commit/df6be201e)
  - Honor ALCHEMY_STAGE instead of STAGE &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1433 [<samp>(0f8b2)</samp>](https://github.com/alchemy-run/alchemy/commit/0f8b2bd62)

### &nbsp;&nbsp;&nbsp;🚀 Features

- CliKit — a terminal UI layer for the CLI on @alchemy.run/sigil &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1233 [<samp>(bf4d2)</samp>](https://github.com/alchemy-run/alchemy/commit/bf4d23590)
- Refactor interaction/auth flows, run ts/tsx files directly under node &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1430 [<samp>(416de)</samp>](https://github.com/alchemy-run/alchemy/commit/416de9dd0)
- Bump distilled to 78a9304 (verbNoun operation names, Railway selection fixes) &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1517 [<samp>(047db)</samp>](https://github.com/alchemy-run/alchemy/commit/047dbb7f1)
- **aws**:
  - Add provisioned ElastiCache resources &nbsp;-&nbsp; by **Henning Pokriefke** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1422 [<samp>(dc983)</samp>](https://github.com/alchemy-run/alchemy/commit/dc9831caa)
- **cli**:
  - Profile tab scrolling, --profile flag, v0 store migration &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1429 [<samp>(c2e8f)</samp>](https://github.com/alchemy-run/alchemy/commit/c2e8ff0cc)
  - Unify plan and dev output presentation &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1458 [<samp>(fe7d1)</samp>](https://github.com/alchemy-run/alchemy/commit/fe7d1e3db)
  - Use oxc for typescript, better reloading of stacks &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1461 [<samp>(37322)</samp>](https://github.com/alchemy-run/alchemy/commit/37322bb96)
  - Refactor auth profiles into provider files &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1475 [<samp>(486bb)</samp>](https://github.com/alchemy-run/alchemy/commit/486bbe9c0)
  - Standardize auth provider methods, env precedence, drop AWS local &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1480 [<samp>(22b41)</samp>](https://github.com/alchemy-run/alchemy/commit/22b41856d)
  - Pointer-focus TUI, tcut demo, and the beta.77 release blog &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1547 [<samp>(8aecc)</samp>](https://github.com/alchemy-run/alchemy/commit/8aecc3e91)
- **cloudflare**:
  - Add Cloudflare.Telemetry native tracing layer &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1444 [<samp>(e05c7)</samp>](https://github.com/alchemy-run/alchemy/commit/e05c734ea)
  - Add abort retryAlarm on DurableObjectState &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1374 [<samp>(b357f)</samp>](https://github.com/alchemy-run/alchemy/commit/b357f7119)
  - Add webSocketError to the Durable Object shape and bridge &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/1497 [<samp>(84bb1)</samp>](https://github.com/alchemy-run/alchemy/commit/84bb1ad76)
  - **workflows**: Support native cron schedules &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1491 [<samp>(533df)</samp>](https://github.com/alchemy-run/alchemy/commit/533dfb5bb)
- **cloudflare-runtime**:
  - Update workerd and vendored Workers runtime sources &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1442 [<samp>(59ede)</samp>](https://github.com/alchemy-run/alchemy/commit/59ede0883)
- **fly**:
  - Support health checks &nbsp;-&nbsp; by **Adam Svystun** in https://github.com/alchemy-run/alchemy/issues/1463 [<samp>(0f814)</samp>](https://github.com/alchemy-run/alchemy/commit/0f814dfca)
- **railway**:
  - Support service pre-deploy commands &nbsp;-&nbsp; by **Dallen Pyrah** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1438 [<samp>(d76d7)</samp>](https://github.com/alchemy-run/alchemy/commit/d76d7be7b)
  - Support private services &nbsp;-&nbsp; by **Dallen Pyrah** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1439 [<samp>(2ceae)</samp>](https://github.com/alchemy-run/alchemy/commit/2ceae5476)
  - Support local Docker contexts &nbsp;-&nbsp; by **Dallen Pyrah** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1440 [<samp>(59573)</samp>](https://github.com/alchemy-run/alchemy/commit/59573d7c8)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Expose the Worker resource's ref method in its type &nbsp;-&nbsp; by **pollux** in https://github.com/alchemy-run/alchemy/issues/1434 [<samp>(74e5f)</samp>](https://github.com/alchemy-run/alchemy/commit/74e5f36b2)
- Resolve example test failures &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1527 [<samp>(63236)</samp>](https://github.com/alchemy-run/alchemy/commit/632360a5e)
- **apply**:
  - Persist downstream edges on noop resources &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1552 [<samp>(5463c)</samp>](https://github.com/alchemy-run/alchemy/commit/5463ca826)
- **auth**:
  - Deduplicate environment credential notices &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1520 [<samp>(233a5)</samp>](https://github.com/alchemy-run/alchemy/commit/233a5aff8)
- **aws**:
  - **organizations**: Unwrap Redacted account name and email &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1556 [<samp>(f2957)</samp>](https://github.com/alchemy-run/alchemy/commit/f2957a194)
- **cli**:
  - Stream apply notes in plain mode and stop wrapping log lines &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1423 [<samp>(e0d72)</samp>](https://github.com/alchemy-run/alchemy/commit/e0d72263a)
  - Prompt for approval in plain interactive mode &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1426 [<samp>(bd74f)</samp>](https://github.com/alchemy-run/alchemy/commit/bd74f6880)
  - Show feedback during slow shutdowns &nbsp;-&nbsp; by **Rahul Mishra** and **Claude Fable 5** in https://github.com/alchemy-run/alchemy/issues/1427 [<samp>(695ba)</samp>](https://github.com/alchemy-run/alchemy/commit/695ba55ce)
  - Bindings state, persist plan collapse state &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1492 [<samp>(743e6)</samp>](https://github.com/alchemy-run/alchemy/commit/743e64013)
  - Restore nuke progress and bulk state cleanup &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1532 [<samp>(55f7c)</samp>](https://github.com/alchemy-run/alchemy/commit/55f7c0999)
  - Virtualize the profile dashboard's provider list &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1533 [<samp>(ab83e)</samp>](https://github.com/alchemy-run/alchemy/commit/ab83e7872)
  - Honor --profile on cloudflare bootstrap &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1538 [<samp>(93b3a)</samp>](https://github.com/alchemy-run/alchemy/commit/93b3a7ef9)
  - Update Sigil to fix terminal input corruption &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1545 [<samp>(b979f)</samp>](https://github.com/alchemy-run/alchemy/commit/b979ffc6a)
- **cloudflare**:
  - Local dev crashes when assets contain a _headers or _redirects file &nbsp;-&nbsp; by **Michael** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1418 [<samp>(35a3b)</samp>](https://github.com/alchemy-run/alchemy/commit/35a3b9bcb)
  - Preserve RpcWorker logical ID &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1487 [<samp>(5ab17)</samp>](https://github.com/alchemy-run/alchemy/commit/5ab171d92)
  - Wrap WorkerLoader.get() as a WorkerStub &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1488 [<samp>(39258)</samp>](https://github.com/alchemy-run/alchemy/commit/39258554d)
  - Run Durable Object callbacks with the caller's context &nbsp;-&nbsp; by **Alex** in https://github.com/alchemy-run/alchemy/issues/1498 [<samp>(cf8e0)</samp>](https://github.com/alchemy-run/alchemy/commit/cf8e00845)
  - Fix broken framework dev/builds/tests &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1534 [<samp>(7e375)</samp>](https://github.com/alchemy-run/alchemy/commit/7e3757771)
- **cloudflare-runtime**:
  - Bump internal isolate compatibility dates &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1380 [<samp>(18880)</samp>](https://github.com/alchemy-run/alchemy/commit/18880d16d)
- **frontend**:
  - Don't cache in NodeServe &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(11c95)</samp>](https://github.com/alchemy-run/alchemy/commit/11c95dc04)
- **pr-package**:
  - Keep PR previews until the pull request closes &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1511 [<samp>(b12d8)</samp>](https://github.com/alchemy-run/alchemy/commit/b12d8167b)
- **railway**:
  - Bump distilled to drop admin-only platformFeatureFlags &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1479 [<samp>(eadf6)</samp>](https://github.com/alchemy-run/alchemy/commit/eadf6d9f7)
- **website**:
  - SEO, noindex, canonical, nosnippet & more &nbsp;-&nbsp; by **Sam Goodwin** and **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1269 [<samp>(09f2a)</samp>](https://github.com/alchemy-run/alchemy/commit/09f2a23f1)
- **workflows**:
  - Omit undefined step config keys from bridge &nbsp;-&nbsp; by **Lord Coughmann** in https://github.com/alchemy-run/alchemy/issues/1416 [<samp>(034c0)</samp>](https://github.com/alchemy-run/alchemy/commit/034c02885)

### &nbsp;&nbsp;&nbsp;🏎 Performance

- **cloudflare**:
  - **workers**: Upload asset buckets concurrently &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1445 [<samp>(90b5d)</samp>](https://github.com/alchemy-run/alchemy/commit/90b5df7a6)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.76...HEAD)

---

## v2.0.0-beta.76

### &nbsp;&nbsp;&nbsp;🚀 Features

- **aws**:
  - **cognito**:
    - Add ManagedLoginBranding resource &nbsp;-&nbsp; by **Thiago Felix** in https://github.com/alchemy-run/alchemy/issues/1396 [<samp>(5ef8d)</samp>](https://github.com/alchemy-run/alchemy/commit/5ef8d9e62)
    - Add emailConfiguration to UserPool for SES-backed email delivery &nbsp;-&nbsp; by **Thiago Felix** in https://github.com/alchemy-run/alchemy/issues/1395 [<samp>(a57a8)</samp>](https://github.com/alchemy-run/alchemy/commit/a57a8cacb)
- **planetscale**:
  - Expose Postgres private connection details for AWS Privatelink etc. &nbsp;-&nbsp; by **henningpokriefke** in https://github.com/alchemy-run/alchemy/issues/1414 [<samp>(e1a7f)</samp>](https://github.com/alchemy-run/alchemy/commit/e1a7fac51)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **aws**:
  - **website**: Dev-connectable site URLs; green test:aws:floci with floci 1.6.0-alchemy.9 &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1417 [<samp>(1380b)</samp>](https://github.com/alchemy-run/alchemy/commit/1380b3485)
- **cli**:
  - Only load floci CA when it exists &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1412 [<samp>(1a3f7)</samp>](https://github.com/alchemy-run/alchemy/commit/1a3f7ad5f)
- **cloudflare**:
  - Route asset upload sessions to the dispatch-namespace endpoint &nbsp;-&nbsp; by **Pedro Toledo** in https://github.com/alchemy-run/alchemy/issues/1405 [<samp>(90185)</samp>](https://github.com/alchemy-run/alchemy/commit/901859886)
  - **email**: Unblock the Email suite on scope-limited credentials &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1408 [<samp>(e1b01)</samp>](https://github.com/alchemy-run/alchemy/commit/e1b016c90)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.75...HEAD)

---

## v2.0.0-beta.75

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **aws**:
  - **apprunner**: Reap the service's auto-created log groups on delete &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1327 [<samp>(19ab3)</samp>](https://github.com/alchemy-run/alchemy/commit/19ab37cee)
- **aws,cloudflare,website**:
  - AWS + Cloudflare frontend parity on one flat props vocabulary &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1353 [<samp>(cf3e5)</samp>](https://github.com/alchemy-run/alchemy/commit/cf3e53ada)
- **bundle**:
  - Support bun and pnpm isolated installs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1324 [<samp>(99154)</samp>](https://github.com/alchemy-run/alchemy/commit/9915412db)
- **deps**:
  - Update to effect 4.0.0-rc.111 &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1318 [<samp>(6ff7b)</samp>](https://github.com/alchemy-run/alchemy/commit/6ff7b8b67)

### &nbsp;&nbsp;&nbsp;🚀 Features

- Add first-class Vocs website support &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1278 [<samp>(9f7fb)</samp>](https://github.com/alchemy-run/alchemy/commit/9f7fb7696)
- **aws**:
  - Dev HMR for AWS ECS, EC2 and MicrovVMs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1335 [<samp>(7cfaa)</samp>](https://github.com/alchemy-run/alchemy/commit/7cfaa1563)
  - **cognito**: Email OTP sign-in policy, CustomEmailSender and KMS key on UserPool &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1323 [<samp>(08642)</samp>](https://github.com/alchemy-run/alchemy/commit/08642fa58)
  - **lambda**: Docker Functions &nbsp;-&nbsp; by **Simon Westerlund** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1077 [<samp>(20862)</samp>](https://github.com/alchemy-run/alchemy/commit/208623a25)
- **axiom**:
  - Support dataset edge deployments &nbsp;-&nbsp; by **Aman Varshney** in https://github.com/alchemy-run/alchemy/issues/1361 [<samp>(a9893)</samp>](https://github.com/alchemy-run/alchemy/commit/a9893b885)
- **cloudflare**:
  - **r2**: Enable the r2.dev managed domain on Bucket &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1329 [<samp>(59cb3)</samp>](https://github.com/alchemy-run/alchemy/commit/59cb34285)
  - **workers**: Add Email event source for inbound mail &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/401 [<samp>(3449c)</samp>](https://github.com/alchemy-run/alchemy/commit/3449cae8c)
- **fly,hetzner,railway,websites**:
  - Fly, Hetzner, and Railway framework sites &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1351 [<samp>(33f19)</samp>](https://github.com/alchemy-run/alchemy/commit/33f192403)
- **planetscale**:
  - Surface Metal SKUs on PostgresClusterSize &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1319 [<samp>(75fdb)</samp>](https://github.com/alchemy-run/alchemy/commit/75fdb0c44)
- **railway**:
  - Project, Service, Postgres, Redis, Bucket, and bindings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1295 [<samp>(85936)</samp>](https://github.com/alchemy-run/alchemy/commit/859369cfa)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Suite leaks, flakes, and live binding data-plane &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1406 [<samp>(1703d)</samp>](https://github.com/alchemy-run/alchemy/commit/1703d2ace)
- Upgrade to effect rc 112 &nbsp;-&nbsp; by **Sam Goodwin** [<samp>(ba579)</samp>](https://github.com/alchemy-run/alchemy/commit/ba579a98e)
- **aws**:
  - Endpoint.none to avoid deadlock &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1252 [<samp>(e40c9)</samp>](https://github.com/alchemy-run/alchemy/commit/e40c94760)
- **bundle**:
  - Preserve namespace initialization with Rolldown 1.2.5 &nbsp;-&nbsp; by **Saatvik Arya** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1316 [<samp>(83dc6)</samp>](https://github.com/alchemy-run/alchemy/commit/83dc6c3a2)
- **cloudflare**:
  - Reuse unchanged container image digests &nbsp;-&nbsp; by **Dan van der Merwe** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1282 [<samp>(49c27)</samp>](https://github.com/alchemy-run/alchemy/commit/49c27bee7)
  - Containers reach loopback host DBs from Linux dev containers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1366 [<samp>(8c7bb)</samp>](https://github.com/alchemy-run/alchemy/commit/8c7bb6e04)
  - **containers**:
    - Bind a container's DO namespace and script metadata under one sid &nbsp;-&nbsp; by **Damjan Znidarsic** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1271 [<samp>(040ce)</samp>](https://github.com/alchemy-run/alchemy/commit/040ce2aa2)
    - Reach host services from dev containers, downgrade https on container ports &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1344 [<samp>(9c593)</samp>](https://github.com/alchemy-run/alchemy/commit/9c593d38a)
    - Fail the dev container image build when docker does &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1377 [<samp>(6ffc7)</samp>](https://github.com/alchemy-run/alchemy/commit/6ffc7b7eb)
  - **email**:
    - Retry rule writes while a fresh Worker propagates &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1349 [<samp>(089d1)</samp>](https://github.com/alchemy-run/alchemy/commit/089d17e51)
  - **foldkit**:
    - Upgrade foldkit and add a SSR Foldkit example &nbsp;-&nbsp; by **Filip Falcon** in https://github.com/alchemy-run/alchemy/issues/1314 [<samp>(beb50)</samp>](https://github.com/alchemy-run/alchemy/commit/beb5012cb)
  - **r2**:
    - Register catalog credential first &nbsp;-&nbsp; by **Dillon Mulroy** in https://github.com/alchemy-run/alchemy/issues/1338 [<samp>(869ca)</samp>](https://github.com/alchemy-run/alchemy/commit/869ca84a8)
- **config**:
  - Prefer process environment over dotenv defaults &nbsp;-&nbsp; by **Saatvik Arya** in https://github.com/alchemy-run/alchemy/issues/1355 [<samp>(58c7f)</samp>](https://github.com/alchemy-run/alchemy/commit/58c7f185b)
- **dev**:
  - Route binding clients to the bound resource's data plane &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1308 [<samp>(4c02b)</samp>](https://github.com/alchemy-run/alchemy/commit/4c02b1fae)
- **docker**:
  - Container report assigned host ports, support extra hosts, stop disconnecting foreign networks &nbsp;-&nbsp; by **Michael K** in https://github.com/alchemy-run/alchemy/issues/1398 [<samp>(ffb42)</samp>](https://github.com/alchemy-run/alchemy/commit/ffb42999c)
- **fly**:
  - Unresolvable Postgres direct URI, dead code-change detection, in-network example migrations &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1320 [<samp>(a43d7)</samp>](https://github.com/alchemy-run/alchemy/commit/a43d7e8df)
- **fly,examples**:
  - Unflake the fly-postgres and cloudflare-worker example tests &nbsp;-&nbsp; by **Sam Goodwin** and **Cursor** in https://github.com/alchemy-run/alchemy/issues/1309 [<samp>(34b58)</samp>](https://github.com/alchemy-run/alchemy/commit/34b58ccbf)
- **frontend-frameworks**:
  - Support @sveltejs/kit@3.0.0-next.21+ config shape &nbsp;-&nbsp; by **Cameron McEvenue** in https://github.com/alchemy-run/alchemy/issues/1347 [<samp>(f91f2)</samp>](https://github.com/alchemy-run/alchemy/commit/f91f29a71)
- **kubernetes**:
  - Exclude Helm lifecycle hooks from HelmChart's managed objects &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1322 [<samp>(bb3ee)</samp>](https://github.com/alchemy-run/alchemy/commit/bb3eed9c1)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.74...HEAD)

---

## v2.0.0-beta.74

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **alchemy**: Declare @alchemy.run/frontend-frameworks as an optional peer dependency &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1303 [<samp>(932d0)</samp>](https://github.com/alchemy-run/alchemy/commit/932d03cc2)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.73...HEAD)

---

## v2.0.0-beta.73

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **aws**: Web framework interface parity Cloudflare Websites &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Fable 5** in https://github.com/alchemy-run/alchemy/issues/1158 [<samp>(579aa)</samp>](https://github.com/alchemy-run/alchemy/commit/579aa331a)
- **cloudflare**: Protect Workers with Access &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1228 [<samp>(67022)</samp>](https://github.com/alchemy-run/alchemy/commit/67022d69a)
- **deps**: Update to effect 4.0.0-rc.110 &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1245 [<samp>(1596e)</samp>](https://github.com/alchemy-run/alchemy/commit/1596e503b)
- **engine**: Persist removalPolicy on the noop path &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1253 [<samp>(37178)</samp>](https://github.com/alchemy-run/alchemy/commit/371784e64)
- **sql**: One Alchemy-owned migration format with one-way conversion from drizzle/prisma/wrangler &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1226 [<samp>(6e7fa)</samp>](https://github.com/alchemy-run/alchemy/commit/6e7fa35a3)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **RDS**:
  - Support parameters on DBParameterGroup &nbsp;-&nbsp; by **Jordan** in https://github.com/alchemy-run/alchemy/issues/1205 [<samp>(b5012)</samp>](https://github.com/alchemy-run/alchemy/commit/b50125feb)
- **aws**:
  - Local dev with floci &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Fable 5** in https://github.com/alchemy-run/alchemy/issues/1154 [<samp>(1182f)</samp>](https://github.com/alchemy-run/alchemy/commit/1182f9b89)
  - Local dev improvements + patch floci to pass alchemy test suites &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1250 [<samp>(d4cec)</samp>](https://github.com/alchemy-run/alchemy/commit/d4cec4ad3)
  - **dynamodb**:
    - Support multi-attribute GSI keys &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1216 [<samp>(264de)</samp>](https://github.com/alchemy-run/alchemy/commit/264de8d85)
  - **ecs**:
    - Local dec and HMR for ECS.Task and Service &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Fable 5** in https://github.com/alchemy-run/alchemy/issues/1185 [<samp>(d38e8)</samp>](https://github.com/alchemy-run/alchemy/commit/d38e8a165)
  - **website**:
    - Web frameworks on AWS &nbsp;-&nbsp; by **Sam Goodwin** and **Claude Fable 5** in https://github.com/alchemy-run/alchemy/issues/1140 [<samp>(c8a84)</samp>](https://github.com/alchemy-run/alchemy/commit/c8a8405b4)
    - Route dev sites through an emulated CloudFront &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1283 [<samp>(a5b59)</samp>](https://github.com/alchemy-run/alchemy/commit/a5b593bdc)
- **cli**:
  - **nuke**: --local mode to clear locally emulated resources &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1287 [<samp>(6d641)</samp>](https://github.com/alchemy-run/alchemy/commit/6d6419bef)
- **cloudflare**:
  - Bind Pipelines streams and legacy pipelines to Workers &nbsp;-&nbsp; by **Damjan Znidarsic** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1176 [<samp>(f02b6)</samp>](https://github.com/alchemy-run/alchemy/commit/f02b68000)
  - **dns**: Support structured record data &nbsp;-&nbsp; by **Saatvik Arya** in https://github.com/alchemy-run/alchemy/issues/1257 [<samp>(8cc17)</samp>](https://github.com/alchemy-run/alchemy/commit/8cc1757a3)
  - **website**: Foldkit resource &nbsp;-&nbsp; by **Filip Falcon** in https://github.com/alchemy-run/alchemy/issues/1120 [<samp>(9d3fc)</samp>](https://github.com/alchemy-run/alchemy/commit/9d3fc84b7)
  - **workflows**: Add per-workflow step limits &nbsp;-&nbsp; by **Filip Falcon** in https://github.com/alchemy-run/alchemy/issues/816 [<samp>(a4b87)</samp>](https://github.com/alchemy-run/alchemy/commit/a4b875e50)
- **fly**:
  - Machine, Service, Sprite, Postgres, Redis, Tigris, Secret, SecretKey &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1261 [<samp>(252b2)</samp>](https://github.com/alchemy-run/alchemy/commit/252b2e168)
- **hetzner**:
  - Cloud resources, Service platform, and Bindings &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1258 [<samp>(bf8de)</samp>](https://github.com/alchemy-run/alchemy/commit/bf8debd51)
  - **server**: Compose custom init scripts with the alchemy bootstrap &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1289 [<samp>(062d3)</samp>](https://github.com/alchemy-run/alchemy/commit/062d3ae97)
- **prisma**:
  - Object storage (resources + bindings), locked Postgres state backend, Deployment.redeployOn &nbsp;-&nbsp; by **Will Madden** in https://github.com/alchemy-run/alchemy/issues/1061 [<samp>(9d90b)</samp>](https://github.com/alchemy-run/alchemy/commit/9d90b5452)
- **website**:
  - Deploy PR previews as worker versions &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1267 [<samp>(5f0db)</samp>](https://github.com/alchemy-run/alchemy/commit/5f0db9f9a)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- Better platform runtime detection and error messages &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1197 [<samp>(db3d4)</samp>](https://github.com/alchemy-run/alchemy/commit/db3d45460)
- **alchemy**:
  - Move @effect/vitest to devDependencies &nbsp;-&nbsp; by **Kristof Siket** in https://github.com/alchemy-run/alchemy/issues/1191 [<samp>(17006)</samp>](https://github.com/alchemy-run/alchemy/commit/1700698be)
- **astro**:
  - Forward prerender environment &nbsp;-&nbsp; by **Maxwell Brown** in https://github.com/alchemy-run/alchemy/issues/1242 [<samp>(6b738)</samp>](https://github.com/alchemy-run/alchemy/commit/6b73819a0)
- **aws**:
  - Fully local `alchemy dev` for ECS + event-source glue; dev/integ tests for ECS and website examples &nbsp;-&nbsp; by **Sam Goodwin** and **Cursor** in https://github.com/alchemy-run/alchemy/issues/1210 [<samp>(fb8ca)</samp>](https://github.com/alchemy-run/alchemy/commit/fb8ca1dc3)
- **bundle**:
  - Make zipCode archives deterministic &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1211 [<samp>(7c4ec)</samp>](https://github.com/alchemy-run/alchemy/commit/7c4ecec45)
- **cli**:
  - Never suggest a downgrade in the version check &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1116 [<samp>(98b50)</samp>](https://github.com/alchemy-run/alchemy/commit/98b50ecf8)
  - Honor STAGE environment variable &nbsp;-&nbsp; by **Seth Carlton** in https://github.com/alchemy-run/alchemy/issues/1244 [<samp>(95000)</samp>](https://github.com/alchemy-run/alchemy/commit/950005a7d)
  - Keep alchemy dev alive when the stack module fails to load &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1259 [<samp>(00c26)</samp>](https://github.com/alchemy-run/alchemy/commit/00c2650bc)
- **cloudflare**:
  - Type circular Worker layers &nbsp;-&nbsp; by **Patrik Duksin** in https://github.com/alchemy-run/alchemy/issues/1199 [<samp>(2d17b)</samp>](https://github.com/alchemy-run/alchemy/commit/2d17b265b)
  - Pin Worker.domain zoneId and paginate listZones &nbsp;-&nbsp; by **Ben Snyder** in https://github.com/alchemy-run/alchemy/issues/1241 [<samp>(92660)</samp>](https://github.com/alchemy-run/alchemy/commit/926605c55)
  - Support assets in worker versions &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1266 [<samp>(8829a)</samp>](https://github.com/alchemy-run/alchemy/commit/8829a3d26)
  - **containers**: Env vars and SQL database connections in Cloudflare.Container &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1277 [<samp>(75f5b)</samp>](https://github.com/alchemy-run/alchemy/commit/75f5bf8a5)
  - **dns**: Disambiguate DNS record adoption by content/priority &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1264 [<samp>(f5d17)</samp>](https://github.com/alchemy-run/alchemy/commit/f5d17e8f8)
  - **workers**: Converge nested yielded-resource env plans &nbsp;-&nbsp; by **Odysseas Papadimas** in https://github.com/alchemy-run/alchemy/issues/1273 [<samp>(85991)</samp>](https://github.com/alchemy-run/alchemy/commit/859916002)
- **cloudflare-runtime**:
  - Drop vulnerable extract-zip and libvips deps &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1255 [<samp>(b4d9b)</samp>](https://github.com/alchemy-run/alchemy/commit/b4d9b7fe8)
- **lambda**:
  - Preserve installed package archive metadata &nbsp;-&nbsp; by **Joaquín Pérez** in https://github.com/alchemy-run/alchemy/issues/855 [<samp>(7b12f)</samp>](https://github.com/alchemy-run/alchemy/commit/7b12f5800)
- **platform**:
  - Name the missing layer when a tagged resource is yielded without its impl &nbsp;-&nbsp; by **apostoli** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1055 [<samp>(8c458)</samp>](https://github.com/alchemy-run/alchemy/commit/8c458c871)
- **release**:
  - Keep validator logs out of GITHUB_OUTPUT &nbsp;-&nbsp; by **Rahul Mishra** and **Claude Fable 5** in https://github.com/alchemy-run/alchemy/issues/1301 [<samp>(c84f5)</samp>](https://github.com/alchemy-run/alchemy/commit/c84f548a7)
  - Fetch distilled submodule in the Publish job &nbsp;-&nbsp; by **Rahul Mishra** and **Claude Fable 5** in https://github.com/alchemy-run/alchemy/issues/1302 [<samp>(39241)</samp>](https://github.com/alchemy-run/alchemy/commit/3924145ac)
- **runtime**:
  - Store unambiguous env strings bare instead of JSON-packing them &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1254 [<samp>(92db7)</samp>](https://github.com/alchemy-run/alchemy/commit/92db797eb)
- **test**:
  - Harden full-suite flakes — reconnect broken RPC sidecar sessions, right-size load-sensitive budgets &nbsp;-&nbsp; by **Sam Goodwin** and **Cursor** [<samp>(9d63f)</samp>](https://github.com/alchemy-run/alchemy/commit/9d63fde53)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.72...HEAD)

---

## v2.0.0-beta.72

*No significant changes*

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.71...HEAD)

---

## v2.0.0-beta.71

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **cloudflare**: Assets-first dev routing, asset MIME/hash fixes; SPA/static/dev-mode test coverage &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1121 [<samp>(e63fe)</samp>](https://github.com/alchemy-run/alchemy/commit/e63fea1f9)
- **deps**: Upgrade to effect 4.0.0-beta.105 &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1132 [<samp>(6bbad)</samp>](https://github.com/alchemy-run/alchemy/commit/6bbadc1b8)
- **drizzle**: Subpath-only MySQL/Postgres/DurableObject; defer optional driver imports &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1119 [<samp>(b3800)</samp>](https://github.com/alchemy-run/alchemy/commit/b3800e338)

### &nbsp;&nbsp;&nbsp;🚀 Features

- Integrate Cloudflare tooling packages &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1122 [<samp>(1b7ad)</samp>](https://github.com/alchemy-run/alchemy/commit/1b7ad6c12)
- **better-auth**: Effectful wrapper + a database layer per platform &nbsp;-&nbsp; by **sam** and **Claude Fable 5** in https://github.com/alchemy-run/alchemy/issues/1157 [<samp>(7a73b)</samp>](https://github.com/alchemy-run/alchemy/commit/7a73bbe9f)
- **website**: Cache incremental Astro builds &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1128 [<samp>(98641)</samp>](https://github.com/alchemy-run/alchemy/commit/986412a08)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **aws**:
  - Avoid name collisions with Resource Groups, S3 Tables and S3 Vectors &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1186 [<samp>(6eefd)</samp>](https://github.com/alchemy-run/alchemy/commit/6eefd51d1)
  - **ec2**: Ride out lingering public-IP ENIs on InternetGateway detach &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1125 [<samp>(c534c)</samp>](https://github.com/alchemy-run/alchemy/commit/c534c8da9)
- **cloudflare**:
  - Queue consumers on Website.Vite workers in alchemy dev &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1113 [<samp>(fd2c8)</samp>](https://github.com/alchemy-run/alchemy/commit/fd2c8879a)
  - Child-process framework builds; Alchemy.remote() stale preview sessions &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1139 [<samp>(3fb98)</samp>](https://github.com/alchemy-run/alchemy/commit/3fb98ada2)
  - Allow Worker Props to be an Effect &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1172 [<samp>(e6f65)</samp>](https://github.com/alchemy-run/alchemy/commit/e6f655f56)
  - **queues**:
    - Map consumer settings to the local broker's field names &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1126 [<samp>(8d0ce)</samp>](https://github.com/alchemy-run/alchemy/commit/8d0ce935d)
    - Recover queue/consumer wiring wedged by pre-stamping dev runs &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1133 [<samp>(97c34)</samp>](https://github.com/alchemy-run/alchemy/commit/97c34c196)
  - **website**:
    - Set NODE_ENV for vite build and update all examples to test plugins &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1178 [<samp>(0a443)</samp>](https://github.com/alchemy-run/alchemy/commit/0a44303ef)
- **deps**:
  - Unblock npm-driven builds and patch drizzle-orm for effect beta.105 &nbsp;-&nbsp; by **sam** and **Cursor** [<samp>(ba705)</samp>](https://github.com/alchemy-run/alchemy/commit/ba705bede)
- **dev**:
  - Configured dev ports must not cascade on restart or be IPv6-shadowed on localhost &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1129 [<samp>(03a06)</samp>](https://github.com/alchemy-run/alchemy/commit/03a066728)
- **docker**:
  - Pass environment values to the container create child process &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1118 [<samp>(0cdde)</samp>](https://github.com/alchemy-run/alchemy/commit/0cdde8575)
- **engine**:
  - Alchemy dev leaked resources deployed before beta.66 &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1110 [<samp>(ef79d)</samp>](https://github.com/alchemy-run/alchemy/commit/ef79dfda4)
  - Route legacy dev:-marker state rows to the local provider &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1130 [<samp>(f12b8)</samp>](https://github.com/alchemy-run/alchemy/commit/f12b834a2)
- **test**:
  - Durable file-namespaced scratch state so interrupted destroys resume &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1164 [<samp>(1904f)</samp>](https://github.com/alchemy-run/alchemy/commit/1904f8a57)

### &nbsp;&nbsp;&nbsp;🏎 Performance

- **tsconfig**: Fix IDE language-server hangs &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1179 [<samp>(b9fc7)</samp>](https://github.com/alchemy-run/alchemy/commit/b9fc7d2db)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.70...HEAD)

---

## v2.0.0-beta.70

*No significant changes*

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.69...HEAD)

---

## v2.0.0-beta.69

### &nbsp;&nbsp;&nbsp;🚀 Features

- **engine**: RenamedFrom() — migrate state rows across FQN renames &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1108 [<samp>(abf3f)</samp>](https://github.com/alchemy-run/alchemy/commit/abf3fdfe)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **ci**: Bump actions pin — dist-tag moves now survive OIDC-only auth &nbsp;-&nbsp; by **sam** and **Cursor** in https://github.com/alchemy-run/alchemy/issues/1115 [<samp>(f94b7)</samp>](https://github.com/alchemy-run/alchemy/commit/f94b731c)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.68...HEAD)

---

## v2.0.0-beta.68

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **cloudflare**:
  - **website**: Stop StaticSite duplicating env resources into its namespace &nbsp;-&nbsp; by **apostoli** in https://github.com/alchemy-run/alchemy/issues/1053 [<samp>(4798c)</samp>](https://github.com/alchemy-run/alchemy/commit/4798cd91)

### &nbsp;&nbsp;&nbsp;🚀 Features

- Migrate to distilled v1 &nbsp;-&nbsp; by **Michael K** and **sam** in https://github.com/alchemy-run/alchemy/issues/823 [<samp>(73d7d)</samp>](https://github.com/alchemy-run/alchemy/commit/73d7de6e)
- **aws**:
  - **lambda**: Add declarative function versions &nbsp;-&nbsp; by **Saatvik Arya** in https://github.com/alchemy-run/alchemy/issues/993 [<samp>(a81bb)</samp>](https://github.com/alchemy-run/alchemy/commit/a81bba6b)
  - **ses**: SESv2 coverage — identity policies, contacts, tenants, dedicated IPs, account settings &nbsp;-&nbsp; by **Saatvik Arya** in https://github.com/alchemy-run/alchemy/issues/976 [<samp>(a5176)</samp>](https://github.com/alchemy-run/alchemy/commit/a5176376)
- **binding**:
  - Pulumi-style data-sources and ec2.GetAmi as first use-case &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1037 [<samp>(07909)</samp>](https://github.com/alchemy-run/alchemy/commit/07909245)
- **cli**:
  - Add bulk state read via `alchemy state export` &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1043 [<samp>(bc039)</samp>](https://github.com/alchemy-run/alchemy/commit/bc039b18)
- **cloudflare**:
  - Local emulation for alchemy dev — cron, secrets, email, browser, images, stream, tails &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1039 [<samp>(f57bc)</samp>](https://github.com/alchemy-run/alchemy/commit/f57bc58c)
  - Alchemy.remote() for worker-only bindings, drop dev.remote props &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1065 [<samp>(d58a4)</samp>](https://github.com/alchemy-run/alchemy/commit/d58a4e22)
  - Run vite dev servers in child processes &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1076 [<samp>(86158)</samp>](https://github.com/alchemy-run/alchemy/commit/861589fd)
  - **access**:
    - Support managed OAuth applications &nbsp;-&nbsp; by **Magoz** in https://github.com/alchemy-run/alchemy/issues/1023 [<samp>(acfba)</samp>](https://github.com/alchemy-run/alchemy/commit/acfba3aa)
    - Typed per-provider IdP configs, zone scope, SAML cert sets &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1002 [<samp>(5e3b8)</samp>](https://github.com/alchemy-run/alchemy/commit/5e3b8a06)
  - **vpc**:
    - Bind VPC services to Workers &nbsp;-&nbsp; by **Filip Falcon** and **sam** in https://github.com/alchemy-run/alchemy/issues/821 [<samp>(95e4b)</samp>](https://github.com/alchemy-run/alchemy/commit/95e4b15d)
  - **website**:
    - Waku, Astro, SvelteKit, Nuxt resources &nbsp;-&nbsp; by **sam**, **Rahul Mishra**, **John Royal** and **Claude** in https://github.com/alchemy-run/alchemy/issues/1086 [<samp>(7125b)</samp>](https://github.com/alchemy-run/alchemy/commit/7125b54b)
    - Website.Nextjs resource &nbsp;-&nbsp; by **John Royal** and **sam** in https://github.com/alchemy-run/alchemy/issues/923 [<samp>(80cd7)</samp>](https://github.com/alchemy-run/alchemy/commit/80cd726c)
    - Octane resource — deploy OctaneJS fullstack apps &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1093 [<samp>(f5631)</samp>](https://github.com/alchemy-run/alchemy/commit/f5631591)
  - **workers**:
    - WorkerEntrypoint bindings — named entrypoints + ctx.props &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1097 [<samp>(8c857)</samp>](https://github.com/alchemy-run/alchemy/commit/8c8576f2)
- **drizzle**:
  - Drizzle.DurableObject helper for migrations and bundle .sql imports as text modules &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1031 [<samp>(0110f)</samp>](https://github.com/alchemy-run/alchemy/commit/0110f4a8)
- **kubernetes**:
  - Cluster-agnostic Kubernetes workloads &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/986 [<samp>(57286)</samp>](https://github.com/alchemy-run/alchemy/commit/57286a42)
- **sql**:
  - **mysql**: SQL.MySQL and Drizzle.MySQL runtime clients &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1063 [<samp>(5ae3d)</samp>](https://github.com/alchemy-run/alchemy/commit/5ae3df20)
- **test**:
  - Run dev-mode tests under the real alchemy dev sidecar topology &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1010 [<samp>(70ebd)</samp>](https://github.com/alchemy-run/alchemy/commit/70ebd99b)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **aws**:
  - Repair AWS utility subpath exports &nbsp;-&nbsp; by **Saatvik Arya** in https://github.com/alchemy-run/alchemy/issues/1033 [<samp>(d1c07)</samp>](https://github.com/alchemy-run/alchemy/commit/d1c07cdd)
  - **ec2**: Hosted instance bootstrap, planning, and replacement fixes &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1029 [<samp>(e35c6)</samp>](https://github.com/alchemy-run/alchemy/commit/e35c6c6d)
- **bundle**:
  - Build.pure is now opt-in for any package outside whitelist &nbsp;-&nbsp; by **Daniel Gangl** and **sam** in https://github.com/alchemy-run/alchemy/issues/1021 [<samp>(78e72)</samp>](https://github.com/alchemy-run/alchemy/commit/78e720ed)
- **cloudflare**:
  - Allocate ephemeral Vite child ports &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1090 [<samp>(a3d78)</samp>](https://github.com/alchemy-run/alchemy/commit/a3d7824f)
  - Isolate builds from transient cwd races; parallelize Website tests &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1102 [<samp>(688ea)</samp>](https://github.com/alchemy-run/alchemy/commit/688eaf54)
  - **access**:
    - Adopt IdentityProvider with empty display name + getIdentityProvider data source &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1099 [<samp>(00bf7)</samp>](https://github.com/alchemy-run/alchemy/commit/00bf7846)
  - **email**:
    - Opt send_email into live sends via Alchemy.remote() &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1064 [<samp>(6e149)</samp>](https://github.com/alchemy-run/alchemy/commit/6e149b20)
  - **vite**:
    - Hash the real root when `rootDir` is relative &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1079 [<samp>(7cb41)</samp>](https://github.com/alchemy-run/alchemy/commit/7cb4130d)
  - **website**:
    - Pass a string assets hash from StaticSite &nbsp;-&nbsp; by **apostoli** and **sam** in https://github.com/alchemy-run/alchemy/issues/1057 [<samp>(8436f)</samp>](https://github.com/alchemy-run/alchemy/commit/8436fb82)
  - **worker**:
    - Hash the assets directory during plan diff &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1045 [<samp>(6ac20)</samp>](https://github.com/alchemy-run/alchemy/commit/6ac200f2)
  - **workers**:
    - Apply Vite base to the assets manifest &nbsp;-&nbsp; by **sam** and **Abdullahi Mohamed** in https://github.com/alchemy-run/alchemy/issues/1048 [<samp>(1b143)</samp>](https://github.com/alchemy-run/alchemy/commit/1b143c9e)
    - Tolerate an unresolved Output `main` in getCompatibility &nbsp;-&nbsp; by **apostoli** and **sam** in https://github.com/alchemy-run/alchemy/issues/1050 [<samp>(1d1e6)</samp>](https://github.com/alchemy-run/alchemy/commit/1d1e66fb)
- **core**:
  - Whole-resource refs resolve fresh upstream attrs at apply &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1068 [<samp>(065f2)</samp>](https://github.com/alchemy-run/alchemy/commit/065f2112)
  - Re-resolve whole-resource binding payloads at apply &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1070 [<samp>(9beee)</samp>](https://github.com/alchemy-run/alchemy/commit/9beee721)
  - Infinite recursion on cyclic props and class-instance flattening in the engine's prop walkers &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1094 [<samp>(afe91)</samp>](https://github.com/alchemy-run/alchemy/commit/afe91661)
- **deps**:
  - Move pg, mysql2, mongodb to optional peer dependencies &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1069 [<samp>(88038)</samp>](https://github.com/alchemy-run/alchemy/commit/880380bb)
  - Move @vercel/nft to optional peer dependencies &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1071 [<samp>(1c04d)</samp>](https://github.com/alchemy-run/alchemy/commit/1c04d069)
- **engine**:
  - Interrupted first deploy no longer bricks later plans with SchemaError &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1005 [<samp>(77727)</samp>](https://github.com/alchemy-run/alchemy/commit/77727700)
- **http**:
  - Preserve Effect error responses &nbsp;-&nbsp; by **Patrik Duksin** in https://github.com/alchemy-run/alchemy/issues/1011 [<samp>(acebf)</samp>](https://github.com/alchemy-run/alchemy/commit/acebf64e)
- **kubernetes**:
  - Parse OCI Helm chart output &nbsp;-&nbsp; by **Andy Jefferson** in https://github.com/alchemy-run/alchemy/issues/1042 [<samp>(5fe04)</samp>](https://github.com/alchemy-run/alchemy/commit/5fe046b2)
- **lambda**:
  - Pin external installs from lockfiles &nbsp;-&nbsp; by **Joaquín Pérez** and **sam** in https://github.com/alchemy-run/alchemy/issues/858 [<samp>(9984a)</samp>](https://github.com/alchemy-run/alchemy/commit/9984a016)
- **planetscale**:
  - Split same-line statement-breakpoint markers &nbsp;-&nbsp; by **BEEIRL** in https://github.com/alchemy-run/alchemy/issues/1062 [<samp>(bfa6e)</samp>](https://github.com/alchemy-run/alchemy/commit/bfa6eb24)
- **state**:
  - Invalidate LocalState directory cache on deleteStack &nbsp;-&nbsp; by **sam** in https://github.com/alchemy-run/alchemy/issues/1072 [<samp>(9f52c)</samp>](https://github.com/alchemy-run/alchemy/commit/9f52c379)
- **website**:
  - Use proper domain object and redirects &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1088 [<samp>(2ef25)</samp>](https://github.com/alchemy-run/alchemy/commit/2ef25360)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.67...HEAD)

---

## v2.0.0-beta.67

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **cloudflare**:
  - Provide runtime for local D1 migrations &nbsp;-&nbsp; by **Patrik Duksin** in https://github.com/alchemy-run/alchemy/issues/1009 [<samp>(50017)</samp>](https://github.com/alchemy-run/alchemy/commit/5001713c)
  - Match existing DNS record with relative records too &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/1017 [<samp>(06c02)</samp>](https://github.com/alchemy-run/alchemy/commit/06c02536)
- **prisma**:
  - Align provider with management api &nbsp;-&nbsp; by **Aman Varshney** in https://github.com/alchemy-run/alchemy/issues/1012 [<samp>(914dd)</samp>](https://github.com/alchemy-run/alchemy/commit/914ddc3b)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.66...HEAD)

---

## v2.0.0-beta.66

### &nbsp;&nbsp;&nbsp;🚨 Breaking Changes

- **cloudflare**:
  - **workers**: WorkersDev + domain props; url/urls/domain outputs &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/977 [<samp>(33061)</samp>](https://github.com/alchemy-run/alchemy/commit/3306118d)

### &nbsp;&nbsp;&nbsp;🚀 Features

- **auth**:
  - Headless OAuth flow via hosted relay (Cloudflare + PlanetScale) &nbsp;-&nbsp; by **Rahul Mishra** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/962 [<samp>(62f2a)</samp>](https://github.com/alchemy-run/alchemy/commit/62f2a0d5)
- **aws**:
  - **bedrock**: Effect AI LanguageModel binding over the Converse API &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/919 [<samp>(64eb2)</samp>](https://github.com/alchemy-run/alchemy/commit/64eb282a)
  - **ecs**: EnvironmentFiles on the shared task-definition surface &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/904 [<samp>(d62e8)</samp>](https://github.com/alchemy-run/alchemy/commit/d62e8838)
  - **lambda**: Layer support &nbsp;-&nbsp; by **Saatvik Arya** in https://github.com/alchemy-run/alchemy/issues/971 [<samp>(6975e)</samp>](https://github.com/alchemy-run/alchemy/commit/6975e2e8)
  - **ses**: Email receiving — receipt rule sets, rules, IP filters, SendBounce &nbsp;-&nbsp; by **Saatvik Arya** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/939 [<samp>(76f6d)</samp>](https://github.com/alchemy-run/alchemy/commit/76f6db76)
- **cloudflare**:
  - Container-backed Durable Objects on async Workers &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/956 [<samp>(5fd9a)</samp>](https://github.com/alchemy-run/alchemy/commit/5fd9ac01)
  - Worker.URL — bind a Worker's own URL onto itself &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/964 [<samp>(ff3bd)</samp>](https://github.com/alchemy-run/alchemy/commit/ff3bd997)
  - Version.affinity sticky-session sugar for gradual deployments &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/985 [<samp>(77899)</samp>](https://github.com/alchemy-run/alchemy/commit/77899a58)
  - **email**:
    - Local send_email stub in dev with dev.remote opt-in &nbsp;-&nbsp; by **Zé Yuri**, **John Royal** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/865 [<samp>(eb702)</samp>](https://github.com/alchemy-run/alchemy/commit/eb70263d)
  - **workers**:
    - Assets-only Workers (no script) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/969 [<samp>(e922d)</samp>](https://github.com/alchemy-run/alchemy/commit/e922d342)
    - Class form without an impl (assets-only / external Workers) &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/970 [<samp>(4dc06)</samp>](https://github.com/alchemy-run/alchemy/commit/4dc0610f)
    - Worker versions and gradual deployments &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/948 [<samp>(48b20)</samp>](https://github.com/alchemy-run/alchemy/commit/48b20c49)
- **docker**:
  - Introduce docker swarm resources &nbsp;-&nbsp; by **Sergey Bekrin** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/972 [<samp>(1fd9b)</samp>](https://github.com/alchemy-run/alchemy/commit/1fd9bfcc)
- **engine**:
  - Aggregate delete failures during destroy instead of aborting &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/973 [<samp>(cd667)</samp>](https://github.com/alchemy-run/alchemy/commit/cd6671e2)
  - First-class local vs live provider modes &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/963 [<samp>(68fd7)</samp>](https://github.com/alchemy-run/alchemy/commit/68fd7901)
- **prisma**:
  - Add Prisma provider &nbsp;-&nbsp; by **Aman Varshney** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/416 [<samp>(92f9b)</samp>](https://github.com/alchemy-run/alchemy/commit/92f9b3a5)
- **telemetry**:
  - OpenTelemetry export across all runtimes via Effect's OTLP exporters &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/860 [<samp>(33ce5)</samp>](https://github.com/alchemy-run/alchemy/commit/33ce5f4f)

### &nbsp;&nbsp;&nbsp;🐞 Bug Fixes

- **auth**:
  - Update clack and pass cancel signal &nbsp;-&nbsp; by **Rahul Mishra** in https://github.com/alchemy-run/alchemy/issues/968 [<samp>(f998d)</samp>](https://github.com/alchemy-run/alchemy/commit/f998d999)
- **aws**:
  - Wait for ECS service eventual consistency &nbsp;-&nbsp; by **Samnan Rahee** in https://github.com/alchemy-run/alchemy/issues/945 [<samp>(9ff48)</samp>](https://github.com/alchemy-run/alchemy/commit/9ff48312)
  - **cloudfront**: Merge observed config into UpdateDistribution requests &nbsp;-&nbsp; by **Ben Weis** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/935 [<samp>(c1bb2)</samp>](https://github.com/alchemy-run/alchemy/commit/c1bb2bd3)
  - **ecs**: Attach taskRoleManagedPolicyArns in Service reconcile &nbsp;-&nbsp; by **Ben Weis** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/936 [<samp>(75812)</samp>](https://github.com/alchemy-run/alchemy/commit/7581253b)
- **bundle**:
  - Stop CLI startup from loading rolldown's native binding &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/955 [<samp>(75dcb)</samp>](https://github.com/alchemy-run/alchemy/commit/75dcbab6)
- **cli**:
  - Print the version-update warning before interactive prompts &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/959 [<samp>(fd05e)</samp>](https://github.com/alchemy-run/alchemy/commit/fd05e4f8)
- **cloudflare**:
  - Refresh OAuth credentials on expiry instead of caching forever &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/966 [<samp>(9d90e)</samp>](https://github.com/alchemy-run/alchemy/commit/9d90eeb4)
  - Default nodejs_compat for plain Workers, resolve Config/Output in StaticSite build env, relative vite.main &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/796 [<samp>(96fac)</samp>](https://github.com/alchemy-run/alchemy/commit/96fac368)
  - Vite build treats Container env bindings as Effects &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/999 [<samp>(10395)</samp>](https://github.com/alchemy-run/alchemy/commit/10395a99)
  - **queues**:
    - Local dev worker fails to start with a dead-letter queue &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/1000 [<samp>(4e980)</samp>](https://github.com/alchemy-run/alchemy/commit/4e9808e4)
  - **workers**:
    - Scope Worker read route discovery to known zones &nbsp;-&nbsp; by **Ben Snyder** in https://github.com/alchemy-run/alchemy/issues/944 [<samp>(b6141)</samp>](https://github.com/alchemy-run/alchemy/commit/b61411c7)
    - Encrypt Output env secrets and preserve inference &nbsp;-&nbsp; by **Seth Carlton** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/943 [<samp>(51b4b)</samp>](https://github.com/alchemy-run/alchemy/commit/51b4bf42)
    - Keep the previous dev worker instance serving until its replacement starts &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/863 [<samp>(9cb28)</samp>](https://github.com/alchemy-run/alchemy/commit/9cb28f35)
    - Cut Worker read API fan-out that trips 429/971 &nbsp;-&nbsp; by **John Royal** and **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/932 [<samp>(2e0b0)</samp>](https://github.com/alchemy-run/alchemy/commit/2e0b00c4)
    - Converge plans for unmanaged custom domains &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/975 [<samp>(f414e)</samp>](https://github.com/alchemy-run/alchemy/commit/f414e001)
- **planetscale**:
  - Stop false role replacement on metadata-only branch/database updates &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/957 [<samp>(0eb44)</samp>](https://github.com/alchemy-run/alchemy/commit/0eb4460b)
- **state**:
  - Destroy removes the persisted stack output instead of writing an empty husk &nbsp;-&nbsp; by **Sam Goodwin** in https://github.com/alchemy-run/alchemy/issues/965 [<samp>(663d4)</samp>](https://github.com/alchemy-run/alchemy/commit/663d4670)

##### &nbsp;&nbsp;&nbsp;&nbsp;[View changes on GitHub](https://github.com/alchemy-run/alchemy/compare/v2.0.0-beta.65...HEAD)

---

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
