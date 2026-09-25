# Fork feature map

This is the canonical feature inventory consumed by `scripts/fork-features.mjs`.
Each JSON block is one feature. Keep stable ids, a one-line purpose, Issue/PR
links, exact repository-relative paths and literal, case-insensitive watch keywords.
Empty file arrays mean no new files or no independently owned upstream edits.

`upstreamFiles` assigns every allowlisted path to exactly one primary feature.
`sharedFiles` records other features using that path; all three file arrays take
part in overlap detection. Primary ownership does not imply exclusive behavior.
Some historical allowlist entries (the threads toolkit) are actually fork-new
files; they remain allowlisted and have one owner for compatibility.

Update this map with each fork feature or deletion. The report is a heuristic:
renamed capabilities or different vocabulary still need human review. Keywords
flag possible overlap, not proof of duplication. See [the routine](fork.md#routine)
for per-match decisions and the absorption PR record.

## Project Direction

```json
{
  "id": "direction",
  "purpose": "Keep the fork mission and completion criteria explicit.",
  "issues": ["https://github.com/toolboxmd/t3code/issues/5"],
  "prs": ["https://github.com/toolboxmd/t3code/pull/5"],
  "newFiles": ["MISSION.md", "OBJECTIVE.md", "VISION.md"],
  "upstreamFiles": [],
  "sharedFiles": [],
  "keywords": ["project direction", "VISION.md", "MISSION.md", "OBJECTIVE.md"]
}
```

## Product glossary

```json
{
  "id": "glossary",
  "purpose": "Keep Chromeria and its product family terminology consistent.",
  "issues": ["https://github.com/toolboxmd/t3code/issues/11"],
  "prs": ["https://github.com/toolboxmd/t3code/pull/11"],
  "newFiles": ["GLOSSARY.md"],
  "upstreamFiles": [],
  "sharedFiles": [],
  "keywords": ["Chromeria", "Luxin", "Drafter", "Prism"]
}
```

## Chromeria branding

```json
{
  "id": "branding",
  "purpose": "Give desktop and web the Chromeria name, icons and independent desktop identity.",
  "issues": [
    "https://github.com/toolboxmd/t3code/issues/12",
    "https://github.com/toolboxmd/t3code/issues/13",
    "https://github.com/toolboxmd/t3code/issues/14"
  ],
  "prs": [
    "https://github.com/toolboxmd/t3code/pull/12",
    "https://github.com/toolboxmd/t3code/pull/13",
    "https://github.com/toolboxmd/t3code/pull/14"
  ],
  "newFiles": [
    "assets/chromeria/chromeria-icon-1024.png",
    "assets/chromeria/chromeria-web-apple-touch-180.png",
    "assets/chromeria/chromeria-web-favicon-16x16.png",
    "assets/chromeria/chromeria-web-favicon-32x32.png",
    "assets/chromeria/chromeria-web-favicon.ico",
    "assets/chromeria/chromeria-windows.ico",
    "apps/web/public/chromeria-mark.png"
  ],
  "upstreamFiles": [
    "apps/desktop/package.json",
    "apps/desktop/src/app/DesktopAppIdentity.test.ts",
    "apps/desktop/src/app/DesktopEnvironment.ts",
    "apps/desktop/src/app/DesktopPreReadyPlatform.test.ts",
    "scripts/build-desktop-artifact.ts",
    "scripts/build-desktop-artifact.test.ts",
    "scripts/lib/brand-assets.ts",
    "scripts/lib/brand-assets.test.ts",
    "apps/web/index.html",
    "apps/web/src/bootstrap.test.ts",
    "apps/web/src/branding.test.ts",
    "apps/web/src/branding.ts",
    "apps/web/src/bundledDev.test.ts",
    "apps/web/src/components/T3Wordmark.tsx",
    "apps/web/src/components/chat/MessagesTimeline.tsx",
    "apps/web/src/components/onboarding/WelcomeWizard.tsx",
    "apps/web/src/components/settings/IntegrationsSettings.tsx",
    "apps/web/src/components/settings/ThemePreviewCircles.tsx",
    "apps/web/src/components/sidebar/SidebarChrome.tsx",
    "apps/web/src/lib/bootError.ts"
  ],
  "sharedFiles": [],
  "keywords": [
    "branding",
    "productName",
    "appId",
    "wordmark",
    "favicon",
    "Chromeria",
    "auto-update"
  ]
}
```

## Child threads

```json
{
  "id": "child-threads",
  "purpose": "Spawn child threads, hide them from sidebars and open them from their parent.",
  "issues": ["https://github.com/toolboxmd/t3code/issues/8"],
  "prs": ["https://github.com/toolboxmd/t3code/pull/10"],
  "newFiles": [
    "apps/server/src/mcp/toolkits/threads/childThreads.test.ts",
    "apps/server/src/mcp/toolkits/threads/handlers.ts",
    "apps/server/src/mcp/toolkits/threads/subagentThreadId.test.ts",
    "apps/server/src/mcp/toolkits/threads/subagentThreadId.ts",
    "apps/server/src/mcp/toolkits/threads/tools.ts",
    "apps/web/src/components/AgentThreadLink.tsx",
    "apps/web/src/components/subagentThreads.test.ts",
    "apps/web/src/components/subagentThreads.ts"
  ],
  "upstreamFiles": [
    "apps/server/src/entrypoint.test.ts",
    "apps/server/src/mcp/McpHttpServer.ts",
    "apps/web/src/components/LegacySidebar.tsx",
    "apps/web/src/components/Sidebar.tsx"
  ],
  "sharedFiles": ["scripts/build-desktop-artifact.ts", "apps/web/src/components/AgentsPanel.tsx"],
  "keywords": ["parentThreadId", "child thread", "subagent", "spawn_thread", "sidebar"]
}
```

## Fork maintenance and CI

```json
{
  "id": "fork-maintenance",
  "purpose": "Keep the fork stack small, checked and rebasable on GitHub-hosted CI.",
  "issues": [
    "https://github.com/toolboxmd/t3code/issues/6",
    "https://github.com/toolboxmd/t3code/issues/20"
  ],
  "prs": [
    "https://github.com/toolboxmd/t3code/pull/9",
    "https://github.com/toolboxmd/t3code/pull/24"
  ],
  "newFiles": [
    ".github/workflows/fork.yml",
    "docs/fork.md",
    "scripts/fork-check.sh",
    "scripts/fork-maintenance.test.ts",
    "scripts/fork-rebase.sh",
    "scripts/fork-upstream-edits.txt",
    "docs/fork-features.md",
    "scripts/fork-features.mjs"
  ],
  "upstreamFiles": [
    ".github/workflows/ci.yml",
    ".github/workflows/mobile-fingerprint-check.yml",
    "knip.jsonc"
  ],
  "sharedFiles": ["scripts/build-desktop-artifact.ts", "apps/server/src/entrypoint.test.ts"],
  "keywords": ["fork", "rebase", "upstream", "blacksmith", "ELECTRON_RUN_AS_NODE", "TMPDIR"]
}
```

## Thread scope

```json
{
  "id": "thread-scope",
  "purpose": "Allow explicit same-project supervision while retaining child-only defaults.",
  "issues": ["https://github.com/toolboxmd/t3code/issues/15"],
  "prs": ["https://github.com/toolboxmd/t3code/pull/16"],
  "newFiles": [],
  "upstreamFiles": [
    "apps/server/src/mcp/toolkits/threads/childThreads.test.ts",
    "apps/server/src/mcp/toolkits/threads/handlers.ts",
    "apps/server/src/mcp/toolkits/threads/tools.ts"
  ],
  "sharedFiles": [],
  "keywords": ["thread scope", "scope", "projectId", "list_threads", "read_thread", "send_message"]
}
```

## Agents panel

```json
{
  "id": "agents-panel",
  "purpose": "Separate Prism and direct spawns, nest child threads and navigate parent and siblings.",
  "issues": ["https://github.com/toolboxmd/t3code/issues/17"],
  "prs": ["https://github.com/toolboxmd/t3code/pull/18"],
  "newFiles": [
    "apps/web/src/components/AgentThreadTree.logic.test.ts",
    "apps/web/src/components/AgentThreadTree.logic.ts",
    "apps/web/src/components/AgentThreadTree.tsx",
    "apps/web/src/components/chat/ThreadParentCrumbs.tsx"
  ],
  "upstreamFiles": [
    "apps/web/src/components/AgentsPanel.tsx",
    "apps/web/src/components/chat/ChatHeader.tsx"
  ],
  "sharedFiles": [],
  "keywords": [
    "AgentsPanel",
    "Prism Spawns",
    "Direct Spawns",
    "child tree",
    "breadcrumb",
    "parentThreadId",
    "sidebar section"
  ]
}
```

## Prism toolkit and role kits

```json
{
  "id": "prism-toolkit",
  "purpose": "Expose provider capacity and assign scoped thread tools through Prism roles.",
  "issues": ["https://github.com/toolboxmd/t3code/issues/19"],
  "prs": ["https://github.com/toolboxmd/t3code/pull/22"],
  "newFiles": [
    "apps/server/src/mcp/toolkits/prism/handlers.test.ts",
    "apps/server/src/mcp/toolkits/prism/handlers.ts",
    "apps/server/src/mcp/toolkits/prism/tools.ts",
    "apps/server/src/mcp/toolkits/threads/roles.test.ts",
    "apps/server/src/mcp/toolkits/threads/roles.ts",
    "apps/server/src/prism/snapshotRoute.test.ts",
    "apps/server/src/prism/snapshotRoute.ts",
    "packages/contracts/src/prism.test.ts",
    "packages/contracts/src/prism.ts",
    "packages/contracts/src/prismSnapshot.ts"
  ],
  "upstreamFiles": [
    "apps/server/src/provider/Drivers/OpenCodeDriver.ts",
    "packages/contracts/src/index.ts",
    "packages/contracts/src/settings.ts"
  ],
  "sharedFiles": [
    "apps/server/src/mcp/McpHttpServer.ts",
    "apps/server/src/mcp/toolkits/threads/handlers.ts",
    "apps/server/src/mcp/toolkits/threads/tools.ts"
  ],
  "keywords": [
    "prism",
    "role kit",
    "prismRoles",
    "spawn_thread",
    "provider snapshot",
    "capacity",
    "usage limit",
    "resume"
  ]
}
```

## Prism settings page

```json
{
  "id": "prism-settings",
  "purpose": "Configure role preferences and show provider usage and capacity in Settings.",
  "issues": ["https://github.com/toolboxmd/t3code/issues/21"],
  "prs": ["https://github.com/toolboxmd/t3code/pull/23"],
  "newFiles": [
    "apps/web/src/components/settings/PrismSettings.logic.test.ts",
    "apps/web/src/components/settings/PrismSettings.logic.ts",
    "apps/web/src/components/settings/PrismSettings.state.test.ts",
    "apps/web/src/components/settings/PrismSettings.state.ts",
    "apps/web/src/components/settings/PrismSettings.tsx",
    "apps/web/src/routes/settings.prism.tsx"
  ],
  "upstreamFiles": [
    "apps/web/src/components/settings/SettingsSidebarNav.tsx",
    "apps/web/src/components/settings/settingsSearch.ts",
    "apps/web/src/routeTree.gen.ts"
  ],
  "sharedFiles": [],
  "keywords": ["PrismSettings", "prismRoles", "role preferences", "capacity", "usage", "settings"]
}
```
