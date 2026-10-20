# Usage limits hub fixture

A fake CLIProxyAPI hub that serves the Limits evidence scenarios in `scenarios.json`
(A mixed, B one account per provider, C six long-named Codex accounts, L named accounts,
T forty accounts). Run `node hub.mjs state.json 18517` with `state.json` set to
`{"scenario": "A", "n0": <epoch ms>}`, add `http://127.0.0.1:18517` with any management key
under Settings → Usage limit sources in a dev server, and freeze the browser clock at `n0`.
Edit `state.json` and press Refresh limits to switch scenarios.
