# This fork

A private copy of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). `main` is an upstream
nightly tag with our commits on top, rebased onto each new nightly. Remotes: `upstream` is
pingdotgg, `origin` is this repo.

Our commits so far:

- dithered usage widgets under the new-chat composer (`apps/web/src/components/chat/heroWidgets`)
- this `fork/` folder

## Installing it

The app itself still comes from the stock AUR `t3code-nightly-bin` through `yay`. While the fork
only changes `apps/web`, there is no need to build the whole desktop app: the web UI ships as
one folder (`apps/server/dist/client`) inside `resources/app.asar`, and `t3-fork` swaps it.

After each `yay` install or upgrade of `t3code-nightly-bin`, the pacman hook
(`/etc/pacman.d/hooks/t3-fork.hook`) runs, as your user, `t3-fork build`:

1. rebase `main` onto the tag of the installed nightly and push it,
2. refuse if the fork changes anything outside `apps/web` and `fork/`,
3. run the fork's changed web tests, build `apps/web` at that version with nightly branding,
4. write `~/.cache/t3-fork/app.asar`: the installed asar with only the client folder replaced,

then, as root, installs that file over `/opt/t3code-nightly-bin/resources/app.asar`. If any step
fails (dirty checkout, rebase conflict, a test), nothing changes and the stock UI stays.

## Commands

`t3-fork <command>`, a zsh alias for `uv run --project ~/repos/t3-fork/fork t3-fork`:

- `status`: installed nightly, latest nightly, fork base and commit count, what is applied.
- `sync [--latest]`: rebase onto the installed (or newest) nightly and push.
- `apply`: build and install by hand, e.g. after committing a change. Asks for sudo.
- `build`: what the hook runs; writes the patched asar only.
- `setup`: install the pacman hook, then apply.

Work on `main` and commit normally (the repo's pre-commit hook runs fmt, lint and knip), then
`t3-fork apply`. A conflict during a rebase is resolved by hand with plain git, then `t3-fork apply`.

When the fork grows past `apps/web` (server or desktop changes), the web swap is no longer
enough: that needs the full `scripts/build-desktop-artifact.ts` AppImage build packaged in
place of `t3code-nightly-bin`.

## Undo

`sudo rm /etc/pacman.d/hooks/t3-fork.hook && yay -S t3code-nightly-bin`
