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
