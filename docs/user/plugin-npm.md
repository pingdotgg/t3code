# Installing plugins from npm

T3 Code can install a trusted plugin from an npm registry instead of a local
directory. Installing runs nothing: the plugin waits for your approval like
any added directory. Buttons for installing and updating arrive in the
clients later; until then, use an administrative connection and the
`plugins.npm.*` requests below. A standard pairing can list npm packages but
cannot install or update them.

## Installing a package

`plugins.npm.add` takes a package `name` and a `version`: an exact version
such as `1.2.0`, or a dist-tag such as `latest`. Ranges such as `^1.2.0` are
refused. T3 Code records the exact version the registry resolved, never the
tag. `registry` is optional and defaults to the public npm registry; give
another registry as an `http` or `https` URL without a user name, password,
query or fragment. Registries that need a login are not supported, and
`.npmrc` is not read.

Before anything is written, T3 Code checks that:

- the registry publishes a `sha512` integrity for that version, and the
  downloaded tarball matches it;
- the tarball is at most 32 MiB, unpacks to at most 10,000 files and 64 MiB,
  and every path stays inside the package (no links or special files);
- `package.json` has the requested name and version, no `preinstall`,
  `install` or `postinstall` script and no native build (`binding.gyp`), and
  every runtime dependency is bundled inside the package.

The package is then added like a directory and shows as needing your
approval. Approve its digest and enable it as usual. Each package can be
installed once per registry.

## Writing a package for T3 Code

Publish `t3-plugin.json` and the plugin's code at the package root. npm
dependencies are never installed for you, so list each runtime dependency in
`bundleDependencies` and publish it inside the package, or bundle your code
into one file.

## Updating

Updating takes two steps, so a new version never runs without your approval:

1. `plugins.npm.stageUpdate` with the installation and a version downloads and
   checks it next to the installed one, which keeps running. The reply shows
   the staged version, its manifest and its digest. Staging another version
   replaces it; a server restart forgets it.
2. `plugins.npm.applyUpdate` with the staged digest approves those exact files
   and swaps them in. If the plugin was enabled, it restarts on the new
   version. If anything fails before the new version is approved, the old
   version is put back. The earlier approval does not carry over to the new
   files.

`plugins.npm.discardUpdate` deletes a staged update. A new version must keep
the same plugin id.

## Removing

Remove the plugin with `plugins.remove`, as for any plugin. T3 Code deletes
its downloaded files once the plugin has stopped.
