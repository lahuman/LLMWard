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
