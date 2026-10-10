#!/bin/bash
set -euo pipefail
ROOT=/workspace/changjuan
DB=/tmp/molan-g4-rust-$$.sqlite
rm -f "$DB" "$DB"-wal "$DB"-shm
export MOLAN_SQLITE_PATH="$DB"
export MOLAN_ROOT="$ROOT"
export RUST_LOG=warn
cd "$ROOT/rust-server"
cargo build -q
PORT=8799 ./target/debug/molan-api >/tmp/g4-rust-api.log 2>&1 &
PID=$!
cleanup() { kill $PID 2>/dev/null || true; rm -f "$DB" "$DB"-wal "$DB"-shm; }
trap cleanup EXIT
for i in $(seq 1 40); do
  if curl -sf http://127.0.0.1:8799/api/health >/dev/null; then break; fi
  sleep 0.15
done
curl -sf http://127.0.0.1:8799/api/health >/dev/null

BOOK=$(curl -sf -X POST http://127.0.0.1:8799/api/books -H 'content-type: application/json' \
  -d '{"title":"G4 Rust故事包","genre":"测","targetChapters":4,"wordsPerChapter":500}')
BOOK_ID=$(echo "$BOOK" | python3 -c 'import sys,json; print(json.load(sys.stdin)["book"]["id"])')
CH1=$(echo "$BOOK" | python3 -c 'import sys,json; print([c["id"] for c in json.load(sys.stdin)["chapters"] if c["number"]==1][0])')

SAVED=$(curl -sf -X PUT "http://127.0.0.1:8799/api/books/$BOOK_ID/artifacts" -H 'content-type: application/json' \
  -d '{"kind":"chapter_body","chapterNumber":1,"body":"林舟入城。","source":"human"}')
REV=$(echo "$SAVED" | python3 -c 'import sys,json; print(json.load(sys.stdin)["revisionId"])')

FIN=$(curl -sf -X POST "http://127.0.0.1:8799/api/books/$BOOK_ID/story/chapters/$CH1/finalize" \
  -H 'content-type: application/json' \
  -d "{\"bodyRevisionId\":\"$REV\",\"expectedPublicationId\":null,\"expectedCurrentRevisionId\":\"$REV\",\"expectedStoryEpoch\":0,\"idempotencyKey\":\"rust-g4-1\"}")
echo "$FIN" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["memoryState"]=="pending"; print("finalize ok")'

PC=$(curl -sf "http://127.0.0.1:8799/api/books/$BOOK_ID/story/publish-check?chapterNumber=1")
echo "$PC" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert "checks" in d and "budgetEstimate" in d["context"]; print("publish-check ok")'

curl -sf "http://127.0.0.1:8799/api/books/$BOOK_ID/story-pack.zip?includeSecrets=1" -o /tmp/g4-pack-$$.zip
PACK=/tmp/g4-pack-$$.zip
python3 - "$PACK" <<'PY'
import sys, zipfile, json
path=sys.argv[1]
z=zipfile.ZipFile(path)
names=set(z.namelist())
assert "manifest.json" in names
assert "manuscript/book.json" in names
assert "story/publications.json" in names
assert "provenance/schema.json" in names
man=json.loads(z.read("manifest.json"))
assert man["format"]=="molan.story-pack/v1"
print("export pack ok", man["counts"])
PY

# import as new book
B64=$(python3 -c 'import base64,sys; print(base64.b64encode(open(sys.argv[1],"rb").read()).decode())' "$PACK")
IMP=$(curl -sf -X POST http://127.0.0.1:8799/api/books/import-story-pack -H 'content-type: application/json' \
  -d "{\"zipBase64\":\"$B64\"}")
echo "$IMP" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["bookId"]; assert "bookId" in d and "book" in d; print("import ok", d["bookId"])'

NEW_ID=$(echo "$IMP" | python3 -c 'import sys,json; print(json.load(sys.stdin)["bookId"])')
test "$NEW_ID" != "$BOOK_ID"
HEAD=$(curl -sf "http://127.0.0.1:8799/api/books/$NEW_ID/story/head")
echo "$HEAD" | python3 -c 'import sys,json; d=json.load(sys.stdin); assert d["storyEpoch"]>=1; print("imported epoch", d["storyEpoch"])'

# T21: reject bad zip
BAD=$(python3 -c 'import zipfile,io,base64; b=io.BytesIO(); z=zipfile.ZipFile(b,"w"); z.writestr("../evil.txt","x"); z.writestr("manifest.json","{}"); z.close(); print(base64.b64encode(b.getvalue()).decode())')
CODE=$(curl -s -o /tmp/g4-bad.json -w '%{http_code}' -X POST http://127.0.0.1:8799/api/books/import-story-pack \
  -H 'content-type: application/json' -d "{\"zipBase64\":\"$BAD\"}")
test "$CODE" != "201"
echo "reject bad zip ok status=$CODE"
echo "RUST_G4_SMOKE_OK"
