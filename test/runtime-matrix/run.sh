#!/usr/bin/env bash
# Runtime matrix over PACKED artifacts. Usage: run.sh [MONGO_HOST_PORT]
# Needs nvm-installed Node versions and bun on PATH. Creates and drops only its own uniquely named Mongo DBs.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$HERE/../.."
MONGO="${1:-127.0.0.1:27042}"
WORK="$(mktemp -d /tmp/mt-matrix.XXXXXX)"
NVM="$HOME/.nvm/versions/node"
JOSK_VERSION="${JOSK_VERSION:-6.4.0}"
# label|node|mongodb driver
MATRIX=(
  "node12.20.1|v12.20.1|3.7.4"
  "node14.19.3|v14.19.3|3.7.4"
  "node14.21.3|v14.21.3|3.7.4"
  "node16.20.2|v16.20.2|3.7.4"
  "node18.19.1|v18.19.1|6.21.0"
  "node20.11.1|v20.11.1|6.21.0"
  "node22.21.1|v22.21.1|7.2.0"
  "node24.16.0|v24.16.0|7.2.0"
  "bun|bun|6.21.0"
)
# MT_ONLY="label label" limits the run to those rows.
if [ -n "${MT_ONLY:-}" ]; then
  FILTERED=(); for row in "${MATRIX[@]}"; do for want in $MT_ONLY; do [ "${row%%|*}" = "$want" ] && FILTERED+=("$row"); done; done
  MATRIX=("${FILTERED[@]}")
fi
NPM="$NVM/v24.16.0/bin/npm"; export PATH="$NVM/v24.16.0/bin:$PATH"
if [ -n "${MT_TARBALL:-}" ]; then cp "$MT_TARBALL" "$WORK/"; else ( cd "$REPO" && npm pack --pack-destination "$WORK" >/dev/null 2>&1 ) || exit 2; fi
( cd "$WORK" && npm pack "josk@$JOSK_VERSION" >/dev/null 2>&1 ) || exit 2
MT_TGZ="$(ls "$WORK"/mail-time-*.tgz)"; JOSK_TGZ="$(ls "$WORK"/josk-*.tgz)"
echo "mail-time tarball: $(basename "$MT_TGZ") sha1 $(shasum "$MT_TGZ" | cut -d' ' -f1)"
echo "josk tarball: $(basename "$JOSK_TGZ")"
FAIL=0
for row in "${MATRIX[@]}"; do
  IFS='|' read -r label node driver <<<"$row"
  dir="$WORK/$label"; mkdir -p "$dir"
  cat > "$dir/package.json" <<JSON
{"name":"mx-$label","private":true,"type":"module","dependencies":{"mail-time":"file:$MT_TGZ","josk":"file:$JOSK_TGZ","mongodb":"$driver"},"overrides":{"josk":"file:$JOSK_TGZ"}}
JSON
  cp "$HERE/probe.mjs" "$dir/probe.mjs"
  ( cd "$dir" && $NPM install --no-audit --no-fund --ignore-scripts --engine-strict=false >install.log 2>&1 ) && inst=OK || inst=FAIL
  db="mtmx_${label//./_}_$$_$RANDOM"
  echo "=== $label mongodb@$driver install=$inst db=$db"
  [ "$inst" = OK ] || { tail -3 "$dir/install.log"; FAIL=1; continue; }
  if [ "$node" = bun ]; then RUN=(bun); else RUN=("$NVM/$node/bin/node"); fi
  ( cd "$dir" && "${RUN[@]}" probe.mjs "mongodb://$MONGO/$db" ) | sed 's/^/  /'
  [ "${PIPESTATUS[0]}" = 0 ] || FAIL=1
  "$NVM/v24.16.0/bin/node" -e "
    const {MongoClient}=require('$REPO/node_modules/mongodb');
    MongoClient.connect('mongodb://$MONGO').then(async c=>{await c.db('$db').dropDatabase();await c.close();});" 
done
echo "work dir: $WORK"
exit $FAIL
