# 위협 검토

## 범위와 신뢰 경계

LLMWard는 한 관리자와 100명 이하 사용자를 전제로 한 단일 Node.js 프로세스·단일 SQLite 서버다. 외부 DB, Redis, 분산 제한, 결제 및 프롬프트 저장은 범위 밖이다.

| 경계 | 주요 자산 | 현재 통제 | 감사 초점 |
|---|---|---|---|
| 사용자 → Gateway | 사용자 토큰, 모델 권한, quota | Bearer token hash 조회, 활성/만료 검사, body 1 MiB 제한, 요청별 멱등 cleanup | 인증 우회, 제한 경쟁, disconnect |
| 관리자 → 관리 API | 관리자 키, 공급자 설정, 사용자·토큰 | 명시적 CORS, header key, timing-safe 비교, prepared SQL, CSP·no-store·safe DOM sink | 브라우저 헤더, XSS, 감사 로그, 위험 작업 |
| Gateway → 공급자 | 공급자 키, 내부망 목적지, 요청 본문 | canonical 등록 URL만 사용, 고정 endpoint 결합, 새 Authorization 구성, redirect manual, abort | URL 우회, endpoint 결합, streaming lifecycle |
| Gateway → SQLite/로그/백업 | token hash, 사용량, 감사 데이터 | prepared SQL, header·protected-data-dir private-WAL future-schema preflight, 고정 audit metadata, POSIX `0o600`·Windows 보호 NTFS ACL 요구, 검증 후 게시하는 온라인 backup | schema/FK 위반, 원문 잔존, 복원 검증·권한 |

## 확인된 안전 속성

- 사용자 token 원문은 신규 발급 응답에만 반환되고 `user_tokens.token_hash`에는 SHA-256 hash가 저장된다.
- 사용자 Authorization header를 upstream에 복사하지 않고 공급자 설정에서 새 header를 구성한다.
- 프롬프트·응답·공급자 오류 본문을 request/audit log에 넣지 않는다.
- 관리자 감사 metadata는 action별 고정 field name과 canonical positive safe integer target만 저장하며 실패 field 목록은 비운다.
- SQL 값은 prepared statement로 바인딩하며 동적 SQL identifier는 고정 목록 또는 검증된 placeholder 개수에 한정된다.
- provider redirect는 `redirect: 'manual'`로 자동 추적하지 않는다.
- output quota 예약은 `BEGIN IMMEDIATE` transaction으로 직렬화되어 동시 oversubscription을 방지한다.
- 성공, 오류, timeout, downstream disconnect, shutdown은 같은 멱등 cleanup 경로로 quota와 concurrency를 해제한다.
- provider Base URL은 query, fragment, 자격증명, traversal, 인코딩 경로 구분자를 거부하고 고정 endpoint를 URL API로 결합한다.
- migration은 real target을 SQLite로 열기 전 file type과 read-only header를 검사한다. nonempty WAL은 보호된 data 디렉터리의 고유한 직접 자식에 둔 private main/WAL copy로 검사하고 writable-open에서 재검사한다. sidecar가 없는 missing path 또는 0-byte regular file만 신규 DB로 허용하며 orphaned sidecar는 main 생성이나 sidecar 변경 없이 거부한다. 비정규 파일, stat 오류, integrity, foreign-key, 필수 컬럼 위반과 private cleanup 실패도 fail closed 처리한다. startup `VACUUM`은 실행하지 않는다.
- backup은 POSIX에서 `0o600`으로 생성하고 게시 전에 독립 연결에서 integrity, foreign key, 정확한 schema version을 검사하며 `verify-backup` 명령으로 복원 후보를 읽기 전용 검증한다. Windows에서는 data와 backup 위치의 보호 NTFS ACL을 Gateway 서비스 계정으로 제한하는 배포 통제가 필요하다.
- 관리자 응답은 CSP, frame 방지, nosniff, referrer, no-store 정책을 적용하고 dashboard는 외부 asset과 안전한 DOM sink를 사용한다.
- Docker build context는 환경 파일, SQLite DB·WAL·SHM·rollback journal·backup 변형, coverage·log와 로컬 scratch directory를 루트 및 중첩 경로에서 제외한다.
- doctor는 DB·디렉터리·runtime 상태를 PASS/WARN/FAIL로 구분하고 비밀 값을 출력하지 않는다. CI와 Compose 정의는 Node 22와 최소 권한 구성을 정적으로 검증한다.

## 의도적으로 남는 위험

- DB에 직접 저장하도록 선택한 공급자 자격증명은 host/DB 권한 침해 시 노출된다. 환경 변수 참조가 권장 경로다.
- TLS 종료와 네트워크 접근 제어는 배포 환경 책임이다.
- 메모리 기반 RPM·동시성 상태는 프로세스 재시작 시 초기화된다.
- 신뢰한 내부 공급자가 usage를 제공하지 않으면 tokenizer 없이 정확한 토큰 회계를 할 수 없다.
- 내부 LLM 지원을 위해 localhost와 사설 주소를 일괄 차단하지 않는다. 관리자 권한 탈취와 DNS rebinding 위험은 네트워크 allowlist로 추가 완화해야 한다.
- Windows 배포가 data, backup, restore-staging 위치의 NTFS ACL을 Gateway 서비스 계정으로 제한하지 않으면 로컬 계정에 DB, data ACL을 상속하는 schema-preflight private copy 및 backup이 노출될 수 있다.
