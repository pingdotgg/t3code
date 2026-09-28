---
name: effect
description: Works with Effect TypeScript code using the source checkout as truth. Use when implementing, reviewing, or debugging Effect services, schemas, layers, or Effect-based tests.
---

# Effect

This repo uses Effect for typed, composable TypeScript services, schemas, and workflows.

## Source of truth

Use the current Effect source, not memory or older Effect v2/v3 examples.

1. If an Effect source checkout is missing, clone `https://github.com/Effect-TS/effect-smol` into a scratch references directory outside the skill folder. Do this in the project, not in the skill folder.
2. Search the checkout for exact APIs, examples, tests, and naming patterns before answering or implementing Effect-specific code.
3. Also inspect existing repo code for local house style before introducing new patterns.
4. Prefer answers and implementations backed by specific source files or nearby repo examples.

## Guidelines

- Prefer current Effect APIs and project-local patterns over old blog posts, examples, or package-memory guesses.
- Use `Effect.gen(function* () { ... })` for multi-step workflows.
- Use `Effect.fn("Name")` or `Effect.fnUntraced(...)` for named effects when adding reusable service methods or important workflows.
- Prefer Effect `Schema` for API and domain data shapes. Use branded schemas for IDs and `Schema.TaggedErrorClass` for typed domain errors when modeling new error surfaces.
- Keep HTTP handlers thin: decode input, read request context, call services, and map transport errors. Put business rules in services.
- In Effect service code, prefer Effect-aware platform abstractions and dependencies over ad hoc promises where the surrounding code already does so.
- Keep layer composition explicit. Avoid broad hidden provisioning that makes missing dependencies hard to see.
- In tests, prefer the repo's existing Effect test helpers and live tests for filesystem, git, child process, locks, or timing behavior.
- Do not introduce `any`, non-null assertions, unchecked casts, or older Effect APIs just to satisfy types.
- Do not answer from memory. Verify against the source checkout or nearby code first.

## Testing patterns

- Use the repo's existing Effect test helpers for tests that exercise Effect services, layers, runtime context, scoped resources, or platform integrations.
- Use live tests for filesystem, git repositories, HTTP servers, sockets, child processes, locks, real time, and other live platform behavior.
- For persisted deadlines and retries, verify that writers and workers use compatible clocks. Use a live clock when subprocesses supply wall-clock timestamps; with simulated time, keep fixture timestamps and clock advancement consistent. See the [test-clock scar](../../references/scars/full.md#test-clocks-and-durable-pr-monitoring).
- Run tests from package directories such as `packages/<name>`; never run package tests from the repo root.
- Prefer explicit test layers over ad hoc managed runtimes. Keep dependency provisioning visible in the test file.
- Use scoped fixtures and finalizers for resources that must be cleaned up, including temporary directories, flags, databases, fibers, servers, and global state.

Ported from [Hona/opencode](https://github.com/Hona/opencode/blob/main/.opencode/skills/effect/SKILL.md).
