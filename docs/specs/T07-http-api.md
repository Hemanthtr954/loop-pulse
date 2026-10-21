# T07 — HTTP API

Base path `/v1`. JSON everywhere; errors are RFC 9457 `application/problem+json`.

| Method & path | Purpose | Success |
|---|---|---|
| `GET /healthz` | liveness | 200 |
| `GET /readyz` | DB reachable | 200 / 503 |
| `GET /v1/repos` | registered repos with sync state | 200 |
| `POST /v1/repos` `{owner,name}` | register + start sync (API key if configured) | 202 + `Location`; 200 if already registered |
| `GET /v1/repos/{owner}/{name}` | one repo's sync state and queryable range | 200 / 404 |
| `POST /v1/repos/{owner}/{name}/sync` | trigger refresh | 202 |
| `GET /v1/repos/{owner}/{name}/insights/contributors` | T06.1 | 200 |
| `GET …/insights/knowledge-risk` | T06.2 | 200 |
| `GET …/insights/activity` | T06.3 | 200 |
| `GET …/insights/reviewers` | T06.4 | 200 / 409 |
| `GET …/insights/flow` | T06.5 | 200 / 409 |
| `GET …/narrative` | T08 | 200 |
| `GET /openapi.json`, `GET /docs` | OpenAPI 3.1 + Swagger UI | 200 |

Common query: `from`, `to` (ISO date or datetime), `includeBots`, `limit`, `sort`.

## HTTP semantics
- `400` invalid query/body (with per-field `errors`), `401` missing/invalid API key,
  `404` unknown repo, `409` repo not synced yet (`Retry-After`) or source not configured,
  `422` period outside the synced horizon, `429` rate limited, `502` upstream LLM failure is
  **not** surfaced — the narrative degrades to the deterministic narrator instead.
- `ETag` = hash of `(data_version, normalised query)`; `If-None-Match` → `304`.
  `Cache-Control: private, max-age=60`.
- Every response carries `x-request-id` (generated, or echoed if it is a safe token).
- Responses include `meta: {repo, period, dataVersion, generatedAt, definitions}` so a
  number never travels without its meaning.

## Security
- `@fastify/helmet` (CSP allows only self for the bundled UI), CORS deny-by-default.
- Body limit 16 KB; all inputs validated by Zod; unknown query keys rejected.
- Rate limits: 120 req/min/IP globally, 10 req/min/IP for `/narrative`, 5/min for writes.
- Mutating endpoints require `x-api-key` when `API_KEY` is set (constant-time compare).
- Errors never echo raw upstream messages or stack traces in production.

## Acceptance criteria
`fastify.inject` tests cover: 200 shapes, 304 on matching ETag, 400 with field errors,
404, 409 + `Retry-After`, 422 out of horizon, 401 on writes, problem+json content type.
