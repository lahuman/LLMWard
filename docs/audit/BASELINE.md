# 감사 기준선

측정 시각: 2026-08-04 (Asia/Seoul)  
작업 시작 브랜치: `main`  
작업 시작 HEAD: `93e9ad6411f2b99153e31fdcf35c4b1623947fea`  
감사 브랜치: `audit/codex-hardening-release`

## 저장소 상태

- 시작 작업 트리는 깨끗했다.
- Git이 추적하는 `.env`, SQLite DB/WAL/SHM, 로그, 백업, coverage 파일은 없었다.
- 실제 `.env`와 `data/`는 존재하지만 `.gitignore`로 제외되어 있으며 내용은 감사 문서에 기록하지 않았다.
- 루트 `AGENTS.md`는 존재하지만 Git에서 제외되어 있고 현재 코드와 맞지 않는 오래된 내용이었다.

## 실행 환경

| 항목 | 실측값 |
|---|---|
| OS | Windows (`win32 x64`) |
| Node.js | `v22.14.0` |
| npm | `10.9.2` (`npm.cmd` 사용) |
| Docker | CLI를 찾을 수 없어 실행 검증 불가 |

PowerShell 실행 정책이 `npm.ps1`을 차단하므로 Windows 검증에는 `npm.cmd`를 사용했다.

## 기준선 명령

| 명령 | 결과 | 비고 |
|---|---|---|
| `npm.cmd install` | 성공 | 변경할 패키지 없음 |
| `npm.cmd test` | 성공 | 28/28 통과, 약 6.46초 |
| `npm.cmd audit --omit=dev` | 성공 | 권한 재시도 후 취약점 0건 |
| `npm.cmd run doctor` | 성공 | 현재 개발 DB 기준 모든 기존 검사 통과 |
| `npm.cmd run benchmark` | 성공 | 임시 DB와 로컬 mock provider 사용 |
| `docker version` | 실행 불가 | Docker CLI 없음 |
| `docker compose version` | 실행 불가 | Docker CLI 없음 |

## 기준선 벤치마크

`npm.cmd run benchmark`의 2026-08-04T08:05:06.652Z 실측값이다.

| 항목 | 값 |
|---|---:|
| 시작 시간 | 585.08 ms |
| 유휴 RSS | 51.70 MiB |
| 신규 DB 크기 | 126,976 bytes |
| mock 공급자 직접 평균 | 1.97 ms |
| Gateway 경유 평균 | 7.50 ms |
| 평균 추가 시간 | 5.53 ms |
| 1명 시뮬레이션 | 8.58 ms, 1/1 성공 |
| 10명 시뮬레이션 | 72.79 ms, 10/10 성공 |
| 100명 시뮬레이션 | 712.48 ms, 100/100 성공 |
| SSE | HTTP 200, `[DONE]` 확인 |
| 모델 동시성 초과 | HTTP 200 1건, HTTP 429 1건 |

이 값은 같은 프로세스의 mock 공급자를 사용한 단일 실행 결과이며 운영 성능 보장이 아니다.

