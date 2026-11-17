# This fork

A private copy of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) running Maria's
redesign. `main` is the top of the redesign stack (upstream PRs #28839 to #28845, branch
`maria/redesign/6-workspace-panes`) with our commits on top. That branch is force-pushed as it
is rebased onto upstream `main`, so the local and pushed branch `fork-base` marks the upstream
commit `main` sits on. Remotes: `upstream` is pingdotgg, `origin` is this repo.

Once the stack lands upstream, set `UPSTREAM_BRANCH` in `fork/src/t3_fork/__init__.py` to `main`.

Our commits so far:

- dithered usage widgets under the new-chat composer (`apps/web/src/components/chat/heroWidgets`);
  the design prototype and a screenshot are in `fork/widgets/`
- this `fork/` folder
- `themes/brave-kitty`: the Brave Kitty theme, as a git submodule of its own repo
  ([t3-themes](https://github.com/JoshuaHayesWasHere/t3-themes))

## Themes

Each theme under `themes/` stays its own repo, added as a submodule tracking its `main`. Work on
a theme in its repo and push; the next `t3-fork sync`, `build` or `apply` moves the submodule
to that repo's latest `main`, commits the bump here, and copies the theme's committed
`dist/*.json` and `dist/*.webp` into `~/.t3/userdata/themes`. The theme's own `build.sh` is not
run, so commit its `dist/` when you change it. Add another theme with
`git submodule add -b main <url> themes/<name>`.

After a fresh clone: `git submodule update --init`.

## Installing it

The redesign changes the server, contracts and desktop shell, not just `apps/web`, so the whole
desktop app is built from this tree. `t3-fork apply`:

1. moves `themes/*` to their repos' latest `main` (committing the bump), rebases `main` onto the
   redesign branch's latest head, moves `fork-base`, and pushes both,
2. runs `vp i` and the test files our commits touch,
3. builds the Linux AppImage with `scripts/build-desktop-artifact.ts` at a nightly-shaped
   version (`<desktop version>-nightly.<today>.<commit count>`), so it brands and stores its data
   exactly like the stock nightly (`~/.t3/userdata` is shared),
4. wraps it with `fork/pkg/PKGBUILD` into a `t3code-fork` pacman package in `~/.cache/t3-fork/pkg`,
   laid out like the AUR `t3code-nightly-bin` (`/opt/t3code-fork`, `/usr/bin/t3code-nightly`,
   the same desktop entry),
5. installs the themes into `~/.t3/userdata/themes`,

then removes `t3code-nightly-bin` if present (it conflicts) and installs the package. If a step
fails (dirty checkout, rebase conflict, a test, the build), nothing installed changes.

Nothing runs automatically: `yay` no longer upgrades T3 Code, since `t3code-fork` replaces the AUR
package. Run `t3-fork status` to see whether the redesign moved, then `t3-fork apply`.

## Commands

`t3-fork <command>`, a zsh alias for `uv run --project ~/repos/t3-fork/fork t3-fork`:

- `status`: the redesign branch's head, the fork's base and commit count, what is installed, themes.
- `sync`: update themes, rebase onto the redesign's latest head, and push.
- `build`: sync, test, and build the package without installing it.
- `apply`: build and install. Asks for sudo.

Work on `main` and commit normally (the repo's pre-commit hook runs fmt, lint and knip), then
`t3-fork apply`. A rebase conflict is resolved by hand with plain git (the error prints the
commands), then `t3-fork apply`.

## Undo

`sudo pacman -R t3code-fork && yay -S t3code-nightly-bin`
