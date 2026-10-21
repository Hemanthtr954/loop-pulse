#!/usr/bin/env bash
# Smoke test against a running instance: ./scripts/smoke.sh [base_url] [owner/name]
set -euo pipefail
BASE=${1:-http://localhost:8080}
REPO=${2:-fastify/fastify}
pass=0; fail=0
check() { # name expected actual
  if [[ "$2" == "$3" ]]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1 (expected $2, got $3)"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "Smoke test: $BASE ($REPO)"
check "GET /healthz" 200 "$(code "$BASE/healthz")"
check "GET /readyz" 200 "$(code "$BASE/readyz")"
check "GET / (dashboard)" 200 "$(code "$BASE/")"
check "GET /openapi.json" 200 "$(code "$BASE/openapi.json")"
check "GET /docs (Swagger UI)" 200 "$(code -L "$BASE/docs")"
check "GET /v1/repos" 200 "$(code "$BASE/v1/repos")"
for kind in contributors knowledge-risk activity; do
  check "GET insights/$kind" 200 "$(code "$BASE/v1/repos/$REPO/insights/$kind")"
done
check "GET narrative" 200 "$(code "$BASE/v1/repos/$REPO/narrative")"
etag=$(curl -s -D - -o /dev/null "$BASE/v1/repos/$REPO/insights/contributors" | awk 'tolower($1)=="etag:"{print $2}' | tr -d '\r')
check "conditional GET → 304" 304 "$(code -H "If-None-Match: $etag" "$BASE/v1/repos/$REPO/insights/contributors")"
check "bad date → 400" 400 "$(code "$BASE/v1/repos/$REPO/insights/contributors?from=2026-02-30")"
check "unknown repo → 404" 404 "$(code "$BASE/v1/repos/nobody/nothing/insights/activity")"
check "out-of-horizon → 422" 422 "$(code "$BASE/v1/repos/$REPO/insights/activity?from=2019-01-01&to=2019-02-01")"
check "reviewers w/o token → 409 or 200" 1 "$(c=$(code "$BASE/v1/repos/$REPO/insights/reviewers"); [[ $c == 409 || $c == 200 ]] && echo 1 || echo $c)"
check "problem+json content type" 1 "$(curl -s -D - -o /dev/null "$BASE/v1/nope" | grep -ci 'application/problem+json')"
check "CSP header present" 1 "$(curl -s -D - -o /dev/null "$BASE/" | grep -ci '^content-security-policy')"
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
