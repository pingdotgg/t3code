export const PR_REVIEW_PROMPT = `## Code Review Instructions

1. Launch a haiku agent to return a list of file paths (not their contents) for all relevant CLAUDE.md files including:

    - The root CLAUDE.md file, if it exists
    - Any CLAUDE.md files in directories containing files modified by the workspace diff (use mcp__conductor__GetWorkspaceDiff with stat option)

2. If this workspace has an associated PR, read the title and description (but not the changes). This will be helpful context.

3. In parallel with step 2, launch a sonnet agent to view the changes, using mcp__conductor__GetWorkspaceDiff, and return a summary of the changes

4. Launch 4 agents in parallel to independently review the changes using mcp__conductor__GetWorkspaceDiff. Each agent should return the list of issues, where each issue includes a description and the reason it was flagged (e.g. "CLAUDE.md adherence", "bug"). The agents should do the following:

    Agents 1 + 2: CLAUDE.md or AGENTS.md compliance sonnet agents
    Audit changes for CLAUDE.md or AGENTS.md compliance in parallel. Note: When evaluating CLAUDE.md or AGENTS.md compliance for a file, you should only consider CLAUDE.md or AGENTS.md files that share a file path with the file or parents.

    Agent 3: Opus bug agent
    Scan for obvious bugs. Focus only on the diff itself without reading extra context. Flag only significant bugs; ignore nitpicks and likely false positives. Do not flag issues that you cannot validate without looking at context outside of the git diff.

    Agent 4: Opus bug agent
    Look for problems that exist in the introduced code. This could be security issues, incorrect logic, etc. Only look for issues that fall within the changed code.

    **CRITICAL: We only want HIGH SIGNAL issues.** This means:

    - Objective bugs that will cause incorrect behavior at runtime
    - Clear, unambiguous CLAUDE.md violations where you can quote the exact rule being broken

    We do NOT want:

    - Subjective concerns or "suggestions"
    - Style preferences not explicitly required by CLAUDE.md
    - Potential issues that "might" be problems
    - Anything requiring interpretation or judgment calls

    If you are not certain an issue is real, do not flag it. False positives erode trust and waste reviewer time.

    In addition to the above, each subagent should be told the PR title and description. This will help provide context regarding the author's intent.

5. For each issue found in the previous step, launch parallel subagents to validate the issue. These subagents should get the PR title and description along with a description of the issue. The agent's job is to review the issue to validate that the stated issue is truly an issue with high confidence. For example, if an issue such as "variable is not defined" was flagged, the subagent's job would be to validate that is actually true in the code. Another example would be CLAUDE.md issues. The agent should validate that the CLAUDE.md rule that was violated is scoped for this file and is actually violated. Use Opus subagents for bugs and logic issues, and sonnet agents for CLAUDE.md violations.

6. Filter out any issues that were not validated in step 5. This step will give us our list of high signal issues for our review.

7. Post inline comments for each issue using mcp__conductor__DiffComment:

    **IMPORTANT: Only post ONE comment per unique issue.**

8. Write out a list of issues found, along with the location of the comment. For example:

    <example>
    ### **#1 Empty input causes crash**

    If the input field is empty when page loads, the app will crash.

    File: src/ui/Input.tsx

    ### **#2 Dead code**

    The getUserData function is now unused. It should be deleted.

    File: src/core/UserData.ts
    </example>

Use this list when evaluating issues in Steps 5 and 6 (these are false positives, do NOT flag):

-   Pre-existing issues
-   Something that appears to be a bug but is actually correct
-   Pedantic nitpicks that a senior engineer would not flag
-   Issues that a linter will catch (do not run the linter to verify)
-   General code quality concerns (e.g., lack of test coverage, general security issues) unless explicitly required in CLAUDE.md or AGENTS.md
-   Issues mentioned in CLAUDE.md or AGENTS.md but explicitly silenced in the code (e.g., via a lint ignore comment)

Notes:

-   All subagents should be explicitly instructed not to post comments themselves. Only you, the main agent, should post comments.
-   Do not use the AskUserQuestion tool. Your goal should be to complete the entire review without user intervention.
-   Use gh CLI to interact with GitHub (e.g., fetch pull requests, create comments). Do not use web fetch.
-   You must cite and link each issue in inline comments (e.g., if referring to a CLAUDE.md or AGENTS.md rule, include a link to it).

## Fallback: if you don't have access to subagents

If you don't have subagents, perform all the steps above yourself sequentially instead of launching agents. Do each review axis (CLAUDE.md compliance, bug scan, introduced problems) yourself, and validate each issue yourself.

## Fallback: if you don't have access to the workspace diff tool

If you don't have access to the mcp__conductor__GetWorkspaceDiff tool, use the following git commands to get the diff:

\`\`\`bash
# Get the merge base between this branch and the target
MERGE_BASE=$(git merge-base origin/develop HEAD)

# Get the committed diff against the merge base
git diff $MERGE_BASE HEAD

# Get any uncommitted changes (staged and unstaged)
git diff HEAD
\`\`\`

Review the combination of both outputs: the first shows all committed changes on this branch relative to the target, and the second shows any uncommitted work in progress.

No need to mention in your report whether or not you used one of the fallback strategies; it's usually irrelevant.`;

export function buildReviewThreadTitle(): string {
  return "PR Review";
}
