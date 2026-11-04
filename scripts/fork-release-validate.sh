#!/usr/bin/env bash
# The fork's release gate. The nightly release runs it before packaging and every
# PR into the release branch runs it too, so a change that would break the nightly
# is caught before it merges. Add fork feature tests here rather than in either workflow.
set -euo pipefail

node scripts/check-patch-pins.ts
node scripts/check-upstream-migrations.ts
node scripts/check-fork-guards.ts
# shellcheck disable=SC2046 # one test file per word
NODE_ENV=test vp test run $(node -p "[...new Set(require('./scripts/fork-guards.json').map((g) => g.test))].join(' ')")

NODE_ENV=test vp test run \
  apps/web/src/components/agents \
  packages/client-runtime/src/gateway \
  packages/mcp-gateway/src \
  apps/server/src/mcp/toolkits/project \
  apps/server/src/mcp/agents \
  apps/server/src/mcp/McpGatewayBroker.test.ts \
  apps/server/src/orchestration-v2/Orchestrator.parentThread.test.ts \
  apps/server/src/orchestration-v2/pullRequestWatch.test.ts \
  apps/server/src/threadTask \
  apps/server/src/scheduledTasks \
  apps/server/src/clients \
  scripts/build-desktop-artifact.test.ts
NODE_ENV=test vp test run \
  apps/server/src/persistence/ForkMigrations.test.ts \
  apps/server/src/persistence/Migrations.test.ts \
  apps/server/src/persistence/Migrations/fork \
  apps/server/src/persistence/Migrations/050_ProjectionThreadPullRequests.test.ts \
  apps/server/src/persistence/Migrations/051_ProjectionThreadMessageContext.test.ts \
  apps/server/src/persistence/Migrations/052_ProjectionThreadTitleState.test.ts \
  apps/server/src/persistence/Migrations/053_PullRequestFilesViewed.test.ts \
  apps/server/src/persistence/Migrations/054_ProjectionThreadsAutoSettleDisabledAt.test.ts
NODE_ENV=test vp test run \
  apps/desktop/src/app/SharedSafeStorage.test.ts \
  apps/desktop/src/app/LegacyTokenStorage.test.ts \
  apps/desktop/src/app/DesktopClerk.test.ts \
  apps/desktop/src/app/DesktopConnectionCatalogStore.test.ts
vp run --filter @t3tools/web --filter @t3tools/desktop --filter @t3tools/client-runtime \
  --filter @t3tools/mcp-gateway --filter @t3tools/contracts --filter @t3tools/scripts \
  --filter t3 typecheck
