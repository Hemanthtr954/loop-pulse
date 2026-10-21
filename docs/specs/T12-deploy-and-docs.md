# T12 — Containerisation, deployment, docs

## Container
- Multi-stage `Dockerfile`: `deps` (npm ci) → `build` (tsc + vite) → `runtime`
  (`node:22-slim` + `git` + `ca-certificates`, production deps only, non-root `node` user,
  `/data` volume, `HEALTHCHECK` on `/healthz`, `tini`-style init via `--init` in compose).
- `docker-compose.yml`: one service, `env_file: .env` (optional), port 8080, named volume.
  `docker compose up --build` is the whole quickstart.

## Deployment in this build
- Image built and run locally; smoke tests run against the container.
- A static snapshot of the dashboard (real data, captured from the running service) is
  published as a hosted page so the result can be seen without running anything.
- Source delivered as a tarball including `.git` (no GitHub account was linked to push).

## Docs
- `README.md`: what it is, 60-second quickstart, curl examples, metric definitions.
- `NOTES.md`: the four submission questions (how to run, architecture tour, next day, AI use).
- `docs/FINAL_REPORT.md`: what was built, verification evidence, deviations and known gaps.
