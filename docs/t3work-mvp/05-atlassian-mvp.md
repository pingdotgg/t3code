# Epic 05: Atlassian MVP

## Purpose

Atlassian provides structured project discovery and Jira issue context for the first
`t3work` MVP.

## MVP Capabilities

- Discover accessible Atlassian sites/accounts.
- List Jira projects visible to the user.
- Create a `t3work` project from a Jira project.
- List recent/open issues for that Jira project.
- Fetch issue details.
- Fetch issue comments.
- Normalize issue data into resource snapshots.
- Prepare Jira comment mutations.
- Commit Jira comments after user approval.

## Project Creation Flow

1. User chooses Atlassian as project source.
2. User completes agent runtime preflight for the managed project.
3. Integration lists accessible sites.
4. User picks a site.
5. Integration lists Jira projects.
6. User picks a Jira project.
7. Shell creates managed workspace.
8. Shell writes project source metadata and runtime defaults.
9. Shell opens project overview.

## Jira Issue Snapshot

Minimum normalized fields:

- key
- title
- type
- status
- priority
- assignee
- reporter
- labels
- description
- comments
- linked issues
- updated time
- URL

Also store raw payloads for debugging and future custom field support.

## Default Issue Query

Start with a conservative default:

```text
project = <KEY> AND statusCategory != Done ORDER BY updated DESC
```

Later, allow project-specific JQL configuration.

## Comment Mutation

Draft flow:

1. Skill proposes comment.
2. Integration returns mutation preview.
3. UI displays editable comment body.
4. User approves.
5. Integration commits comment.
6. Shell saves mutation result to artifact/run history.

## Deferred Atlassian Scope

- Confluence page search/fetch — specced as the first expansion in
  [Epic 26 (Knowledge Workbench)](./26-knowledge-workbench.md); Confluence shares this same
  Atlassian connection rather than requiring a separate one
- Jira transitions
- issue field editing
- board and sprint modeling
- attachments
- custom field mapping UI
- organization-wide reporting
