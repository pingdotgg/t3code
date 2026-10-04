# Issue tracker: GitHub

Issues and specs live in `screen-gd/t3mobile` on GitHub. Use `gh` when authenticated;
the connected GitHub tools are the fallback when CLI credentials are unavailable.
This configuration does not itself authorize publishing issues or comments.

- Read: `gh issue view <number> --repo screen-gd/t3mobile --comments`.
- List: `gh issue list --repo screen-gd/t3mobile --state open --json number,title,body,labels`.
- Create: `gh issue create --repo screen-gd/t3mobile --title "..." --body-file <file>`.
- Comment: `gh issue comment <number> --repo screen-gd/t3mobile --body-file <file>`.
- Label: `gh issue edit <number> --repo screen-gd/t3mobile --add-label "..."`.
- Close: `gh issue close <number> --repo screen-gd/t3mobile`.

Use a file for multiline bodies. When a skill says to publish a spec or ticket,
create a GitHub issue within the user's authorized scope. Fetch referenced tickets
with their comments and labels before implementing them.

**PRs as a request surface: no.**
