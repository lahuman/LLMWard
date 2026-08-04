# OpenAI compatibility

| 기능 | 상태 | 동작 |
|---|---|---|
| `GET /v1/models` | 지원 | 허용된 활성 모델 목록 |
| `POST /v1/chat/completions` | 지원 | 알 수 없는 요청/응답 필드를 변환하지 않고 전달 |
| SSE `stream: true` | 지원 | SSE chunk와 tool call 필드를 투명 전달, usage가 있으면 기록 |
| Tool calls | 전달 | Gateway가 해석하거나 변환하지 않음 |
| `usage` | 지원 | `prompt_tokens`, `completion_tokens`; 없으면 0 |
| 공급자 오류 | 안전 변환 | 상태/분류만 기록, 오류 본문 미저장 |
| Timeout | 지원 | 504와 upstream 취소 |
| Client disconnect | 지원 | upstream 취소, 예약/동시성 슬롯 해제 |
| 예상하지 못한 redirect | 거부 | 자동 추적하지 않음 |
| Responses/Realtime/Claude/Gemini 변환 | 미지원 | 지원한다고 가장하지 않음 |

Streaming 공급자가 마지막 chunk에 usage를 포함하지 않으면 Gateway는 토큰 수를 0으로 기록합니다. 자체 tokenizer를 포함하지 않는 의도적인 제한입니다.
