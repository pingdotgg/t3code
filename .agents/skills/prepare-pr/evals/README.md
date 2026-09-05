# Behavioral eval fixture

Each scenario runs in a disposable directory with a real local bare Git remote
and a small persisted GitHub simulator. The simulator implements the PR commands
needed by the skill and an attachment upload/fetch API described by
`gh fixture --help`. It records service state in `service/state.json` and
completed operations plus attachment failures in `service/operations.jsonl`.

Create a scenario, run an agent from its checkout with the fixture `gh` first on
`PATH`, then check the resulting state and handoff:

```sh
python3 evals/fixture.py setup new_pr /tmp/prepare-pr-new
cd /tmp/prepare-pr-new/repo
PATH="/tmp/prepare-pr-new/bin:$PATH" <agent-command> "$(cat ../prompt.txt)"
python3 /path/to/prepare-pr/evals/fixture.py check new_pr /tmp/prepare-pr-new /tmp/prepare-pr-new/report.md
```

Replace `new_pr` with `existing_pr`, `description_only`, or `upload_failure`.
`setup` refuses to reuse a directory so evaluations cannot inherit state. Both
commands return nonzero on failure; `check` prints a JSON result with concrete
invariant failures. A zero exit establishes only the observable-state checks;
it is not a complete behavioral-eval verdict.

Setup copies the skill, excluding `evals/`, into `input/prepare-pr` and records
its SHA-256 manifest. The generated prompt points to that frozen copy, and the
checker rejects changes to it. Simulator transactions use an advisory file lock,
so parallel agent commands do not lose service state. The fixture supports
macOS and Linux hosts with Python 3 and Git; it is not a Windows fixture.

This fixture proves local Git publication and the modeled PR/evidence protocol.
It does not make a real GitHub request, validate GitHub authentication, render
Markdown, or establish that GitHub's current private attachment endpoint matches
the simulator. Those claims still require an authorized integration run.
The supplied images are deliberately tiny synthetic files and the video payloads
are not playable recordings. They test file handling, not visual proof quality.
Scenarios with those unresolved proof gaps must remain drafts; an evaluator
should read the handoff and PR body to judge whether media-quality and playback
limits are described honestly rather than matching prescribed wording.

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

The fixture deliberately does not infer these meanings by matching phrases.
For example, “does not claim the PR is ready for review” must not be rejected
because it contains “PR is ready for review”; conversely, passing file and Git
checks cannot validate a false readiness claim.
