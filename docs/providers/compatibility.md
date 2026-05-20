# Provider Compatibility Map

This guide is for maintainers updating `provider-compatibility.v1.json`.

T3 Code bundles this file at build time and also fetches a hosted copy at
runtime. The hosted copy is the maintainer-overridable source of truth: old
installs can receive newer compatibility policy without updating the app. The
fetch is best effort, so the bundled copy must remain conservative and useful
when the user is offline or hosted endpoints are unavailable.

## When To Update It

Update the map when a provider harness release changes compatibility with a T3
Code release.

Examples:

- Codex ships an app-server breaking change.
- OpenCode changes its SDK or CLI behavior.
- Cursor changes ACP behavior.
- A new T3 Code release restores support for a provider version that older T3
  Code releases cannot support.

## Policy Shape

Each policy applies to one provider driver and one T3 Code version range.

```json
{
  "t3CodeRange": ">=0.0.24 <0.0.25",
  "driver": "codex",
  "recommendedRange": ">=0.129.0 <0.131.0",
  "recommendedVersion": "0.130.0",
  "ranges": [
    {
      "status": "supported",
      "range": ">=0.129.0 <0.131.0",
      "label": "Known working Codex app-server harness"
    },
    {
      "status": "broken",
      "range": "<0.129.0",
      "label": "Known incompatible Codex app-server harness"
    },
    {
      "status": "broken",
      "range": ">=0.131.0",
      "label": "Known incompatible Codex app-server harness"
    }
  ]
}
```

Fields:

- `t3CodeRange`: T3 Code versions this policy applies to.
- `driver`: provider driver id. Current ids include `codex`, `claudeAgent`,
  `opencode`, and `cursor`.
- `recommendedRange`: the harness range users should be on.
- `recommendedVersion`: a concrete version to suggest when possible.
- `ranges`: ordered harness-version classifications.

Statuses:

- `supported`: known working.
- `graceful`: still expected to work, but users should update.
- `unsupported`: outside the maintained range.
- `broken`: known incompatible; the app shows an error-level advisory.
- `unknown`: not tested or not enough signal yet.

## Version Ranges

The range syntax is intentionally small:

- comparators: `=`, `<`, `<=`, `>`, `>=`, `^`
- spaces mean AND, for example `>=0.129.0 <0.131.0`
- `||` means OR
- two-segment versions are treated as patch zero, for example `>=24.10`

Provider and T3 Code prerelease suffixes are ignored for compatibility
comparison. For example:

- `2026.05.09-0afadcc` matches `>=2026.05.09`
- `0.0.24-nightly.20260513.1` matches `>=0.0.24`

## Handling Provider Breakages

If Codex `0.131.0` breaks T3 Code `0.0.24`, narrow the existing Codex policy for
that app release and mark the new Codex range as broken:

```json
{
  "t3CodeRange": ">=0.0.24 <0.0.25",
  "driver": "codex",
  "recommendedRange": ">=0.129.0 <0.131.0",
  "recommendedVersion": "0.130.0",
  "ranges": [
    { "status": "supported", "range": ">=0.129.0 <0.131.0" },
    { "status": "broken", "range": "<0.129.0" },
    { "status": "broken", "range": ">=0.131.0" }
  ]
}
```

If T3 Code `0.0.25` fixes that breakage, add a separate policy for newer app
versions instead of leaving a single broad `>=0.0.24` policy:

```json
{
  "t3CodeRange": ">=0.0.25",
  "driver": "codex",
  "recommendedRange": ">=0.131.0",
  "recommendedVersion": "0.131.0",
  "ranges": [{ "status": "supported", "range": ">=0.131.0" }]
}
```

Keep T3 Code ranges as narrow as needed. A broad app range such as `>=0.0.24`
means future app releases inherit the same provider policy until the hosted map
is updated again.

## Full Breakage Recovery Flow

Use this sequence when a provider release breaks existing T3 Code installs.

1. A provider ships a breaking harness release.
2. Update the hosted map on `main` so existing T3 Code installs classify that
   provider version correctly. For example, mark Codex `>=0.131.0` as `broken`
   for `t3CodeRange: ">=0.0.24 <0.0.25"`.
3. Existing installs fetch the hosted map best-effort and show the compatibility
   advisory without requiring an app update.
4. Ship a T3 Code fix in a new app release.
5. Update the bundled `provider-compatibility.v1.json` in that release so fresh
   installs and offline users have the fixed policy baked in.
6. Update the hosted map again with a separate policy for the fixed T3 Code
   version. For example, add `t3CodeRange: ">=0.0.25"` that marks Codex
   `>=0.131.0` as `supported`.

The hosted map is the emergency override for already-released builds. The
bundled map is the conservative fallback for future downloads, fresh installs,
and offline sessions.

## Hosting

The default runtime URLs are tried in order:

```text
https://t3.codes/provider-compatibility.v1.json
https://raw.githubusercontent.com/pingdotgg/t3code/main/provider-compatibility.v1.json
```

The marketing app build mirrors the repo-root `provider-compatibility.v1.json`
into `apps/marketing/public/provider-compatibility.v1.json`, so marketing
deployments publish the primary `https://t3.codes/...` copy as a static asset.
The GitHub raw URL remains a fallback mirror.

## Updating The Hosted Map

The primary hosted map is:

```text
https://t3.codes/provider-compatibility.v1.json
```

To update compatibility policy for existing installs:

1. Edit `provider-compatibility.v1.json` on `main`.
2. Keep the JSON schema version at `1`.
3. Prefer non-overlapping `t3CodeRange` values when app releases differ.
4. Include a concrete `recommendedVersion` when a one-click install target is
   known.
5. Ensure the marketing app release/deploy runs so the primary static copy is
   updated.
6. Validate with `bun fmt`, `bun lint`, and `bun typecheck`.

Old installs cache the remote map briefly, so hosted changes are not always
visible immediately.
