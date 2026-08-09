# LLMWard repository guidance

## Product boundary

LLMWard is a single-process, single-SQLite LLM access gateway for on-premises organizations of at most 100 users. It does not require a cloud account, external database, or Redis. It supports only the API behavior verified by tests and documented in `docs/COMPATIBILITY.md`.

Do not add distributed infrastructure, billing or credit sales, SSO/social login, telemetry, prompt storage, provider-specific SDKs, generic format conversion, fallback/load balancing, or a plugin framework.

## Commands

```powershell
npm.cmd install
npm.cmd run setup
npm.cmd test
npm.cmd run doctor
npm.cmd run backup
npm.cmd run benchmark
npm.cmd audit --omit=dev
npm.cmd start
```

PowerShell may block `npm.ps1`; use `npm.cmd` on Windows. Docker verification uses `docker compose` when the CLI is available.

## Database changes

- Use prepared statements for values and keep `PRAGMA foreign_keys = ON`, WAL, and the busy timeout.
- Every schema change must be an idempotent, versioned migration covered by empty, legacy, partial, repeated, and already-current DB fixtures.
- Refuse a database newer than the application schema. Run integrity and foreign-key checks before and after migration.
- Preserve data atomically. Never test migrations against `data/gateway.db`, automatically restore over an operating DB, or run automatic startup `VACUUM`.

## Privacy and security invariants

- Never persist or log prompts, message arrays, system prompts, response/generated content, provider error bodies, raw user tokens, administrator keys, or provider credentials.
- Raw user tokens are returned once at creation. Authentication uses the full cryptographic hash; prefixes are display-only.
- Runtime requests may use only an administrator-registered provider Base URL. Reject credentials and unsafe URL forms, do not follow redirects, and never forward the client Authorization header upstream.
- All quota and concurrency resources use one idempotent cleanup path covering success, error, timeout, disconnect, and shutdown.
- Preserve authorization checks, input validation, transaction safety, XSS protection, accessibility, and fail-closed behavior even when a shorter implementation exists.

## Code and verification

Use CommonJS, the Node.js standard library, Express, and current dependencies. Prefer a small local change over a new abstraction or dependency. Follow existing naming and response shapes; do not mix unrelated refactoring into a fix.

After a change, run the focused regression tests and then `npm.cmd test`. Run doctor, backup verification, benchmark, production audit, startup health checks, and Docker checks when relevant. Tests use temporary directories, temporary SQLite files, and local mock providers only.

## Secrets and generated files

Do not print or commit `.env`, `data/`, DB/WAL/SHM files, logs, backups, benchmark temporary data, coverage, or real API keys. Report only a secret file's path and risk, never its contents. Preserve an existing `.env` and DB during setup and tests.

The Docker image must not contain `.env`, data, logs, or backups. Keep one non-root Gateway service with one persistent `/app/data` directory.
