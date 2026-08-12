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

공급자 모델 검색: `GET /admin/providers/:id/discover-models`. 검색은 읽기 전용이며 등록은 `POST /admin/models`로 명시적으로 수행합니다.

제한 초과는 HTTP 429, 안정적인 `code`, 가능한 경우 `Retry-After`를 반환합니다.

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
| 413 | `request_too_large` | 마스킹·`max_tokens` 적용 뒤 공급자 요청이 1 MiB 초과 |
| 500 | `filter_configuration_invalid` | 적용할 저장 설정이 손상됨 |
| 502 | `filter_processing_failed` | 비스트리밍 출력 필터 실패 또는 응답 헤더 전 filtered SSE 처리 실패 |

출력 필터가 활성화된 SSE는 이벤트 구분자를 포함해 이벤트 하나당 1 MiB로 제한합니다. invalid JSON data event, 이 상한 초과 또는 필터 처리 실패는 fail-closed이며, 응답 헤더 전에는 HTTP 502 `filter_processing_failed`를 반환하고 헤더 전송 뒤에는 upstream을 중단하고 JSON 오류 본문 없이 연결을 종료합니다. 출력 필터가 없을 때의 byte-transparent relay에는 이 이벤트 상한을 적용하지 않습니다.

오류 본문은 규칙 이름·ID, 패턴 또는 일치 내용을 포함하지 않습니다.

`content_filtered` is the sole exception for a client-safe policy name: its standard HTTP 400 body includes `filter_name`. When multiple active policies match, it identifies the first matching policy in database ID order. The response does not disclose a pattern or matched content.
