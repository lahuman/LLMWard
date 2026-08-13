# OpenAI compatibility

| 기능 | 상태 | 동작 |
|---|---|---|
| `GET /v1/models` | 지원 | 허용된 활성 모델 목록과 최대 출력 토큰, nullable `context_window` 메타데이터 |
| `POST /v1/chat/completions` | 지원 | 생략된 다섯 생성 필드에 모델 기본값을 적용하고, 필터 대상 텍스트 외의 알 수 없는 요청/응답 필드는 변환하지 않고 전달 |
| SSE `stream: true` | 지원 | 출력 필터가 없으면 byte-transparent 전달; 있으면 이벤트당 1 MiB(구분자 포함) 상한으로 SSE를 증분 처리해 content만 마스킹 |
| Tool calls | 전달 | Gateway가 해석하거나 변환하지 않음 |
| 선언형 콘텐츠 필터 | 지원 | 전체 또는 모델별 입력 `block`/`mask`, 비스트리밍·SSE 출력 `mask` |
| `usage` | 지원 | `prompt_tokens`, `completion_tokens`; 없으면 0 |
| 공급자 오류 | 안전 변환 | 상태/분류만 기록, 오류 본문 미저장 |
| Timeout | 지원 | 비스트리밍 전체 응답과 streaming upstream 응답 헤더 대기는 `LLMWARD_PROVIDER_TIMEOUT_MS`, 진행 중 stream은 `LLMWARD_STREAM_IDLE_TIMEOUT_MS`·`LLMWARD_STREAM_MAX_DURATION_MS` 적용(기본 60초/2분/30분); 클라이언트 응답 헤더 전 timeout은 504 `provider_timeout`, 이후에는 연결 종료 |
| Client disconnect | 지원 | upstream 취소, 예약/동시성 슬롯 해제 |
| 예상하지 못한 redirect | 거부 | 자동 추적하지 않음 |
| Responses/Realtime/Claude/Gemini 변환 | 미지원 | 지원한다고 가장하지 않음 |

`GET /v1/models`의 `max_tokens`는 최대 출력 토큰 수이고 `context_window`는 숫자 또는 `null`인 정보성 컨텍스트 메타데이터입니다. 관리자 전용 `default_temperature`, `default_top_p`, `default_presence_penalty`, `default_frequency_penalty`, `default_seed`는 공개 모델 목록에 포함되지 않습니다. `context_window`는 공급자 요청에 전달되지 않으며 공급자의 런타임 설정을 변경하지 않습니다.

Chat Completions는 입력 필터 적용 뒤 클라이언트가 생략한 `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`에만 해당 모델의 non-null 기본값을 넣습니다. 명시적인 `0`과 `null`을 포함해 클라이언트가 소유한 필드가 모델 기본값보다 우선하고, Gateway가 결정하는 라우팅·보안·쿼터와 `max_tokens`가 그보다 우선합니다. 저장된 기본값이 null이면 필드를 추가하지 않아 공급자 기본값에 맡깁니다.

이 다섯 필드 외의 알 수 없는 요청 필드와 vendor 확장 필드는 기존처럼 구조와 값을 유지해 전달합니다. 임의 요청 필드의 저장 기본값, `model_config` 병합, 공급자별 컨텍스트·실행 옵션 전달은 지원하지 않습니다. 공급자 런타임 구성은 운영자가 공급자에서 직접 관리합니다.

Streaming idle은 완성된 SSE event나 downstream write가 아니라 출력 필터 처리 전의 raw upstream body chunk 수신을 기준으로 갱신합니다. 따라서 필터가 event를 조립하는 동안에도 upstream bytes가 계속 도착하면 활성 상태로 취급합니다. downstream backpressure로 upstream 읽기가 중단된 동안에는 idle timeout이 계속 적용됩니다.

Streaming 공급자가 마지막 chunk에 usage를 포함하지 않으면 Gateway는 토큰 수를 0으로 기록합니다. 자체 tokenizer를 포함하지 않는 의도적인 제한입니다.

`usage`를 받은 뒤 필터 처리가 실패하면 원본 공급자 토큰을 반영하고 요청을 `error_type=filter` 실패로 한 번 기록합니다. 스트림이 usage 전에 실패하면 0-token 실패로 기록합니다.

출력 필터가 활성화된 SSE의 invalid JSON data event, 이벤트당 1 MiB(구분자 포함) 상한 초과 또는 필터 처리 실패는 fail-closed입니다. 헤더 전에는 HTTP 502 `filter_processing_failed`를 반환하고, 헤더 전송 뒤에는 upstream을 중단하고 연결을 종료합니다. 출력 필터가 없을 때의 byte-transparent relay에는 이 이벤트 상한을 적용하지 않습니다.

입력 필터는 `messages[*].content` 문자열과 `{type:"text", text}` part만 검사합니다. 출력 필터는 비스트리밍 `choices[*].message.content`와 스트리밍 `choices[*].delta.content`만 검사합니다. 서로 다른 메시지나 part 경계는 넘지 않지만, 같은 choice의 연속 streaming content 경계는 넘겨 매칭합니다. `model`, `stream`, tool/function arguments, 이미지·오디오 part, `usage`와 vendor 확장 필드는 유지합니다.

필터 패턴은 정규식이 아닌 Unicode 대소문자 비구분 리터럴 부분 문자열이며 치환문은 `[FILTERED]`로 고정됩니다. 임의 코드, 정규식, 외부 정책 서버는 지원하지 않습니다. 새 필터는 기본 비활성이며, 전체 적용이 아닌 필터에 모델 할당이 없으면 no-op입니다.

`content_filtered` applies only after matching those supported input text fields. Its `filter_name` identifies the first matching active policy in database ID order; the response never includes a pattern or matched text.

## Built-in Korean PII / secret filter compatibility

This filter covers Korean resident and foreigner registration numbers, payment
card numbers, Korean phone numbers, email addresses, IPv4 addresses, and
distinctive secrets such as private-key blocks. Resident identifiers use modern
date/type validation without a legacy checksum, including the October 12, 2020
resident random-tail change documented by the Ministry of the Interior and
Safety: https://www.mois.go.kr/frt/bbs/type002/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000205&nttId=75077
Foreigner identifiers use their separate checksum. Supported Korean telephone
prefixes are `010`, `02`, `031` through `033`, `041` through `044`, `051` through `055`, `061` through `064`,
and `070`.

It does not detect names, free-form addresses, bank accounts, business
registration numbers, general URLs, attachments, tool or function arguments,
or provider-generated raw PII. The filter examines only documented chat text
fields and is not general DLP.

SSE without an active mapping or literal output filter is byte-transparent.
With a mapping or literal filter active, SSE is processed strictly by supported
content field and event boundaries. Invalid JSON data events, an event over
1 MiB including delimiters, or filtering failures fail closed: before response
headers the gateway returns HTTP 502 `filter_processing_failed`; after headers
it stops the upstream request and closes the connection. This keeps the error
boundary safe without exposing unfiltered content.
