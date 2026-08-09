# Changelog

## Unreleased

## 1.0.1 - 2026-08-09

- Hardened streaming cleanup and provider URL validation without expanding the supported API surface.
- Made SQLite migrations fail closed, preserved quota reservation dates, and removed automatic startup `VACUUM`.
- Added integrity, foreign-key, and schema-verified backup and independent restore checks.
- Added browser security headers and safe DOM rendering, race-safe setup, stronger diagnostics, CI, and hardened Compose definitions.
- Rejected future SQLite schemas without opening the real target through SQLite, covered uncheckpointed WAL state through a private copy, excluded SQLite and backup variants from Docker contexts, and constrained audit metadata to fixed families and fields.
- Requested `0o600` backup creation on POSIX; Windows deployments require protected NTFS ACLs on data and backup storage, restricted to the Gateway service identity.
- Kept private WAL schema-preflight copies under the protected database directory and allowed sidecar-free zero-byte database files to initialize without weakening corrupt or future-schema rejection.

## 1.0.0 - 2026-08-04

- 해시 기반 복수 사용자 토큰, 만료·폐기·회전·마지막 사용 시각
- 사용자 RPM과 사용자·모델·공급자 동시성 제한
- SSE streaming, client disconnect upstream 취소, redirect 거부
- 공급자 프리셋, 명시적 모델 검색/등록, 최초 설정 체크리스트
- SQLite 온라인 백업, 보존 정책, doctor/setup/benchmark 명령
- 관리자 감사 로그와 프라이버시 회귀 테스트
- 단일 서비스 Docker 배포와 운영 문서
