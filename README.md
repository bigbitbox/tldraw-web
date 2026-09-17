# 自部署白板

运行在 `ali-hk-24`。入口：<https://tldraw.rayzor.site>，固定画布链接：<https://tldraw.rayzor.site/r/main>。公网可访问登录页，画布、附件、同步与 AI 接口均要求认证。

这是基于官方组件整合的自部署实例，镜像由本仓库构建，不是官方 Docker 镜像。画布和同步依赖固定为 tldraw 5.4.2；官方 Agent 模板来源版本记录在 `UPSTREAM-REVISION`。

## 功能与数据

- 工作区列表、新建、重命名、拖拽排序和删除画布；`main` 主白板是固定入口不能删除，删除其他画布会一并清理它引用的附件。通过 `/r/<id>` 在多设备打开同一画布。
- 官方 tldraw sync 同步图形、页面、图片和鼠标状态，Node 内置 SQLite 持久化。
- 官方 Agent 模板的 AI 侧栏，使用 DeepSeek `deepseek-flash`。AI 修改会同步到其他设备。
- AI 对话历史按画布保存在当前浏览器，**对话历史不跨设备同步**；画布内容由服务器同步。
- Codex 可经带认证的 HTTP 接口读取和修改画布，修改经同一个房间广播。
- 一个 Docker 容器。房间、工作区及附件在 `/home/ray/datas/tldraw`；重建容器保留数据。
- 无服务器任意 URL 抓取；书签显示原 URL。上传限 20 MiB，支持 PNG/JPEG/GIF/WebP/AVIF 和 MP4/WebM。

当前以 `APP_ENV=production` 构建，已接入官方 Trial 许可证，到期日 **2026-12-21**，试用覆盖任意域名。Hobby 申请已提交，尚待官方审核。保留 SDK 原有授权检查逻辑。许可证并不替代 AI 模型的费用。

## 访问与凭证

浏览器优先选择“使用 Authelia 登录”，以 `auth.rayzor.site` 的 `ray` 身份进入现有工作区。也保留访问口令登录。OIDC 仅允许已核对的本人 subject；没有改变画布的所有权，也没有开放多用户共享。

本机：

- `~/.config/tldraw/access.txt`：浏览器入口和访问口令。
- `~/.config/tldraw/curl.conf`：Codex API 用的独立 Bearer token。
- `~/.config/tldraw/server.env`：服务端凭证备份。
- `~/.config/tldraw/license-key.txt`：官方许可证原文；通过 BuildKit secret 传入构建，不写入 Git。许可证是浏览器可见的签名授权字符串，会编译进入前端。

远端：`/home/ray/.config/tldraw/server.env`，由 Nix OCI 的 `environmentFiles` 注入。服务端凭证文件均为 0600，不进 Git、Nix store 或镜像。浏览器只接收 HttpOnly 会话 cookie，不接收模型 API key。改访问口令后重启服务，已有 cookie 失效。

OIDC 的 `OIDC_CLIENT_SECRET` 和 `OIDC_ALLOWED_SUBJECT` 单独保存在 `/home/ray/.config/authelia/tldraw-oidc.env`，Mac 副本位于 `~/.config/authelia/ali-hk-24/tldraw-oidc.env`。`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_REDIRECT_URI` 由主机 Nix 配置管理；缺少 issuer 时保留原口令模式，配置 OIDC 时必须同时指定完整凭据、HTTPS 地址和明确的本人 subject。

登录路由为 `/auth/oidc/start` 和 `/auth/oidc/callback`。`openid-client` 校验 issuer、audience、有效期、ID Token 签名、state、nonce 与 PKCE S256；回调只能返回 `/` 或本地画布路径。登录事务在内存最多保留 10 分钟，每个 IP 最多 10 个未完成事务，全局最多 1000 个。若重启发生在授权途中，重新点击登录即可。

登录成功后复用原有 `whiteboard_session`，因此重建/重启容器不会强制已登录浏览器退出；CLI Bearer token 不变。该既有会话由访问口令派生，浏览器 Cookie 有效期为 30 天，服务端没有逐会话撤销功能。网页注销只退出本应用；如需立即撤销所有浏览器会话，应更换 `ACCESS_TOKEN` 并重启。禁用 Authelia 用户不会立即撤销已发出的应用本地会话。

Cloudflare DNS 的 A 记录直连香港服务器，Caddy 自动签发、续期 HTTPS 证书并代理 WebSocket/SSE。容器只绑定 `127.0.0.1:5858`，会话 cookie 标记为 Secure，允许的浏览器来源仅为正式 HTTPS 域名。后端仅信任紧邻的 Caddy 代理，以客户端地址执行登录限流。首次访问可通过 Authelia 或访问口令登录；原 HTTP 域名下的本地 AI 对话历史不会自动迁移，画布数据保持不变。旧 Tailscale HTTP 入口已退役；Tailnet Serve 未启用。实例不依赖官方 demo 同步服务器。

## 本地 Codex 操作

推荐使用独立的 `tldraw` CLI + Skill，支持画布 URL、新建/读取/改名、批量作画及图片读取/插入。安装与认证见 [CLI 说明](cli/README.md)。原 curl recipes 保留用于底层运维。

```sh
tldraw auth status
tldraw board create --name '新画布'
tldraw board read 'https://tldraw.rayzor.site/r/main'
tldraw schema board.apply
```

在仓库根目录运行：

```sh
just -f apps/tldraw/justfile canvas-list
just -f apps/tldraw/justfile canvas-get main
just -f apps/tldraw/justfile canvas-apply main /tmp/changes.json
```

读取返回 `{revision, schema, records}`。修改体格式：

```json
{
  "expectedRevision": 10,
  "upsert": [],
  "delete": []
}
```

`upsert` 是完整 tldraw shape/asset/binding 记录，最方便的方式是从 `records` 取出目标图形，修改 `x`、`y` 或 `props` 后提交。创建记录时需要完整属性及有效的 `parentId`。禁止修改或删除 document/page 等结构记录。HTTP 409 表示期间有其他修改：重新读取并基于新状态修改，不能盲目重试旧数据。API 不执行任意 JavaScript。

API 修改和 AI 的修改都会实时反映到已打开的画布。正式构建关闭 `window.editor` 和 `window.agentApp` 调试入口；外部 Agent 使用带认证的 HTTP API。

## 构建、部署与运维

```sh
just -f apps/tldraw/justfile check
just -f apps/tldraw/justfile build
just -f apps/tldraw/justfile load
just -f hosts/nixos/server/ali-hk-24/justfile deploy
just -f apps/tldraw/justfile status
just -f apps/tldraw/justfile logs
just -f apps/tldraw/justfile restart
just -f apps/tldraw/justfile backup
```

本机 OrbStack 构建 Linux amd64 镜像和 NixOS 配置；远端只接收镜像、闭包并激活服务。更新同名镜像后需要 `restart`。`build` 已包含 `--no-cache-filter build`，替换许可证后执行它即可；BuildKit secret 内容变化本身不会自动使缓存失效。首次部署需先落盘 `server.env`，再加载镜像并部署 Nix 配置。

`backup` 短暂停止白板、打包完整数据目录、恢复服务，输出备份路径；不备份凭证。恢复时停止服务、将备份解压回 `/home/ray/datas` 并确认目录属主为 `ray:users`，然后启动。不要在运行时直接复制单个 SQLite 文件，WAL 可能尚未合并。

服务名 `docker-tldraw-dev`，镜像 `ori/tldraw:20260913-oidc`。默认限制 768 MiB 内存、1.5 CPU、256 进程，只读容器文件系统，仅 `/data` 和临时目录可写。

2026-09-13 OIDC 验收：服务端 3 项测试、CLI 9 项测试、TypeScript 检查及 Linux amd64 生产构建通过；Vivaldi 真实 OIDC 登录无需再次输入密码，返回 `/r/main` 并正常加载画布。重启后同一浏览器会话与原 API token 均有效，4 个画布、65 条记录的 revision 和内容摘要与升级前一致。升级前完整数据备份：`/home/ray/backups/tldraw/20260913-100600.tar.gz`。

## 上游

- [tldraw SDK](https://github.com/tldraw/tldraw)，受 tldraw license 约束。
- [官方 Node 同步示例](https://github.com/tldraw/tldraw/tree/main/templates/simple-server-example)。
- [官方 Agent 模板](https://github.com/tldraw/tldraw/tree/main/templates/agent)，保留在 `UPSTREAM-LICENSE.md` 中的 MIT 许可。
- 本地调整：替换 Cloudflare 外壳为 Node 服务；接入 Sync、会话认证、工作区列表、DeepSeek Chat Completions、Codex records API 和本地静态资源。
