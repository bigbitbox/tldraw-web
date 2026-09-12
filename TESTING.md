# 部署验收（2026-09-12）

## 公网与 Trial 更新

当前入口 <https://tldraw.rayzor.site>。镜像 `ori/tldraw:20260912-trial`，ID `sha256:c883017e1dd300b4aab223299cd552bf533af6142a1378ea09cc83b209141f08`。以下旧版记录保留为历史，当前运行生产构建。

- Trial 签名校验通过，任意域名有效，到期日 2026-12-21；通过 BuildKit secret 注入前端构建。
- Cloudflare A 记录直连 ali-hk-24；Caddy 配置验证、NixOS 本机构建与远程激活通过。HTTP 308 跳转 HTTPS，TLS 证书校验通过，健康检查返回 production。
- 未认证 API、编码路径及附件请求返回 401；HTTPS 登录成功，cookie 包含 Secure、HttpOnly 和 SameSite=Strict。新增单层代理登录限流测试通过，包括伪造左侧 X-Forwarded-For 不绕过限流。
- 公网 WSS 两客户端握手成功，浏览器 cookie 会话写入由 API bearer 会话收到；API 恢复记录后两个客户端均收到更新。
- 公网 AI SSE 请求完整返回；Chrome 中 AI 生成“HTTPS + AI OK”并保存至验收画布。
- Chrome 已实际登录新域名并显示主画布鲸鱼；切换公网前后主画布 19 条记录完全一致。备份 `/home/ray/backups/tldraw/20260912-230501.tar.gz`。
- 主画布及 AI 历史预览均接入许可证；预览资源改为本地路径，并使用稳定对象引用避免编辑器反复初始化。修复后的 Docker 构建与类型检查通过，容器健康。
- **未完成项**：旧测试标签页出现无响应后，浏览器控制无法关闭或重开该页，最终预览修复尚未完成浏览器回归验收。服务端同步、AI 和健康检查未受影响。

## 初次私网部署记录


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
