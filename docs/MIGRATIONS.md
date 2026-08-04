# Database migration policy

시작 시 먼저 `PRAGMA integrity_check`가 `ok`인지 확인합니다. 실패하면 마이그레이션을 시작하지 않습니다. 모든 스키마 변경과 기존 토큰 이동은 `BEGIN IMMEDIATE` 단일 트랜잭션에서 수행하며 `PRAGMA user_version`으로 버전을 기록합니다.

버전 2는 `user_tokens`, `audit_logs`, `app_settings`, `backup_history`와 RPM/동시성 열을 추가합니다. 기존 `users.api_token` 원문은 SHA-256 해시 레코드로 이동하고 `sha256:<hash>`로 치환하므로 기존 토큰 인증은 유지되지만 원문은 복구/표시할 수 없습니다.

마이그레이션은 테이블/열/인덱스를 추가하는 방향으로만 수행합니다. 자동으로 안전하게 보존할 수 없는 변경은 구현하지 않고 중지합니다. 업그레이드 전 `npm run backup`을 권장합니다.
