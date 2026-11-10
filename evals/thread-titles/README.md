# Thread titles

Generates thread titles for real thread shapes with the server's Codex title generator, then sets each new title against the old one for a blind review.

## Run

```sh
cd evals
pnpm thread-titles --model <codex model> --out runs/titles
pnpm thread-titles --model <codex model> --out runs/titles-new --baseline runs/titles/results.json
```

- It uses your local Codex login, like the server does.
- `--initial` titles from the first message only, as a new thread does.
- A run writes `results.json` (titles and latency), `review.json` (titles A and B in random order, with a rubric), and `answer-key.json`. Score `review.json` before you open `answer-key.json`.

## Add a case

Add an entry to `cases.ts` with an `id`, a `source`, the thread `messages`, the `previousTitle`, and a `rubric` that says what a good title names.
