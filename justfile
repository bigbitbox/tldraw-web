set positional-arguments := true
host := "ali-hk-24"
url := "https://tldraw.rayzor.site"
image := "ori/tldraw:20260912-trial"

default:
    @just --list

check:
    npm ci --no-audit --no-fund
    npm run check
    npm test
    npm run build

# 所有安装、构建都在当前 Mac；云主机仅加载预构建镜像。
build:
    @test -s "$HOME/.config/tldraw/license-key.txt"
    docker buildx build --builder multiarch-proxy --platform linux/amd64 --no-cache-filter build --build-arg APP_ENV=production --secret id=tldraw_license,src="$HOME/.config/tldraw/license-key.txt" --load -t {{image}} .

load:
    #!/usr/bin/env bash
    set -euo pipefail
    docker save '{{image}}' | gzip -1 | ssh '{{host}}' 'gunzip | docker load'

status:
    ssh {{host}} 'systemctl is-active docker-tldraw-dev; docker inspect --format "{{ "{{" }}.State.Health.Status}}" tldraw-dev'
    curl --fail --silent --show-error '{{url}}/healthz'

logs n="80":
    ssh {{host}} 'docker logs --tail {{n}} tldraw-dev'

restart:
    ssh {{host}} 'sudo systemctl restart docker-tldraw-dev'

# 重启保留 /data。备份期间短暂停服，包含完整 SQLite 数据库和附件。
backup:
    #!/usr/bin/env bash
    set -euo pipefail
    ssh '{{host}}' bash -s <<'REMOTE'
    set -euo pipefail
    mkdir -p /home/ray/backups/tldraw
    sudo systemctl stop docker-tldraw-dev
    trap 'sudo systemctl start docker-tldraw-dev' EXIT
    target="/home/ray/backups/tldraw/$(date +%Y%m%d-%H%M%S).tar.gz"
    tar -C /home/ray/datas -czf "$target" tldraw
    echo "$target"
    REMOTE

# 本机 curl.conf 以 0600 保存 API token；不把口令放进进程参数或仓库。
canvas-list:
    @curl --config "$HOME/.config/tldraw/curl.conf" --fail-with-body --silent --show-error '{{url}}/api/rooms'

canvas-get room="main":
    @curl --config "$HOME/.config/tldraw/curl.conf" --fail-with-body --silent --show-error '{{url}}/api/rooms/{{room}}/records'

canvas-apply room file:
    @curl --config "$HOME/.config/tldraw/curl.conf" --fail-with-body --silent --show-error -H 'Content-Type: application/json' -X POST --data-binary @{{quote(file)}} '{{url}}/api/rooms/{{room}}/records'

# CLI 独立安装，类似 lark-cli；无需重建或重启服务器。
cli-install:
    #!/usr/bin/env bash
    set -euo pipefail
    cd cli
    staging_dir="$(mktemp -d)"
    trap 'rm -rf "$staging_dir"' EXIT
    npm pack --pack-destination "$staging_dir" --silent
    npm install --global --no-audit --no-fund "$staging_dir"/*.tgz
    tldraw --version

cli-check:
    npm --prefix cli ci --no-audit --no-fund
    npm run test:cli

# 升级 SDK 后从官方 ShapeUtils 重新生成默认属性；CLI 运行时只依赖 schema，不引入 DOM。
cli-defaults:
    #!/usr/bin/env bash
    set -euo pipefail
    node --input-type=module <<'JS'
    import { defaultShapeUtils } from 'tldraw'
    import { writeFileSync, readFileSync } from 'node:fs'
    const sdkVersion = JSON.parse(readFileSync('node_modules/tldraw/package.json', 'utf8')).version
    const shapes = Object.fromEntries(defaultShapeUtils.map(C => [C.type, new C(null).getDefaultProps()]))
    writeFileSync('cli/src/defaults.json', JSON.stringify({ sdkVersion, shapes }, null, 2) + '\n')
    process.exit(0)
    JS
