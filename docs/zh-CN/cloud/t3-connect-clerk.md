# T3 Connect Clerk 配置

T3 Connect 使用一个 Clerk 应用完成 Web、桌面和移动端认证。Relay 只接受由 `t3-relay` 模板生成且受众为共享值 `t3-code-relay` 的 Clerk JWT。

## 应用密钥

新克隆的仓库默认禁用 T3 Connect。要在源码构建中启用它，请在仓库根目录添加 `.env` 或 `.env.local` 文件：

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

共享客户端加载器会将这些规范值映射为框架专用的 `VITE_*` 和 `EXPO_PUBLIC_*` 别名。为兼容已有配置，现有别名仍可作为覆盖值使用，但新的客户端配置应使用规范名称。

配置优先级如下：

1. 进程或 CI 环境变量。
2. 仓库根目录的 `.env.local`。
3. 仓库根目录的 `.env`。

Clerk 可发布密钥、JWT 模板名称、CLI OAuth 客户端 ID 和 Relay URL 都是公开标识符，不是机密。Web、桌面、移动端和捆绑服务器构建会在构建步骤静态注入各自使用的值。构建产物运行时不需要环境文件。CI 发布构建应在构建前设置 `T3CODE_CLERK_PUBLISHABLE_KEY`、`T3CODE_CLERK_JWT_TEMPLATE`、`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` 和 `T3CODE_RELAY_URL`。EAS 预览与生产构建只需在 EAS 环境中配置 Clerk 可发布密钥、JWT 模板名称和 Relay URL。

任何面向客户端的公开值缺失时，云端 UI 都不会显示。CLI 公开值缺失时，`t3 connect` CLI 命令组不会显示。捆绑服务器仍接受运行时覆盖，以支持自托管或运维人员管理的部署。

对于托管 Relay 部署，将 `infra/relay/.env.example` 复制到 `infra/relay/.env`。Relay 部署通过 Effect `Config` 读取 `RELAY_DOMAIN`、`RELAY_API_ZONE_NAME`、`RELAY_TUNNEL_ZONE_NAME`、`CLERK_PUBLISHABLE_KEY` 和 `CLERK_JWT_AUDIENCE`。仓库中没有部署默认值。`vp run --filter t3code-relay deploy` 会从 Relay 目录调用 Alchemy，因此 Alchemy 会加载 `infra/relay/.env`。部署成功后，包装脚本会使用已部署的 HTTPS Relay URL 更新仓库根目录的 `.env`。Relay 仍需将 `CLERK_SECRET_KEY` 作为 Alchemy 机密。绝不要将 `CLERK_SECRET_KEY` 放入客户端应用环境或提交到仓库。

`prod` Alchemy 阶段拥有保留的 PlanetScale 数据库。非生产阶段引用该数据库并预置相互隔离的 PlanetScale 分支，因此请先部署 `prod`，再创建个人开发阶段。

## 无界面 CLI OAuth 应用

`t3 connect` 命令使用独立的 Clerk OAuth 应用为无界面环境授权。它使用带 PKCE 的 OAuth 公开客户端，因此 CLI 不存储客户端密钥。

在 **Clerk Dashboard > OAuth applications** 中：

1. 为 T3 CLI 创建 OAuth 应用。
2. 启用 **Public** 选项，使授权码交换使用 PKCE。
3. 将 `http://127.0.0.1:34338/callback` 添加为允许的重定向 URI。
4. 启用 `openid`、`profile` 和 `email` 作用域。
5. 将仓库根目录 `.env` 文件和发布构建环境中的 `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` 设置为生成的公开客户端 ID。

CLI 从可发布密钥推导 Clerk 前端 API URL，并直接调用 Clerk 的 `/oauth/authorize` 和 `/oauth/token` 端点。Relay 不参与 OAuth 握手；只有在 CLI 管理环境关联时，它才验证签发的 Clerk Bearer 令牌。

CLI 支持以下无界面操作：

```sh
t3 connect login
t3 connect link
t3 connect status
t3 connect unlink
t3 connect logout
t3 serve
```

`t3 connect login` 打开 Clerk 授权流程并存储 CLI 凭据，但不启用云端暴露。`t3 connect link` 会在需要时安装锁定版本的托管 `cloudflared` 二进制文件、执行授权，并记录暴露环境的持久意图。该命令无需运行中的 T3 服务器。下一次执行 `t3 serve` 或 `t3 start` 时会协调 Relay 关联并启动托管隧道。`t3 connect unlink` 会立即记录禁用意图、停止可访问且正在运行的连接器，并尝试撤销 Relay 端环境记录。它会保留已存储的 CLI 授权，使 `t3 connect link` 能够重新启用暴露而不必再次执行浏览器流程。`t3 connect logout` 会执行相同的清理并移除已存储的 CLI 授权。

当前 OAuth 回调监听器绑定到回环端口 `34338`。通过 SSH 运行 CLI 时，请先转发该端口，再运行 `t3 connect login` 或 `t3 connect link`：

```sh
ssh -L 34338:127.0.0.1:34338 <host>
```

将来可以使用 Relay 托管的回调代理去掉端口转发要求，而无需更改已存储的 PKCE 令牌模型。

## JWT 模板

在 **Clerk Dashboard > JWT templates** 中创建以下模板：

| 设置 | 值                           |
| ---- | ---------------------------- |
| 名称 | `t3-relay`                   |
| 声明 | `{ "aud": "t3-code-relay" }` |

在仓库根目录 `.env` 中设置 `T3CODE_CLERK_JWT_TEMPLATE=t3-relay`，并在 `infra/relay/.env` 中设置 `CLERK_JWT_AUDIENCE=t3-code-relay`。生产 Relay 部署环境中也要定义 `CLERK_JWT_TEMPLATE` 和 `CLERK_JWT_AUDIENCE`。稳定的 `aud` 值由生产和非生产 Relay 阶段共享。面向客户端的 `T3CODE_RELAY_URL` 仍用于选择具体 Relay 部署，但更改该 URL 无需更改 JWT 模板。

## 桌面 OAuth 重定向允许列表

桌面应用在系统浏览器中打开 OAuth，并使用自定义 URL 方案返回应用。在 **Clerk Dashboard > Native applications** 中启用 Native API，并在移动 SSO 重定向允许列表中添加：

```text
t3code-dev://app/
t3code://app/
```

本地桌面开发使用 `t3code-dev://app`，打包构建使用 `t3code://app`。还要将匹配的源添加到每个 Clerk 实例后端 API 的 `allowed_origins` 数组。开发 Clerk 实例只需 `t3code-dev://app`，生产 Clerk 实例只需 `t3code://app`。`@clerk/electron` 负责原生请求适配器、加密的 Clerk 令牌持久化、外部浏览器 OAuth 传输，以及首次登录和关联账户流程中的回调传递。

目前没有用于 `allowed_origins` 的 Dashboard UI。保留已有条目，并通过后端 API 更新实例：

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -d '{"allowed_origins":["t3code://app"]}'
```

绝不要将 `CLERK_SECRET_KEY` 放入桌面应用、面向客户端的环境文件或构建产物。

## 桌面通行密钥

生产 macOS 包 ID 为 `com.t3tools.t3code`。启用原生通行密钥：

1. 在 Apple Developer 门户中为 `com.t3tools.t3code` 创建显式 macOS App ID，并启用 **Associated Domains**。
2. 为该 App ID 和签署分发应用所用的证书创建兼容的 macOS 预置描述文件。
3. 在 Clerk 的 Native API 设置中，添加一个具有相同 Apple Team ID 和包 ID 的 iOS 应用。这也是 Electron/macOS 通行密钥的配置位置。
4. 确认 Clerk 提供 `https://<frontend-api>/.well-known/apple-app-site-association`，并且 `webcredentials.apps` 包含 `<TEAM_ID>.com.t3tools.t3code`。
5. 设置下文所述的本地或 CI 签名配置。

对于本地签名构建，将以下值添加到 `.env.local`，或在调用桌面产物命令前导出：

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/t3code.provisionprofile
# 可选：Clerk 的 RP ID 与前端 API 主机名不同时，以逗号分隔的覆盖值。
T3CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

未设置 `T3CODE_CLERK_PASSKEY_RP_DOMAINS` 时，构建会从 `T3CODE_CLERK_PUBLISHABLE_KEY` 推导 RP 域。如果缺少 Team ID、预置描述文件或 RP 域配置，签名的 macOS 构建会提前失败。生成的主应用权限文件包含所有已配置的 `webcredentials:<domain>` 条目；辅助应用保留 Electron 的最小默认权限。

常规 `dev:desktop` 启动器未签名，无法完成 macOS 通行密钥仪式。要使用渲染器 HMR，请先构建并安装签名应用、运行渲染器开发服务器，然后在设置 `VITE_DEV_SERVER_URL` 和 `T3CODE_PORT` 后启动已安装的应用可执行文件。原生依赖、主进程、预加载、权限、预置或签名发生变化后要重新构建签名应用；只有渲染器发生变化时可以复用已安装应用。

使用默认开发端口时，在一个终端中运行 `pnpm dev:web`，并从另一个终端启动已安装的二进制文件：

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
T3CODE_PORT=13773 \
  "/Applications/T3 Code (Browser).app/Contents/MacOS/T3 Code (Browser)"
```

更改 Associated Domains 后，请在重新构建前增加构建版本；否则 macOS 可能为相同应用/版本组合复用过期的 Shared Web Credentials 元数据。

测试前验证已安装的应用包：

```sh
codesign --verify --deep --strict "/Applications/T3 Code (Browser).app"
codesign -d --entitlements :- "/Applications/T3 Code (Browser).app"
```

当前移动端 UI 使用 Clerk 原生认证视图。如果未来的移动端浏览器 OAuth 流程使用自定义重定向 URI，请将该 URI 原样添加到同一允许列表。

## 启用候补名单访问

对于需要用户申请访问权限的私有测试，请使用 **Clerk Dashboard > Waitlist**：

1. 打开 **Enable waitlist** 并保存。
2. 在同一页面审查申请，选择 **Invite** 或 **Deny**。

获准且已登录的用户在**连接**中管理 T3 Connect。Web 和桌面侧栏不提供专用账户或候补名单控件。未登录用户可从“连接”页面的 T3 Connect 控件按上下文进入 Clerk 候补名单和登录流程。

在移动端，未登录用户打开**设置 > T3 账户**，在设置表单页中进入 `/settings/waitlist`。该页面通过 Clerk 的 `useWaitlist()` 流程提交注册，因为预构建的 `<Waitlist />` 组件在 Expo SDK 中仅支持 Web。获准用户可在该页面使用**登录**。

## 替代方案：已知用户允许列表

对于所有获准用户均已提前确定的封闭测试，请使用允许列表，而不是申请与审批式候补名单。

要将测试限制为允许的电子邮件地址或域名：

1. 在 **Clerk Dashboard > Restrictions > Allowlist** 中添加每个允许的电子邮件地址或域名。
2. 启用允许列表并保存。
3. 或者，在所有新用户都必须被明确邀请或手动创建，且不提供候补申请流程时启用 **Restricted mode**。

不要启用空允许列表：它会阻止所有新用户注册。

Clerk 允许列表控制谁能够注册，但不会撤销已有用户的活动云端访问权限。要移除已创建用户的访问权限，请在 Clerk 中封禁该用户，以结束其活动会话并拒绝未来登录。
