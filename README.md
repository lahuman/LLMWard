# LLM Gateway

단일 서버에서 운영하는 **100명 이하 온프레미스 조직용** OpenAI 호환 LLM 접근 관리 Gateway입니다.

- 외부 DB·Redis·클라우드 계정 불필요, 단일 SQLite 파일 사용
- 프롬프트, 메시지, 응답 본문, 공급자 오류 본문 미저장
- 단일 프로세스·단일 서버 전용(분산 운영 미지원)
- 결제·충전·실제 청구 시스템이 아닌 사용량·예상 비용 관리 도구
- 지원 API: `GET /v1/models`, `POST /v1/chat/completions`와 SSE streaming
- 관리자 정의 리터럴 규칙으로 전체 또는 모델별 입력 차단·마스킹과 출력 마스킹 지원
- 관리자 화면 이미지 위치: `docs/images/admin-dashboard.png` (릴리스 캡처 추가 예정)

## 10분 Quick Start

Node.js 20 이상이 필요합니다.

```powershell
npm install
npm run setup
npm start
```

`setup`이 처음 한 번만 표시하는 관리자 키를 안전한 비밀 저장소에 보관합니다. 이후 `http://localhost:3000/admin/`에서 다음 순서로 설정합니다.

1. 공급자 등록 및 연결 테스트
2. 모델 검색 후 필요한 모델만 선택 등록
3. 사용자 생성 및 한 번만 표시되는 API 토큰 보관

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer <user-token>"

curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <user-token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","messages":[{"role":"user","content":"hello"}]}'
```

진단과 백업:

```powershell
npm run doctor
npm run backup
```

## Docker

`.env`와 영속 `data` 디렉터리만 준비합니다.

```powershell
npm run setup
docker compose up --build -d
```

Compose는 Gateway 한 서비스만 실행합니다. PostgreSQL, MySQL, Redis는 사용하지 않습니다.

## 안전한 기본 동작

- 사용자 토큰은 SHA-256 해시만 DB에 저장하며 원문은 발급 시 한 번만 반환합니다.
- 기존 `users.api_token` 원문은 마이그레이션 시 해시 테이블로 옮기고 비가역 표시값으로 치환합니다. 기존 토큰은 계속 동작합니다.
- 토큰별 만료·폐기·마지막 사용 시각과 사용자당 복수 토큰을 지원합니다.
- 일일 입력/출력 쿼터, 사용자 RPM, 사용자·모델·공급자 동시성 제한을 적용합니다.
- 새 콘텐츠 필터는 비활성·모델 미할당 상태로 생성됩니다. 활성화해도 전체 적용이 아니면서 할당 모델이 없으면 아무 요청에도 적용되지 않습니다.
- RPM과 동시성 카운터는 단일 프로세스 메모리에 있으며 재시작 시 초기화됩니다.
- 예상하지 못한 HTTP redirect를 추적하지 않습니다. 클라이언트 연결 종료 시 upstream 요청을 취소합니다.
- `CORS_ORIGIN`은 쉼표로 구분한 명시적 origin 목록입니다. 기본값은 `http://localhost:3000`입니다.
- TLS는 신뢰할 수 있는 내부 reverse proxy에서 종료하고 Gateway와 공급자 포트는 내부망으로 제한하십시오.

공급자 DB 저장 자격증명은 기존 호환성을 위해 유지되며 SQLite에서 암호화되지 않습니다. 가능하면 `api_key_env_name`과 환경 변수를 사용하고 DB/호스트 파일 권한을 보호하십시오.

콘텐츠 필터 패턴은 매칭을 위해 관리 API, SQLite와 백업에 평문으로 존재합니다. 실제 비밀, 프롬프트 또는 응답 예시를 패턴으로 등록하지 마십시오.

## 공급자와 모델

Generic OpenAI-compatible, Ollama, vLLM, LM Studio, llama.cpp server, LocalAI, NVIDIA NIM 프리셋을 제공합니다. 프리셋은 URL과 설명일 뿐 별도 SDK가 아닙니다. `/models` 검색 결과는 DB를 변경하지 않으며 관리자가 확인한 모델 하나만 명시적으로 등록됩니다.

## 보존, 통계, 비용

`REQUEST_LOG_RETENTION_DAYS` 기본값은 30일이며 `0`은 자동 삭제 비활성화입니다. 정리는 상세 `request_logs`만 삭제하고 일별 `usage_logs` 요약은 유지합니다. 통계에는 토큰 수, 상태, 오류 분류, 모델, 사용자, 공급자, 응답 시간과 설정된 경우 예상 비용만 저장합니다. 비용은 청구 금액이 아닙니다.

## 검증

```powershell
npm test
npm audit --omit=dev
npm run benchmark
```

테스트와 벤치마크는 로컬 mock provider와 임시 SQLite DB만 사용합니다. 운영 `data/gateway.db`나 인터넷 공급자에 의존하지 않습니다.

자세한 문서: [API](docs/API.md), [호환성](docs/COMPATIBILITY.md), [백업/복구](docs/BACKUP_RESTORE.md), [위협 모델](docs/THREAT_MODEL.md), [마이그레이션](docs/MIGRATIONS.md), [벤치마크](docs/BENCHMARK.md).

## 비목표

다중 서버, 분산 rate limit, Kubernetes, SSO/OIDC/LDAP, 결제, MCP, semantic cache, 벡터 DB, 복잡한 fallback/load balancing, 프롬프트 분석·저장, 별도 텔레메트리, 플러그인 프레임워크, Claude/Gemini/Responses/Realtime 변환은 지원하지 않습니다.

## 라이선스

[MIT License](LICENSE)로 배포됩니다.

## Built-in Korean PII filter

The global Built-in Korean PII & Secret Filter card is disabled by default.
Administrators can only enable it; reviewed rules are edited in
`services/pii-filter.js` together with tests. PII pseudonym mappings are
request-local, while detected secrets return `[FILTERED]` and are never restored.
The filter is not output DLP or a general DLP system.
