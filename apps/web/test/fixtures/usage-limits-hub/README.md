# Usage limits hub fixture

A fake CLIProxyAPI hub that serves the Limits evidence scenarios in `scenarios.json`:

| Scenario | Accounts                                                       |
| -------- | -------------------------------------------------------------- |
| A        | mixed Codex and Claude accounts                                |
| B        | one account per provider                                       |
| C        | six long-email Codex accounts                                  |
| L        | named accounts (no email, so segments show the auth-file name) |
| T        | forty accounts, so pooled segments are 4px wide at 390px       |

Reset times are minute offsets from `n0`.

## Rebuild a capture

1. Start a dev server with empty provider homes, so local logins add no accounts:

   ```sh
   CODEX_HOME=$(mktemp -d) CLAUDE_CONFIG_DIR=$(mktemp -d) vp run dev
   ```

2. Write `state.json` as `{"scenario": "A", "n0": 1792515540000}`. That `n0` is 2026-10-20T16:59:00Z, the instant every published capture uses. Then start the hub:

   ```sh
   node hub.mjs state.json 18517
   ```

3. Under Settings → Providers → Usage limit sources, add a hub with URL `http://127.0.0.1:18517`, any management key, and label `Team hub`. The composer panel prints that label on every account row.

4. Freeze the browser clock at `n0` from the devtools console:

   ```js
   const T = 1792515540000;
   const R = Date;
   window.Date = class extends R {
     constructor(...a) {
       super(...(a.length ? a : [T]));
     }
     static now() {
       return T;
     }
   };
   ```

   Then re-read the time:
   - On the Usage page, select Cost and then Limits again.
   - Open the composer panel with `/usage-limits` after freezing.
   - The sidebar's relative timestamp picks up the frozen clock on its next minute tick.

5. Viewports and themes: emulate `prefers-color-scheme` light and dark, and wait a few seconds after switching theme or size so transitions and overlay scrollbars settle.

   | Surface                                         | Viewport                              |
   | ----------------------------------------------- | ------------------------------------- |
   | Usage page                                      | 1440×900 and 390×1500                 |
   | Scenario T                                      | 390×3100, so the page does not scroll |
   | Composer panel, Codex thread (`gpt-6-astra`)    | 1440×900                              |
   | Composer panel, Claude thread (Claude Opus 5.5) | 390×1300                              |

6. Edit `state.json` and press Refresh limits to switch scenarios.

## Not from the fixture

- **"Codex: Could not read limits."** That banner comes from the local Codex install, which is unauthenticated with an empty `CODEX_HOME`.
- **"Claude API Key" rows** in the Claude composer panel come from the local Claude install, not the fixture.
