# Dictation cleanup

Checks the shipped cleanup prompt and Codex text generation path on synthetic transcripts. No microphone or audio service is used. Run from `evals/` with a configured Codex login:

```sh
pnpm voice-cleanup --model <model> --out runs/voice
pnpm voice-cleanup --model <model> --out runs/voice-new --baseline runs/voice/results.json
```

Use `--case <id> --samples 1` for a smoke run. By default the three cases run three times each (nine short model calls). Read `review.json` against each rubric before opening the answer key. Allow cosmetic punctuation differences; do not accept changed meaning or existing draft text copied into the result. Add cases to `cases.ts` when an actual cleanup failure exposes a missing behavior.
