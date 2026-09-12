# tldraw CLI

供外部 Agent 操作本项目自部署白板的独立 Node CLI，命令名 `tldraw`。这是本项目提供的工具，不是官方 tldraw CLI。无需打开浏览器，无需调用白板侧栏的 AI，不在服务器新增进程。

## 安装与认证

Node.js 22+，在仓库根目录执行：

```sh
just -f apps/tldraw/justfile cli-install
tldraw auth login --server https://tldraw.rayzor.site --with-token < api-token.txt
tldraw auth status
tldraw skill install
```

API key 是服务端 `API_TOKEN`，不是网页访问口令。当前 Mac 已配置。`auth login` 先验证 key，然后写入 `${XDG_CONFIG_HOME:-~/.config}/tldraw-cli/config.json`，权限 0600；不把 key 放进参数或输出。CI/其他 Agent 可设置 `TLDRAW_URL`、`TLDRAW_TOKEN`，不用创建文件。`TLDRAW_CONFIG_DIR` 可隔离配置。

`skill install` 默认安装到 `$CODEX_HOME/skills/tldraw` 或 `~/.codex/skills/tldraw`；其他 Agent 可指定 `--dir ~/.agents/skills` 等其支持的技能目录。遇到已有 Skill 会停止以保护本地修改。更新时比较 `tldraw skill read` 和已安装文件，明确合并后替换。Skill 随 CLI 打包，可跨机器安装。

也可在 `cli` 目录运行 `npm pack`，将生成的 `.tgz` 复制到另一台机器后 `npm install -g ./rayzor-tldraw-cli-0.1.0.tgz`；再配置相同服务器和 API key。不是 npm 公共发布包。

## 用法

```sh
tldraw board create --name '项目设计'
tldraw board list
tldraw board read 'https://tldraw.rayzor.site/r/main'
tldraw board read main --raw --output /tmp/board-records.json
tldraw board rename main --name '我的画布'
tldraw schema board.apply
tldraw board apply main --file edit.json --dry-run
tldraw board apply main --file edit.json
tldraw asset list main
tldraw asset get main asset:ID --output /tmp/image.png
tldraw asset add main --file /tmp/image.png --if-revision 12 --x 100 --y 100
```

`board read` 返回文字、形状、页面、位置、连线和附件。默认分页 100 个图形，`hasMore/nextOffset` 显式提示剩余内容。`--raw` 返回完整 native records。图片下载后由 Agent 的视觉工具读取；当前没有整幅画布的 PNG 渲染，结构读取不会被伪装成截图。

写入用简化的 create/update/delete/bind 操作，详见随包 [Skill](skill/SKILL.md) 与 `schema board.apply`。CLI 从官方 ShapeUtils 提取默认属性，用同版本的官方 tlschema 校验；不会维护另一个绘图格式。图形、图片和连线仍是可编辑的 tldraw 对象。

所有操作默认 JSON，错误 JSON 走 stderr。`--format text` 提供列表/画布概要；筛选可交给 `jq`。`--file -` 支持管道输入。`--dry-run` 在创建、重命名、批量作画、图片插入和通用 API 上可用：会读状态和校验，但没有远程写入。

退出码：0 成功，1 请求/本地错误，2 参数错误，4 未认证或主机不匹配，5 冲突。写入必须携带已读取的 revision，不自动重试。超时可能已写入，先按 shape ID 检查。图片上传和形状创建是两次请求，冲突时可能留下未引用的附件，错误详情含已上传 asset 供恢复。

凭证绑定配置的 origin。画布链接必须属于同一服务器，HTTP 重定向不跟随，图片只从同服务器 `/uploads` 或受支持的 data URL 读取，防止把工作区密钥发给画布内的外链。当前使用单个工作区 API key，持有者可以访问该实例所有画布；不是逐画布权限系统。

## 设计与维护

- 参考 [gh auth login](https://cli.github.com/manual/gh_auth_login) 的 stdin key、[gh formatting](https://cli.github.com/manual/gh_help_formatting) 的机器输出。
- 参考 [Lark CLI](https://github.com/larksuite/cli) 的高层命令、schema 自发现、dry-run 与 Skill 配合。
- 命令目录同时驱动参数解析、help、schema，减少文档漂移。`board.apply` 的输入 schema 由 Zod 定义生成。
- `just -f apps/tldraw/justfile cli-check` 在本机跑官方服务集成测试，包括凭证、创建/修改/冲突、图片往返及重定向隔离。
- SDK 版本固定 5.4.2。升级后同步 package 依赖，执行 `cli-defaults`，重新检查并安装。CLI 检测服务端 schema 不匹配时停止写入。

CLI 使用现有 HTTP records API，不包含浏览器编辑器的文本测量、自动布局和几何修正。重要视觉效果仍需浏览器验收。原始 `api` 命令是高级出口，不替代高层操作的引用检查。
