# 自托管 T3 Code

本指南通过 HTTPS/WSS 反向代理公开一个 T3 环境，并启用自托管账号密码会话。推荐架构是让
Windows 电脑继续持有 provider 和工作区，VPS 只负责公网 TLS 与路由入口。

## 架构与限制

```text
手机/网页 -> HTTPS/WSS VPS nginx -> 私有隧道 -> Windows T3 环境 -> provider CLI
```

- 命令由实际持有工作区的环境服务器鉴权并执行。
- `control.sendText` 只能发起普通线程 turn，不能提交任意 shell 或 argv。
- 当前没有离线持久命令队列；环境服务器必须在线且可达。
- 在 VPS 上运行 Docker 会创建独立的 Linux 环境，其 provider 和工作区位于容器/宿主机，
  不会自动控制 Windows 本地工作区。
- Web、桌面端和移动端共享同一协议；直连、Tailscale、反向代理均可使用，但 HTTP 与
  WebSocket 必须到达同一个环境。

## 前置条件

- 域名 A/AAAA 记录已指向 VPS
- Ubuntu 24.04 或其他受支持的 Linux
- 源码部署使用 Node.js 24 与 pnpm 11，或安装 Docker Engine 与 Compose
- VPS 到 Windows 主机存在私有通路，推荐 Tailscale 或 WireGuard
- 公网只开放 TCP 80/443，不要公开 T3 源站端口

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 使用淘宝镜像构建

仓库 `.npmrc` 已使用 `https://registry.npmmirror.com`，并设置 npmmirror 的 Node、Electron
和 electron-builder 镜像。由于淘宝镜像没有锁定的 `@distilled.cloud` 版本，该 scope 必须
回退到 npm 官方源。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @t3tools/web build
pnpm --filter t3 build:bundle
cp -R apps/web/dist apps/server/dist/client
```

不要设置 `VITE_HTTP_URL` 或 `VITE_WS_URL`。客户端使用同源模式，由 nginx 同时代理 HTTP
和 WebSocket。

## 创建账号文件

下列命令生成 scrypt 哈希，账号文件中不会保存明文密码：

```bash
read -rsp 'Password: ' T3_PASSWORD; echo
export T3_PASSWORD
node -e 'const c=require("node:crypto");const s=c.randomBytes(16);const d=c.scryptSync(process.env.T3_PASSWORD,s,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});console.log(`scrypt$16384$8$1$${s.toString("base64url")}$${d.toString("base64url")}`)'
unset T3_PASSWORD
```

创建权限为 `0600`、归服务账号所有的 `/etc/t3code/accounts.json`：

```json
{
  "version": 1,
  "accounts": [
    {
      "username": "demo",
      "passwordHash": "scrypt$16384$8$1$替换盐值$替换派生密钥",
      "scopes": ["orchestration:read", "orchestration:operate"],
      "label": "演示账号"
    }
  ]
}
```

不要提交此文件。默认 scope 只允许读取编排状态和发送正常 turn，不授予访问管理权限。

## 运行 Windows 源站

在 Windows PowerShell 中按前述命令构建。绑定 VPS 能通过 Tailscale/LAN 私下访问的地址：

```powershell
$env:T3CODE_HOST = "100.64.0.10"
$env:T3CODE_PORT = "3773"
$env:T3CODE_HOME = "C:\ProgramData\T3CodeSelfHosted"
$env:T3CODE_NO_BROWSER = "true"
$env:T3CODE_SELFHOST_ACCOUNTS_FILE = "C:\ProgramData\T3CodeSelfHosted\accounts.json"
$env:T3CODE_SELFHOST_REQUIRE_SECURE_TRANSPORT = "true"
node apps/server/dist/bin.mjs serve
```

把 `infra/self-hosted/nginx-t3.conf` 的 `proxy_pass` 改成 Windows 私网地址，例如
`http://100.64.0.10:3773`。保留 `X-Forwarded-Proto https`，安全传输校验依赖该头部。
使用任务计划程序或 Windows 服务管理器保持源站运行。

## 使用 systemd 运行 Linux 源站

将构建后的仓库放到 `/opt/t3code`，并创建 `/etc/t3code/t3code.env`：

```ini
T3CODE_HOST=127.0.0.1
T3CODE_PORT=3773
T3CODE_HOME=/var/lib/t3code
T3CODE_NO_BROWSER=true
T3CODE_SELFHOST_ACCOUNTS_FILE=/etc/t3code/accounts.json
T3CODE_SELFHOST_REQUIRE_SECURE_TRANSPORT=true
```

```bash
sudo install -m 0644 infra/self-hosted/t3-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now t3-server
sudo systemctl status t3-server
journalctl -u t3-server -f
```

## 使用 Docker 运行 Linux 源站

把 `.env.example` 复制为 `.env`，在 Compose 文件旁创建 `accounts.json`，然后运行：

```bash
cd infra/self-hosted
docker compose build
docker compose up -d
docker compose logs -f t3code
```

Compose 端口只绑定 `127.0.0.1`，nginx 是唯一公网监听器。状态保存在 `t3code-data`
卷中，账号文件以只读方式挂载。

## 配置 TLS 与 nginx

替换 `infra/self-hosted/nginx-t3.conf` 中的 `t3.example.com`，安装配置并申请证书：

```bash
sudo cp infra/self-hosted/nginx-t3.conf /etc/nginx/sites-available/t3code
sudo ln -s /etc/nginx/sites-available/t3code /etc/nginx/sites-enabled/t3code
sudo nginx -t
sudo certbot --nginx -d t3.example.com
sudo systemctl reload nginx
sudo certbot renew --dry-run
```

Upgrade 头和长超时用于 WebSocket，不能删除。

## 在线客户端、撤销与日志

- 具有 `access:read` 的会话可通过 `GET /api/auth/clients` 查看客户端会话。
- 具有 `access:write` 的会话可调用 `POST /api/auth/clients/revoke` 或
  `/api/auth/clients/revoke-others`。默认自托管账号刻意不含这些 scope；请使用已配对的
  管理员会话或现有管理界面撤销服务端会话。
- 现有会话存储会跟踪 WebSocket 上下线；具有 `orchestration:read` 的调用方可通过
  `control.requestStatus` 获取轻量服务器、会话和客户端状态。
- 服务追踪日志位于 `$T3CODE_HOME/userdata/logs`；systemd 使用 journald；Docker 使用
  `docker compose logs`；nginx 日志位于 `/var/log/nginx`。
- 控制审计记录 subject、session、客户端元数据、方法、目标、结果、trace ID、文本长度、
  SHA-256 和规范化后的 80 字符摘要，不记录完整正文。

## 本地复现与验收

```bash
T3CODE_HOST=127.0.0.1 \
T3CODE_PORT=3773 \
T3CODE_HOME="$PWD/.t3-selfhost" \
T3CODE_SELFHOST_ACCOUNTS_FILE="$PWD/accounts.json" \
T3CODE_SELFHOST_REQUIRE_SECURE_TRANSPORT=false \
node apps/server/dist/bin.mjs serve

curl -i http://127.0.0.1:3773/api/login \
  -H 'content-type: application/json' \
  --data '{"username":"demo","password":"替换密码","client":{"label":"curl"}}'
```

生产验收步骤：

1. 确认 HTTP 跳转 HTTPS，证书校验通过。
2. 正确账号返回 bearer 会话；错误账号与不存在账号均返回相同的 401。
3. Web/移动端通过公网 URL 连接，确认 WebSocket 可重连。
4. 按 scope 调用 `control.ping`、`control.requestStatus`、`control.sendText`。
5. 确认纯空白/超长文本和 scope 不足请求被拒绝并写入审计。
6. 撤销测试会话，确认 HTTP 与 WebSocket 访问均失效。

## 回滚

升级前保留旧镜像标签或发行目录，并备份 `$T3CODE_HOME/userdata`。Docker 回滚时改回旧
镜像并运行 `docker compose up -d`；systemd 回滚时恢复旧 `/opt/t3code` 并重启服务。
不要直接复制正在使用的 SQLite 文件；应先停止服务，或使用 SQLite `VACUUM INTO`。

## 常见故障

- 登录始终返回 401：检查账号路径、JSON 版本、scrypt 格式、文件权限，以及 HTTPS/
  `X-Forwarded-Proto` 链路。
- 页面能打开但无法连接：检查 nginx Upgrade/Connection 头，并确认 `/ws` 与 `/api`
  指向同一源站。
- nginx 返回 502：检查 VPS 到 Windows 的私有路由，或容器 loopback 端口。
- 找不到 provider：在实际环境主机安装并登录 provider。只在 VPS 安装无法操作 Windows 工作区。
- 源站离线时发送的命令不会保留；恢复连接后需要重新发送。
