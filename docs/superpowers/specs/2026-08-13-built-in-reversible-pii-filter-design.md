# Built-in reversible PII and secret filter design

## Goal

Provide one code-native, globally scoped filter that pseudonymizes high-confidence Korean PII before a request reaches an upstream model and restores only request-owned PII placeholders in the response. The filter also removes reviewed high-confidence secrets without ever restoring them.

The filter is built in but inactive by default. An administrator can enable or disable it in the Filters page. Detection rules remain ordinary reviewed CommonJS code so maintainers can add, change, or remove them without adding a plugin system or allowing administrator-supplied regular expressions.

## Chosen approach

Store one activation flag in the existing `app_settings` table and keep the built-in rule registry in a focused `services/pii-filter.js` module.

This is preferred over adding a `kind` column to `content_filters`. The existing table represents administrator-authored literal rules and requires patterns and actions. Reusing it for code-native validated detectors would require a schema migration, conditional constraints, protected rows, and branching throughout the current CRUD UI. A separate setting preserves the literal-filter API and schema exactly.

Running Presidio in Python or a sidecar is out of scope because LLMWard is a single-process CommonJS application and does not otherwise require Python, an NLP model, or an additional service.

## Administration and persistence

Use the setting key `built_in_pii_filter_active` with the exact stored values `0` and `1`.

- A missing row means disabled. Installation and upgrade do not insert a row or alter traffic.
- Any other stored value is invalid configuration. Requests fail closed before provider dispatch rather than silently disabling protection.
- `GET` reports invalid configuration, while a valid authenticated `PUT` may overwrite the corrupt value so an administrator can repair it.
- The filter is global when enabled and applies to every model. Model-specific assignment is not included.
- Existing `content_filters` rows, endpoints, response shapes, assignments, and defaults remain unchanged.

Add authenticated administration endpoints before the parameterized filter routes:

- `GET /admin/filters/built-in-pii`
- `PUT /admin/filters/built-in-pii` with the sole field `{ "is_active": <boolean> }`

The response contains the stable built-in ID, display name, active/global state, and read-only rule metadata derived from the code registry. It does not expose regular-expression sources or validators. `PUT` rejects unknown fields and non-boolean values. The setting upsert and successful audit entry run in one transaction. Audit data contains only the action, target ID, success flag, and changed field name; it never contains detector output or sensitive values.

The Filters tab shows a separate `Built-in Korean PII & Secret Filter` card above the existing literal-filter form. The card explains that the filter is global, inactive by default, code-defined, request-scoped, and not a general DLP system. It provides one accessible enable/disable control and a read-only list of the currently compiled rule names and behaviors. The existing literal filters remain the mechanism for organization-specific literal block and mask policies.

## Code-defined rule registry

`services/pii-filter.js` owns one ordered, immutable rule list. Each rule has:

- a unique stable ID and user-facing label;
- a fixed detection source or focused matcher;
- an optional validator for dates, checksums, or numeric ranges;
- a mode of `restore` for PII or `redact` for secrets; and
- adjacent comments stating the information detected, accepted formats, validation performed, and deliberate exclusions.

The module validates definitions when it loads. Duplicate IDs, unsupported modes, invalid matcher definitions, or patterns that can match an empty string prevent application startup. Stateful regular-expression objects are not shared between requests. Rule definitions come only from trusted source code; database values and HTTP input can never become executable patterns.

Matchers must use bounded or otherwise linear-time forms over the 1 MiB request limit. Every new matcher includes a long non-matching input regression test; nested unbounded quantifiers and broad dot-star credential rules are not accepted.

Adding or changing a rule means editing this single registry or its focused validator, updating its explanatory comment, and adding positive, negative, boundary, and overlap tests. No factory, registration API, dynamic loader, or extension framework is added.

### Initial reversible PII rules

Rules are ordered from more specific/high-risk identifiers to broader formats. An accepted span is protected from all later rules, while later rules continue over every remaining unclaimed span.

1. Korean resident registration number
   - Accept 13 digits with an optional hyphen between the sixth and seventh digits.
   - Require a valid encoded date, a valid century/sex digit in the resident range, and digit boundaries.
   - Do not require the legacy resident-number checksum. Since October 12, 2020, newly assigned or changed resident numbers keep the birth-date and century/sex positions but use six random trailing digits, so a mandatory checksum would miss valid modern numbers. This deliberately favors protecting a structurally valid resident number over rejecting every unrelated 13-digit value; exact request-local restoration limits the effect of a false positive. See the [Ministry of the Interior and Safety announcement](https://www.mois.go.kr/frt/bbs/type002/commonSelectBoardArticle.do?bbsId=BBSMSTR_000000000205&nttId=75077).
2. Korean foreigner registration number
   - Accept the same 13-digit layout.
   - Require a valid encoded date, a valid foreigner century/sex digit, digit boundaries, and the foreigner-number checksum.
3. Payment-card number
   - Accept 13 to 19 digits with conventional spaces or hyphens.
   - Strip separators and require the Luhn checksum before accepting a candidate.
4. Korean telephone number
   - Cover modern `010` mobile numbers, Seoul `02`, geographic area codes `031`, `032`, `033`, `041`, `042`, `043`, `044`, `051`, `052`, `053`, `054`, `055`, `061`, `062`, `063`, and `064`, and `070` internet telephone numbers in contiguous, space-separated, or hyphenated forms.
   - Exclude legacy mobile prefixes, personal-number services, toll-free numbers, and representative service numbers such as `15xx`, `16xx`, and `18xx` in the initial version.
5. Email address
   - Match a conservative mailbox/domain form with surrounding token boundaries.
   - Do not attempt full RFC mailbox parsing or treat arbitrary URLs as PII.
6. IPv4 address
   - Require exactly four decimal octets and validate every octet as `0` through `255`.
   - Do not treat URLs or hostnames as PII.

Names, natural-language addresses, bank-account numbers, business registration numbers, arbitrary URLs, and US identifiers are excluded because the chosen local rule engine cannot identify them with acceptable precision for this release.

### Initial irreversible secret rules

Secret rules run before every PII rule. The initial reviewed catalog is deliberately limited to these distinctive families:

- complete PEM or PGP private-key blocks with matching begin/end labels;
- OpenAI keys beginning with `sk-proj-`, or `sk-` followed by at least 20 allowed secret characters while excluding the distinct Stripe prefixes;
- Anthropic keys beginning with `sk-ant-` followed by at least 20 allowed secret characters;
- AWS access-key IDs in the `AKIA` plus 16 uppercase alphanumeric form;
- GitHub `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, and `github_pat_` token families with at least 20 allowed token characters;
- Slack `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, and `xoxs-` tokens and complete Slack webhook URLs;
- Stripe `sk_live_`, `sk_test_`, `rk_live_`, and `rk_test_` secret/restricted key families with at least 16 following alphanumeric characters; and
- Google API keys beginning with `AIza` followed by exactly 35 allowed characters.

It does not include generic `password=...`, generic bearer strings, OAuth client IDs, Firebase URLs, or broad dot-star label rules. Prefixes and conservative minimum lengths are code-defined compatibility choices and can be updated in the registry with fixtures when a provider changes its issued format.

Each secret rule must match the complete sensitive value that it claims. A marker-only private-key match is forbidden because it would leave the key body visible. A recognized private-key begin marker without a matching valid end marker fails input processing before provider dispatch. Secret matches receive request-owned placeholders but their raw values are never added to either restoration map. Returned secret placeholders become `[FILTERED]`.

## Input pipeline and short-circuit behavior

The request path remains ordered as follows:

1. Authenticate the user and authorize the requested model.
2. Acquire the existing concurrency resource.
3. Build one immutable filter/settings snapshot for the request.
4. Apply existing literal input blocks against the original supported text.
   - The first block match terminates the entire pipeline before quota reservation or provider dispatch.
5. Apply existing literal input masks.
6. If the built-in filter is disabled, return the existing body without PII work.
7. Run the ordered built-in rules over the supported chat text fields.
8. Reserve quota, clamp `max_tokens`, enforce the post-transform 1 MiB limit, and call the registered provider.

The built-in detector processes only the fields already documented for content filtering:

- `messages[*].content` when it is a string; and
- `{ "type": "text", "text": ... }` content parts.

It does not inspect tool/function arguments, image or audio parts, top-level vendor fields, usage objects, or arbitrary nested strings.

Terminal rules and transformation rules have different short-circuit semantics. A literal block stops the request. A PII or secret match claims only its matched span, so lower-priority rules skip that span but continue scanning all remaining input. Stopping the whole detector after the first PII match is forbidden because later PII in the same request would otherwise reach the provider.

Candidate validators reject cheaply and continue without claiming a span. If the filter is disabled or no candidate is accepted, no transformation context or body clone is created.

## Request-local pseudonymization

When the first match is accepted, create one request-local transformation context. It contains a cryptographically random 128-bit nonce, an exact placeholder-to-PII map, a PII-to-placeholder reverse map for stable reuse within that request, and a set of secret placeholders without secret values.

Placeholders use a fixed ASCII form containing the nonce, rule ID, and counter. Before use, the nonce prefix is checked against all supported input text; a collision causes nonce regeneration. Restoration uses exact complete tokens only. Fuzzy matching, session fallback, cross-request lookup, global maps, and user-ID maps are forbidden.

Repeated PII within one request reuses its placeholder so the upstream model retains local referential consistency. Different requests always use different nonces. Secret occurrences do not store a reverse mapping to the raw secret.

The context is limited to 200 unique restorable PII values and 64 KiB of total UTF-8 PII source bytes, counting every accepted occurrence including repeated values that reuse a placeholder. Exceeding either bound returns HTTP 413 with the existing safe `request_too_large` classification before provider dispatch. The transformed serialized request must also remain within the existing 1 MiB limit.

The context remains a handler-local value. It is never attached to `req`, a snapshot, an error, a cache, or a global object. If input processing fails before a context can be returned, the service error boundary clears the partial context before throwing. After a context is returned, the existing single `finally` cleanup path clears it on success, provider error, output-processing error, timeout, client disconnect, backpressure failure, or server shutdown. PII values, placeholders, matches, and provider content are never written to SQLite, application logs, audit logs, or error bodies.

## Response processing

### Non-streaming

For `choices[*].message.content` strings:

1. Restore only exact PII placeholders owned by this request.
2. Replace request-owned secret placeholders with `[FILTERED]`.
3. Apply the existing literal output mask last.

This order preserves administrator output policy: restored PII can still be masked by an explicitly configured literal output rule. Unknown, fabricated, truncated, modified, or previous-request placeholders remain ordinary text and never trigger a lookup.

An output transformation failure returns the existing generic `filter_processing_failed` response without returning the unprocessed provider body. If provider usage was received, it is recorded exactly once as a filter failure through the existing usage/reservation path.

### Streaming

When neither request-owned placeholders nor literal output patterns exist, keep the current byte-transparent SSE relay exactly.

When either is present, use the existing strict SSE event transformer. Each choice owns independent restoration carry followed by the existing literal-mask carry. This allows a placeholder and a subsequently restored literal mask pattern to cross transport chunks and multiple `delta.content` events. Both stages flush in order on `finish_reason`, `[DONE]`, and clean EOF.

Invalid UTF-8, invalid JSON data events, invalid choice structure, oversized or unterminated events, and transformation failures retain the existing fail-closed behavior: HTTP 502 before headers, or upstream abort and connection termination after headers. Usage and quota/concurrency cleanup remain exactly-once.

A partial or modified placeholder contains no original PII and is emitted unchanged after the carry flush; it is never guessed or restored.

## Error handling and privacy boundaries

- Corrupt activation settings produce `filter_configuration_invalid` before provider dispatch.
- Invalid code-defined rules prevent startup.
- Mapping or transformed-body limits produce HTTP 413 before provider dispatch.
- Unexpected input processing errors return HTTP 500 `filter_processing_failed` with no matched value or rule details.
- Output processing errors never return an unfiltered provider body.
- Authentication and model authorization continue to run before filter configuration is read.
- No client `Authorization` value or administrator/provider credential is forwarded or used as filter material.

This feature reduces disclosure of supported input PII and secrets to the registered provider. It is not a general DLP engine. It does not detect names or natural-language addresses, encoded/obfuscated values, unsupported protocol fields, attachments, or new raw PII or secrets independently generated by the provider. Existing literal output filters remain available for organization-specific response masking.

## Verification

### Unit coverage

- Positive, negative, separator, boundary, invalid-date, and invalid-century/sex fixtures for resident registration numbers, including legacy-checksum and post-2020 random-tail forms.
- Positive, negative, separator, boundary, invalid-date, invalid-century/sex, and invalid-checksum fixtures for foreigner registration numbers.
- Supported and deliberately excluded Korean telephone formats.
- Conservative email boundaries, Luhn card validation, and IPv4 octet validation.
- Complete high-confidence secret matches, truncated lookalikes, and secret precedence over PII.
- Definition validation, deterministic ordering, per-span short-circuiting, and multiple different matches in one text.
- Same-value reuse, nonce collision handling, exact restoration, fabricated/previous-request placeholder rejection, context bounds, and explicit context clearing.
- Given the body returned by existing literal input filtering, a built-in no-match returns that same object reference and a null transformation context.

All fixtures use synthetic values and must not contain real credentials or real personal data.

### Runtime and administration coverage

- Missing setting is disabled and leaves provider/client payload behavior unchanged.
- Active filtering removes every supported raw value from the provider request and restores only PII for the client.
- Secrets are never restored; literal block precedes built-in processing; literal output mask follows restoration.
- Unsupported request fields and response extensions are preserved.
- Non-streaming failure accounting and request-local snapshot behavior remain deterministic.
- SSE placeholders split across bytes/events, interleaved choices, finish markers, `[DONE]`, and EOF restore correctly.
- Mapping-active malformed/oversized streams, disconnects, timeouts, backpressure, and shutdown preserve fail-closed and exactly-once cleanup behavior.
- No-match streams retain the existing byte-transparent path.
- Authentication-first GET/PUT administration, strict body validation, atomic audit behavior, default-off state, and unchanged literal-filter list responses.
- Accessible Web UI toggle, read-only rule list, safe DOM construction, immediate configuration reload, and independence from Usage statistics loading.
- Database, audit, request-log, application-log, and HTTP-error assertions verify that raw PII, secrets, mappings, and matched content are absent.

Run focused detector, content-filter, runtime, streaming, administration, and dashboard tests first. Then run `npm.cmd test`, `npm.cmd run doctor`, `npm.cmd audit --omit=dev`, and a temporary-database startup/health check. No schema migration or dependency installation is required.

## Documentation and attribution

Update the API, compatibility, threat-model, README, and changelog documentation with activation behavior, rule categories, pipeline ordering, supported fields, memory limits, streaming behavior, exclusions, and the distinction between provider-input pseudonymization and output DLP.

Add a third-party notice identifying the MIT-licensed inspiration, `Reversible PII / Secret Pseudonymization Filter v3.2.5` by Isidro Spencer, with its source URL, supplied attribution metadata, and the MIT permission and warranty terms. The implementation is an independent CommonJS design and does not copy its unsafe process-global session maps, cross-session restoration fallback, debug logging, broad recursive mutation, or Python/Presidio dependency.

## Non-goals

- Presidio, NLP/NER models, Python, sidecars, or external policy services
- Administrator-authored regular expressions or executable filter code
- A plugin or dynamic detector framework
- Model-specific activation in the initial version
- Names, free-form addresses, bank accounts, business registration numbers, URLs, attachments, tool arguments, or arbitrary nested fields
- Persisted or cross-request reversible mappings
- Provider-generated raw PII or secret detection
- Unrelated refactoring of the existing literal filter engine
