# Benchmark

`npm run benchmark`는 임시 SQLite DB와 로컬 mock provider로 시작 시간, RSS, DB 크기, 직접 공급자 대비 Gateway 평균 추가 시간, 1/10/100 사용자 요청, SSE와 동시성 제한을 측정합니다.

아래 결과는 검증 시점의 실제 로컬 측정값으로 갱신합니다. 다른 하드웨어·OS·Node 버전의 성능을 보장하지 않습니다.

<!-- BENCHMARK_RESULT -->

측정 시각: 2026-08-04T03:57:20.906Z  
환경: Windows x64, Node v22.14.0

| 항목 | 실측값 |
|---|---:|
| 시작 시간 | 400.09 ms |
| 초기 유휴 RSS | 48.65 MiB |
| 초기 스키마 DB 크기 | 126,976 bytes |
| mock 공급자 직접 평균 | 1.75 ms |
| Gateway 경유 평균 | 7.11 ms |
| Gateway 평균 추가 시간 | 5.36 ms |
| 1명 동시 1회 | 7.66 ms, 1/1 성공 |
| 10명 동시 1회 | 58.99 ms, 10/10 성공 |
| 100명 동시 1회 | 560.07 ms, 100/100 성공 |
| SSE | HTTP 200, `[DONE]` 수신 |
| 동시성 제한 초과 | HTTP 200 1건, HTTP 429 1건 |

시작 시간은 앱 로드·마이그레이션·임의 포트 listen까지, 초기 RSS와 DB 크기는 공급자/사용자 등록 전 WAL checkpoint 직후를 측정했습니다. 지연 시간은 같은 프로세스의 로컬 mock provider를 직접 20회 호출한 평균과 Gateway를 20회 경유한 평균의 차이입니다.

## Docker stress benchmark

`npm run stress:docker`는 production Dockerfile로 Gateway를 빌드하고, 별도 컨테이너에서 local mock provider와 부하 생성기를 실행합니다. 매 실행은 독립된 Compose 프로젝트와 named volume을 사용하며 완료 후 `down --volumes --remove-orphans`로 정리합니다.

- 부하: 짧은 합성 Chat Completions 요청(`max_tokens=1`), provider 응답 지연 8 ms
- 동시성: 기본 1/10/50/100, 각 구간 3회 반복
- 측정: 구간별 성공 수·HTTP 상태 분포·총 경과 시간·요청/초·p50/p95/max 클라이언트 지연
- 계약 확인: SSE HTTP 200 및 `[DONE]`, 제한 모델의 동시 요청 결과가 정확히 HTTP 200 1건과 429 1건
- 제외: 실제 모델 추론, 외부 네트워크, 장시간 soak, 다중 Gateway, 실제 사용자 트래픽

기본 출력은 git-ignored `artifacts/docker-stress-result.json`입니다. 공개용 수치를 갱신할 때는 아래의 고정 JSON 스냅샷도 함께 갱신합니다.

```bash
npm run stress:docker -- --output docs/benchmarks/2026-08-18-docker-stress.json
```

<!-- DOCKER_STRESS_RESULT -->

측정 시각: 2026-08-18T11:20:50.824Z<br>
환경: Docker, Node v22.23.2, linux arm64; LLMWard production 이미지; 8 ms 응답 지연의 격리 mock provider

| 동시성 | 요청 / 성공 | 상태 | 경과 시간 | 처리량 | p50 / p95 / 최대 지연 |
|---:|---:|---:|---:|---:|---:|
| 1 | 3 / 3 | 200: 3 | 39.82 ms | 75.35 req/s | 13.13 / 13.60 / 13.60 ms |
| 10 | 30 / 30 | 200: 30 | 57.88 ms | 518.29 req/s | 17.42 / 18.97 / 19.89 ms |
| 50 | 150 / 150 | 200: 150 | 236.85 ms | 633.30 req/s | 53.33 / 85.54 / 97.53 ms |
| 100 | 300 / 300 | 200: 300 | 293.02 ms | 1,023.81 req/s | 60.93 / 104.58 / 108.97 ms |

SSE는 HTTP 200 및 `[DONE]`을 수신했고, 별도의 제한 모델 동시 요청은 `[200, 429]`로 확인했습니다. 원본: [2026-08-18 Docker stress JSON](benchmarks/2026-08-18-docker-stress.json).

수치를 공개할 때에는 위의 `measured_at`, workload, mock-provider 지연을 함께 제시해야 합니다. 이 결과는 실제 LLM 추론, 장시간 soak, 다중 Gateway 또는 일반적 성능을 보장하지 않습니다.
