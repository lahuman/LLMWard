# LLMWard Gateway

단일 서버에서 운영하는 **100명 이하 온프레미스 조직용** OpenAI 호환 LLM 접근 관리 Gateway입니다.

- 외부 DB·Redis·클라우드 계정 불필요, 단일 SQLite 파일 사용
- 프롬프트, 메시지, 응답 본문, 공급자 오류 본문 미저장
- 단일 프로세스·단일 서버 전용(분산 운영 미지원)
- 결제·충전·실제 청구 시스템이 아닌 사용량·예상 비용 관리 도구
- 지원 API: `GET /v1/models`, `POST /v1/chat/completions`와 SSE streaming
- 관리자 정의 리터럴 규칙으로 전체 또는 모델별 입력 차단·마스킹과 출력 마스킹 지원
- B안 Signal Grid 관리자 콘솔: Overview와 Users/Models/Providers/Filters/Usage의 반응형·접근성 탐색

## 10분 Quick Start

Node.js 22 이상이 필요합니다.

```powershell
npm.cmd install
npm.cmd run setup
npm.cmd start
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

Chat Completions는 상태를 저장하지 않습니다. LLMWard는 요청에 포함된 `messages`만 공급자에 전달하며 대화 기록을 보관하거나 재구성하지 않습니다. OpenWebUI 같은 클라이언트가 연결을 다시 맺을 때도 이전 대화를 이어가려면 전체 대화의 `messages`를 다시 보내야 합니다.

진단과 백업:

```powershell
npm.cmd run doctor
npm.cmd run backup
```

## 관리자 콘솔: Signal Grid

최종 확정한 B안 **Signal Grid**를 `/admin/`에 적용했습니다. 기존 관리 API와 데이터 모델은 유지하며 정적 HTML, CSS, vanilla JavaScript만 사용합니다.

- 여섯 섹션은 `Overview`, `Users`, `Models`, `Providers`, `Filters`, `Usage` 순서입니다.
- Overview의 `Users → Policies → Models → Providers` 경로는 현재 유효한 리소스 수를 요약하며, 각 노드에서 해당 관리 섹션으로 이동할 수 있습니다.
- Overview는 고정 7일 요청 수·성공률·p95 응답 시간·예상 비용(청구 아님), 공급자 상태, 최근 요청 최대 5건을 표시합니다.
- 최근 요청에는 시간, 사용자, 모델, 상태·오류 유형, 토큰 수와 응답 시간만 표시합니다. 프롬프트, 메시지, 응답 본문, 공급자 오류 본문, 자격증명, 원문 토큰과 관리자 키는 표시하지 않습니다.
- 관리자 키는 브라우저 저장소에 쓰지 않고 현재 페이지의 JavaScript 메모리에만 유지합니다. 새로고침, 로그아웃 또는 현재 세션의 인증 실패 후에는 다시 로그인해야 합니다.
- 데스크톱에서는 라벨이 있는 탐색 레일을, 840px 미만에서는 가로 스크롤 탐색을 사용합니다. 표와 네이티브 대화상자는 키보드, 포커스와 스크린리더 사용을 지원합니다.

상세 결정과 검증 범위는 [Signal Grid 관리자 콘솔 설계](docs/superpowers/specs/2026-08-14-signal-grid-admin-redesign-design.md)에 정리되어 있습니다.

## Docker

`.env`와 영속 `data` 디렉터리만 준비합니다.

```powershell
npm.cmd run setup
docker compose up --build -d
```

Compose는 Gateway 한 서비스만 실행합니다. PostgreSQL, MySQL, Redis는 사용하지 않습니다.

### Docker 스트레스 검증

배포 이미지가 실제 컨테이너 경로에서 동작하는지는 다음 명령으로 검증합니다.

```bash
npm run stress:docker
```

이 명령은 임의의 일회성 관리자 키와 이름이 충돌하지 않는 Compose 프로젝트를 만들고, production Gateway 이미지·격리된 로컬 mock provider·부하 생성기 컨테이너를 함께 실행한 뒤 모두 제거합니다. 운영 DB, 외부 모델, 실제 프롬프트나 자격증명은 사용하지 않습니다. 기본 시험은 8 ms 응답 지연 mock provider에 짧은 합성 요청을 1/10/50/100 동시성으로 각각 3회 보내고, 성공률·처리량·p50/p95/max 지연, SSE `[DONE]`, 모델 동시성 제한의 `200`/`429` 동작을 확인합니다.

원본 JSON과 측정 한계, 최근 실측값은 [Docker stress benchmark](docs/BENCHMARK.md#docker-stress-benchmark)를 참조하십시오. 결과는 특정 하드웨어나 실제 모델의 성능 보장이 아닙니다.

2026-08-18에 Docker/Node v22.23.2/linux arm64에서 실행한 최근 결과입니다. Gateway는 production 이미지이고 provider는 8 ms 지연의 격리 mock입니다.

| 동시성 | 요청 / 성공 | 처리량 | p50 / p95 / 최대 지연 |
|---:|---:|---:|---:|
| 1 | 3 / 3 | 75.35 req/s | 13.13 / 13.60 / 13.60 ms |
| 10 | 30 / 30 | 518.29 req/s | 17.42 / 18.97 / 19.89 ms |
| 50 | 150 / 150 | 633.30 req/s | 53.33 / 85.54 / 97.53 ms |
| 100 | 300 / 300 | 1,023.81 req/s | 60.93 / 104.58 / 108.97 ms |

총 483개 요청이 모두 HTTP 200이었고, SSE는 HTTP 200과 `[DONE]`을 수신했습니다. 별도의 제한 모델 동시 요청은 HTTP 200 한 건과 429 한 건으로 제한이 작동함을 확인했습니다. [원본 결과 JSON](docs/benchmarks/2026-08-18-docker-stress.json)을 함께 보관합니다.

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

### 모델 응답 timeout

LLMWard는 다음 millisecond 단위 설정을 사용합니다.

- `LLMWARD_PROVIDER_TIMEOUT_MS=60000`: 비스트리밍 전체 응답 또는 스트리밍 upstream 응답 헤더 대기
- `LLMWARD_STREAM_IDLE_TIMEOUT_MS=120000`: 스트리밍 응답 헤더 이후 raw upstream body chunk 사이의 최대 무응답 시간
- `LLMWARD_STREAM_MAX_DURATION_MS=1800000`: upstream 요청 시작부터 스트림 종료까지의 절대 상한

진행 중인 스트림은 raw upstream body chunk를 받을 때마다 idle timeout을 갱신하지만 절대 상한은 갱신하지 않습니다. downstream backpressure로 LLMWard가 upstream을 더 읽지 못하는 동안에도 idle timeout은 계속 적용됩니다.

Timeout이 클라이언트에 SSE 응답 헤더를 보내기 전에 발생하면 HTTP 504 `provider_timeout`을 반환합니다. 이미 SSE 헤더를 보냈다면 JSON 또는 SSE 오류를 추가하지 않고 연결을 종료합니다.

기존 설치의 다른 제품명 접두사 timeout 설정은 읽지 않습니다. 기존 `.env`를 세 LLMWard 설정으로 직접 변경한 뒤 프로세스를 다시 시작하거나 컨테이너를 다시 생성해야 합니다. Compose의 `env_file` 변경은 `docker compose restart`로 다시 읽히지 않으므로 `docker compose up -d --force-recreate gateway`를 사용합니다.

reverse proxy의 read/idle timeout은 `LLMWARD_STREAM_IDLE_TIMEOUT_MS`보다 길어야 하며 기본 설정에서는 180초 이상을 권장합니다. 절대 연결 제한은 `LLMWARD_STREAM_MAX_DURATION_MS`보다 길게 설정하거나 이 경로에서 비활성화하고, SSE buffering은 비활성화하십시오.

## 공급자와 모델

Generic OpenAI-compatible, Ollama, vLLM, LM Studio, llama.cpp server, LocalAI, NVIDIA NIM 프리셋을 제공합니다. 프리셋은 URL과 설명일 뿐 별도 SDK가 아닙니다. `/models` 검색 결과는 DB를 변경하지 않으며 관리자가 확인한 모델 하나만 명시적으로 등록됩니다.

모델의 `Maximum output tokens`는 한 응답에 허용하는 최대 출력 토큰 수이며 전체 컨텍스트 크기가 아닙니다. `context_window`는 공급자에서 실제로 설정한 모델 컨텍스트 크기를 기록하는 정보성 메타데이터일 뿐, LLMWard가 공급자의 컨텍스트 설정을 변경하지 않습니다. Ollama `num_ctx`, vLLM `max_model_len`, llama.cpp `n_ctx` 같은 공급자별 실행 설정은 운영자가 해당 공급자에서 직접 관리해야 합니다.

## 보존, 통계, 비용

`REQUEST_LOG_RETENTION_DAYS` 기본값은 30일이며 `0`은 자동 삭제 비활성화입니다. 정리는 상세 `request_logs`만 삭제하고 일별 `usage_logs` 요약은 유지합니다. 통계에는 토큰 수, 상태, 오류 분류, 모델, 사용자, 공급자, 응답 시간과 설정된 경우 예상 비용만 저장합니다. 비용은 청구 금액이 아닙니다.

## 검증

```powershell
npm.cmd test
npm.cmd audit --omit=dev
npm.cmd run benchmark
npm run stress:docker
```

테스트와 벤치마크는 로컬 mock provider와 임시 SQLite DB만 사용합니다. 운영 `data/gateway.db`나 인터넷 공급자에 의존하지 않습니다.

자세한 문서: [관리자 콘솔 설계](docs/superpowers/specs/2026-08-14-signal-grid-admin-redesign-design.md), [API](docs/API.md), [호환성](docs/COMPATIBILITY.md), [백업/복구](docs/BACKUP_RESTORE.md), [위협 모델](docs/THREAT_MODEL.md), [마이그레이션](docs/MIGRATIONS.md), [벤치마크](docs/BENCHMARK.md), [15초 아키텍처 데모 영상](docs/assets/llmward-architecture-demo.mp4), [영상 제작 노트](docs/DEMO_VIDEO.md).

## 비목표

다중 서버, 분산 rate limit, Kubernetes, SSO/OIDC/LDAP, 결제, MCP, semantic cache, 벡터 DB, 복잡한 fallback/load balancing, 프롬프트 분석·저장, 별도 텔레메트리, 플러그인 프레임워크, Claude/Gemini/Responses/Realtime 변환은 지원하지 않습니다.

## 라이선스

[MIT License](LICENSE)로 배포됩니다.

## Built-in Korean PII 및 Secret Filter

전역 Built-in Korean PII & Secret Filter는 기본 비활성입니다. 관리자 화면에서는 활성 상태만 변경할 수 있으며, 검토된 규칙은 `services/pii-filter.js`와 테스트에서 함께 관리합니다. PII 가명 매핑은 요청 범위에서만 유지되고, 탐지한 비밀은 `[FILTERED]`로 비가역 치환됩니다. 출력 DLP나 범용 DLP 시스템은 아닙니다.
