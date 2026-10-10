#!/bin/bash
set -euo pipefail
ROOT=/workspace/changjuan
DB=/tmp/molan-g5-rust-$$.sqlite
rm -f "$DB" "$DB"-wal "$DB"-shm
export MOLAN_SQLITE_PATH="$DB"
export MOLAN_ROOT="$ROOT"
export RUST_LOG=warn
cd "$ROOT/rust-server"
cargo build -q
PORT=8797 ./target/debug/molan-api >/tmp/g5-rust-api.log 2>&1 &
PID=$!
cleanup() { kill $PID 2>/dev/null || true; rm -f "$DB" "$DB"-wal "$DB"-shm; }
trap cleanup EXIT
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:8797/api/health >/dev/null; then break; fi
  sleep 0.15
done
curl -sf http://127.0.0.1:8797/api/health >/dev/null

BOOK=$(curl -sf -X POST http://127.0.0.1:8797/api/books -H 'content-type: application/json' \
  -d '{"title":"G5 Rust书","genre":"测","targetChapters":3,"wordsPerChapter":500}')
BOOK_ID=$(echo "$BOOK" | python3 -c 'import sys,json; print(json.load(sys.stdin)["book"]["id"])')
CH1=$(echo "$BOOK" | python3 -c 'import sys,json; print([c["id"] for c in json.load(sys.stdin)["chapters"] if c["number"]==1][0])')

curl -sf -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/bible" -H 'content-type: application/json' \
  -d '{"kind":"character","name":"林舟","summary":"主角","details":""}' >/dev/null
curl -sf -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/bible" -H 'content-type: application/json' \
  -d '{"kind":"character","name":"守卫","summary":"配角","details":""}' >/dev/null

SAVED=$(curl -sf -X PUT "http://127.0.0.1:8797/api/books/$BOOK_ID/artifacts" -H 'content-type: application/json' \
  -d '{"kind":"chapter_body","chapterNumber":1,"body":"林舟与守卫结盟。","source":"human"}')
REV=$(echo "$SAVED" | python3 -c 'import sys,json; print(json.load(sys.stdin)["revisionId"])')

curl -sf -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/story/chapters/$CH1/finalize" \
  -H 'content-type: application/json' \
  -d "{\"bodyRevisionId\":\"$REV\",\"expectedPublicationId\":null,\"expectedCurrentRevisionId\":\"$REV\",\"expectedStoryEpoch\":0,\"idempotencyKey\":\"rust-g5-1\"}" >/dev/null

REL=$(curl -sf "http://127.0.0.1:8797/api/books/$BOOK_ID/story/views/relations?asOfChapter=2")
echo "$REL" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["derived"] is True; assert "story_facts" in d["authority"]; print("relations ok", len(d["nodes"]), "nodes")'

TL=$(curl -sf "http://127.0.0.1:8797/api/books/$BOOK_ID/story/views/timeline")
echo "$TL" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert any(e["kind"]=="publication" for e in d["events"]); print("timeline ok", len(d["events"]))'

HK=$(curl -sf "http://127.0.0.1:8797/api/books/$BOOK_ID/story/views/hooks")
echo "$HK" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["derived"] is True; assert "hook_events" in d["authority"]; print("hooks view ok")'

BATCH=$(curl -sf -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/story/batch/memory-ready" \
  -H 'content-type: application/json' \
  -d '{"fromChapter":1,"toChapter":1,"autoExtract":true,"strictMemoryReady":true,"maxModelCalls":5}')
BID=$(echo "$BATCH" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
TICK=$(curl -sf -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/story/batch/$BID/tick" -H 'content-type: application/json' -d '{}')
echo "$TICK" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["gates"]["unconstrainedAgentOrchestration"] is False; assert d["gates"]["writesOnlyViaStoryLedger"] is True; assert d["status"]=="paused_gate"; assert d["progress"]["gate"]=="needs_approval"; print("batch gate ok", d["status"], d["progress"]["gate"])'

CANCEL=$(curl -sf -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/story/batch/$BID/cancel" -H 'content-type: application/json' -d '{}')
echo "$CANCEL" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["status"]=="cancelled"; print("cancel ok")'

CODE=$(curl -s -o /tmp/g5-orch.json -w '%{http_code}' -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/story/agent/orchestrate" \
  -H 'content-type: application/json' -d '{"tools":[{"name":"x"}],"autonomous":true}')
test "$CODE" = "422"
echo "refuse orchestration ok $CODE"

REVW=$(curl -sf -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/story/review/readonly" \
  -H 'content-type: application/json' -d '{"chapterNumber":1}')
echo "$REVW" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["writable"] is False; assert d["agentOrchestration"] is False; assert len(d["findings"])>=2; print("readonly review ok")'

BATCH2=$(curl -sf -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/story/batch/memory-ready" \
  -H 'content-type: application/json' \
  -d '{"fromChapter":1,"toChapter":1,"autoExtract":true,"strictMemoryReady":true,"maxModelCalls":0}')
BID2=$(echo "$BATCH2" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
TICK2=$(curl -sf -X POST "http://127.0.0.1:8797/api/books/$BOOK_ID/story/batch/$BID2/tick" -H 'content-type: application/json' -d '{}')
echo "$TICK2" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["progress"]["gate"]=="cost_cap"; print("cost cap ok")'

echo "RUST_G5_SMOKE_OK"
