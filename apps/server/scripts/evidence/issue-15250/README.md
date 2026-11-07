# #15250 runtime evidence

Run `node apps/server/scripts/evidence/issue-15250/run.mjs --checkout <server checkout> --out <scratch dir> --port <port>` once per SHA (with `vp i` done in the checkout). It starts a real server against an isolated home in `<scratch dir>`, with Codex replaced by the STUBBED Codex app-server in `stub-codex-app-server.mjs`. Then it prints, for each row, the child `thread/read` and `thread/resume` requests with their timings and the subagent model the projection stores.
