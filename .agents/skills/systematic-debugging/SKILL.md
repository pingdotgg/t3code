---
name: systematic-debugging
description: Investigates bugs, test failures, unexpected behavior, build failures, integration problems, and performance regressions by establishing and validating their root cause before making a fix. Use when the user reports something broken, failing, slow, or behaving unexpectedly.
---

# Systematic Debugging

**No fixes without root-cause investigation.** Do not treat a plausible symptom as a confirmed cause.

## 1. Establish the failure

Before editing production code:

1. Read the complete error, warning, stack trace, and relevant logs.
2. Create a fast, deterministic feedback loop: a focused failing test, command, HTTP request, fixture replay, or minimal harness.
3. Record exact reproduction steps, inputs, expected result, actual result, and frequency. For flakes, increase the reproduction rate rather than guessing.
4. Inspect relevant recent changes, configuration, dependencies, and environment differences.

If a reproducible loop is unavailable, collect a trace, log, artifact, or targeted instrumentation. State what evidence is missing instead of proposing a speculative fix.

## 2. Locate the root cause

Trace faulty data, control flow, or state backward from the observed failure to the first incorrect input, transition, or assumption.

For multi-component paths, instrument only component boundaries needed to distinguish hypotheses:

```text
input -> component A -> component B -> failing operation
```

At each boundary, verify incoming and outgoing data, configuration, and state. Use uniquely tagged temporary logs and remove them after the investigation.

Find a working analogue in the codebase or an authoritative reference. Compare behavior, dependencies, configuration, and lifecycle assumptions; list material differences before deciding which matters.

## 3. Test a hypothesis

State a falsifiable hypothesis:

> `<cause>` is responsible because `<evidence>`; if true, `<minimal probe>` will produce `<predicted result>`.

Change one variable per probe. A failed probe invalidates or refines the hypothesis; return to evidence gathering rather than layering another fix on top. Do not continue from an unconfirmed explanation.

## 4. Fix and lock it down

Once the cause is confirmed:

1. Turn the minimal reproduction into a regression test at the seam that exercises the real failure, when one exists.
2. Make the smallest fix at the source of the defect; avoid unrelated cleanup or refactoring.
3. Run the regression test, original reproduction, and relevant affected tests.
4. Remove temporary instrumentation and test scaffolding.

If no trustworthy test seam exists, document that limitation and validate with the strongest available reproduction.

## Escalation

After three invalidated fix hypotheses or evidence of recurring cross-cutting failures, stop attempting incremental fixes. Re-examine the relevant architecture, ownership boundaries, shared state, and assumptions before continuing.

For external, environmental, or timing-dependent causes, document the evidence gathered and implement explicit handling such as a retry, timeout, validation, or monitoring only when it addresses the demonstrated failure mode.

## Red flags

Stop and return to investigation when tempted to:

- make a "quick fix" before reproducing the issue;
- change several things and see what works;
- assume a value, configuration, or lifecycle state without observing it;
- claim a test or validation that was not run;
- fix downstream behavior while the bad input or state originates upstream.
