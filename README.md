# 私有白板开发环境

运行在 `ali-hk-24`，仅监听 Tailscale 地址。入口：<http://100.97.118.114:5858>，固定画布链接：<http://100.97.118.114:5858/r/main>。访问设备需要连接同一 Tailnet。

这是基于官方组件整合的开发联调实例，镜像由本仓库构建，不是官方 Docker 镜像。画布和同步依赖固定为 tldraw 5.4.2；官方 Agent 模板来源版本记录在 `UPSTREAM-REVISION`。

## 功能与数据

- 工作区列表、新建和重命名画布；通过 `/r/<id>` 在多设备打开同一画布。
- 官方 tldraw sync 同步图形、页面、图片和鼠标状态，Node 内置 SQLite 持久化。
- 官方 Agent 模板的 AI 侧栏，使用 DeepSeek `deepseek-flash`。AI 修改会同步到其他设备。
- AI 对话历史按画布保存在当前浏览器，**对话历史不跨设备同步**；画布内容由服务器同步。
- Codex 可经带认证的 HTTP 接口读取和修改画布，修改经同一个房间广播。
- 一个 Docker 容器。房间、工作区及附件在 `/home/ray/datas/tldraw`；重建容器保留数据。
- 无服务器任意 URL 抓取；书签显示原 URL。上传限 20 MiB，支持 PNG/JPEG/GIF/WebP/AVIF 和 MP4/WebM。

此版本是开发测试构建，保留官方开发提示和许可证检查逻辑，没有许可证补丁。正式长期使用前需取得有效许可证；`APP_ENV=production` 和 `VITE_TLDRAW_LICENSE_KEY` 用于正式构建。许可证并不替代 AI 模型的费用。

## 访问与凭证

本机：

- `~/.config/tldraw/access.txt`：浏览器入口和访问口令。
- `~/.config/tldraw/curl.conf`：Codex API 用的独立 Bearer token。
- `~/.config/tldraw/server.env`：服务端凭证备份。

远端：`/home/ray/.config/tldraw/server.env`，由 Nix OCI 的 `environmentFiles` 注入。上述文件均为 0600，不进 Git、Nix store 或镜像。浏览器只接收 HttpOnly 会话 cookie，不接收模型 API key。改访问口令后重启服务，已有 cookie 失效。

内网 HTTP 由 Tailscale/WireGuard 保护传输。浏览器的部分剪贴板能力可能要求 HTTPS；Tailnet 当前未开启 Serve，未开放公网 HTTPS 服务。开发实例本身不依赖官方 demo 同步服务器，不受 demo 的一天清理期限影响。

## 本地 Codex 操作

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

API 修改和 AI 的修改都会实时反映到已打开的画布。开发构建在浏览器内暴露 `window.editor` 和 `window.agentApp`，便于本地浏览器调试；它们不是公开远程执行端点。

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

本机 OrbStack 构建 Linux amd64 镜像和 NixOS 配置；远端只接收镜像、闭包并激活服务。更新同名镜像后需要 `restart`。首次部署需先落盘 `server.env`，再加载镜像并部署 Nix 配置。

`backup` 短暂停止白板、打包完整数据目录、恢复服务，输出备份路径；不备份凭证。恢复时停止服务、将备份解压回 `/home/ray/datas` 并确认目录属主为 `ray:users`，然后启动。不要在运行时直接复制单个 SQLite 文件，WAL 可能尚未合并。

服务名 `docker-tldraw-dev`，镜像 `ori/tldraw-dev:20260912`。默认限制 768 MiB 内存、1.5 CPU、256 进程，只读容器文件系统，仅 `/data` 和临时目录可写。

## 上游

- [tldraw SDK](https://github.com/tldraw/tldraw)，受 tldraw license 约束。
- [官方 Node 同步示例](https://github.com/tldraw/tldraw/tree/main/templates/simple-server-example)。
- [官方 Agent 模板](https://github.com/tldraw/tldraw/tree/main/templates/agent)，保留在 `UPSTREAM-LICENSE.md` 中的 MIT 许可。
- 本地调整：替换 Cloudflare 外壳为 Node 服务；接入 Sync、会话认证、工作区列表、DeepSeek Chat Completions、Codex records API 和本地静态资源。
