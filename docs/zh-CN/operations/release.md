# Fork 每夜版发布

> 面向 `nolaurence/t3code-chinese` 维护者。

本 fork 只保留一个 GitHub Actions 工作流：[`.github/workflows/release.yml`](../../../.github/workflows/release.yml)。
上游的 CI、部署、npm、移动端、AUR 和稳定版发布工作流不会继续保留。

## 计划与触发方式

- 每天 UTC 18:00（北京时间 02:00）检查一次 `main`。
- 如果 `main` 与上一个每夜版标签指向同一提交，定时任务会在变更检查后结束。
- 手动执行 `workflow_dispatch` 时始终构建，可用于验证工作流修改。
- 同一时间只允许一个每夜版任务运行，后来的任务不会取消正在发布的版本。

## 发布产物

每次发布先运行工作区质量门禁和 release smoke，再构建：

- macOS arm64 DMG 和更新 ZIP
- macOS x64 DMG 和更新 ZIP
- Linux x64 AppImage
- Windows x64 NSIS 安装程序
- 对应的 Electron 更新清单与 blockmap

产物会发布到本仓库的 GitHub 预发布版本。工作流不会发布 `t3` npm 包、部署 T3 Connect
Relay 或托管 Web、更新 AUR、发送公告，也不会把版本号改动写回 `main`。

由于 fork 不发布 `t3`，客户端无法通过 npm 把独立安装的远端服务自动升级到每夜版的精确版本。
桌面内置服务和手动部署的兼容远端仍可使用。要恢复精确版本远端升级，需要 fork 自有 npm 包，
并同步修改客户端与服务端的升级配置。

每夜版标签格式为 `vX.Y.Z-nightly.YYYYMMDD.<run_number>`。基础版本取
`apps/desktop/package.json` 当前版本的下一个补丁版本；包版本只在发布 runner 内临时修改。

## 可选公共配置

没有 T3 Connect 配置也可以生成桌面产物。只有当 fork 拥有自己的兼容服务时才配置以下仓库变量：

- `RELAY_URL`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `CLERK_PASSKEY_RP_DOMAINS`

自动更新仓库从 `GITHUB_REPOSITORY` 推导，因此 fork 构建会从当前仓库检查更新，不会访问上游发布源。

## 可选签名

默认生成未签名产物。macOS 签名与公证需要：

- Secrets：`CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_API_KEY`、`APPLE_API_KEY_ID`、
  `APPLE_API_ISSUER`、`MACOS_PROVISIONING_PROFILE`
- Variable：`APPLE_TEAM_ID`
- Passkey 权限还需要 `CLERK_PUBLISHABLE_KEY` 或 `CLERK_PASSKEY_RP_DOMAINS`

Windows Azure Trusted Signing 需要：

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

如果没有完整凭据，该平台会生成未签名产物。不要保留只配置了一部分的签名凭据。

## 验证步骤

1. 将工作流推送到本仓库的分支。
2. 打开 **Actions > Fork Nightly > Run workflow**，选择该分支。
3. 确认质量门禁和四个平台构建全部通过。
4. 确认 GitHub 预发布版本包含安装包、macOS ZIP、更新清单与 blockmap。
5. 在依赖每日定时发布前，至少在每个操作系统上安装验证一次。

本地发布专项检查：

```bash
vp run release:smoke
vp test run scripts/resolve-nightly-release.test.ts \
  scripts/resolve-previous-release-tag.test.ts \
  scripts/update-release-package-versions.test.ts \
  scripts/merge-update-manifests.test.ts
```
