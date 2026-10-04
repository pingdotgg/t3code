# Embedded runtime inputs

This module installs a Termux-derived userland inside T3 Mobile. It does not
install or depend on the separate Termux Android application.

Termux package names, exact versions, archive URLs, SHA-256 checksums and the
package-recipe source revision are recorded in `scripts/android-runtime.lock.json`.
Builds use those exact inputs; first launch does not download executable code.
Package license files are retained in the runtime, together with
`licenses/upstream-inputs.json` linking to the pinned inputs and source recipes.
The packages have their respective upstream licenses; this project does not
relicense them. Preserve all notices and corresponding-source obligations when
distributing APKs containing these packages. CI publishes the matching upstream
sources and build recipes as `t3mobile-runtime-sources` alongside each APK;
`scripts/prepare-runtime-sources.py` reproduces that archive from the lock file.
GNU Bash and Readline patches are included with their upstream sources.

The bundled Codex is the community Android port from
https://github.com/DioNanos/codex-termux, version 0.155.0, derived from OpenAI Codex.
It is Apache-2.0 licensed. Its LICENSE and NOTICE are included under
`licenses/codex/` in the installed environment.

Node.js is MIT licensed with additional third-party notices. The npm and ws
license files are preserved in their installed package directories. Termux's
execution library remains under its upstream license.
