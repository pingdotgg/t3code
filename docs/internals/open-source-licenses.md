# Open source license notices

License notices are generated independently for the client that ships them:

- The web build emits `third-party-licenses.json` beside `index.html`. The Settings page loads that
  static file, so the same artifact works in hosted web, the client bundled with `npx t3`, and
  desktop.
- The mobile Metro config generates an ignored virtual module before each development, native, or
  over-the-air JavaScript bundle. Mobile reads the manifest directly from that module and does not
  need a network request.

Neither path depends on the connected environment or an RPC.

## What the build collects

The generator follows installed production and optional dependencies, including dependencies of
workspace packages, and omits first-party `@t3tools/*` packages. The web manifest starts from the
web, server, and desktop package manifests. The mobile manifest starts from the mobile package
manifest. During the web bundle, the generator also checks emitted module ids to catch a bundled
npm import missing from a package manifest.

The mobile manifest deliberately follows the complete production dependency closure declared by
Expo and React Native. That is conservative and can include build tooling that is not present in
the final JavaScript bundle, but it avoids dropping a notice when platform bundling changes.

The build fails when a collected package has no distributable license identifier or contains no
license or notice text. Generated notices use license templates from the pinned SPDX License List.
Strict web and EAS builds download a missing template into the gitignored `.generated/` cache;
`pnpm licenses:sync` can warm that cache explicitly. Local web and Metro development do not make a
network request and omit generated rows until the cache exists. This keeps dev startup optional
while preventing incomplete release artifacts.

## Custom notices and package overrides

The repository-level `third-party-licenses.config.json` holds manually maintained exceptions for
all clients. Add an entry to `customNotices` for adapted icons, fonts, media, native modules, or
another asset that did not come from an npm package:

```json
{
  "name": "asset-name",
  "license": "CC-BY-4.0",
  "generatedNotices": [
    {
      "licenseId": "CC-BY-4.0",
      "preamble": ["Asset by Example Author. Changes: converted to MP3."]
    }
  ],
  "sourceUrl": "https://example.com/source",
  "bundles": ["assets", "web"]
}
```

Each `generatedNotices` item names an SPDX license template and can add `copyrights` or a short
`preamble` for attribution and provenance. Multiple items are joined into one row for software
that vendors separately licensed code. Keep `noticeFile` or `noticeFiles` only when a vendored
source tree already carries an intrinsic license file that should remain beside it. Paths are
relative to the config file. `bundles` controls which generated manifests include the entry and
supplies the label shown to users. Use `includeInBundles` when those differ, such as an optional
server tool that should appear in both client manifests but is not bundled into either client.

Use `packageOverrides` only when an installed npm archive omits its notice or has incorrect
metadata:

```json
{
  "name": "package-name",
  "version": "1.2.3",
  "generatedNotice": {
    "licenseId": "MIT",
    "copyrights": ["Copyright (c) 2026 Example Author"]
  },
  "license": "MIT",
  "sourceUrl": "https://example.com/package-name"
}
```

`version`, `license`, and `sourceUrl` are optional. Omitting `version` applies the override to every
installed version of that package. An override can use `repositoryUrl` instead of `name` when
several packages from one monorepo share the same notice:

```json
{
  "repositoryUrl": "https://github.com/example/project",
  "generatedNotice": {
    "licenseId": "Apache-2.0"
  }
}
```

The generator also reuses an installed sibling package's notice when both packages declare the
same normalized repository and license. A name-and-version override always wins over these
repository fallbacks.

The `@react-grab/cli` override uses the root React Grab repository's MIT license because the CLI's
npm archive omits both its license field and license file. Keep the override until the published
CLI package carries that metadata itself.

Generated mobile files live under `apps/mobile/.generated/`, while fetched SPDX templates live
under the repository `.generated/` directory. Both are ignored. Do not commit or edit them;
updating dependencies or configuration is enough for the next strict build to refresh the output.
