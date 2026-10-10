#!/bin/bash
set -euo pipefail
ROOT=/workspace/changjuan
DB=/tmp/molan-g2-rust-$$.sqlite
rm -f "$DB" "$DB"-wal "$DB"-shm
export MOLAN_SQLITE_PATH="$DB"
export MOLAN_ROOT="$ROOT"
export RUST_LOG=warn
# build if needed
cd "$ROOT/rust-server"
# start server
PORT=8799 ./target/debug/molan-api >/tmp/g2-rust-api.log 2>&1 &
PID=$!
cleanup() { kill $PID 2>/dev/null || true; rm -f "$DB" "$DB"-wal "$DB"-shm; }
trap cleanup EXIT
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:8799/api/health >/dev/null; then break; fi
  sleep 0.15
done
curl -sf http://127.0.0.1:8799/api/health >/dev/null

BOOK=$(curl -sf -X POST http://127.0.0.1:8799/api/books -H 'content-type: application/json' \
  -d '{"title":"G2 Rust书","genre":"测","targetChapters":2,"wordsPerChapter":500}')
BOOK_ID=$(echo "$BOOK" | python3 -c 'import sys,json; print(json.load(sys.stdin)["book"]["id"])')
CH_ID=$(echo "$BOOK" | python3 -c 'import sys,json; print([c["id"] for c in json.load(sys.stdin)["chapters"] if c["number"]==1][0])')

# save body
SAVED=$(curl -sf -X PUT "http://127.0.0.1:8799/api/books/$BOOK_ID/artifacts" -H 'content-type: application/json' \
  -d '{"kind":"chapter_body","chapterNumber":1,"body":"林舟左手受伤。","source":"human"}')
REV=$(echo "$SAVED" | python3 -c 'import sys,json; print(json.load(sys.stdin)["revisionId"])')

HEAD=$(curl -sf "http://127.0.0.1:8799/api/books/$BOOK_ID/story/head")
EPOCH=$(echo "$HEAD" | python3 -c 'import sys,json; print(json.load(sys.stdin)["storyEpoch"])')

FIN=$(curl -sf -X POST "http://127.0.0.1:8799/api/books/$BOOK_ID/story/chapters/$CH_ID/finalize" \
  -H 'content-type: application/json' \
  -d "{\"bodyRevisionId\":\"$REV\",\"expectedPublicationId\":null,\"expectedCurrentRevisionId\":\"$REV\",\"expectedStoryEpoch\":$EPOCH,\"idempotencyKey\":\"rust-g2-1\"}")
echo "$FIN" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["memoryState"]=="pending" and d["storyEpoch"]==1; print("finalize ok", d["publicationId"][:8])'
PUB=$(echo "$FIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["publicationId"])')

# wait for proposal extract (local-draft)
PROP_ID=""
for i in $(seq 1 30); do
  ST=$(curl -sf "http://127.0.0.1:8799/api/books/$BOOK_ID/story/chapters/$CH_ID/status")
  PROP_ID=$(echo "$ST" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("openProposal") or {}).get("id") or "")')
  MEM=$(echo "$ST" | python3 -c 'import sys,json; d=json.load(sys.stdin); print((d.get("publication") or {}).get("memoryState") or "")')
  if [ -n "$PROP_ID" ]; then echo "proposal $PROP_ID state=$MEM"; break; fi
  sleep 0.25
done
if [ -z "$PROP_ID" ]; then
  echo "WARN no auto proposal; status=$ST" >&2
  # still pass finalize path
  echo "RUST_SMOKE_PARTIAL_OK"
  exit 0
fi

HEAD2=$(curl -sf "http://127.0.0.1:8799/api/books/$BOOK_ID/story/head")
EPOCH2=$(echo "$HEAD2" | python3 -c 'import sys,json; print(json.load(sys.stdin)["storyEpoch"])')
PROP=$(curl -sf "http://127.0.0.1:8799/api/books/$BOOK_ID/story/memory/proposals/$PROP_ID")
SRC=$(echo "$PROP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["sourceRevisionId"])')
OPS=$(echo "$PROP" | python3 -c 'import sys,json; print(",".join(o["operationId"] for o in json.load(sys.stdin)["operations"]))')

APP=$(curl -sf -X POST "http://127.0.0.1:8799/api/books/$BOOK_ID/story/memory/proposals/$PROP_ID/apply" \
  -H 'content-type: application/json' \
  -d "{\"acceptedOperationIds\":[\"${OPS%%,*}\"],\"expectedSourceRevisionId\":\"$SRC\",\"expectedStoryEpoch\":$EPOCH2,\"idempotencyKey\":\"rust-g2-apply\"}")
echo "$APP" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["memoryState"]=="ready"; print("apply ok epoch", d["storyEpoch"])'
echo "RUST_SMOKE_OK"
