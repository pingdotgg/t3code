---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Use the "tdd" skill where possible, at pre-agreed seams. Sequence the work per `~/.agents/skills/principle-sequence-verifiable-units/SKILL.md`.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use the "validate-change" skill on the work. If the change is user-visible UI, offer the "verify" skill after it.

Commit your work to the current branch.
