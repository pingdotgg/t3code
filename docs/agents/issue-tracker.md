# Issue tracker: GitHub

Issues, product specs, and implementation tickets for this repository live in GitHub Issues. Use the `gh` CLI from this clone so the fork is inferred from `origin`.

## Conventions

- Create a product spec or ticket with `gh issue create`.
- Read the full issue, labels, and comments before changing its state.
- Use native GitHub issue dependencies for blocking relationships when available.
- Apply the repository triage label that matches the engineering workflow role.
- Close an implementation ticket only after its acceptance behavior and validation notes are recorded.

## Pull requests as a triage surface

PRs as a request surface: no.

Pull requests implement already accepted work. Raw feature requests and bug reports enter through Issues.

## Publishing from an engineering skill

When an engineering skill says to publish to the issue tracker, create a GitHub issue in this fork.

When a skill says to fetch the relevant ticket, read the issue body, labels, dependencies, assignees, and comments.

## Wayfinding

A wayfinding map is one GitHub issue whose child issues hold individual decisions. Prefer native sub-issues and issue dependencies. If those features are unavailable, use an ordered task list in the map and a `Blocked by:` line in each child.
