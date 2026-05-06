# 17 — AWS Well-Architected

Use the AWS Well-Architected Framework as a mandatory design and review lens for
every non-trivial change.

This starter is not AWS-only. Apply the principle behind each pillar and map it
to the stack in use (Render, Vercel, Convex, Neon, Doppler, Sentry, etc.)
instead of forcing AWS-specific services or implementation details.

Source: AWS Well-Architected Framework
<https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html>

## Operating rules

- In planning, name the impacted pillars and the intended tradeoffs
- In implementation, prefer small, reversible, observable changes
- In review, use a blame-free, lightweight conversation that surfaces risks and
  actions rather than turning the framework into a checklist-only audit
- Escalate or block changes that materially weaken a pillar without explicit
  justification and mitigation
- When pillars conflict, document the tradeoff in `docs/tasks/*.md` or PR text
- Treat this framework as additive to PDPL, security, testing, and deployment
  rules; it does not replace them

## General design principles

- Stop guessing capacity needs; prefer elastic or measurable sizing decisions
- Test systems at production scale when the risk justifies it
- Automate with experimentation and rollback in mind
- Prefer evolutionary architectures over hard-to-reverse one-way doors
- Drive architecture decisions using data, not intuition alone
- Improve through game days or other realistic failure exercises

## Pillar checklist

| Pillar                 | Required behavior in this repo                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operational excellence | Operations as code, clear ownership, runbooks/checklists for risky work, small reversible deploys, post-incident learning                                        |
| Security               | Least privilege, defense in depth, secret hygiene, auditability, encryption and data handling aligned with PDPL                                                  |
| Reliability            | Health checks, timeouts, retries with limits, idempotency where needed, graceful degradation, tested rollback or recovery path                                   |
| Performance efficiency | Measure before tuning, choose fit-for-purpose compute/storage patterns, control latency, caching, and high-cost queries                                          |
| Cost optimization      | Right-size environments and dependencies, remove waste, track expensive paths, justify always-on resources                                                       |
| Sustainability         | Minimize unnecessary compute, storage, and transfer; prefer retention limits, efficient defaults, and lower-footprint architectures that still meet requirements |

## What to require during creation

- Operational excellence: the change can be deployed, observed, and reversed
  safely
- Security: new data flows, secrets, permissions, and external integrations are
  identified and protected
- Reliability: dependency failure modes are known; user-visible failure behavior
  is intentional
- Performance efficiency: expected latency and throughput impact are understood;
  avoid premature over-engineering
- Cost optimization: new services, background work, polling, storage growth, and
  third-party spend are justified
- Sustainability: avoid wasteful polling, over-fetching, excess retention,
  duplicate processing, and oversized infrastructure

## What to require during review

Ask these questions for every meaningful change:

1. How will this be operated, observed, and rolled back?
2. What secrets, privileges, or sensitive data does this add or expose?
3. What happens when a dependency is slow, unavailable, or returns bad data?
4. What is the expected latency, throughput, and scaling behavior?
5. What is the direct cost impact now and at 10x usage?
6. Can the same user outcome be achieved with less compute, storage, or network?

## Review posture

- Reviews should happen early on high-risk or one-way-door decisions, not only
  before release
- Significant architecture changes should trigger another Well-Architected pass
- The output of a review is a prioritized action list, owners, and mitigations

## Existing rule mappings

- Security controls: `13-security.md`, `14-secret-management.md`,
  `15-pdpl-compliance.md`
- Reliability and recovery: `10-error-handling.md`, `11-testing.md`,
  `16-deployment.md`
- Performance, observability, and SLOs: `12-telemetry.md`, `16-deployment.md`

## Known adaptation gap

The upstream AWS framework includes provider-specific guidance. For this starter,
translate that guidance to the selected stack unless the project explicitly runs
on AWS.
