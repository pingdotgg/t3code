---
name: t3code-update
description: Update Leo's T3 Code from source (~/Projects/T3/t3code), rebuild it, and restart the systemd service that runs it, or start the isolated dev stack over Tailscale. Use when Leo asks to update, rebuild, restart, or run T3 Code / t3code, or to start its dev server.
---

# T3 Code from source: update and run

Leo runs T3 Code from his clone at `~/Projects/T3/t3code` instead of the installed release, on more than one machine (omarchy, distilo). Check which one you are on with `hostname` and read its own drop-in and `service.env` rather than assuming the values below. The normal update path is the app's Update / Rebuild button, which runs `scripts/self-update.sh`; the steps below are the manual equivalent. Reply to him in Portuguese.

## Setup

- **Production service:** the systemd user unit `t3code.service` has the drop-in `~/.config/systemd/user/t3code.service.d/source.conf`. It runs `node apps/server/dist/bin.mjs serve --base-dir ~/.t3 --no-browser`, with `EnvironmentFile=~/.t3/service.env` (`T3CODE_HOST=127.0.0.1`, `T3CODE_PORT=3773`).
- **Real data:** `~/.t3/userdata`. The service log is `~/.t3/userdata/logs/boot-service.log`.
- **Tailnet:** `tailscale serve` maps this machine's tailnet name (`tailscale serve status`) to `127.0.0.1:3773`.
- **The release's own updater is out of the loop.** `t3 update` and the release service launcher are not used. Never repoint the unit back at `~/.t3/runtime/versions/*`.
- **`vp` (Vite+) is not on PATH by default.** Prefix commands with `. ~/.config/vite-plus/env &&`.

## Update and restart the service

```sh
. ~/.config/vite-plus/env
cd ~/Projects/T3/t3code
git status --short          # commit or stash local work first
git pull origin main        # origin = christinoleo/t3code (Leo's fork; maestro workers merge here)
git fetch upstream          # upstream = pingdotgg/t3code (Theo). Never push or open PRs there.
git merge upstream/main     # merge, not rebase: workers build on origin/main
git push origin main
vp i                        # only needed when the lockfile changed, but cheap
vp run workflow:link        # re-links workflow/skills into each provider's skill folder
vp run --filter t3 build    # builds apps/web and bundles it into apps/server/dist
systemctl --user restart t3code
```

Then verify:

```sh
systemctl --user is-active t3code
grep -aE "Migrations ran|Listening on" ~/.t3/userdata/logs/boot-service.log | tail -3
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3773/
```

- Ask Leo before restarting if agent turns may be running. A restart interrupts them.
- A new version may migrate `~/.t3/userdata/statev2.sqlite`. Leo does not need a way back, but a cheap backup is a read-only `sqlite3 "file:$HOME/.t3/userdata/statev2.sqlite?mode=ro" ".backup '<dest>'"`.
- Do not print `boot-service.log` wholesale. It contains pairing QR codes and tokens.

## Pair a new browser with the service

```sh
node ~/Projects/T3/t3code/apps/server/dist/bin.mjs pair --base-dir ~/.t3 --tailscale --ttl 30m --label "<device>"
```

Give Leo the `Pairing URL` line. Do not open it yourself; a token is consumed on first use.

## Dev stack (hot reload, isolated data, over Tailscale)

`~/Projects/T3/t3code` is the main checkout, not a linked worktree. Because of that, plain `vp run dev` falls back to the REAL `~/.t3` and runs a second server on Leo's live database. Always pass `--home-dir`.

```sh
. ~/.config/vite-plus/env
cd ~/Projects/T3/t3code
# Refresh the isolated copy of real data (dev must be stopped). Reads ~/.t3 read-only.
vp run migrate-dev-db --base-dir /home/christinoleo/Projects/T3/t3code/.t3
# Start in the background from your own shell; stop it with the harness's task stop.
vp run dev --share --home-dir /home/christinoleo/Projects/T3/t3code/.t3
```

- Confirm the `[dev-runner]` line shows `baseDir=/home/christinoleo/Projects/T3/t3code/.t3`. If it shows `~/.t3`, stop the dev stack immediately.
- Wait for the `pairingUrl:` line and give that URL to Leo. The dev web port is 5733 and the server is on 13773, shared at port 5733 of this machine's tailnet name.
- UI changes in `apps/web` hot-reload in dev. They reach the service only after `vp run --filter t3 build` and `systemctl --user restart t3code`.
