# Workspace reader

[extension.ts](extension.ts) is the complete author source. It reads README.md through the public workspace API and renders text. Change the file path/title first; the build generates metadata and bundles public imports.

Run npm run build, then npm run check. Install .t3-extension on the target environment with its project and t3.workspace/read-text grant. Open Extensions → Workspace README. Rebuild and update after edits.

The generated receipt contains hashes of the actual output and says installed: false. [authoring.test.mjs](../../test/authoring.test.mjs) checks lifecycle behavior; [authoring-package.test.mjs](../../test/authoring-package.test.mjs) exercises build/check against an external package. Neither substitutes for the installed journey.
