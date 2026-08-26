const assert = require("node:assert/strict");
const test = require("node:test");

const {
  COMMENT_MARKER,
  effectiveChangedLines,
  evaluatePull,
  hasVideo,
  imageCount,
  parseVouchedUsers,
  renderComment,
  reviewPull,
  upsertComment,
} = require("./pr-guideline-review.cjs");

const completeBody = `
## What Changed

Stops the server from retrying a completed receipt.

## Why

The retry duplicates a completed side effect.

## Checklist

- [x] This PR is small and focused
- [x] I explained what changed and why
- [x] I included before/after screenshots for any UI changes
- [x] I included a video for animation/interaction changes
`;

function evaluate(overrides = {}) {
  const files = overrides.files ?? [
    { filename: "apps/server/src/receipts.ts", additions: 8, deletions: 2, patch: "+return;" },
    { filename: "apps/server/src/receipts.test.ts", additions: 20, deletions: 0 },
  ];
  return evaluatePull({
    pull: {
      title: "fix(server): do not retry completed receipts",
      body: completeBody,
      changed_files: files.length,
      ...overrides.pull,
    },
    files,
    repository: "pingdotgg/t3code",
    vouchedUsers: overrides.vouchedUsers,
    vouchedStandardAvailable: overrides.vouchedStandardAvailable,
  });
}

test("passes a small focused non-UI fix", () => {
  const result = evaluate();

  assert.equal(result.status, "pass");
  assert.deepEqual(result.findings, []);
  assert.equal(result.metrics.effectiveChangedLines, 10);
  assert.equal(result.metrics.testChangedLines, 20);
});

test("reports missing template content with direct fixes", () => {
  const result = evaluate({
    pull: {
      body: `
## What Changed
<!-- Describe the change clearly and keep scope tight. -->
## Why
<!-- Explain the problem being solved. -->
## Checklist
- [ ] This PR is small and focused
- [ ] I explained what changed and why
`,
    },
  });

  assert.equal(result.status, "needs_work");
  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["missing-what-changed", "missing-why"],
  );
});

test("applies the richer handoff to collaborators and vouched contributors", () => {
  const collaborator = evaluate({
    pull: {
      body: completeBody,
      author_association: "COLLABORATOR",
    },
    vouchedStandardAvailable: true,
  });

  assert.equal(collaborator.status, "needs_work");
  assert.deepEqual(
    collaborator.findings.map((entry) => entry.code),
    [
      "missing-scope-and-non-goals",
      "missing-affected-areas",
      "missing-validation",
      "missing-risks-and-untested",
    ],
  );

  const vouched = evaluate({
    pull: {
      user: { login: "VouchedPerson", type: "User" },
      body: `${completeBody}
## Scope and Non-Goals
Only receipt retry state changes; UI behavior is unchanged.
## Affected Areas
Server receipts only. No client, provider, contract, or remote-path change.
## Validation
\`node --test receipts.test.ts\`: passed.
## Risks and Untested Paths
None known.`,
    },
    vouchedUsers: new Set(["vouchedperson"]),
    vouchedStandardAvailable: true,
  });

  assert.equal(vouched.status, "pass");
  assert.deepEqual(vouched.findings, []);
  assert.equal(vouched.metrics.trustedPull, true);
});

test("parses only active GitHub entries from the vouch file", () => {
  assert.deepEqual(
    [...parseVouchedUsers("# comment\ngithub:Alice\n-github:Blocked reason\ngithub:bob\n")],
    ["alice", "bob"],
  );
});

test("accepts equivalent vouched-guide headings and surface evidence", () => {
  const result = evaluate({
    pull: {
      author_association: "MEMBER",
      body: `${completeBody}
## Scope and Non-Goals
Documentation only. No client, provider, platform, contract, or connection behavior changes.
## Validation
\`vp fmt guide.md --check\`: passed.
## Risks and Limitations
The guide will need updates when policy changes. No runtime path was exercised.`,
    },
    vouchedStandardAvailable: true,
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.findings, []);
});

test("requires images and video for a visible motion change", () => {
  const result = evaluate({
    files: [
      {
        filename: "apps/web/src/components/sidebar.tsx",
        additions: 12,
        deletions: 2,
        patch: "+transition: opacity 120ms ease;",
      },
    ],
  });

  assert.equal(result.status, "needs_work");
  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["missing-ui-images", "missing-interaction-video"],
  );
});

test("accepts GitHub image and video evidence", () => {
  const result = evaluate({
    pull: {
      body: `${completeBody}\n## UI Changes\n![Before](https://github.com/user-attachments/assets/before)\n![After](https://github.com/user-attachments/assets/after)\nVideo: https://github.com/user-attachments/assets/demo-video`,
    },
    files: [
      {
        filename: "apps/mobile/src/sidebar.tsx",
        additions: 8,
        deletions: 2,
        patch: "+const style = useAnimatedStyle(() => ({}));",
      },
    ],
  });

  assert.equal(result.status, "pass");
  assert.equal(
    imageCount(
      "![Before](https://github.com/user-attachments/assets/before)\n![After](https://github.com/user-attachments/assets/after)",
    ),
    2,
  );
  assert.equal(hasVideo("Video: https://github.com/user-attachments/assets/demo-video"), true);
});

test("accepts an explicit explanation that client behavior is unchanged", () => {
  const result = evaluate({
    pull: {
      body: `${completeBody}\n## UI Changes\nNo visual change. Existing interactions are unchanged.`,
    },
    files: [
      {
        filename: "apps/mobile/src/thread-work-log.tsx",
        additions: 5,
        deletions: 4,
        patch: "+transition: existingBehavior;",
      },
    ],
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.findings, []);
});

test("does not infer a visual change from TSX logic, generics, handlers, or closing tags", () => {
  const result = evaluate({
    files: [
      {
        filename: "apps/mobile/src/Animated.tsx",
        additions: 2,
        deletions: 1,
        patch:
          "+const selected = useState<boolean>(false);\n+const onSelect = () => selected;\n+</Panel>;\n+const View = Animated.View;",
      },
    ],
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.findings, []);
});

test("detects a self-closing JSX element as a visible change", () => {
  const result = evaluate({
    files: [
      {
        filename: "apps/web/src/sidebar.tsx",
        additions: 1,
        deletions: 0,
        patch: "+<Button />",
      },
    ],
  });

  assert.equal(result.status, "needs_work");
  assert.equal(result.findings.at(-1).code, "missing-ui-images");
});

test("accepts the exact no-UI phrase documented by the template", () => {
  const result = evaluate({
    pull: { body: `${completeBody}\n## UI Changes\nNo visual or interaction changes.` },
    files: [
      {
        filename: "apps/web/src/sidebar.tsx",
        additions: 2,
        deletions: 1,
        patch: "+style={{ transition: 'opacity 120ms' }};",
      },
    ],
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.findings, []);
});

test("does not treat an HTML image attachment as video evidence", () => {
  const image = '<img src="https://github.com/user-attachments/assets/screenshot">';
  assert.equal(imageCount(image), 1);
  assert.equal(hasVideo(image), false);
  assert.equal(hasVideo("https://github.com/user-attachments/assets/unlabelled-still"), false);
  assert.equal(hasVideo("Video: https://github.com/user-attachments/assets/demo"), true);
});

test("requires non-empty HTML evidence sources", () => {
  assert.equal(imageCount("<img><img src=''>"), 0);
  assert.equal(imageCount('<img data-src="deferred.png">'), 0);
  assert.equal(imageCount('<img src="before.png"><img src="after.png">'), 2);
  assert.equal(hasVideo("<video></video>"), false);
  assert.equal(hasVideo("<video><source src=''></video>"), false);
  assert.equal(hasVideo('<video data-src="deferred.mp4"></video>'), false);
  assert.equal(hasVideo('<video src="demo.mp4"></video>'), true);
  assert.equal(hasVideo('<video><source src="demo.webm"></video>'), true);
});

test("accepts single-quoted Markdown image titles", () => {
  assert.equal(
    imageCount(
      "![Before](https://example.com/before.png 'before')\n![After](https://example.com/after.png 'after')",
    ),
    2,
  );
});

test("counts UI evidence only in the UI Changes section", () => {
  const result = evaluate({
    pull: {
      body: `${completeBody}
## UI Changes
Changed the sidebar layout.
## Validation
![Unrelated](https://github.com/user-attachments/assets/unrelated)
![Also unrelated](https://github.com/user-attachments/assets/also-unrelated)
Video: https://github.com/user-attachments/assets/unrelated-video`,
    },
    files: [
      {
        filename: "apps/web/src/sidebar.tsx",
        additions: 3,
        deletions: 1,
        patch: "+transition: opacity 120ms ease;",
      },
    ],
  });

  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["missing-ui-images", "missing-interaction-video"],
  );
});

test("requires prior repository context for features and large changes", () => {
  const feature = evaluate({
    pull: {
      title: "feat(web): add a new dashboard",
      body: `${completeBody}\nBug: https://github.com/pingdotgg/t3code/issues/1234`,
    },
  });
  assert.equal(feature.status, "needs_work");
  assert.equal(feature.findings.at(-1).code, "missing-feature-discussion");

  const discussedFeature = evaluate({
    pull: {
      title: "feat(web): add a new dashboard",
      body: `${completeBody}\nProposal: https://github.com/pingdotgg/t3code/discussions/1234`,
    },
  });
  assert.equal(discussedFeature.status, "pass");

  const directedFeature = evaluate({
    pull: {
      title: "feat(web): add a new dashboard",
      body: `${completeBody}\nMaintainer-directed work; no public routing link exists.`,
    },
  });
  assert.equal(directedFeature.status, "manual_review");
  assert.equal(directedFeature.findings.at(-1).code, "private-feature-context");

  const docsFeature = evaluate({
    pull: { title: "feat(docs): explain dashboards" },
    files: [{ filename: "docs/user/dashboard.md", additions: 20, deletions: 0 }],
  });
  assert.equal(docsFeature.status, "pass");

  const large = evaluate({
    pull: { body: `${completeBody}\nContext: https://github.com/pingdotgg/t3code/issues/1234` },
    files: [{ filename: "apps/server/src/receipts.ts", additions: 120, deletions: 0 }],
  });
  assert.equal(large.status, "manual_review");
  assert.deepEqual(
    large.findings.map((entry) => entry.code),
    ["large-change"],
  );
});

test("recognizes a plain-language feature title", () => {
  const result = evaluate({
    pull: { title: "Add a dashboard" },
    files: [
      {
        filename: "apps/web/src/dashboard.tsx",
        additions: 20,
        deletions: 0,
        patch: "+export const dashboardEnabled = true;",
      },
    ],
  });

  assert.equal(result.status, "needs_work");
  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["missing-feature-discussion"],
  );
});

test("ignores repository links hidden in HTML comments", () => {
  const feature = evaluate({
    pull: {
      title: "feat(web): add a dashboard",
      body: `${completeBody}\n<!-- https://github.com/pingdotgg/t3code/discussions/1234 -->`,
    },
  });
  assert.equal(feature.findings.at(-1).code, "missing-feature-discussion");

  const large = evaluate({
    pull: {
      body: `${completeBody}\n<!-- https://github.com/pingdotgg/t3code/issues/1234 -->`,
    },
    files: [{ filename: "apps/server/src/receipts.ts", additions: 120, deletions: 0 }],
  });
  assert.deepEqual(
    large.findings.map((entry) => entry.code),
    ["missing-nontrivial-context", "large-change"],
  );

  const hiddenMaintainerContext = evaluate({
    pull: {
      title: "feat(web): add a dashboard",
      body: `${completeBody}\n<!-- Maintainer-directed work. -->`,
    },
  });
  assert.equal(hiddenMaintainerContext.findings.at(-1).code, "missing-feature-discussion");
});

test("ignores section headings inside fenced code blocks", () => {
  const result = evaluate({
    pull: {
      body: `
\`\`\`markdown
## What Changed
Pretend change.
## Why
Pretend reason.
\`\`\`
`,
    },
  });

  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["missing-what-changed", "missing-why"],
  );

  const tildeFence = evaluate({
    pull: {
      body: `
~~~\`markdown
## What Changed
Pretend change.
## Why
Pretend reason.
~~~
`,
    },
  });
  assert.deepEqual(
    tildeFence.findings.map((entry) => entry.code),
    ["missing-what-changed", "missing-why"],
  );
});

test("accepts section headings with closing hashes", () => {
  const result = evaluate({
    pull: {
      body: `
## What Changed ##
Stops a duplicate retry.
## Why ###
The retry repeats a side effect.
`,
    },
  });

  assert.deepEqual(result.findings, []);
});

test("treats missing context on a large external fix as maintainer judgment", () => {
  const result = evaluate({
    files: [{ filename: "apps/server/src/receipts.ts", additions: 120, deletions: 0 }],
  });

  assert.equal(result.status, "manual_review");
  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["missing-nontrivial-context", "large-change"],
  );
});

test("flags an XXL change and a diff crossing many project areas", () => {
  const result = evaluate({
    pull: {
      body: `${completeBody}\nContext: https://github.com/pingdotgg/t3code/discussions/1234`,
    },
    files: [
      { filename: "apps/server/src/a.ts", additions: 400, deletions: 0 },
      { filename: "packages/contracts/src/a.ts", additions: 350, deletions: 0 },
      { filename: "packages/client-runtime/src/a.ts", additions: 300, deletions: 0 },
    ],
  });

  assert.equal(result.status, "manual_review");
  assert.deepEqual(
    result.findings.map((entry) => entry.code),
    ["xxl-change", "many-areas"],
  );
});

test("requires human judgment when GitHub truncates the changed-file list", () => {
  const result = evaluate({ pull: { changed_files: 3_001 } });

  assert.equal(result.status, "manual_review");
  assert.equal(result.findings.at(-1).code, "incomplete-file-list");
});

test("requires human judgment when GitHub omits a client patch", () => {
  const result = evaluate({
    files: [
      {
        filename: "apps/web/src/components/sidebar.tsx",
        additions: 2_000,
        deletions: 0,
      },
    ],
  });

  assert.equal(result.status, "manual_review");
  assert.equal(result.findings.at(-1).code, "uninspectable-ui-patch");
});

test("uses test lines only for a test-only PR", () => {
  assert.deepEqual(
    effectiveChangedLines([
      { filename: "apps/server/src/a.test.ts", additions: 40, deletions: 2 },
      { filename: "apps/server/tests/fixture.ts", additions: 8, deletions: 0 },
      { filename: "apps/server/integration/fixture.ts", additions: 7, deletions: 0 },
    ]),
    { nonTest: 0, test: 57, effective: 57 },
  );
});

test("renders an advisory comment without claiming approval", () => {
  const comment = renderComment(evaluate(), {
    repository: "pingdotgg/t3code",
    policyRevision: "base-sha",
  });

  assert.match(comment, new RegExp(COMMENT_MARKER));
  assert.match(comment, /Looks ready for a maintainer to inspect/);
  assert.match(comment, /does not approve, reject, or replace maintainer review/);
  assert.match(comment, /CONTRIBUTING\.md/);
  assert.match(comment, /blob\/base-sha\/CONTRIBUTING\.md/);
  assert.match(comment, /size:\*.*ignores whitespace-only changes/);
});

test("links the pinned vouched standard when it is active", () => {
  const result = evaluate({
    pull: { author_association: "COLLABORATOR" },
    vouchedStandardAvailable: true,
  });
  const comment = renderComment(result, {
    repository: "pingdotgg/t3code",
    policyRevision: "base-sha",
    vouchedStandardAvailable: true,
  });

  assert.match(comment, /blob\/base-sha\/CONTRIBUTING_VOUCHED\.md/);
});

test("does not publish stale results", async () => {
  let listedFiles = false;
  const result = await reviewPull({
    github: {
      paginate: async () => {
        listedFiles = true;
        return [];
      },
      rest: {
        pulls: {
          get: async () => ({ data: { head: { sha: "new-sha" } } }),
          listFiles: () => {},
        },
      },
    },
    context: {
      repo: { owner: "pingdotgg", repo: "t3code" },
      payload: {
        pull_request: { number: 7, head: { sha: "old-sha" } },
        repository: { default_branch: "main" },
      },
    },
    core: { info: () => {}, setOutput: () => {} },
  });

  assert.deepEqual(result, { published: false, reason: "stale" });
  assert.equal(listedFiles, false);
});

test("does not comment on bot-authored PRs", async () => {
  let listedFiles = false;
  const pull = {
    number: 7,
    head: { sha: "head-sha" },
    user: { login: "dependabot[bot]", type: "Bot" },
  };
  const result = await reviewPull({
    github: {
      paginate: async () => {
        listedFiles = true;
        return [];
      },
      rest: {
        pulls: {
          get: async () => ({ data: pull }),
          listFiles: () => {},
        },
      },
    },
    context: {
      repo: { owner: "pingdotgg", repo: "t3code" },
      payload: { pull_request: pull, repository: { default_branch: "main" } },
    },
    core: { info: () => {}, setOutput: () => {} },
  });

  assert.deepEqual(result, { published: false, reason: "bot" });
  assert.equal(listedFiles, false);
});

test("removes a stale bot comment when a PR becomes a draft", async () => {
  let listedFiles = false;
  let deletedComment;
  const listFiles = () => {};
  const listComments = () => {};
  const pull = {
    number: 7,
    head: { sha: "head-sha" },
    draft: true,
    user: { login: "contributor", type: "User" },
  };
  const result = await reviewPull({
    github: {
      paginate: async (method) => {
        if (method === listComments) {
          return [
            {
              id: 99,
              user: { login: "github-actions[bot]" },
              body: `${COMMENT_MARKER}\nold result`,
            },
          ];
        }
        listedFiles = true;
        return [];
      },
      rest: {
        issues: {
          listComments,
          deleteComment: async (input) => {
            deletedComment = input.comment_id;
          },
        },
        pulls: {
          get: async () => ({ data: pull }),
          listFiles,
        },
      },
    },
    context: {
      repo: { owner: "pingdotgg", repo: "t3code" },
      payload: { pull_request: pull, repository: { default_branch: "main" } },
    },
    core: { info: () => {}, setOutput: () => {} },
  });

  assert.deepEqual(result, { published: false, reason: "draft", removal: "removed" });
  assert.equal(listedFiles, false);
  assert.equal(deletedComment, 99);
});

test("does not publish after the head changes during file collection", async () => {
  const listFiles = () => {};
  let pullRead = 0;
  let listedComments = false;
  const result = await reviewPull({
    github: {
      paginate: async (method) => {
        if (method === listFiles) return [];
        listedComments = true;
        return [];
      },
      rest: {
        issues: { listComments: () => {} },
        pulls: {
          get: async () => ({
            data: {
              number: 7,
              head: { sha: pullRead++ === 0 ? "head-sha" : "new-sha" },
              base: { sha: "base-sha" },
              title: "fix: example",
              body: completeBody,
            },
          }),
          listFiles,
        },
      },
    },
    context: {
      repo: { owner: "pingdotgg", repo: "t3code" },
      payload: {
        pull_request: { number: 7, head: { sha: "head-sha" } },
        repository: { default_branch: "main" },
      },
    },
    core: { info: () => {}, setOutput: () => {} },
  });

  assert.deepEqual(result, { published: false, reason: "stale" });
  assert.equal(listedComments, false);
});

test("leaves an unchanged bot comment alone and ignores an attacker marker", async () => {
  const body = `${COMMENT_MARKER}\ncurrent result`;
  let wrote = false;
  const publication = await upsertComment(
    {
      paginate: async () => [
        { id: 1, user: { login: "contributor" }, body: COMMENT_MARKER },
        { id: 2, user: { login: "github-actions[bot]" }, body },
      ],
      rest: {
        issues: {
          listComments: () => {},
          createComment: async () => {
            wrote = true;
          },
          updateComment: async () => {
            wrote = true;
          },
        },
      },
    },
    { repo: { owner: "pingdotgg", repo: "t3code" } },
    7,
    body,
  );

  assert.equal(publication, "unchanged");
  assert.equal(wrote, false);
});

test("updates one existing bot comment in place", async () => {
  const calls = [];
  const listFiles = () => {};
  const listComments = () => {};
  const pull = {
    number: 7,
    head: { sha: "head-sha" },
    title: "fix(server): do not retry completed receipts",
    body: completeBody,
    changed_files: 1,
    base: { sha: "base-sha" },
  };
  const result = await reviewPull({
    github: {
      paginate: async (method) => {
        if (method === listFiles) {
          return [{ filename: "apps/server/src/receipts.ts", additions: 8, deletions: 2 }];
        }
        assert.equal(method, listComments);
        return [
          {
            id: 99,
            user: { login: "github-actions[bot]" },
            body: `${COMMENT_MARKER}\nold result`,
          },
        ];
      },
      rest: {
        issues: {
          listComments,
          createComment: async (input) => calls.push(["create", input]),
          updateComment: async (input) => calls.push(["update", input]),
        },
        pulls: {
          get: async () => ({ data: pull }),
          listFiles,
        },
      },
    },
    context: {
      repo: { owner: "pingdotgg", repo: "t3code" },
      payload: { pull_request: pull, repository: { default_branch: "main" } },
    },
    core: { info: () => {}, setOutput: () => {} },
  });

  assert.equal(result.published, true);
  assert.equal(result.publication, "updated");
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["update"],
  );
  assert.equal(calls[0][1].comment_id, 99);
});
