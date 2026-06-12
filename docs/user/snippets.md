# Snippets

Saved-prompt snippets are reusable prompt templates that expand into the
composer when you select them from the `/` menu. They are stored as part of
the server-authoritative settings and sync across your devices.

Snippets are available everywhere the composer is: threads, drafts, and
across every connected environment.

## Adding a snippet

Open **Settings → Snippets** and click the **+** button in the section
header. Each snippet has:

- **Title** — human-readable label, shown in the snippet list.
- **Trigger** — the slug you type after `/` in the composer. Lowercase
  letters, digits, and dashes only, up to 40 characters. The trigger
  defaults to a slugified version of the title, with a numeric suffix
  appended if it would collide with an existing snippet.
- **Description** (optional) — short hint shown in the slash menu. Falls
  back to the title if omitted.
- **Body** — the text that gets inserted into the composer when you
  select the snippet. Plain text, up to 8 KB.

The trigger is immutable after creation. To rename a snippet you only
change the title; the trigger stays stable so any in-flight references
keep working.

## Using a snippet

In the composer, type `/` to open the slash menu. Saved snippets appear
under the **Saved** group between **Built-in** and **Provider** commands.
Pick one to expand its body into the composer at the cursor.

The body is inserted verbatim — there is no variable substitution in v1.
Edit the inserted text freely before sending.

## Where the data lives

Snippets are persisted in the server's `settings.json` under
`promptSnippets`, alongside the rest of the server-authoritative
settings. Edits made in one client propagate to every other client that
shares the same backend (web, desktop, mobile).

## Limits

- Trigger: 1–40 characters, lowercase letters / digits / dashes, must
  start with a letter or digit.
- Title: 1–80 characters.
- Description: 0–160 characters.
- Body: 1–8 192 characters.

See [`packages/contracts/src/snippets.ts`](../../packages/contracts/src/snippets.ts)
for the full schema.
