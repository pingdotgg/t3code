# Linear

The Linear page lets you browse your Linear workspace by team, project and milestone, and start a
chat or a [pipeline](./pipelines.md) straight from an issue. T3 Code can also move the issue to
In Progress and comment on it with a link to the work.

## Connect

T3 Code connects with a personal API key. Create one in Linear under **Settings → Account →
Security & access → Personal API keys**. If Linear asks for permissions, give the key Read, Write,
Create issues and Create comments, or full access. Paste it into **Settings → Integrations →
Linear** and choose **Verify & save**.

The key is stored in the secret store of the T3 Code server you are connected to, and it never
leaves that server. Linear is set up on your primary environment only. If Linear later rejects the
key, the page asks for a new one. **Disconnect** removes the key but keeps your mappings and the
links between issues and threads.

## Start work from an issue

Open an issue and choose **Start chat** or **Run pipeline**. T3 Code attaches the issue, its
sub-issues and comments as context, and by default creates a new worktree on Linear's branch name
so Linear links the pull request when you open it. If that branch already exists, T3 Code adds a
suffix such as `-2`.

Under **Settings → Integrations → Linear**, map a Linear team or project to a T3 Code project so
launches open in the right place. A project mapping wins over its team's mapping. Without a
mapping, T3 Code asks for a project each time.

Moving the issue and commenting on it are off until you turn them on in **When launching from an
issue**. You can still switch each one off for a single launch from the hint under the composer
or in the pipeline dialog. The issue is only moved when it is in Backlog, Triage or an unstarted
state. A pipeline keeps one comment up to date as its steps finish.

## On mobile

The mobile app has a Linear tab. Browse teams, projects, milestones and issues, open an issue, and start a chat or run a pipeline from it. Connecting Linear and editing mappings stay on the computer (Settings → Integrations → Linear); the phone picks up the connection automatically. Comments posted for a launch from the phone link to the hosted web app (app.t3.codes), because the phone has no web address of its own.

## Things to know

- Links to issues in your connected Linear workspace open in the Linear page, or the issue screen
  on mobile, instead of the browser. Command/Ctrl+Click opens them in your browser.
- The page refreshes when you return to it, every minute while it is open, and when you choose
  refresh. It does not poll while closed.
- When Linear is unreachable or rate limited, the page shows the last data it loaded with a banner.
- On the Linear page, ⌘K (Ctrl+K on Windows and Linux) focuses the jump search instead of the
  command palette. `/` focuses the issue search.
- Comment links point to the address you launched from. A link to `localhost` or a private network
  address only works for people who can reach that server.
