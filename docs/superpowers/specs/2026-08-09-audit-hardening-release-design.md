# 감사 하드닝 패치 릴리즈 설계

## 목표

감사에서 확인한 LLW-001~008을 기존 단일 프로세스·단일 SQLite 구조 안에서 최소 변경으로 수정하고, 회귀 테스트와 운영 검증을 거쳐 `1.0.1` 릴리즈 PR을 만든다. `main` 병합과 태그 생성은 PR 검토 이후에 수행한다.

## 범위

- LLW-001: streaming backpressure, client disconnect, timeout, shutdown이 같은 멱등 cleanup 경로를 사용하도록 한다.
- LLW-002: 관리자 등록 시 provider Base URL을 canonical form으로 검증하고, 고정 OpenAI-compatible endpoint를 URL API로 결합한다.
- LLW-003/004: 미래 schema와 foreign-key 위반을 거부하고, legacy token 이전을 원자적·반복 가능하게 유지하며 startup `VACUUM`을 실행하지 않는다.
- LLW-005: 사용량 완료 처리는 quota 예약 때 기록한 UTC 날짜를 사용한다.
- LLW-006: backup 생성과 독립 검증에서 integrity, foreign key, schema version을 모두 확인한다.
- LLW-007: 관리자 UI와 API에 CSP, frame 방지, nosniff, referrer, 민감 응답 no-store 정책을 적용한다.
- LLW-008: doctor의 안전한 진단 범위를 보강하고, 최소 GitHub Actions CI와 단일 비-root Compose 서비스 hardening을 적용한다.

새 provider SDK, tokenizer, Redis, 외부 DB, telemetry, prompt 저장, 범용 변환, fallback, plugin framework는 추가하지 않는다. 새 런타임 의존성도 추가하지 않는다.

## 구현 구조

### 요청 lifecycle

`routes/v1.js`가 진행 중 요청의 AbortController와 quota/concurrency cleanup을 소유한다. 성공, provider 오류, timeout, downstream disconnect, shutdown은 같은 멱등 종료 함수로 모인다. `server.js`는 새 요청 수락을 중단한 뒤 이 라우터 hook을 호출하고, 상한 시간 안에 DB checkpoint와 close를 수행한다.

### Provider URL

기존 관리자 입력 검증에서 `URL` 표준 객체를 사용한다. 자격증명, query, fragment, 인코딩된 경로 구분자, traversal을 거부하고 허용된 HTTP(S) origin과 정규화된 base path만 저장한다. runtime endpoint는 문자열 연결 대신 같은 origin의 고정 상대 경로로 만든다. redirect는 계속 수동 거부한다.

### SQLite와 quota

`db/migrations.js`의 단일 `BEGIN IMMEDIATE` transaction, `PRAGMA foreign_keys = ON`, WAL, busy timeout을 보존한다. schema가 애플리케이션보다 새롭거나 integrity/FK/필수 컬럼 검사가 실패하면 변경 전에 중단한다. legacy token 원문은 secure delete가 활성화된 transaction에서 hash marker로 교체하고 자동 `VACUUM`은 하지 않는다. quota 완료는 reservation row의 `request_date`를 읽어 동일 날짜의 사용량에 반영한다.

### Backup과 운영 진단

backup은 임시·독립 SQLite 연결에서 integrity, foreign key, 정확한 schema version을 검증한 뒤에만 성공으로 기록한다. 검증 실패 시 기존 운영 DB와 정상 backup을 덮어쓰지 않는다. doctor는 비밀 값 자체를 출력하지 않고 설정 존재 여부, DB 검사, data directory 접근성, 필수 runtime 조건을 PASS/WARN/FAIL로 반환한다.

### 브라우저·배포 보안

Express 기본 middleware에 작은 로컬 security-header middleware를 추가한다. 관리자 HTML과 인증된 관리자 API는 `Cache-Control: no-store`를 사용한다. 현재 dashboard의 inline style과 script는 동일한 `public/` 디렉터리의 정적 파일로 기계적으로 분리하고, CSP는 script와 style을 같은 origin에서만 허용한다. Compose는 한 비-root Gateway 서비스와 `/app/data` 하나만 유지하고, capability 축소, `no-new-privileges`, healthcheck, 명시적 restart 정책을 적용한다.

## 오류 처리

- 신뢰 경계의 입력과 DB 상태는 fail-closed로 처리한다.
- cleanup은 여러 이벤트에서 호출돼도 quota와 concurrency가 한 번만 해제된다.
- provider 오류 본문, prompt, response, token, 관리자 키, provider credential은 DB·로그·테스트 출력에 남기지 않는다.
- migration과 backup 검증 실패는 운영 DB 자동 복원이나 startup `VACUUM`을 유발하지 않는다.
- graceful shutdown 상한 초과는 오류 종료로 기록하되 비밀이나 요청 본문을 로깅하지 않는다.

## 테스트 전략

각 항목은 기존 `node:test`, 임시 디렉터리, 임시 SQLite, 로컬 mock provider만 사용해 실패하는 회귀 테스트를 먼저 추가한다.

- streaming backpressure와 disconnect/shutdown 동시 발생
- URL query/fragment/credential/traversal/encoded separator 거부와 안전한 endpoint 결합
- empty, legacy, partial, repeated, already-current, future-version, FK-invalid migration fixture
- UTC 날짜 경계에서 reservation 날짜 유지
- 손상·FK-invalid·잘못된 schema backup 거부와 독립 복원 검증
- security header와 저장형 XSS 방어
- doctor 비밀 비노출, CI/Compose 정적 검사

완료 전 `npm.cmd test`, `npm.cmd run doctor`, `npm.cmd run backup`, `npm.cmd run benchmark`, `npm.cmd audit --omit=dev`, startup health check를 새로 실행한다. backup과 startup 검증은 운영 `data/gateway.db` 대신 명시적인 임시 DB와 임시 디렉터리를 사용한다. Docker CLI가 있으면 `docker compose config`와 build/up health를 실행하고, 없으면 정적 검증과 미실행 사유를 감사 문서에 기록한다.

## 릴리즈

모든 회귀와 전체 검증이 통과한 뒤 `package.json`과 lockfile을 `1.0.1`로 맞추고 감사 findings/worklog 및 릴리즈 내역을 갱신한다. 변경을 목적별 커밋으로 정리해 `audit/codex-hardening-release`를 `origin`에 push하고, 검증 명령과 잔여 위험을 포함한 ready-for-review 릴리즈 PR을 만든다. PR 검토 전에는 `main`을 직접 변경하거나 `v1.0.1` 태그를 만들지 않는다.
