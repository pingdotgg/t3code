# t3work MVP

This folder describes `t3work`, an additive MVP for a project-oriented T3 Code shell.

The goal is to keep benefiting from active T3 Code development while adding a sibling
experience for non-developer and QA-oriented users. The shell should avoid broad edits
to the existing app and server. New behavior should live in additive packages and a
separate UI surface.

`t3work` is the product and namespace for the additive work-oriented layer. Package and
app names should make it obvious which code belongs to `t3work` and which code belongs
to the existing T3 Code runtime.

## Product Thesis

`t3work` is an **extensible work platform**: it turns the systems you already work in into
guided, AI-accelerated workspaces, and lets users extend it along two axes — **Sources**
(connect any back-end as a first-class data provider) and **Surfaces** (compose
role-specific pages and recipes for how you work). Atlassian/Jira and the QA profile are
the first Source and the first Surface, not the definition of the product. See the full
[Vision & Extensibility Model](./00-vision.md).

T3 Code should remain a local-first agent runtime with strong provider orchestration.
`t3work` adds a guided layer on top:

- users start from a project, not a blank chat
- projects can come from integrations such as Jira
- local workspaces can be managed automatically
- recipes suggest useful actions based on current context
- recipes are backed by skills
- skills produce rich, persistent artifacts, not only chat text
- external mutations use reviewable app-style UI before commit

## MVP Scope

The first MVP targets Atlassian/Jira-backed projects, but `t3work` is not a QA-only
product. QA is the first useful skill pack because Jira tickets, test plans, and review
flows are concrete MVP inputs. The broader product is a project-based agent workspace
for different kinds of work.

The user should be able to:

1. Choose a project source.
2. Complete agent runtime preflight by choosing or installing a default provider and model.
3. Connect Atlassian.
4. Pick a Jira project visible to their account.
5. Create a T3 project without choosing a local directory.
6. Browse Jira issues inside `t3work`.
7. Open a Jira issue and see context-relevant recipes.
8. Launch a recipe without writing a prompt.
9. Get a durable rich output, such as a QA test plan or risk board.
10. Review and optionally post a drafted Jira comment.

## Epic Documents

- [Vision & Extensibility Model](./00-vision.md)
- [Epic 01: Product Scope](./01-product-scope.md)
- [Epic 02: Additive Architecture](./02-additive-architecture.md)
- [Epic 03: Project Browser](./03-project-browser.md)
- [Epic 04: Integration Platform](./04-integration-platform.md)
- [Epic 05: Atlassian MVP](./05-atlassian-mvp.md)
- [Epic 06: Recipes And Skills](./06-recipes-and-skills.md)
- [Epic 07: Skill Tools And Mutations](./07-skill-tools-and-mutations.md)
- [Epic 08: Rich Artifacts](./08-rich-artifacts.md)
- [Epic 09: Delivery Plan](./09-delivery-plan.md)
- [Engineering Constitution](./10-engineering-constitution.md)
- [Epic 11: Atlassian Setup UI](./11-atlassian-setup-ui.md)
- [Epic 12: Profiles And Skill Packs](./12-profiles-and-skill-packs.md)
- [Epic 13: Resource References](./13-resource-references.md)
- [Epic 14: Native Provider Tool Injection](./14-native-provider-tool-injection.md)
- [Epic 15: Native Provider Tool Injection Additive Design](./15-native-provider-tool-injection-additive-design.md)
- [Epic 16: Action Recipes](./16-action-recipes.md)
- [Epic 17: Build-Time Localization Spike](./17-build-time-localization.md)
- [Epic 18: Integration Freshness Polling Plan](./18-integration-freshness-polling-plan.md)
- [Epic 19: Workspace Miniapps](./19-workspace-miniapps.md)
- [Epic 20: Embedded Chat And Agent Handoffs](./20-embedded-chat-and-handoffs.md)
- [Epic 21: Context Tool Catalog](./21-context-tool-catalog.md)
- [Epic 22: GitHub Pull Request Workspace](./22-github-pull-request-workspace.md)
- [Epic 23: Project Setup Preflight UI](./23-project-setup-preflight-ui.md)
- [Epic 24: Tiered Message Composition (proposal)](./24-tiered-message-composition.md)
- [Epic 25: Workflow Engine](./25-workflow-engine.md)
- [Epic 26: Knowledge Workbench](./26-knowledge-workbench.md)

## Supporting Docs

- [Concrete Example Flows](./supporting/concrete-example-flows.md)
- [Plan Recipes Skills Tools](./supporting/plan-recipes-skills-tools.md)
- [Provider Agnostic Features](./supporting/provider-agnostic-features.md)

## Non-Goals

- Do not fork T3 Code into a separate long-lived product.
- Do not build a full Jira replacement.
- Do not build a full Confluence replacement; the knowledge layer accelerates, it does not
  replicate.
- Do not require every project to have a Git repository.
- Do not silently create autonomous memory or recipes without user confirmation.
- Do not let skills mutate external systems without a reviewable UI.

## Success Criteria

The product MVP succeeds when non-technical users can start from a Jira project, pick a
ticket, choose a useful recipe, and receive a durable output without having to write a
good prompt.

The technical MVP succeeds when existing T3 behavior remains unchanged, all private T3
coupling is isolated behind one adapter package, and future integrations can reuse the
same project, resource, recipe, tool, artifact, and mutation models.
