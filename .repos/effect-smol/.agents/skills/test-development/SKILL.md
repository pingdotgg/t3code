---
name: test-development
description: Test development. Use when adding or changing runtime Vitest coverage or Tstyche contracts for behavior, inference, assignability, or displayed public types.
---

Select every applicable branch before editing:

- **Runtime behavior:** Read [runtime.md](runtime.md).
- **Type contracts:** Read [types.md](types.md).

Some changes may require both branches. The task is complete when every
changed runtime behavior and type contract has focused coverage, targeted tests
pass, and applicable root checks pass or are reported as not runnable.
