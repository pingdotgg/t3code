# Capabilities and boundaries

## Current capability truth

Native T3 Dev is present. The Auldric Marketing capabilities in this spine are requirements under
active issues, not shipped features. See [current state](./00-current-state.md) before making product
or launch claims.

## Ownership boundary

| Area                                                                                                                               | Authority         |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Dev modes, prompts, agents, tools, providers, sessions, transport, shell, Git, terminal, preview, Connect, remote, CI, and release | T3                |
| Generic authentication, actors, devices, conversations, collaboration, Work, Loops, and Runs                                       | T3                |
| Marketing sources, evidence, Day 0, Marketing Strategy, GTM, artifacts, decisions, reviews, and approved briefs                    | Auldric Marketing |
| Outward identity and bounded distribution configuration                                                                            | #3 decision       |
| Public Auldric marketing/access surface                                                                                            | #27 decision      |

Marketing may consume only supported T3 seams. It may not rename, wrap, reinterpret, or replace
T3-owned capabilities. A missing generic seam is an upstream dependency. A Marketing failure fails
closed inside Marketing while Dev remains available.

## Data and action boundary

Marketing customer content resolves only through the authorized organization's canonical workspace
store. Evidence is bounded and provenance-bearing. Durable changes require explicit save/review
operations. An approved Marketing-to-Dev brief is non-executable until native T3 accepts it under
its own modes, permissions, plan, tools, and verification.
