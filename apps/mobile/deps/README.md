# Mobile forked dependencies

Change a tarball in this directory through its fork, never with a pnpm patch: `.pnpmfile.cjs` fails the install when `patchedDependencies` names one, since the next tarball would drop the patch without a trace. Native clients need rebuilding whenever either dependency changes.

## `react-native-screens`

Built from the [T3 Screens fork](https://github.com/pingdotgg/react-native-screens) (`t3/main`, version `5.0.0-t3.N`). Each tarball includes compiled JS, declarations, native source, and `t3-fork.json` recording its version, source commit, and upstream base.

To update, sync `main` with upstream, merge it and required branches into `t3/main`, bump `5.0.0-t3.N`, pin `t3Fork.upstreamCommit`, commit, tag `t3-v<version>`, and pack from a clean checkout with Node 24 and the fork's pinned Yarn:

```sh
yarn --cwd /tmp/t3-screens-fork pack:t3 /absolute/path/to/t3code/apps/mobile/deps
```

Push the commit and tag before submitting the app change, replace the old archive, update `apps/mobile/package.json`, and run `vp i`. The same iOS binary supports iPhone, iPad, and Duo; Duo support requires a binary built with the iOS 27.1 SDK (an OTA cannot add native APIs).

## `react-native-enriched-markdown`

Built from Julius's [`fork/t3-mobile` branch](https://github.com/pingdotgg/enriched-markdown/tree/fork/t3-mobile). Its `t3-fork.json` records the exact source commit and upstream base. React block renderers, signed image sources, the `onLinksChange` link list (`renderers`, `resolveImageSource`, `onLinksChange`), the iOS streaming memory bounds, `onSelectionCopy` and iOS Copy as Markdown keeping bold spans whole are upstream. The fork carries only changes with an open upstream PR: clipboard link metadata ([#962](https://github.com/software-mansion/enriched-markdown/pull/962)), development-host autolinks ([#961](https://github.com/software-mansion/enriched-markdown/pull/961)) and hash-route link fragments ([mity/md4c#454](https://github.com/mity/md4c/pull/454), arriving through [md4c#7](https://github.com/software-mansion-labs/md4c/pull/7)), `md4cFlags.preserveWindowsPaths`, which keeps backslashes in Windows drive paths in prose ([#1105](https://github.com/software-mansion/enriched-markdown/pull/1105), after [mity/md4c#477](https://github.com/mity/md4c/pull/477)), GitHub's strikethrough rules for `~` ([md4c#6](https://github.com/software-mansion-labs/md4c/pull/6)), `\(…\)` and `\[…\]` math delimiters ([#1043](https://github.com/software-mansion/enriched-markdown/pull/1043), [md4c#4](https://github.com/software-mansion-labs/md4c/pull/4)), line breaks in copied table cells written as `<br>` ([#1144](https://github.com/software-mansion/enriched-markdown/pull/1144)), and Android measuring text in the span order its view draws it, so code blocks nested in list items no longer make a reply overlap the next message ([#1145](https://github.com/software-mansion/enriched-markdown/pull/1145)), iOS code blocks too big for one backing store drawing through tiles, so a tall block with long lines no longer shows an empty pane ([#1231](https://github.com/software-mansion/enriched-markdown/pull/1231)), and a long-pressed iOS blockquote lifting on the background it sits on instead of drawing its text over the thread ([#1232](https://github.com/software-mansion/enriched-markdown/pull/1232)).

To replace it, commit the fork changes, run `yarn install --immutable` and `yarn workspace react-native-enriched-markdown prepare` in the fork checkout, then `node scripts/pack-t3.mjs /path/to/t3code/apps/mobile/deps`. Keep the package version aligned with Julius's `fork/t3-mobile` branch. Rename the archive to include the first eight characters of the source commit, such as `react-native-enriched-markdown-1.2.0-t3.19-a01cbf49.tgz`, so each build has a distinct dependency path without version bumps. Update the tarball path in `apps/mobile/package.json` and `pnpm-workspace.yaml`'s `allowBuilds`, and run `vp i` to update the lockfile.
