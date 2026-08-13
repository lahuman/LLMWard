# API examples

관리 API는 `X-Admin-Key`, 사용자 API는 `Authorization: Bearer <token>`을 사용합니다. 토큰 원문은 발급 응답에만 나타납니다.

```bash
curl -X POST http://localhost:3000/admin/users \
  -H "X-Admin-Key: <admin-key>" -H "Content-Type: application/json" \
  -d '{"username":"alice","allowed_models":["local-model"]}'

curl -N http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <user-token>" -H "Content-Type: application/json" \
  -d '{"model":"local-model","stream":true,"messages":[{"role":"user","content":"hello"}]}'
```

토큰 관리: `GET/POST /admin/users/:id/tokens`, `DELETE /admin/users/:userId/tokens/:tokenId`, `POST /admin/users/:id/rotate-token`.

## 사용자 일일 토큰 한도

`max_daily_input_tokens`와 `max_daily_output_tokens`는 서로 독립적인 0 이상의 safe integer입니다. 사용자 생성 시 필드를 생략하면 각각 0으로 저장되며, 0은 해당 방향의 일일 토큰 한도가 무제한임을 뜻합니다. 양수는 해당 방향의 일일 토큰 한도이고, 기존 사용자의 저장값은 자동으로 변경되지 않습니다.

출력은 일일 출력 토큰 한도가 0이어도 요청의 `max_tokens`와 모델의 최대 출력 토큰 안에서 예약되므로 요청 및 모델 최대치는 계속 적용됩니다. 입력 사용량은 공급자 응답 후 실제 사용량으로 확정됩니다. 따라서 양수 입력 토큰 한도를 넘기는 요청은 완료될 수 있으며, 한도를 넘은 뒤의 후속 요청부터 HTTP 429를 받습니다.

`GET /dashboard/usage`의 `remainingInput`과 `remainingOutput`은 각 방향의 남은 일일 토큰 수를 반환합니다. 해당 방향의 일일 토큰 한도가 무제한이면 `null`, 양수 한도를 소진했으면 숫자 `0`입니다.

공급자 모델 검색: `GET /admin/providers/:id/discover-models`. 검색은 읽기 전용이며 등록은 `POST /admin/models`로 명시적으로 수행합니다.

제한 초과는 HTTP 429, 안정적인 `code`, 가능한 경우 `Retry-After`를 반환합니다.

## 모델 컨텍스트와 생성 기본값

관리자 전용 모델 API는 `GET /admin/models`, `POST /admin/models`, `PUT /admin/models/:id`입니다. 모델 생성 시 `max_tokens`를 생략하면 기본값은 4096입니다. 이 값은 한 응답의 최대 출력 토큰 수이며 모델의 전체 컨텍스트 크기가 아닙니다.

다음 여섯 필드는 숫자 또는 `null`로 저장되고 관리자 모델 응답에 포함됩니다.

| 필드 | 허용하는 null 이외 값 | 의미 |
|---|---|---|
| `context_window` | 1 이상인 safe integer | 공급자에서 구성한 모델의 유효 컨텍스트 크기를 기록하는 메타데이터 |
| `default_temperature` | 0 이상 2 이하인 finite number | 클라이언트가 `temperature`를 생략했을 때의 기본값 |
| `default_top_p` | 0 이상 1 이하인 finite number | 클라이언트가 `top_p`를 생략했을 때의 기본값 |
| `default_presence_penalty` | -2 이상 2 이하인 finite number | 클라이언트가 `presence_penalty`를 생략했을 때의 기본값 |
| `default_frequency_penalty` | -2 이상 2 이하인 finite number | 클라이언트가 `frequency_penalty`를 생략했을 때의 기본값 |
| `default_seed` | signed safe integer | 클라이언트가 `seed`를 생략했을 때의 기본값 |

`POST /admin/models`에서는 이 필드의 생략과 명시적인 `null`이 모두 `null`을 저장합니다. `PUT /admin/models/:id`에서는 생략한 필드는 기존 값을 유지하고, 명시적인 `null`은 저장된 값을 지웁니다. `context_window`가 숫자이면 항상 `max_tokens <= context_window`여야 하며, 생성이나 부분 수정의 최종 조합이 이 관계를 위반하면 HTTP 400을 반환하고 모델을 변경하지 않습니다.

`context_window`는 정보성 값으로 공급자 요청에 전달되지 않으며 공급자의 실행 설정을 바꾸지 않습니다. 다섯 생성 기본값에는 다음 우선순위를 적용합니다.

```text
gateway-enforced routing/security/quota
> explicit client field, including 0 or null
> non-null per-model default
> provider default
```

따라서 클라이언트 요청이 해당 필드를 소유하면 값이 `0`이나 `null`이어도 그대로 유지됩니다. 저장된 기본값은 필드가 생략된 경우에만 추가됩니다. `max_tokens`는 이 병합 대상이 아니며 기존 모델 최대 출력·사용자 쿼터 계산 결과가 계속 우선합니다. 공급자별 컨텍스트 또는 실행 옵션은 관리 API에 저장해 전달하지 않고 운영자가 공급자에서 직접 관리합니다.

## 콘텐츠 필터

관리자 전용 CRUD는 `GET /admin/filters`, `POST /admin/filters`, `PUT /admin/filters/:id`, `DELETE /admin/filters/:id`입니다. `PUT`은 전달한 필드만 변경합니다.

```json
{
  "id": 1,
  "name": "Organization PII",
  "patterns": ["literal one", "literal two"],
  "input_action": "block",
  "output_action": "mask",
  "is_active": false,
  "is_global": false,
  "model_ids": [1, 2],
  "created_at": "2026-08-11T00:00:00.000Z",
  "updated_at": "2026-08-11T00:00:00.000Z"
}
```

`input_action`은 `null`, `block`, `mask`, `output_action`은 `null`, `mask`만 허용하며 둘 중 하나는 설정해야 합니다. 새 필터는 비활성·모델 미할당으로 생성됩니다. `is_global: true`이면 `model_ids`는 저장하지 않으며, 전체 적용이 아닌 활성 필터에 할당 모델이 없으면 no-op입니다. 패턴은 Unicode 대소문자를 무시하는 리터럴 부분 문자열이고 마스킹 결과는 `[FILTERED]`입니다.

`name`은 trim 후 1–100자이고 고유해야 하며 중복은 HTTP 409를 반환합니다. 각 필터는 패턴이 하나 이상이어야 합니다. 패턴은 trim 후 1–256자이고 제어 문자와 같은 필터 안의 대소문자 비구분 중복을 거부하며, 저장된 전체 패턴은 최대 200개입니다. `model_ids`의 중복·미존재 ID와 알 수 없는 필드·action, 잘못된 boolean을 거부합니다. 패턴은 매칭에 필요하므로 관리 API 응답, SQLite와 백업에 평문으로 존재합니다. 실제 비밀, 프롬프트 또는 응답 예시를 등록하지 마십시오.

| HTTP | `code` | 의미 |
|---|---|---|
| 400 | `content_filtered` | 입력 차단 규칙과 일치 |
| 413 | `request_too_large` | 입력 필터링·모델 기본값 삽입·쿼터로 결정한 `max_tokens` 삽입 뒤 공급자 요청이 1 MiB 초과 |
| 500 | `filter_configuration_invalid` | 적용할 저장 설정이 손상됨 |
| 502 | `filter_processing_failed` | 비스트리밍 출력 필터 실패 또는 응답 헤더 전 filtered SSE 처리 실패 |

출력 필터가 활성화된 SSE는 이벤트 구분자를 포함해 이벤트 하나당 1 MiB로 제한합니다. invalid JSON data event, 이 상한 초과 또는 필터 처리 실패는 fail-closed이며, 응답 헤더 전에는 HTTP 502 `filter_processing_failed`를 반환하고 헤더 전송 뒤에는 upstream을 중단하고 JSON 오류 본문 없이 연결을 종료합니다. 출력 필터가 없을 때의 byte-transparent relay에는 이 이벤트 상한을 적용하지 않습니다.

오류 본문은 규칙 이름·ID, 패턴 또는 일치 내용을 포함하지 않습니다.

`content_filtered` is the sole exception for a client-safe policy name: its standard HTTP 400 body includes `filter_name`. When multiple active policies match, it identifies the first matching policy in database ID order. The response does not disclose a pattern or matched content.

## Built-in Korean PII / secret filter

`GET /admin/filters/built-in-pii` returns `{id,name,is_active,is_global,rules}`.
`PUT /admin/filters/built-in-pii` accepts exactly `{"is_active":true|false}`;
unknown fields and non-booleans are rejected. The setting key is
`built_in_pii_filter_active`: missing or `0` is inactive, `1` is active, and a
corrupt stored value makes admin GET return HTTP 500 `filter_configuration_invalid`
without revealing that value. PUT repairs it with exact `0` or `1`.

Supported input is `messages[*].content` strings and `{type:"text", text}` parts.
At most 200 unique values and 64 KiB are restorable; secrets become `[FILTERED]`.
Input processing uses HTTP 500 `filter_processing_failed`, oversize uses HTTP 413
`request_too_large`, and non-stream output transformation uses HTTP 502
`filter_processing_failed`. JSON/SSE transform before literal output masking;
streaming fails safely before headers or aborts after headers.
