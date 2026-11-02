# #29379 reproduction driver (scratch, not committed)

fake-agy.js stands in for Google's agy_acp_server: it answers `initialize` and `authenticate`
(with the Gemini Enterprise Plus tier `_meta` from the report) and never answers `session/new`.
Mode file next to the script: `stored` answers authenticate at once; `browser` first prints a
Google authorization URL marker on stderr and answers authenticate 20 s later (a completed browser login).

Setup per mode: copy fake-agy.js to <dir>/agy_acp_server, add an executable <dir>/localharness_external
(`#!/bin/sh\nexit 0`), write the mode to <dir>/mode, chmod +x both.
Server: `T3CODE_DEV_SEED=0 vp run dev`, then add to <worktree>/.t3/userdata/settings.json under providerInstances:
  "agyStored":  {"driver":"antigravity","displayName":"Antigravity (stored)","enabled":true,
                 "config":{"enabled":true,"authMethod":"oauth-business","gcpProject":"fake-project","gcpLocation":"eu",
                           "binaryPath":"<stored dir>/agy_acp_server"}}
  "agyBrowser": same with the browser dir.
Then Settings > Providers > Antigravity (stored|browser) > Sign in, read the Account row at 35 s and after 300 s.
