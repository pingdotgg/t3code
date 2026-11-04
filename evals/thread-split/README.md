# Thread independence evaluation

Tests whether a local decision model can identify a new message that needs none
of the preceding thread's results, files, decisions or instructions. A different
subject alone does not establish independence. This is an offline experiment;
it does not create threads, alter history, or display suggestions.

The direct prompt is shared with the server in
`packages/shared/src/threadSplitPrompt.json`. Each request contains one question:
pplx's joint question attention makes scores depend on siblings when batched.
Truncated requests and inference failures abstain and are counted separately.

## Run

Use Python 3.13 on Apple Silicon with `mlx-decision==1.1.0` and a local model.
This evaluation uses Python because the measured runtime is MLX; it does not
call a paid provider or download model weights.

```sh
python3 -m unittest discover -s evals/thread-split
python3 evals/thread-split/run.py --cases /path/to/private-cases.json \
  --model /path/to/pplx-decider-flash-v1.2 --threshold 0.94 \
  --out /path/to/new-run
```

The output directory must not exist. It receives scores, abstentions, request
latencies, the exact prompt, input digest, threshold and confusion counts.
The threshold is explicit; this runner never tunes it on evaluation labels.

Cases are a JSON array with `id`, `session`, `label` (`INDEPENDENT` or `DEPENDS`),
and `state` containing only `prior_thread` and `new_message`. Prior thread entries
contain `user` and `assistant_final`. The new message's answer must never enter
state. Keep private transcripts outside the repository. Use only synthetic,
anonymized cases in committed fixtures.

Choose thresholds using separate calibration sessions; evaluate on wholly new
sessions. Label before scoring, keep ambiguous labels visible, and report real
messages separately from synthetic task switches. Repeat model samples before
drawing conclusions. Abstentions are neither correct predictions nor negatives.

## Evidence and draft boundary

The exploratory November 3 pilot had 190 messages from 44 sessions, with only
nine independent messages. Pplx/direct caught three of nine with one false flag
among 181 dependent messages at the sample-selected cutoff 0.938570. Median
latency was 0.898 seconds; p95 was 5.614 seconds. Those counts were calibrated
and measured on the same sample, so they do not establish held-out accuracy.
A separate synthetic-switch analysis used a different cutoff (about 0.919);
do not combine those thresholds or treat either as a production default.

The app integration is opt-in, passive and asynchronous, using an explicitly
configured local endpoint. It requires user action to move a draft into a fresh
thread. Validate on new sessions before considering a default-on rollout.
Automatic splitting and interrupting prompts are outside this feature.

## Session-held-out experiment

`experiment.py` separates score collection from labeling and calibration. It uses
three fixed yes/no prompts: the production baseline, an actionable-task/reference
check, and a contextual task check. Keep both packets and labels outside the repo.

Packets contain `id`, `session`, `split` (`calibration` or `evaluation`), `state`
(as above), and `eligibility: {"eligible": true, "reasons": []}`. A session cannot
cross splits; `session_group` also cannot cross splits when supplied. Previously
exposed sessions are rejected from evaluation. The default minimum is 100 evaluation packets. An explicitly declared smaller
exploratory run can use `--min-evaluation-cases N` consistently on every command;
its minimum is bound into receipts and the frozen selection. Record the reason
before scoring and report the actual labeled and eligible denominators. Reducing
this minimum does not relax the calibration evidence requirements. Labels are separate
rows with `id` and `label`: `NEW_TASK`, `CONTINUE`, `NO_TASK`, or `UNCERTAIN`.
They should describe the usefulness of a fresh thread, not whether the observed
assistant happened to reuse history. Label before viewing scores. Preserve the
source provenance and independent-label agreement in the private corpus manifest.

Freeze each split's final labels before scoring. Calculate its hash without sending
the labels to the scoring process (replace the path for each split):

```sh
python3 -c 'import sys; sys.path.insert(0, "evals/thread-split"); from experiment import digest, labels; print(digest(labels(sys.argv[1])))' /private/cal-labels.json
```

```sh
python3 evals/thread-split/experiment.py score --packets /private/packets.json \
  --split calibration --labels-sha256 CALIBRATION_LABEL_HASH \
  --model /models/pplx-decider-flash-v1.2 --out /private/cal-scores
python3 evals/thread-split/experiment.py calibrate --packets /private/packets.json \
  --labels /private/cal-labels.json --scores /private/cal-scores/scores.jsonl \
  --out /private/selection.json
python3 evals/thread-split/experiment.py score --packets /private/packets.json \
  --split evaluation --selection /private/selection.json \
  --labels-sha256 EVALUATION_LABEL_HASH --model /models/pplx-decider-flash-v1.2 --out /private/test-scores
python3 evals/thread-split/experiment.py report --packets /private/packets.json \
  --split evaluation --selection /private/selection.json \
  --labels /private/test-labels.json --scores /private/test-scores/scores.jsonl \
  --out /private/report.json
```

Calibration refuses held-out labels or scores. It selects the prompt/cutoff with
most useful eligible detections subject to at most 1% observed false suggestions
among scored, eligible negative calibration cases. Selection requires at least
100 such negatives and five true detections. A candidate that fails on more
eligible cases than the baseline is disqualified. These are minimum evidence
requirements, not guarantees of generalisation. Ties prefer fewer false
suggestions, then the baseline prompt. If no useful cutoff qualifies, the frozen
threshold is null (no suggestions). This empirical constraint is not a population
guarantee. Evaluation scores only the frozen choice and the production baseline;
its report includes the baseline at the shipped 0.94 cutoff.

The report retains every checkpoint in reconstructed-path recall, including
ineligible cases and abstentions; its false-suggestion rate describes all negative
checkpoints, including those the service would never score. `eligible_scored` is the
primary false-suggestion denominator used for calibration. `classifier` includes
all successful scores, even for ineligible packets. Uncertain labels remain visible but do not enter confusion counts. It also
reports class counts, predictions by class (including UNCERTAIN), eligibility
exclusions, failures, eligible-success latency median/p95 and
session-group-resampled intervals. Checkpoint-level Wilson bounds are also
reported with an explicit independence assumption; they do not account for
within-session correlation. In particular, a zero-width bootstrap interval at zero
observed errors must not be interpreted as certainty. Eligibility is supplied by corpus reconstruction,
not observed runtime behavior. Validate actual service availability, permissions,
busy-state checks and HTTP timeouts separately. Direct MLX scoring does not measure
those paths. Output files never overwrite existing results. An interrupted scoring run can use
`--resume` with identical arguments; corpus, driver, split, model path and prompts
must match its saved receipt. Receipts also bind model-file contents, MLX version,
label hashes and relevant source-file contents. Reports validate these receipts.
Evaluation creates a marker beside the selection file and can only resume in its
original output directory. Completed score rows are not run again.

## Verified human follow-up evaluation

The subsequent corpus contains 194 app-attributed human follow-ups across 24
threads and five provider configurations. Independent judges agreed on 181 labels;
a third judge resolved 13 disagreements before scoring. Whole ancestry groups
separate 140 development/calibration cases from 54 held-out cases. This is one
user's history, not a representative population sample.

At the shipped 0.94 threshold, the baseline produced no held-out suggestions.
Among 23 eligible cases, it missed the one actionable independent task and falsely
flagged none of 21 negatives; one case remained uncertain. Across all 54 cases,
there were three new tasks, two excluded by eligibility gates. Zero observed false
positives on 21 eligible negatives is weak evidence: the 95% Wilson upper bound is
15.5%, even assuming independent checkpoints.

Replaying all 54 cases through the production service with reconstructed projection
fixtures and real local HTTP inference produced the same zero suggestions. It
requested inference for 23 cases and excluded 31, with no request-state mismatches
or observed failures. Sequential service latency was 494 ms median and 885 ms p95.
This exercises the service and HTTP path, not historical settings, authenticated
RPC, concurrent drafts, or client typing behavior.

Three fixed prompts were scored on calibration data. Only 23 eligible negatives
were available, below the predeclared 100-negative minimum, so no tuned candidate
qualified. These results do not justify a threshold change or a readiness claim.
The feature remains experimental and opt-in.
