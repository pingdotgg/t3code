import argparse
import hashlib
import json
from pathlib import Path
import time

from detector import PROMPT, request, score_response, summarize


def main():
    parser = argparse.ArgumentParser(description='Offline thread-independence evaluation')
    parser.add_argument('--cases', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--threshold', type=float, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    summarize([], args.threshold)
    cases = json.loads(args.cases.read_text())
    summarize([dict(id=c['id'], label=c['label'], score=None) for c in cases], args.threshold)
    for case in cases:
        state = case['state']
        if set(state) != {'prior_thread', 'new_message'}:
            raise ValueError('State must contain only prior_thread and new_message')
        if not isinstance(state['new_message'], str) or not isinstance(state['prior_thread'], list):
            raise ValueError('Invalid thread state')
        for turn in state['prior_thread']:
            if set(turn) != {'user', 'assistant_final'} or not all(isinstance(v, str) for v in turn.values()):
                raise ValueError('Prior turns must contain only user and assistant_final text')
    args.out.mkdir(parents=True, exist_ok=False)
    import mlx_decision

    model = mlx_decision.load(str(args.model))
    rows = []
    with (args.out / 'scores.jsonl').open('x') as output:
        for case in cases:
            state = case['state']
            row = {key: case[key] for key in ('id', 'session', 'label')}
            start = time.perf_counter()
            try:
                row['score'] = score_response(model.decide_request(request(state)))
            except Exception as error:
                row.update(score=None, error=type(error).__name__)
            row['seconds'] = time.perf_counter() - start
            rows.append(row)
            output.write(json.dumps(row) + '\n')
            output.flush()
    report = {
        'model': args.model.name,
        'threshold': args.threshold,
        'prompt': PROMPT,
        'cases_sha256': hashlib.sha256(args.cases.read_bytes()).hexdigest(),
        'counts': summarize(rows, args.threshold),
        'sessions': len({row['session'] for row in rows}),
        'scope': 'Offline evaluation only; no thread mutation or runtime integration',
    }
    (args.out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
