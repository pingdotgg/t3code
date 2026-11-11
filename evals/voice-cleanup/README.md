# Dictation cleanup

Checks the shipped cleanup prompt and real text generation paths on synthetic transcripts. No microphone or audio service is used. Run from `evals/` with a configured provider login:

```sh
pnpm voice-cleanup --model <model> --out runs/voice
pnpm voice-cleanup --model <model> --out runs/voice-new --baseline runs/voice/results.json
pnpm voice-cleanup --provider opencode --model opencode/deepseek-v4.1-flash-free --out runs/voice-opencode
```

Codex is the default and enforces an output schema. `--provider opencode` runs the `opencode` on PATH, which must be OpenCode 2, through T3's text generation without schema enforcement, so it shows whether the prompt alone yields the JSON reply the server decodes. It starts its own server in a temporary workspace and uses the CLI's configured credentials; T3's server and database are not touched. Free OpenCode models cost nothing.

Use `--case <id> --samples 1` for a smoke run. By default the five cases run three times each (15 short model calls). Replies that fail to decode are recorded as failed samples; the decoded count measures response format only.

Read `review.json` against each rubric before opening the answer key. A case fails if half or more of its samples fail decoding or violate the rubric. Allow cosmetic punctuation differences; do not accept changed meaning or existing draft text copied into the result. Add cases to `cases.ts` when an actual cleanup failure exposes a missing behavior.
