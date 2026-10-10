#!/bin/bash
set -euo pipefail
ROOT=/workspace/changjuan
DB=/tmp/molan-g3-rust-$$.sqlite
rm -f "$DB" "$DB"-wal "$DB"-shm
export MOLAN_SQLITE_PATH="$DB"
export MOLAN_ROOT="$ROOT"
export RUST_LOG=warn
cd "$ROOT/rust-server"
cargo build -q
PORT=8798 ./target/debug/molan-api >/tmp/g3-rust-api.log 2>&1 &
PID=$!
cleanup() { kill $PID 2>/dev/null || true; rm -f "$DB" "$DB"-wal "$DB"-shm; }
trap cleanup EXIT
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:8798/api/health >/dev/null; then break; fi
  sleep 0.15
done
curl -sf http://127.0.0.1:8798/api/health >/dev/null

BOOK=$(curl -sf -X POST http://127.0.0.1:8798/api/books -H 'content-type: application/json' \
  -d '{"title":"G3 Rust书","genre":"测","targetChapters":10,"wordsPerChapter":500}')
BOOK_ID=$(echo "$BOOK" | python3 -c 'import sys,json; print(json.load(sys.stdin)["book"]["id"])')
CH5=$(echo "$BOOK" | python3 -c 'import sys,json; print([c["id"] for c in json.load(sys.stdin)["chapters"] if c["number"]==5][0])')
CARD=$(curl -sf -X POST "http://127.0.0.1:8798/api/books/$BOOK_ID/bible" -H 'content-type: application/json' \
  -d '{"kind":"character","name":"林舟","summary":"主角","details":"持剑"}')
CHAR_ID=$(echo "$CARD" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

SAVED=$(curl -sf -X PUT "http://127.0.0.1:8798/api/books/$BOOK_ID/artifacts" -H 'content-type: application/json' \
  -d '{"kind":"chapter_body","chapterNumber":5,"body":"林舟左手受伤。","source":"human"}')
REV=$(echo "$SAVED" | python3 -c 'import sys,json; print(json.load(sys.stdin)["revisionId"])')

FIN=$(curl -sf -X POST "http://127.0.0.1:8798/api/books/$BOOK_ID/story/chapters/$CH5/finalize" \
  -H 'content-type: application/json' \
  -d "{\"bodyRevisionId\":\"$REV\",\"expectedPublicationId\":null,\"expectedCurrentRevisionId\":\"$REV\",\"expectedStoryEpoch\":0,\"idempotencyKey\":\"rust-g3-1\"}")
echo "$FIN" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["memoryState"]=="pending"; print("finalize ok")'

CHARS=$(curl -sf "http://127.0.0.1:8798/api/books/$BOOK_ID/story/characters?asOfChapter=6")
echo "$CHARS" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert "characters" in d; assert any(c["id"] for c in d["characters"]); print("characters ok")'
FS=$(curl -sf "http://127.0.0.1:8798/api/books/$BOOK_ID/story/foreshadowing?asOfChapter=6")
echo "$FS" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert "hooks" in d; print("foreshadow ok")'
IMP=$(curl -sf "http://127.0.0.1:8798/api/books/$BOOK_ID/story/impact?chapterId=$CH5")
echo "$IMP" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["autoRewriteSubsequentBodies"] is False; assert d["chapterNumber"]==5; print("impact ok")'
ST=$(curl -sf "http://127.0.0.1:8798/api/books/$BOOK_ID/story/characters/$CHAR_ID/state?asOfChapter=6&knowledgeMode=reader")
echo "$ST" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["knowledgeMode"]=="reader"; print("state ok")'
echo "RUST_G3_SMOKE_OK"
