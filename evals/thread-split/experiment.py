"""Session-held-out evaluation. Private packets and labels remain outside the repository."""
import argparse
from collections import Counter, defaultdict
import hashlib
from importlib.metadata import version
import json
import math
from pathlib import Path
import random
import time

from detector import QUESTION, score_response

LABELS = {'NEW_TASK', 'CONTINUE', 'NO_TASK', 'UNCERTAIN'}
MIN_CALIBRATION_NEGATIVES = 100
MIN_CALIBRATION_DETECTIONS = 5
PROMPTS = {
    'baseline': QUESTION,
    'actionable': {
        'type': 'noul',
        'instructions': (
            'Does the new user message request an actionable NEW task that can be handled in a fresh '
            'thread without any earlier thread-specific information? Answer no for acknowledgements, '
            'thanks, pauses, resumptions, confirmations, or progress checks. Answer no if resolving '
            'references such as it, they, that, also, or the earlier work requires previous messages. '
            'The fresh thread keeps the same project, environment, tools and standing project instructions. '
            'A change of subject or the ability to rediscover facts does not by itself make a task independent.'
        ),
        'criteria': {'true': 'Actionable new task; all necessary task-specific context is in the new message.',
                     'false': 'Continuation, non-task, unresolved reference, or uncertain dependence.'},
    },
    'contextual': {
        'type': 'noul',
        'instructions': (
            'Should this message be offered a fresh thread? Check three conditions: it asks for '
            'substantive work, it is a separate task rather than the next step of the current task, '
            'and it can be understood without prior thread-specific entities, constraints, results, '
            'or decisions. Answer yes only when all three hold. Greetings, acknowledgements, '
            'pause/resume messages, status requests and ambiguous references are no. The fresh thread '
            'keeps the same project, environment, tools and standing project instructions.'
        ),
        'criteria': {'true': 'A self-contained actionable new task warrants a fresh thread.',
                     'false': 'Earlier context matters, no new task is requested, or the distinction is unclear.'},
    },
}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def file_digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def source_fingerprints():
    root = Path(__file__).resolve().parents[2]
    paths = [Path(__file__).resolve(), Path(__file__).with_name('detector.py').resolve(),
             root / 'packages/shared/src/threadSplitPrompt.json',
             root / 'apps/server/src/orchestration-v2/ThreadSplitSuggestions.ts']
    return {str(path.relative_to(root)): file_digest(path) for path in paths}


def verify_receipt(receipt, artifact, split, truth=None):
    for key, expected in artifact.items():
        if receipt.get(key) != expected:
            raise ValueError(f'Score receipt mismatch: {key}')
    if receipt.get('split') != split:
        raise ValueError('Score receipt split mismatch')
    for name, prompt in receipt['prompts'].items():
        if name not in PROMPTS or prompt != PROMPTS[name]:
            raise ValueError('Score receipt prompt mismatch')
    if truth is not None and receipt.get('labels_sha256') != digest(truth):
        raise ValueError('Frozen labels mismatch')


def packets(path):
    rows = read(path)
    ids, sessions, groups = set(), {}, {}
    for row in rows:
        if row['id'] in ids:
            raise ValueError('Duplicate packet id')
        ids.add(row['id'])
        split = row['split']
        if split not in ('calibration', 'evaluation'):
            raise ValueError('Unknown split')
        previous = sessions.setdefault(row['session'], split)
        if previous != split:
            raise ValueError('Session appears in calibration and evaluation')
        group = row.get('session_group', row['session'])
        if groups.setdefault(group, split) != split:
            raise ValueError('Session group appears in calibration and evaluation')
        if split == 'evaluation' and row.get('previously_exposed_session', False):
            raise ValueError('Previously exposed session appears in evaluation')
        eligibility = row['eligibility']
        if not isinstance(eligibility['eligible'], bool) or not isinstance(eligibility['reasons'], list):
            raise ValueError('Eligibility must be explicit')
        state = row['state']
        if set(state) != {'prior_thread', 'new_message'} or not isinstance(state['new_message'], str):
            raise ValueError('Invalid model state')
        for turn in state['prior_thread']:
            if set(turn) != {'user', 'assistant_final'} or not all(isinstance(v, str) for v in turn.values()):
                raise ValueError('Invalid prior turn')
    return rows


def labels(path):
    result = {}
    for row in read(path):
        if row['id'] in result or row['label'] not in LABELS:
            raise ValueError('Duplicate or invalid label')
        result[row['id']] = row['label']
    return result


def score_rows(path):
    result = {}
    for line in Path(path).read_text().splitlines():
        row = json.loads(line)
        key = (row['id'], row['prompt'])
        if key in result:
            raise ValueError('Duplicate score')
        score = row['score']
        if score is not None and (not math.isfinite(score) or not 0 <= score <= 1):
            raise ValueError('Invalid score')
        result[key] = row
    return result


def ratio(a, b):
    return a / b if b else None


def wilson_interval(successes, total):
    if not total:
        return None
    z = 1.959963984540054
    proportion = successes / total
    denominator = 1 + z * z / total
    center = (proportion + z * z / (2 * total)) / denominator
    margin = z * math.sqrt(proportion * (1 - proportion) / total + z * z / (4 * total * total)) / denominator
    return [max(0, center - margin), min(1, center + margin)]


def metrics(rows, threshold, full_path):
    counts = dict(tp=0, fp=0, tn=0, fn=0)
    classes = Counter(row['label'] for row in rows)
    abstained = 0
    predictions = Counter()
    for row in rows:
        usable = row['score'] is not None and (row['eligible'] or not full_path)
        if usable and threshold is not None and row['score'] >= threshold:
            predictions[row['label']] += 1
        if row['label'] == 'UNCERTAIN':
            continue
        usable = row['score'] is not None and (row['eligible'] or not full_path)
        if not usable:
            abstained += 1
            if not full_path:
                continue
        predicted = usable and threshold is not None and row['score'] >= threshold
        positive = row['label'] == 'NEW_TASK'
        counts[('t' if positive == predicted else 'f') + ('p' if predicted else 'n')] += 1
    tp, fp, tn, fn = (counts[k] for k in ('tp', 'fp', 'tn', 'fn'))
    return dict(counts, total=len(rows), classes=dict(classes), abstained=abstained,
                ineligible=sum(not r['eligible'] for r in rows),
                failed=sum(r['eligible'] and r['score'] is None for r in rows),
                predicted_by_class=dict(predictions),
                binomial_wilson_ci95_assuming_independent_checkpoints=dict(
                    precision=wilson_interval(tp, tp + fp), recall=wilson_interval(tp, tp + fn),
                    false_suggestion_rate=wilson_interval(fp, fp + tn)),
                precision=ratio(tp, tp + fp), recall=ratio(tp, tp + fn),
                false_suggestion_rate=ratio(fp, fp + tn))


def joined(data, truth, scores, prompt, split):
    result = []
    for case in data:
        if case['split'] != split:
            continue
        key = (case['id'], prompt)
        if case['id'] not in truth or key not in scores:
            raise ValueError('Every packet requires a label and a score/abstention receipt')
        score = scores[key]
        if score['session'] != case['session'] or score['state_sha256'] != digest(case['state']):
            raise ValueError('Score does not belong to this packet state/session')
        if score['prompt_sha256'] != digest(PROMPTS[prompt]):
            raise ValueError('Prompt changed after scoring')
        result.append(dict(score, label=truth[case['id']], eligible=case['eligibility']['eligible'],
                           session_group=case.get('session_group', case['session'])))
    return result


def choose(rows, max_fpr):
    rows = [r for r in rows if r['eligible'] and r['score'] is not None]
    thresholds = sorted({r['score'] for r in rows if r['score'] is not None}, reverse=True)
    choices = []
    for cutoff in thresholds:
        m = metrics(rows, cutoff, False)
        if (m['fp'] + m['tn'] >= MIN_CALIBRATION_NEGATIVES
                and m['tp'] >= MIN_CALIBRATION_DETECTIONS
                and m['false_suggestion_rate'] <= max_fpr):
            choices.append((m['tp'], -m['fp'], cutoff))
    return max(choices)[2] if choices and max(choices)[0] > 0 else None


def percentile(values, fraction):
    values = sorted(values)
    if not values:
        return None
    index = (len(values) - 1) * fraction
    lo = math.floor(index)
    hi = math.ceil(index)
    return values[lo] + (values[hi] - values[lo]) * (index - lo)


def session_intervals(rows, threshold, full_path):
    groups = defaultdict(list)
    for row in rows:
        groups[row.get('session_group', row['session'])].append(row)
    names = sorted(groups)
    rng = random.Random(20261103)
    draws = defaultdict(list)
    for _ in range(1000):
        sample = [row for name in rng.choices(names, k=len(names)) for row in groups[name]]
        for key, value in metrics(sample, threshold, full_path).items():
            if key in ('precision', 'recall', 'false_suggestion_rate') and value is not None:
                draws[key].append(value)
    return {key: [percentile(values, .025), percentile(values, .975)] for key, values in draws.items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['score', 'calibrate', 'report'])
    parser.add_argument('--packets', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--split', choices=['calibration', 'evaluation'])
    parser.add_argument('--model', type=Path)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--prompts', nargs='+', choices=list(PROMPTS), default=list(PROMPTS))
    parser.add_argument('--labels', type=Path)
    parser.add_argument('--scores', type=Path)
    parser.add_argument('--labels-sha256')
    parser.add_argument('--selection', type=Path)
    parser.add_argument('--max-fpr', type=float, default=.01)
    parser.add_argument('--min-evaluation-cases', type=int, default=100)
    args = parser.parse_args()
    data = packets(args.packets)
    if args.min_evaluation_cases < 1:
        parser.error('--min-evaluation-cases must be positive')
    if sum(c['split'] == 'evaluation' for c in data) < args.min_evaluation_cases:
        raise ValueError('Insufficient session-held-out evaluation packets for declared minimum')
    artifact = {'packets_sha256': digest(data), 'source_sha256': source_fingerprints(),
                'minimum_evaluation_cases': args.min_evaluation_cases}
    if args.operation == 'score':
        if not args.model or not args.split:
            parser.error('score requires --model and --split')
        if not args.labels_sha256 or len(args.labels_sha256) != 64 or any(c not in '0123456789abcdef' for c in args.labels_sha256):
            parser.error('score requires --labels-sha256 of the frozen id-to-label mapping')
        model_files = {str(p.relative_to(args.model)): file_digest(p)
                       for p in sorted(args.model.rglob('*'))
                       if p.is_file() and p.suffix in ('.json', '.safetensors', '.model')}
        if not model_files:
            raise ValueError('No model files found')
        model_identity = dict(files=model_files, mlx_decision_version=version('mlx-decision'))
        selected = args.prompts
        if args.split == 'evaluation':
            if not args.selection:
                parser.error('evaluation scoring requires frozen --selection')
            selection = read(args.selection)
            if selection['packets_sha256'] != digest(data) or selection['minimum_evaluation_cases'] != args.min_evaluation_cases:
                raise ValueError('Corpus changed after calibration')
            if selection['source_sha256'] != artifact['source_sha256'] or selection['model_identity'] != model_identity:
                raise ValueError('Source or model changed after calibration')
            selected = list(dict.fromkeys(['baseline', selection['prompt']]))
            if selection['prompt_sha256'] != digest(PROMPTS[selection['prompt']]):
                raise ValueError('Selected prompt changed')
        receipt = dict(artifact, model=str(args.model), split=args.split,
                       prompts={p: PROMPTS[p] for p in selected},
                       model_identity=model_identity, labels_sha256=args.labels_sha256)
        if args.split == 'evaluation':
            receipt['selection_sha256'] = digest(selection)
            marker = args.selection.with_suffix(args.selection.suffix + '.evaluated')
            if args.resume:
                if read(marker) != str(args.out.resolve()):
                    raise ValueError('Evaluation resume directory changed')
            else:
                with marker.open('x') as output:
                    json.dump(str(args.out.resolve()), output)
        if args.resume:
            if read(args.out / 'receipt.json') != receipt:
                raise ValueError('Run metadata changed; cannot resume')
            existing = score_rows(args.out / 'scores.jsonl') if (args.out / 'scores.jsonl').exists() else {}
        else:
            args.out.mkdir(parents=True, exist_ok=False)
            (args.out / 'receipt.json').write_text(json.dumps(receipt, indent=2))
            existing = {}
        import mlx_decision
        model = mlx_decision.load(str(args.model))
        with (args.out / 'scores.jsonl').open('a' if args.resume else 'x') as output:
            for prompt in selected:
                for case in data:
                    if case['split'] != args.split:
                        continue
                    if (case['id'], prompt) in existing:
                        continue
                    row = dict(id=case['id'], session=case['session'], split=args.split,
                               prompt=prompt, prompt_sha256=digest(PROMPTS[prompt]),
                               state_sha256=digest(case['state']), score=None, seconds=None)
                    # Score bounded model inputs even when a product eligibility guard would abstain.
                    if len(json.dumps(case['state'], ensure_ascii=False, separators=(',', ':')).encode('utf-16-le')) // 2 > 24000:
                        row['abstention'] = 'state_limit'
                    else:
                        start = time.perf_counter()
                        try:
                            response = model.decide_request({'state': case['state'], 'questions': {'q': PROMPTS[prompt]}})
                            row['score'] = score_response(response)
                            if row['score'] is None:
                                row['abstention'] = 'truncated'
                        except Exception as error:
                            row['abstention'] = type(error).__name__
                        row['seconds'] = time.perf_counter() - start
                    output.write(json.dumps(row) + '\n')
                    output.flush()
                print(prompt, args.split, 'complete', flush=True)
        return
    if not args.labels or not args.scores:
        parser.error('calibrate/report require --labels and --scores')
    truth, scores = labels(args.labels), score_rows(args.scores)
    split = 'calibration' if args.operation == 'calibrate' else args.split
    receipt = read(args.scores.with_name('receipt.json'))
    verify_receipt(receipt, artifact, split, truth)
    artifact.update(model_identity=receipt['model_identity'], labels_sha256=digest(truth),
                    scores_sha256=file_digest(args.scores))
    if args.operation == 'calibrate':
        if not 0 <= args.max_fpr <= 1:
            raise ValueError('Invalid FPR budget')
        calibration_ids = {c['id'] for c in data if c['split'] == 'calibration'}
        if any(case_id not in calibration_ids for case_id, _ in scores):
            raise ValueError('Calibration cannot read evaluation or unknown scores')
        if any(case_id not in calibration_ids for case_id in truth):
            raise ValueError('Calibration requires calibration-only labels')
        baseline = joined(data, truth, scores, 'baseline', 'calibration')
        baseline_failures = sum(r['eligible'] and r['score'] is None for r in baseline)
        candidates = []
        for prompt in args.prompts:
            rows = joined(data, truth, scores, prompt, 'calibration')
            failures = sum(r['eligible'] and r['score'] is None for r in rows)
            threshold = choose(rows, args.max_fpr) if failures <= baseline_failures else None
            candidates.append(dict(prompt=prompt, threshold=threshold,
                                   exceeds_baseline_failures=failures > baseline_failures, metrics=metrics(rows, threshold, True),
                                   classifier=metrics(rows, threshold, False),
                                   eligible_scored=metrics([r for r in rows if r['eligible']], threshold, False)))
        winner = max(candidates, key=lambda c: (c['metrics']['tp'], -c['metrics']['fp'], c['prompt'] == 'baseline'))
        artifact.update(prompt=winner['prompt'], threshold=winner['threshold'],
                        prompt_sha256=digest(PROMPTS[winner['prompt']]), candidates=candidates,
                        calibration_sessions=sorted({c['session'] for c in data if c['split'] == 'calibration'}),
                        labels_sha256=digest({c['id']: truth[c['id']] for c in data if c['split'] == 'calibration'}),
                        minimum_scored_negative_cases=MIN_CALIBRATION_NEGATIVES,
                        minimum_true_detections=MIN_CALIBRATION_DETECTIONS,
                        max_false_suggestion_rate=args.max_fpr)
    else:
        if not args.selection or not args.split:
            parser.error('report requires frozen --selection and --split')
        selection = read(args.selection)
        if selection['packets_sha256'] != digest(data) or selection['minimum_evaluation_cases'] != args.min_evaluation_cases:
            raise ValueError('Corpus changed after calibration')
        if selection['source_sha256'] != artifact['source_sha256'] or selection['model_identity'] != artifact['model_identity']:
            raise ValueError('Source or model changed after calibration')
        if args.split == 'evaluation' and receipt.get('selection_sha256') != digest(selection):
            raise ValueError('Selection changed after evaluation')
        rows = joined(data, truth, scores, selection['prompt'], args.split)
        baseline_rows = joined(data, truth, scores, 'baseline', args.split)
        threshold = selection['threshold']
        if threshold is not None and not 0 <= threshold <= 1:
            raise ValueError('Invalid frozen threshold')
        elapsed = [r['seconds'] for r in rows if r['eligible'] and r['score'] is not None and r['seconds'] is not None]
        artifact.update(split=args.split, prompt=selection['prompt'], threshold=threshold,
                        selection_sha256=digest(selection), sessions=len({r['session'] for r in rows}),
                        eligibility_scope='reconstructed_static; runtime availability, busy state, permissions and HTTP timeout require separate validation',
                        classifier=metrics(rows, threshold, False),
                        eligible_scored=metrics([r for r in rows if r['eligible']], threshold, False),
                        reconstructed_path=metrics(rows, threshold, True),
                        baseline=dict(threshold=.94, classifier=metrics(baseline_rows, .94, False),
                                      eligible_scored=metrics([r for r in baseline_rows if r['eligible']], .94, False),
                                      reconstructed_path=metrics(baseline_rows, .94, True)),
                        classifier_ci95=session_intervals(rows, threshold, False),
                        reconstructed_path_ci95=session_intervals(rows, threshold, True),
                        eligible=sum(r['eligible'] for r in rows),
                        exclusions=dict(Counter(reason for c in data if c['split'] == args.split for reason in c['eligibility']['reasons'])),
                        failures=dict(Counter(r.get('abstention') for r in rows if r['score'] is None)),
                        latency_seconds=dict(median=percentile(elapsed, .5), p95=percentile(elapsed, .95)))
    with args.out.open('x') as output:
        json.dump(artifact, output, indent=2)
    print(json.dumps(artifact))


if __name__ == '__main__':
    main()
