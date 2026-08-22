# plugin runtime poc

this package compares three ways to implement the same small t3 plugin runtime contract.

## verdict

use a pure reconciliation planner with an effect scope executor.

that keeps cordis's best ideas:

- explicit required and provided capabilities
- dependency-first activation
- dependent-first teardown
- one owner for every effect and finalizer
- staged replacement with rollback
- restarting only the changed spatial subgraph

it also fits t3's existing effect runtime. adding cordis did not remove the need for a t3-specific planner, transaction model, contribution registry, or snapshot format.

## variants

| variant                 | source lines | new runtime dependency                              | result                                                             |
| ----------------------- | -----------: | --------------------------------------------------- | ------------------------------------------------------------------ |
| `effectScopeRuntime.ts` |          680 | none, effect is already used by t3                  | best base for production                                           |
| `cordisRuntime.ts`      |          557 | cordis rc.8 and about 300 kib of installed packages | works, but adds a second lifecycle runtime and the largest adapter |
| `pureRuntime.ts`        |          425 | none                                                | simplest planner, but manual finalizers are too easy to misuse     |

`cordisRuntime.ts` uses real cordis `Context`, `Fiber`, `inject`, `provide`, `effect`, and `isolate` behavior. it still needs its own graph analysis and differential reconciliation so unchanged fibers survive an update and failed candidates never replace the live composition.

cordis `4.0.0-rc.8` also ships extensionless declaration re-exports that do not resolve under this repository's esm settings. the poc has to describe the small public cordis surface it uses locally.

## behavior proved

all variants run the same contract suite. the full package currently has 85 tests. it checks:

- dependency-first activation from unordered manifests
- blocked plugins when required capabilities are missing
- dependent-first teardown
- lifo plugin finalizers
- no restart for unchanged plugin scopes or reordered dependency declarations
- targeted restart when versions, provided values, or activation implementations change
- transitive dependent restart without touching unrelated plugins
- preflight rejection for duplicate ids, duplicate capabilities, and dependency cycles
- immutable detached snapshots with prototype-safe plugin ids and contribution slots
- rollback that preserves both the active composition and the original activation error
- cleanup error reporting without rejecting an already committed replacement
- lifecycle events only for committed plugin compositions
- lifecycle observer failures cannot interrupt a committed transition
- plugin callbacks cannot deadlock the transition queue through reentrant runtime calls
- descendant async tasks may call the runtime after their originating callback settles
- synchronous callback microtasks are queued as external operations after the callback returns
- activation contexts reject late registrations after activation settles
- requested definition arrays are copied before serialized transitions wait
- deeply frozen public snapshots

the pure planner also proves a 20,000-plugin dependency chain without recursive stack overflow.

`manifest.ts` validates namespaced ids, semver 2.0.0 versions, versioned capabilities, permissions, surfaces, and declarative contributions. executable entry points are limited to server, web, and desktop and cannot escape the plugin directory through `..` segments. a mobile javascript entry point is rejected instead of silently ignored.

## illustrative timings

five runs used node `24.13.1`. each run activated a chain of 250 plugins, reconciled the same chain, then changed the root provider so all 250 plugins restarted. these are small local poc timings, not a production benchmark.

| variant         | activate 250 | unchanged reconcile | restart 250 |
| --------------- | -----------: | ------------------: | ----------: |
| effect scope    |      5.71 ms |             1.53 ms |     6.90 ms |
| direct cordis   |     94.75 ms |             1.32 ms |   321.76 ms |
| pure reconciler |      0.88 ms |             0.56 ms |     0.82 ms |

all three produced the same contributions before and after a provider upgrade.

## production shape suggested by the poc

1. extract the deterministic graph planner into a small internal module.
2. execute each active plugin in one child effect scope.
3. keep contributions in plugin-owned staging maps, then publish an immutable snapshot atomically.
4. on update, stage only changed plugins and their transitive dependents.
5. if staging fails, close candidate scopes and leave the live composition untouched.
6. after a successful swap, close old dependent scopes before provider scopes.
7. keep the first public contribution types declarative: commands, settings, integrations, and panels.

this package does not load untrusted packages, wire contributions into the real command palette, or provide a security sandbox. those belong after the runtime contract is accepted.

## run

```sh
vp test run packages/plugin-runtime-poc/src
vp run --filter @t3tools/plugin-runtime-poc typecheck
vp run --filter @t3tools/plugin-runtime-poc demo
```
