import { describe, expect, it } from "vite-plus/test";

import {
  aiReviewerDisplayBody,
  aiReviewerFixText,
  aiReviewerOneLine,
  hasAiReviewerEasyFix,
  parseAiReviewerFeedback,
} from "./aiReviewerFeedback.ts";
import { isBotBadgeImage } from "./botBadgeImages.ts";

const CODERABBIT_FINDING = `_⚠️ Potential issue_ | _🟡 Minor_

**Guard against stale \`lastEditor\` values in localStorage.**  
If localStorage contains an unknown editor id (older versions, manual edits), the IPC handler will throw. Prefer validating against \`EDITORS\` and falling back.  

<details>
<summary>🧩 Analysis chain</summary>

🏁 Script executed:

\`\`\`shell
cat -n apps/renderer/src/components/ChatView.tsx | sed -n '66,69p'
\`\`\`

Length of output: 120

---

</details>

<details>
<summary>🧩 Suggested fix</summary>

\`\`\`diff
-  const [lastEditor, setLastEditor] = useState(
-    () => localStorage.getItem(LAST_EDITOR_KEY) ?? EDITORS[0].id,
-  );
+  const [lastEditor, setLastEditor] = useState(() => {
+    const stored = localStorage.getItem(LAST_EDITOR_KEY);
+    return EDITORS.some((editor) => editor.id === stored)
+      ? stored
+      : EDITORS[0].id;
+  });
\`\`\`
</details>

<!-- suggestion_start -->

<details>
<summary>📝 Committable suggestion</summary>

> ‼️ **IMPORTANT**
> Carefully review the code before committing.

\`\`\`suggestion
  const [lastEditor, setLastEditor] = useState(() => {
    const stored = localStorage.getItem(LAST_EDITOR_KEY);
    return EDITORS.some((editor) => editor.id === stored)
      ? stored
      : EDITORS[0].id;
  });
\`\`\`

</details>

<!-- suggestion_end -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

\`\`\`
In \`@apps/renderer/src/components/ChatView.tsx\` around lines 66 - 69, Validate the
value read from localStorage under LAST_EDITOR_KEY against the known EDITORS
list before using it as the initial state for lastEditor.
\`\`\`

</details>

<!-- fingerprinting:phantom:poseidon:eagle -->

<!-- This is an auto-generated comment by CodeRabbit -->

✅ Addressed in commit 6204eaf
`;

const MACROSCOPE_FINDING = `🟢 **Low**

\`scripts/smoke-test.mjs:41\` The \`setTimeout\` at line 44 leaks if the process exits before the timeout fires. Consider clearing the timer when the race resolves.

\`\`\`diff
-  const exited = await Promise.race([
-    waitForProcessExit(processRef).then(() => true),
-    new Promise((resolve) => {
-      setTimeout(() => resolve(false), timeoutMs);
-    }),
-  ]);
+  let timer;
+  const exited = await Promise.race([
+    waitForProcessExit(processRef).then(() => true),
+    new Promise((resolve) => {
+      timer = setTimeout(() => resolve(false), timeoutMs);
+    }),
+  ]);
+  clearTimeout(timer);
\`\`\`
> 🚀 **Want me to fix this? Reply ex: _"fix it for me"_.**

<details>
<summary><strong>🤖 Prompt for AI</strong></summary>

\`\`\`text
In file apps/t3/scripts/smoke-test.mjs around lines 41-46:

The \`setTimeout\` at line 44 leaks if the process exits before the timeout fires. Consider clearing the timer when the race resolves.
\`\`\`
</details>
`;

const BUGBOT_FINDING = `### CI checks outdated preload artifact name

**Medium Severity**

<!-- DESCRIPTION START -->
The workflow still validates \`apps/desktop/dist-electron/preload.js\`, but this change switches desktop artifacts to module-specific outputs (\`main.mjs\` and \`preload.cjs\`).
<!-- DESCRIPTION END -->

<!-- BUGBOT_BUG_ID: 40ac3287-f3a9-454e-abb9-bb52358d543b -->

<!-- LOCATIONS START
.github/workflows/ci.yml#L52-L54
apps/desktop/package.json#L4-L6
LOCATIONS END -->
<details>
<summary>Additional Locations (1)</summary>

- [\`apps/desktop/package.json#L4-L6\`](https://github.com/example/repo/blob/abc/apps/desktop/package.json#L4-L6)

</details>

<p><a href="https://cursor.com/open?data=eyJhbGciOiJSUzI1NiJ9" target="_blank" rel="noopener noreferrer"><picture><source media="(prefers-color-scheme: dark)" srcset="https://cursor.com/assets/images/fix-in-cursor-dark.png"><img alt="Fix in Cursor" width="115" height="28" src="https://cursor.com/assets/images/fix-in-cursor-light.png"></picture></a></p>
`;

const DEVIN_FINDING = `<!-- devin-review-comment {"id": "BUG_1", "file_path": "apps/server/src/ws.ts", "start_line": 10, "end_line": 10, "side": "RIGHT"} -->

🟡 **WebSocket URL fallback produces invalid URL on default HTTP port**

When neither \`desktopBridge\` nor \`VITE_WS_URL\` provides a URL, the fallback constructs an invalid URL on default ports.

<details>
<summary>Detailed Explanation</summary>

Per the spec, \`window.location.port\` returns \`""\` for default ports.

</details>

\`\`\`suggestion
        : \`ws://\${window.location.host}\`);
\`\`\`

<!-- devin-review-badge-begin -->
<a href="https://app.devin.ai/review/example/repo/pull/1" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://static.devin.ai/assets/gh-open-in-devin-review-dark.svg?v=1">
    <img src="https://static.devin.ai/assets/gh-open-in-devin-review-light.svg?v=1" alt="Open in Devin Review"/>
  </picture>
</a>
<!-- devin-review-badge-end -->
`;

const GREPTILE_FINDING = `**Fetch fetches all refs from remote, not just the branch**

\`git fetch --quiet --no-tags <remote>\` fetches all branches from the remote, not just the one that was checked out.

\`\`\`suggestion
    const branchRef = upstreamRef.slice(separatorIndex + 1);
    await this.git(cwd, ["fetch", "--quiet", "--no-tags", remoteName, branchRef], true);
\`\`\`

**Context Used:** Context from \`dashboard\` - CLAUDE.md ([source](https://app.greptile.com/review/custom-context?memory=758521e8-b620-4ba8-8ebe-e55595bf1c33))

<sub>Note: If this suggestion doesn't match your team's coding style, reply to this and let me know. I'll remember it for next time!</sub>
`;

const GEMINI_FINDING = `**[severity: high]** correctness: null check missing before dereference

\`user.profile.name\` is accessed without verifying \`user.profile\` exists.

\`\`\`suggestion
if (user.profile == null) {
  return;
}
const name = user.profile.name;
\`\`\`
`;

describe("parseAiReviewerFeedback", () => {
  it("extracts CodeRabbit severity, finding, suggestion, and agent prompt", () => {
    const parsed = parseAiReviewerFeedback(CODERABBIT_FINDING);
    expect(parsed).not.toBeNull();
    expect(parsed?.category).toBe("Potential issue");
    expect(parsed?.severity).toBe("Minor");
    expect(parsed?.summary).toContain("Guard against stale");
    expect(parsed?.summary).not.toContain("Analysis chain");
    expect(parsed?.summary).not.toContain("Addressed in commit");
    expect(parsed?.agentPrompt).toContain("Validate the\nvalue read from localStorage");
    expect(parsed?.suggestion).toContain("```suggestion");
    expect(hasAiReviewerEasyFix(CODERABBIT_FINDING)).toBe(true);
  });

  it("extracts Macroscope severity and Prompt for AI", () => {
    const parsed = parseAiReviewerFeedback(MACROSCOPE_FINDING);
    expect(parsed?.severity).toBe("Low");
    expect(parsed?.summary).toContain("setTimeout");
    expect(parsed?.agentPrompt).toContain("smoke-test.mjs around lines 41-46");
    expect(hasAiReviewerEasyFix(MACROSCOPE_FINDING)).toBe(true);
  });

  it("extracts Bugbot title, severity, description, and Easy fix prompt", () => {
    const parsed = parseAiReviewerFeedback(BUGBOT_FINDING);
    expect(parsed?.severity).toBe("Medium");
    expect(parsed?.summary).toContain("CI checks outdated preload artifact name");
    expect(parsed?.summary).toContain("module-specific outputs");
    expect(parsed?.summary).not.toContain("Additional Locations");
    expect(parsed?.summary).not.toContain("Fix in Cursor");
    expect(parsed?.agentPrompt).toContain("module-specific outputs");
    expect(hasAiReviewerEasyFix(BUGBOT_FINDING)).toBe(true);
    expect(aiReviewerOneLine(parsed!)).toBe("Medium · CI checks outdated preload artifact name");
  });

  it("extracts Devin severity, title, and suggestion without badge chrome", () => {
    const parsed = parseAiReviewerFeedback(DEVIN_FINDING);
    expect(parsed?.severity).toBe("Medium");
    expect(parsed?.summary).toContain("WebSocket URL fallback");
    expect(parsed?.summary).toContain("invalid URL");
    expect(parsed?.summary).not.toContain("Detailed Explanation");
    expect(parsed?.summary).not.toContain("Open in Devin");
    expect(parsed?.suggestion).toContain("window.location.host");
    expect(aiReviewerOneLine(parsed!)).toContain("Medium · WebSocket URL fallback");
    expect(hasAiReviewerEasyFix(DEVIN_FINDING)).toBe(false);
  });

  it("extracts Greptile title and suggestion when Context Used is present", () => {
    const parsed = parseAiReviewerFeedback(GREPTILE_FINDING);
    expect(parsed?.summary).toContain("Fetch fetches all refs");
    expect(parsed?.summary).not.toContain("Context Used");
    expect(parsed?.summary).not.toContain("coding style");
    expect(parsed?.suggestion).toContain("branchRef");
    expect(aiReviewerOneLine(parsed!)).toContain("Fetch fetches all refs");
  });

  it("extracts Gemini severity tag and suggestion", () => {
    const parsed = parseAiReviewerFeedback(GEMINI_FINDING);
    expect(parsed?.severity).toBe("High");
    expect(parsed?.summary).toContain("null check missing");
    expect(parsed?.suggestion).toContain("user.profile == null");
    expect(aiReviewerOneLine(parsed!)).toContain("High ·");
  });

  it("reads Gemini severity from a priority badge image", () => {
    const body = `![high](https://www.gstatic.com/codereviewagent/high.svg)

Null check missing before dereference.

\`\`\`suggestion
if (user.profile == null) return;
\`\`\`
`;
    const parsed = parseAiReviewerFeedback(body);
    expect(parsed?.severity).toBe("High");
    expect(parsed?.summary).toContain("Null check missing");
    expect(aiReviewerOneLine(parsed!)).toContain("High ·");
  });

  it("keeps legitimate anchors inside suggestions", () => {
    const body = `<!-- devin-review-comment {"id":"1"} -->

🟡 **Link stays in the suggestion**

See the docs.

\`\`\`suggestion
<a href="https://example.com/docs">docs</a>
\`\`\`
`;
    const parsed = parseAiReviewerFeedback(body);
    expect(parsed?.suggestion).toContain('<a href="https://example.com/docs">docs</a>');
  });

  it("returns null for ordinary human remarks", () => {
    expect(parseAiReviewerFeedback("Please rename this helper.")).toBeNull();
    expect(
      parseAiReviewerFeedback("**Important**\n\nPlease rename this helper before merge."),
    ).toBeNull();
    expect(parseAiReviewerFeedback("@coderabbitai review")).toBeNull();
    expect(
      parseAiReviewerFeedback(
        "🔴 **Blocker**\n\nPlease rename this helper — CodeRabbit also flagged it.",
      ),
    ).toBeNull();
    expect(
      parseAiReviewerFeedback(
        "Mentioning CodeRabbit.\n\n<details><summary>Steps</summary>\nReproduce locally.\n</details>",
      ),
    ).toBeNull();
    expect(hasAiReviewerEasyFix("Please rename this helper.")).toBe(false);
  });

  it("builds a compact display body and prefers the agent prompt for fixes", () => {
    const parsed = parseAiReviewerFeedback(CODERABBIT_FINDING)!;
    const display = aiReviewerDisplayBody(parsed);
    expect(display).toContain("**Potential issue · Minor**");
    expect(display).toContain("Guard against stale");
    expect(display).toContain("Suggested change");
    expect(display).not.toContain("Analysis chain");
    expect(aiReviewerFixText(parsed)).toBe(parsed.agentPrompt);
  });

  it("collapses a finding to a single list line", () => {
    const parsed = parseAiReviewerFeedback(CODERABBIT_FINDING)!;
    expect(aiReviewerOneLine(parsed)).toBe(
      "Minor · Guard against stale lastEditor values in localStorage.",
    );
    expect(aiReviewerOneLine(parseAiReviewerFeedback(MACROSCOPE_FINDING)!)).toContain("Low ·");
  });
});

describe("bot badge images", () => {
  it("matches bot badges but not screenshots hosted by the same services", () => {
    const badges = [
      "https://static.devin.ai/assets/gh-devin-review-light.svg?v=4",
      "https://cursor.com/assets/images/open-in-web-dark.png",
      "https://storage.googleapis.com/coderabbit_public_assets/review-stack-in-coderabbit-ui.svg",
      "https://img.shields.io/badge/P1-orange",
      "https://greptile-static-assets.s3.amazonaws.com/badges/ViewArtifacts.svg?v=4",
      "https://www.gstatic.com/codereviewagent/high-priority.svg",
      "https://user-images.githubusercontent.com/23264/106598434-9e719e00-654f-11eb-9e59-6167043cfa01.png",
    ];
    const screenshots = [
      "https://cursor.com/artifacts/c/art-41567e7e-97f5-46ff-9e6e-df6a85723409",
      "https://www.cursor.com/artifacts/c/art-98360ed1-44f8-4459-bea3-43bf93cc74fc",
      "https://app.devin.ai/attachments/abc/ss_1.png",
      "https://user-images.githubusercontent.com/23264/1-other-upload.png",
      "https://storage.googleapis.com/some-bucket/before.png",
    ];
    expect(badges.filter(isBotBadgeImage)).toEqual(badges);
    expect(screenshots.filter(isBotBadgeImage)).toEqual([]);
  });
});
