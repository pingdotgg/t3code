# PR #22930 evidence scripts

Reproduces the before/after recordings for the PR review Code tab restore fix (issue #22886)
against a local Forgejo fixture forge. Nothing here ships; media and tokens stay in `$EV_DIR`.

```sh
export EV_DIR=/tmp/ev-22930 S=apps/web/scripts/evidence/pr-22930
$S/build-fixture.sh                      # byte-stable src.git (fixed dates => fixed SHAs)
$S/seed.sh                               # Forgejo container ev22930-forgejo, PR #1 (L) + #2 (S),
                                         # stub fj, keys.json, review-a/review-b clones, snapshot
git -C ~/t3code worktree add --detach $EV_DIR/before 8d3b061121 && (cd $EV_DIR/before && vp i)
$S/start-dev.sh before; $S/start-dev.sh after    # isolated --home-dir, PID in logs/dev-<b>.pid
$S/seed-threads.sh $EV_DIR/before $EV_DIR/home-before > $EV_DIR/drv/ids-before.env  # and after
node $S/pair.mjs "<pairingUrl from logs/dev-before.log>" $EV_DIR/drv/state-before.json
$S/run.sh before R4; $S/run.sh after R4          # rows R1-R8, S-<1440|390>-<light|dark>
python3 $S/post.py R4                            # captioned mp4 + events JSON into media/
$S/seed.sh restore                               # before every push row (R1, R2)
```

`run.sh` expects `driver.mjs` and the ids/state files under `$EV_DIR/drv`. Stop servers with
`kill -- -$(cat $EV_DIR/logs/dev-<b>.pid)`, then `docker rm -f ev22930-forgejo`.
