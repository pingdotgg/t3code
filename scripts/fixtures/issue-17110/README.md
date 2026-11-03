# Fresh synthetic Claude captures

For [#17110](https://github.com/pingdotgg/t3code/issues/17110) /
[#23629](https://github.com/pingdotgg/t3code/pull/23629). Based on
[d20e9fa935](https://github.com/pingdotgg/t3code/commit/d20e9fa935d5a943c5c2988837827612b00bfa70).
This fixture enables **new captures**. It does not reconstruct historical screenshots
made from mutable `migrate-dev-db` data, or repair their missing reproducibility proof.

`seed.py` follows the issue-16534 projection-only pattern. It reads only the committed
`scenarios.json`, writes one `seed.sql`, safe Claude `claude-settings.json`, and
`capture.json`, and never opens or modifies a database. No personal data, credentials,
events, runs, provider sessions, messages, or fabricated capability wire frames.
The fixed thread is empty/stopped: no active provider thread and no turn history.
The default selection is explicit Max on the scenario's model (Ultracode in the
alias scenarios); only `project-defaults` also sets the project default.

## Apply manually in an isolated worktree

Use an existing migrated **isolated** database in this new worktree's `.t3`.
Do not copy live data or use `migrate-dev-db`. If initialization is needed later,
run `vp run dev --no-seed` in this worktree, then stop
that server by its captured PID. No server/browser/build/install is needed to
_generate_ these files. Stop the isolated server before every application.

From the root of the new fixture worktree, choose a scenario listed in
`scenarios.json` (for example `xhigh-opus`):

```bash
python3 scripts/fixtures/issue-17110/seed.py \
  --scenario xhigh-opus --output .t3/issue-17110/xhigh-opus
mkdir -p /tmp/t3-issue-17110-synthetic-project .t3/issue-17110/claude-home
cp .t3/issue-17110/xhigh-opus/claude-settings.json \
  .t3/issue-17110/claude-home/settings.json
# Server MUST be stopped. This explicitly targets only this worktree's .t3.
python3 - <<'PY'
import sqlite3
from pathlib import Path
root = Path.cwd().resolve()
assert (root / '.git').is_file(), 'Run from the new worktree root'
db = root / '.t3/userdata/statev2.sqlite'
assert db.is_file() and not db.is_symlink()
assert db.resolve().is_relative_to(root / '.t3')
with sqlite3.connect(db.as_uri() + '?mode=rw', uri=True) as connection:
    connection.executescript((root / '.t3/issue-17110/xhigh-opus/seed.sql').read_text())
PY
```

For another scenario change both `xhigh-opus` paths above. Each SQL transaction
replaces only `issue-17110-project` and `issue-17110-thread`; unrelated projects
and threads are untouched. Existing isolated DBs are supported. Do not submit,
resume, fork, or otherwise run this synthetic thread: projection-only data has no
event history. If a turn was accidentally started, discard the isolated fixture
DB and initialize an empty one again; reseeding does not remove turn history.

In the isolated environment's provider Settings, point the Claude instance
`claudeAgent` **homePath** to the absolute path printed by
`realpath .t3/issue-17110/claude-home`. Keep its binary path pointed at the real
installed Claude CLI. Do not point it at your normal Claude home or copy auth
files. Disable provider update checks (`enableProviderUpdateChecks: false`) in
this isolated environment, and use the bundled model manifest at the recorded
commit, not a previously downloaded `.t3/userdata/model-manifest.json` cache.
Stop/restart the isolated server after changing each scenario's settings so the
capability probe is fresh. Check its effective settings match the scenario before
capturing. The settings files contain only cap configuration; no `env` or secrets.

## Capture matrix and limits

`scenarios.json` records each input and expected label: no cap and global `xhigh`
for current Haiku 5.5/Opus 5.5; global `high` labels; Sonnet 4.6's already-remapped
Max; Opus 4.6's Max capped to High; project defaults; Max + Fast; per-model alias
exemption; Ultracode above/at cap. The per-model scenario deliberately uses
`modelSettings.opus.maxEffortLevel = max` under global `xhigh`, with canonical
Sonnet 5.5 capped to High. It requires the final fix's alias lookup; the base
commit alone may still show the regression. Record the final implementation SHA
alongside this fixture SHA. These are expected results, not claimed observations.

Use the committed browser action steps and capture metadata: dark, en-US, UTC,
1440×900 CSS pixels, 100% zoom. Record actual DPR (e.g. browser DPR 2) as an
override. For a separately requested mobile-sized web capture use 390×844 and
record that override. Freeze Date only for capture, preserving native timers;
the generator itself does not install any browser hooks. Record exact injection,
CLI/browser versions, manifest identity, and overrides with fresh captures.

The real CLI is needed for the effective-settings/capability probe; no account
turn or prompt submission is necessary. A CLI that rejects `get_settings`,
managed/project settings, auth availability, or a different model manifest can
change the result: record this as friction, not a successful cap capture. Do not
substitute the unit tests' synthetic CLI or capability JSON for provider integration.

**Projection fixtures prove rendering only.** Provider-cap logic is covered by
existing `ClaudeModelCatalog.test.ts`, `ProviderRegistry.test.ts`, and
`ProviderInstanceRegistry.test.ts`, plus the separate real-CLI runtime probe;
this seed neither reruns nor replaces that evidence. No browsers, dev servers,
account turns, or native app verification were performed to create this fixture.
Web/desktop-shell captures and native mobile remain unverified until performed.

Validation at creation: all 12 scenarios regenerated byte-identically and applied
twice against scratch SQLite using actual projection table DDL; JSON selections,
project defaults, and `PRAGMA integrity_check` passed. Friction: no isolated DB
was available, so only table definitions were read from the live database with
`mode=ro`; no rows were copied and all SQL writes went to disposable scratch DBs.
