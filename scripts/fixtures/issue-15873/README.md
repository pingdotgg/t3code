# Async answer visibility replay

Sanitized projection data from the maintainer's three-run reproduction of
issue [#15873](https://git.cafe/pingdotgg/t3code/issues/15873). IDs, workspace,
checkpoint refs and command output are synthetic. No credentials, auth rows,
events, effects or scheduled work are included. All runs are completed and
requests resolved. These fixtures exercise production snapshot rendering and
Find; direct projection writes do not prove provider dispatch or event history.

Run a selected product SHA once against a disposable worktree `.t3` home to
migrate its schema. Stop that server, then run:

```sh
python3 -B scripts/fixtures/issue-15873/seed.py .t3/capture/userdata/statev2.sqlite
```

Start with `vp run dev --home-dir "$PWD/.t3/capture"`. Use the actual printed
ports and authenticate through the startup pairing URL. The seeder prints
fixture names and thread IDs. Each fixture has its own project; find its
`project_id` in `fixtures()` or the projection database for direct navigation.
Seeding is idempotent; use a clean migrated database for a clean sidebar.
The seeder accepts only resolved `statev2.sqlite` paths under this script's
checkout `.t3` directory (including `.t3/capture` and `.t3/pass2`). Symlinks
that escape that directory and the installed app's `.t3` home are rejected
before the database is opened. Never run this against the installed app's userdata.

- G retains the genuine queued-gap chronology and turn-start answer shape.
- A removes the intervening run and consistently remaps the later run to 2.
- C moves the answer before the original run's final acknowledgment and removes
  other runs. Its answer remains folded into question history.
- L derives from A with long formatted answer text and an answer-only tail token.
- S changes the later answer's intent to steer in the completed G snapshot.
  It proves only settled steer rendering; active steering, provider delivery,
  streaming, live follow and working controls remain unverified.

Derived fixtures do not prove hot cache invalidation, mounted prefix updates,
echo deduplication, failed transports, history pagination or native behavior.
The separate evidence index must identify which interactions were captured.
