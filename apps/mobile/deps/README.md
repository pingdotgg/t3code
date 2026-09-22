# Enriched Markdown prototype package

The tarball contains the prepared `react-native-enriched-markdown` package based on
upstream [bb2b0942](https://github.com/software-mansion/enriched-markdown/commit/bb2b0942a55555463fe129899d9c922038f10c41),
including the prototype's generic API extensions and native fixes. It replaces
the original pnpm patch and includes opt-in per-link context menus on iOS 17+.
JS, TypeScript declarations, generated native bindings, native sources, and the
MIT license are included. Enriched's postinstall restores its grammar dependencies
as usual. T3 supplies menu titles, actions and callbacks in JS through
`linkContextMenus`; the native package contains no app-specific menu actions.

To inspect the package, extract it with `tar -xzf <tarball>`. The resulting
`package/` directory contains the sources as well as the built outputs.

To replace it, build and prepare the updated Enriched package for npm publication,
then run `npm pack --ignore-scripts --pack-destination <this directory>` from that
prepared package directory. Do not pack an installed copy after postinstall has
downloaded the grammar sources. Use a new filename for each rebuilt package,
update the mobile dependency path, and run `vp install` to refresh the lockfile's
integrity hash and the matching `allowBuilds` entry in `pnpm-workspace.yaml`.

Switch back to the published dependency once the required upstream APIs ship.
