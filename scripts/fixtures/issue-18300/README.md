# Review guide keyboard capture fixture

Use only a stopped worktree development server. Run `vp run dev` once to
initialize `.t3`, then stop it. From the worktree root run:

```sh
python3 scripts/fixtures/issue-18300/seed.py three --bootstrap
vp run dev
```

Enable Review guides in Source Control settings if needed. Open the fixture
thread `thread:project:a0efafb6-84bd-491c-84e3-1b1a0749487b:cfeaf609-dc2b-419d-abe4-20626070bcbb`
under the environment ID printed by this isolated server. Open its linked
[#18338](https://git.cafe/pingdotgg/t3code/pulls/18338), then Guide.
The PR details are read from the real host; host metadata may change.

With the server stopped, `seed.py null`, `zero`, `one`, or `three` replaces
only this PR's stored guide. Restart and reload between segments. `--bootstrap`
also installs the synthetic empty project/thread projection; it does not create
event history or run an agent. Restore `three` after capturing. The script
refuses writes while the supplied server port (default 15360) is listening.
It always writes the checkout's `.t3/userdata`, never the live T3 home.

The guide's metadata head `af68de7a2a51bf626d630916fdf711383f32fd03`
is the linked PR's head at fixture creation, not the served code revision.
There are no excerpts or files. `generatedAt` is fixed. For comparable captures,
use the same browser profile, viewport, appearance and Stop 1; freeze browser
Date at `2026-10-23T01:44:00Z` after setup and keep sidebar/scroll consistent.

The seed has no input parser beyond argparse's four state choices. Its only
loops cover two fixed bootstrap rows and each row's fixed schema columns;
work is O(1) with respect to repository or database size. The guide slice is
bounded at three stops. No captures belong in this directory.
