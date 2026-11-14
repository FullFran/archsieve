#!/usr/bin/env bash
# Reproducible demo on the synthetic NestJS fixtures. No LLM, no network.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-examples/nest-shop}"
mkdir -p "$OUT"
for s in before after; do
  node node_modules/typescript/bin/tsc -p "fixtures/nest-shop/$s"
  node bin/archsieve.mjs scan "fixtures/nest-shop/$s" --nest-entry dist/app.module.js -o "$OUT/$s.json"
  node bin/archsieve.mjs validate "$OUT/$s.json"
done
node bin/archsieve.mjs diff "$OUT/before.json" "$OUT/after.json" -o "$OUT/diff.json"
node bin/archsieve.mjs diff "$OUT/before.json" "$OUT/after.json" --format md -o "$OUT/diff.md"
node bin/archsieve.mjs validate "$OUT/diff.json"
node bin/archsieve.mjs render "$OUT/after.json" --view nest --compare "$OUT/before.json" -o "$OUT/nest-compare.mmd"
node bin/archsieve.mjs render "$OUT/after.json" --view files --compare "$OUT/before.json" -o "$OUT/files-compare.mmd"
node bin/archsieve.mjs render "$OUT/after.json" --view files --format dot -o "$OUT/files-after.dot"
set +e
node bin/archsieve.mjs diff "$OUT/before.json" "$OUT/after.json" --fail-on error -o /dev/null
echo "diff --fail-on error exit code: $? (1 = new verifiable regressions)"
