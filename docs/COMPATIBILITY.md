# OpenAI compatibility

| 기능 | 상태 | 동작 |
|---|---|---|
| `GET /v1/models` | 지원 | 허용된 활성 모델 목록 |
| `POST /v1/chat/completions` | 지원 | 필터 대상 텍스트 외의 알 수 없는 요청/응답 필드는 변환하지 않고 전달 |
| SSE `stream: true` | 지원 | 출력 필터가 없으면 byte-transparent 전달; 있으면 이벤트당 1 MiB(구분자 포함) 상한으로 SSE를 증분 처리해 content만 마스킹 |
| Tool calls | 전달 | Gateway가 해석하거나 변환하지 않음 |
| 선언형 콘텐츠 필터 | 지원 | 전체 또는 모델별 입력 `block`/`mask`, 비스트리밍·SSE 출력 `mask` |
| `usage` | 지원 | `prompt_tokens`, `completion_tokens`; 없으면 0 |
| 공급자 오류 | 안전 변환 | 상태/분류만 기록, 오류 본문 미저장 |
| Timeout | 지원 | 504와 upstream 취소 |
| Client disconnect | 지원 | upstream 취소, 예약/동시성 슬롯 해제 |
| 예상하지 못한 redirect | 거부 | 자동 추적하지 않음 |
| Responses/Realtime/Claude/Gemini 변환 | 미지원 | 지원한다고 가장하지 않음 |

Streaming 공급자가 마지막 chunk에 usage를 포함하지 않으면 Gateway는 토큰 수를 0으로 기록합니다. 자체 tokenizer를 포함하지 않는 의도적인 제한입니다.

`usage`를 받은 뒤 필터 처리가 실패하면 원본 공급자 토큰을 반영하고 요청을 `error_type=filter` 실패로 한 번 기록합니다. 스트림이 usage 전에 실패하면 0-token 실패로 기록합니다.

출력 필터가 활성화된 SSE의 invalid JSON data event, 이벤트당 1 MiB(구분자 포함) 상한 초과 또는 필터 처리 실패는 fail-closed입니다. 헤더 전에는 HTTP 502 `filter_processing_failed`를 반환하고, 헤더 전송 뒤에는 upstream을 중단하고 연결을 종료합니다. 출력 필터가 없을 때의 byte-transparent relay에는 이 이벤트 상한을 적용하지 않습니다.

입력 필터는 `messages[*].content` 문자열과 `{type:"text", text}` part만 검사합니다. 출력 필터는 비스트리밍 `choices[*].message.content`와 스트리밍 `choices[*].delta.content`만 검사합니다. 서로 다른 메시지나 part 경계는 넘지 않지만, 같은 choice의 연속 streaming content 경계는 넘겨 매칭합니다. `model`, `stream`, tool/function arguments, 이미지·오디오 part, `usage`와 vendor 확장 필드는 유지합니다.

필터 패턴은 정규식이 아닌 Unicode 대소문자 비구분 리터럴 부분 문자열이며 치환문은 `[FILTERED]`로 고정됩니다. 임의 코드, 정규식, 외부 정책 서버는 지원하지 않습니다. 새 필터는 기본 비활성이며, 전체 적용이 아닌 필터에 모델 할당이 없으면 no-op입니다.

`content_filtered` applies only after matching those supported input text fields. Its `filter_name` identifies the first matching active policy in database ID order; the response never includes a pattern or matched text.

## Built-in Korean PII / secret filter compatibility

Resident identifiers use modern date/type validation without legacy checksum,
including the October 12, 2020 resident random tail change documented by the
Ministry of the Interior and Safety:
https://www.mois.go.kr/frt/bbs/type002/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000205&nttId=75077
Foreigner identifiers use a separate checksum. Korean phone prefixes, identifiers,
cards, emails, and distinctive secrets are covered; provider-generated values are
not output-detected. No-context SSE is byte-transparent; strict context/literal
