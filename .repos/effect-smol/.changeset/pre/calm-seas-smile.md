---
"effect": patch
---

Align workflow tags with RPCs by changing `Workflow.make` to accept the tag as its first argument, exposing workflow tags as `_tag`, and supporting `class MyWorkflow extends Workflow.make(...) {}`.
