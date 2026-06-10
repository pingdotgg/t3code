# Epic 01: Product Scope

> This epic scopes the **first shippable slice** (Jira/QA). For the product identity it is
> the first instance of — the extensible work platform and its two axes — see the
> [Vision & Extensibility Model](./00-vision.md).

## Problem

Non-developer users often do not know what to type into a blank AI chat. They know their
project, their ticket, and their current problem, but not how to translate that into an
effective prompt.

T3 Code already has useful local agent infrastructure. The MVP should add a guided
project layer that uses this infrastructure without turning the codebase into a fork.

## Goals

- Shift the first user decision from "which folder?" to "which project?"
- Let projects be created from structured integrations.
- Keep local workspaces as implementation detail where possible.
- Offer context-relevant recipes instead of a blank surface.
- Support non-technical profiles, especially QA and product-adjacent workflows.
- Persist generated work as project artifacts.
- Keep the existing T3 app/server mostly untouched.

## Primary User

The first target user is a QA or product-adjacent teammate who works from Jira tickets.

They need help with:

- understanding ticket intent
- finding missing information
- turning requirements into test plans
- drafting clear Jira comments
- summarizing risk
- producing artifacts they can revisit or share

## MVP User Journey

1. User opens `t3work`.
2. User chooses Atlassian as project source.
3. User chooses or installs a default agent provider and model if needed.
4. User connects Atlassian.
5. User chooses one Jira project from a structured list.
6. Shell creates a managed local workspace.
7. User sees project overview, recent tickets, and suggested recipes.
8. User opens a ticket.
9. Shell shows recipes relevant to that ticket type and project.
10. User launches a recipe.
11. Skill reads integration data through tools.
12. Skill saves a rich artifact.
13. User reviews the result and optionally posts a drafted Jira comment.

## Product Principles

- The shell should be helpful before the user types anything.
- Context should be chosen structurally, not described manually.
- Recipes should feel like app actions, not prompt snippets.
- Chat should remain available, but should not be the only interaction mode.
- External side effects should be explicit and reviewable.
- Durable artifacts should be first-class project outputs.

## Initial Profiles

### QA Assistant

- short, simple explanations
- testable claims
- risks and edge cases
- clear open questions
- practical test matrices

### Product Explainer

- explain intent in plain language
- identify ambiguity
- summarize stakeholder impact
- draft concise comments

### Developer Bridge

- translate non-technical concerns into implementation questions
- identify likely code areas only when available
- keep technical detail behind expandable sections

## Deferred Scope

- personal or company-wide recipe collections
- silent autonomous recipe creation
- autonomous project memory writes
- Confluence / knowledge workbench — planned as the first expansion beyond the MVP
  ([Epic 26](./26-knowledge-workbench.md))
- multi-integration dependency graphs
- full external workflow automation
- direct ticket editing beyond comments
