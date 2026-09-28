---
name: diagnose
description: Diagnose a reported bug, failure, regression, or performance problem when the user wants root-cause investigation rather than a routine implementation or review.
---

# Diagnose

Use an evidence-driven loop:

1. **Reproduce or bound the failure.** Read the complete error and relevant logs, identify the smallest reliable trigger, and record when reproduction is unavailable or unsafe.
2. **Minimise the surface.** Trace the execution path and reduce the case only when that will distinguish causes or make a safe probe possible. Do not delay useful investigation behind an arbitrary reproduction count or hypothesis quota.
3. **Form and test explanations.** State the leading explanations, rank them by evidence, and run the smallest discriminating probe. Change one relevant variable at a time when practical.
4. **Fix the cause.** Make the smallest coherent change that explains the evidence. Preserve security boundaries and redact secrets from logs, reports, and copied repros.
5. **Prove the fix.** Re-run the failing case, add or update a regression test when the repository supports one, and run proportional targeted validation. Escalate to broader validation when the change crosses subsystem boundaries.

If the failure is intermittent, use repetition, tracing, stress, or timing control only when it improves evidence and remains safe for the environment. Do not invent load or fuzzing requirements. If the available evidence cannot distinguish causes, say what remains unknown and ask for the smallest missing input.

## Completion

Before declaring an environment or fixture blocker, identify the failing boundary and, when safe and authorized, run a probe that distinguishes configuration, fixture behavior, and product behavior. For example, check whether a pending-job read consults the durable repository or synthesizes a default. If progress requires external access, permission, or unavailable evidence, state that exact dependency rather than retrying indefinitely.

Remove temporary instrumentation and throwaway reproduction artifacts introduced during diagnosis. Preserve regression tests and any reproduction evidence explicitly needed for follow-up; identify retained artifacts and their purpose without deleting user-owned work.

Done means the root cause is supported by evidence, the fix or explicit blocker is recorded, the regression behavior is checked, and relevant validation results are reported. Do not claim resolution from a passing unrelated command.
