# Goal composer state screenshots

PR assets for the composer-attached Goal pill. Regenerate with:

```bash
cd apps/web
vp test run --project e2e e2e/capture-goal-screenshots.test.ts
```

Uses the dev-only `/dev/goal-chips` preview route (not available in production builds).

| File                     | State                          |
| ------------------------ | ------------------------------ |
| `goal-active.png`        | Active (idle)                  |
| `goal-running.png`       | Active while a turn is running |
| `goal-paused.png`        | Paused                         |
| `goal-blocked.png`       | Blocked                        |
| `goal-usage-limited.png` | Usage-limited                  |
| `goal-complete.png`      | Complete                       |
