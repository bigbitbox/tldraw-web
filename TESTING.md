# 部署验收（2026-09-12）

部署主机 `ali-hk-24`，镜像 `ori/tldraw-dev:20260912`，镜像 ID `sha256:afdfa0bab8d318becc855e98ba6fea733ed80e7b312bf082ac50df54f4e5a640`。

## 已完成

- 本机 `npm run check`、`npm test`、Docker 内完整构建通过。测试覆盖登录 cookie、未授权及编码路径访问、跨站 Origin 拒绝、房间创建、原子修改回滚、过期 revision 拒绝、附件及数据库持久化。
- NixOS 配置在本机 OrbStack 构建并复制到远端激活；未在云服务器编译。新增 `docker-tldraw-dev`，已有应用未重启。
- Mac 和 m1max 经 Tailscale 访问远程 `/healthz` 成功。只绑定 `100.97.118.114:5858`；Docker healthy，验收时空闲内存约 93 MiB。
- 两个真实 WebSocket 客户端通过官方协议握手；A 写入、B 收到，B 写入、A 收到；Codex HTTP API 写入同时广播至两个客户端；过期修改返回 409。
- Chrome 登录远程页面，官方 Agent 侧栏调用 DeepSeek，真实生成两个带中文标签的矩形及连接箭头，并接受结果。
- 第二个 Chrome 标签页打开同一画布、拖动矩形，第一个标签页无需刷新立即显示更新。
- Codex HTTP API 将矩形文字改为“Codex 已修改”，浏览器实时显示结果。
- 远程上传及读取 PNG 字节一致；未经认证读取被拒绝。
- 替换镜像、重启容器、执行停服备份后，记录、revision 和附件字节均与重启前一致；浏览器自动重连并显示“已同步”。
- 备份已生成并检查归档内容：`/home/ray/backups/tldraw/20260912-221537.tar.gz`。未对正在使用的数据执行覆盖恢复演练。

验收画布：<http://100.97.118.114:5858/r/5bf3099d-4180-49f9-9ffb-31a4b588f3c9>。主画布 `main` 保留为空，供正式开始绘制。

## 边界

- xplayer 验收时离线，未在该设备实际打开页面；双会话浏览器同步及 m1max 网络访问已验证。
- AI 对话历史仅保存在当前浏览器；同步的是画布内容。
- 当前是保留官方授权提示的开发测试构建。内网 HTTP 由 Tailscale 加密传输，但部分浏览器剪贴板功能仍可能要求 HTTPS。
