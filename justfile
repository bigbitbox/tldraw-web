set positional-arguments := true
host := "ali-hk-24"
url := "http://100.97.118.114:5858"
image := "ori/tldraw-dev:20260912"

default:
    @just --list

check:
    npm ci --no-audit --no-fund
    npm run check
    npm test
    npm run build

# 所有安装、构建都在当前 Mac；云主机仅加载预构建镜像。
build:
    docker buildx build --builder multiarch-proxy --platform linux/amd64 --load -t {{image}} .

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
