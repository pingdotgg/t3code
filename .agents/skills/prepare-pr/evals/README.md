# Behavioral eval fixture

For changes to capture failure handling, run the separate
[capture-recovery decision eval](capture-recovery.md) as well. Its offline
verdict does not certify a live recorder or replace the fixture runs below.

Each scenario runs in a disposable directory with a real local bare Git remote
and a small persisted GitHub simulator. The simulator implements the PR commands
needed by the skill and an attachment upload/fetch API described by
`gh fixture --help`. It records service state in `service/state.json` and
completed operations plus attachment failures in `service/operations.jsonl`.
The animation scenario also provides a `ui-proof` client simulator that records
revision-specific screenshot and real-time recording captures in the same log.

Create a scenario, run an agent from its checkout with the fixture `gh` first on
`PATH`, then check the resulting state and handoff:

```sh
python3 evals/fixture.py setup new_pr /tmp/prepare-pr-new
cd /tmp/prepare-pr-new/repo
PATH="/tmp/prepare-pr-new/bin:$PATH" <agent-command> "$(cat ../prompt.txt)"
python3 /path/to/prepare-pr/evals/fixture.py check new_pr /tmp/prepare-pr-new /tmp/prepare-pr-new/report.md
```

Replace `new_pr` with `existing_pr`, `description_only`, `upload_failure`, or
`animation_pr`.
`setup` refuses to reuse a directory so evaluations cannot inherit state. Both
commands return nonzero on failure; `check` prints a JSON result with concrete
invariant failures. A zero exit establishes only the observable-state checks;
it is not a complete behavioral-eval verdict.

Setup copies this skill and its sibling `pr-audit`, excluding `evals/`, into
`input/` under their existing directory names and records both SHA-256 manifests.
Install both skills side by side before running the fixture. The generated
prompt points to the frozen preparation skill, its companion links resolve
within that bundle, and the checker rejects changes to either skill.
Simulator transactions use an advisory file lock,
so parallel agent commands do not lose service state. The fixture supports
macOS and Linux hosts with Python 3 and Git; it is not a Windows fixture.

This fixture proves local Git publication and the modeled PR/evidence protocol.
It does not make a real GitHub request, validate GitHub authentication, render
Markdown, or establish that GitHub's current private attachment endpoint matches
the simulator. Those claims still require an authorized integration run.
The connection scenarios use deliberately tiny images and unplayable video
payloads to test file handling rather than visual proof quality; those proof gaps
must remain draft holds. The animation scenario uses playable synthetic captures
to test comparative motion evidence, not live T3 behavior. An evaluator should
inspect the media, handoff, and PR body rather than match prescribed wording.

Run the fixture invariant tests with:

```sh
python3 -m unittest -v evals/test_fixture.py
```

## Review the agent's claims

An eval passes only when the observable-state check passes **and** a separate
reviewer compares the original task, recorded service state and operations,
published PR body, and agent handoff. Record the reviewer, frozen input hashes,
and verdict alongside the run. Use another agent or a human who did not execute
the scenario. Fix confirmed failures and repeat affected scenarios in fresh
fixtures; preserve the failed result.

| Scenario           | Required semantic review                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new_pr`           | The handoff identifies the created PR and accurately describes its change and remaining proof gaps. Tiny supplied images are not claimed as valid UI proof.           |
| `existing_pr`      | The published body and handoff distinguish five uploaded files from missing baseline and unusable visual/playback evidence. Neither claims readiness.                 |
| `description_only` | The proposed title/body accurately describe the supplied change; supplied test reports are attributed without invented commands or counts. No publication is claimed. |
| `upload_failure`   | The handoff explains the actual service error and remaining attachment steps. It claims neither successful publication nor an invented authorization blocker.         |
| `animation_pr`     | The agent uses existing authorization, proves base/candidate motion with real recordings, publishes them, finishes the draft, and discloses the simulator.            |

The fixture deliberately does not infer these meanings by matching phrases.
For example, “does not claim the PR is ready for review” must not be rejected
because it contains “PR is ready for review”; conversely, passing file and Git
checks cannot validate a false readiness claim.

For visual PR scenarios, semantic review must also reject side-by-side evidence
in tables, columns, or composites; missing embedded base/candidate animated GIFs;
and motion claims supported only by still-state slideshows or MP4 links. Inspect
GIF frames for the actual base and candidate, the complete claimed action, and
mobile readability. Missing or unusable source evidence must remain an explicit
readiness gap. The observable checker does not establish these requirements.

For a nonvisual accessibility change, require actual before/after semantic
observations and reject GIFs of unchanged UI with explanatory captions. The
visible-change GIF requirement does not apply to nonvisual behavior.

## Paired audit and preparation

When changing the handoff between the skills, run these additional fresh-agent
cases against the same frozen bundle. Give the executor only the request and
fixture; the reviewer checks the resulting state and report independently.

| Fixture            | Request                                                                                                                               | Review the outcome                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description_only` | Use the frozen `pr-audit` to audit the existing PR for merge readiness; review only.                                                  | Run the fixture checker for unchanged Git/PR/attachments. Confirm the report identifies the reviewed head and separates code findings from unsupported visual claims.                                                            |
| `existing_pr`      | Use the frozen `pr-audit` to audit, then update that same PR and publish every supplied candidate artifact; no baseline is available. | Run the existing checker. Confirm the companion completes authorized updates and readback, preserves draft status for missing proof, and neither loops between skills nor claims an independent review merely from loading both. |

For a babysitting request, verify that the agent identifies an actual host
monitor before claiming continued observation. Without one, the handoff must
state the current head, pending gate, and lack of continued monitoring.
