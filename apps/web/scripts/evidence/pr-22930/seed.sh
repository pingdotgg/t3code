#!/usr/bin/env bash
# Starts a local Forgejo (container ev22930-forgejo), seeds fixture/review with PR #1 (L) and
# PR #2 (S), writes the stub fj + keys.json, the two project clones, and a pristine data snapshot.
# `seed.sh restore` stops the container, restores the snapshot and clones, and starts it again.
set -euo pipefail
EV_DIR=${EV_DIR:-/tmp/ev-22930}
FX=$EV_DIR/fixture
HOST=forgejo.127.0.0.1.nip.io:3000
URL=http://$HOST
NAME=ev22930-forgejo
IMAGE=${FORGEJO_IMAGE:-codeberg.org/forgejo/forgejo:11}
# The volume holds files owned by container uids, so copy and delete it from inside a container.
incontainer() { docker run --rm --entrypoint sh -v "$FX:/fx" "$IMAGE" -c "$1"; }

start() {
  docker run -d --name $NAME -p 127.0.0.1:3000:3000 -v "$FX/forgejo-data:/data" \
    -e USER_UID="$(id -u)" -e USER_GID="$(id -g)" \
    -e FORGEJO__security__INSTALL_LOCK=true \
    -e FORGEJO__server__ROOT_URL=$URL/ -e FORGEJO__server__DOMAIN=forgejo.127.0.0.1.nip.io \
    -e FORGEJO__database__DB_TYPE=sqlite3 -e FORGEJO__repository__ENABLE_PUSH_CREATE_USER=true \
    "$IMAGE" >/dev/null
  for _ in $(seq 60); do curl -fsS $URL/api/v1/version >/dev/null 2>&1 && return; sleep 1; done
  echo "forgejo did not start" >&2 && exit 1
}

clones() {
  local token
  token=$(cat "$FX/token")
  rm -rf "$FX/review-a" "$FX/review-b"
  for p in a:review-l b:review-s; do
    git clone -q -b "${p#*:}" "$URL/fixture/review.git" "$FX/review-${p%%:*}"
    git -C "$FX/review-${p%%:*}" config http.extraHeader "Authorization: token $token"
    git -C "$FX/review-${p%%:*}" config user.name Fixture
    git -C "$FX/review-${p%%:*}" config user.email fixture@example.invalid
  done
}

if [ "${1:-}" = "restore" ]; then
  docker rm -f $NAME >/dev/null 2>&1 || true
  incontainer "rm -rf /fx/forgejo-data && cp -a /fx/forgejo-data.seed /fx/forgejo-data"
  start && clones
  exit 0
fi

[ -d "$FX/src.git" ] || { echo "run build-fixture.sh first" >&2; exit 1; }
docker rm -f $NAME >/dev/null 2>&1 || true
incontainer "rm -rf /fx/forgejo-data /fx/forgejo-data.seed" && mkdir -p "$FX/forgejo-data"
start
docker exec -u git $NAME forgejo admin user create --admin --username fixture \
  --password fixture-pass-1 --email fixture@example.invalid --must-change-password=false >/dev/null
docker exec -u git $NAME forgejo admin user generate-access-token --username fixture \
  --token-name ev --scopes all --raw >"$FX/token"
TOKEN=$(cat "$FX/token")
api() { curl -fsS -H "Authorization: token $TOKEN" -H 'Content-Type: application/json' "$@"; }
api -X POST $URL/api/v1/user/repos -d '{"name":"review","default_branch":"main"}' >/dev/null
git -C "$FX/src.git" -c http.extraHeader="Authorization: token $TOKEN" push -q --mirror $URL/fixture/review.git
# Forgejo indexes pushed branches asynchronously.
for _ in $(seq 30); do api $URL/api/v1/repos/fixture/review/branches/review-s >/dev/null 2>&1 && break; sleep 1; done
api -X POST $URL/api/v1/repos/fixture/review/pulls -d '{"head":"review-l","base":"main","title":"L: long review fixture"}' >/dev/null
api -X POST $URL/api/v1/repos/fixture/review/pulls -d '{"head":"review-s","base":"main","title":"S: short review fixture"}' >/dev/null

mkdir -p "$FX/bin" "$FX/xdg/forgejo-cli"
printf '#!/bin/sh\n[ "$1" = version ] && echo "fj v0.6.0"\nexit 0\n' >"$FX/bin/fj" && chmod +x "$FX/bin/fj"
printf '{"hosts":{"%s":{"type":"Application","token":"%s"}}}\n' "$HOST" "$TOKEN" >"$FX/xdg/forgejo-cli/keys.json"

docker stop $NAME >/dev/null
incontainer "cp -a /fx/forgejo-data /fx/forgejo-data.seed"
docker start $NAME >/dev/null
for _ in $(seq 60); do curl -fsS $URL/api/v1/version >/dev/null 2>&1 && break; sleep 1; done
clones
api $URL/api/v1/repos/fixture/review/pulls?state=open | python3 -c 'import json,sys; [print(p["number"], p["title"], p["head"]["sha"]) for p in json.load(sys.stdin)]'
