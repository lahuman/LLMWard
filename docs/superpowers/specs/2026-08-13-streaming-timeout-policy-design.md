# Active Streaming Timeout Policy Design

**Date:** 2026-08-13

## Problem

LLMWard currently reads one legacy product-prefixed timeout value, defaults it to 60 seconds, and uses it as an absolute deadline for the complete upstream request. The timer remains active while an SSE response is making progress, so a healthy model stream is aborted at 60 seconds even when chunks continue to arrive. Some supported on-premises models stream for more than ten minutes.

The configuration name also belongs to a different product and must be removed rather than retained as an alias.

## Goals

- Allow a healthy SSE response to continue beyond ten minutes, up to an absolute 30-minute limit.
- Abort a stream that produces no upstream body bytes for two minutes.
- Keep the existing 60-second protection while waiting for an upstream response to start.
- Keep the existing 60-second whole-response deadline for non-streaming requests.
- Preserve exactly-once quota reservation and concurrency cleanup on success, timeout, provider error, downstream disconnect, backpressure failure, and shutdown.
- Use only LLMWard-specific environment variable names with explicit millisecond units.
- Preserve the existing privacy boundary: do not log or persist prompt, response, provider error body, credentials, or raw tokens.

## Non-goals

- No asynchronous job or polling API.
- No synthetic SSE heartbeat events.
- No automatic retry, provider fallback, queue, or load balancer.
- No provider-specific SDK or behavior.
- No database schema change.
- No automatic edit of an existing `.env` file.
- No reverse-proxy implementation inside this repository.

## Configuration

The following positive integer settings replace the old setting:

| Environment variable | Default | Meaning |
|---|---:|---|
| `LLMWARD_PROVIDER_TIMEOUT_MS` | `60000` | Non-streaming whole-response deadline; streaming response-start deadline |
| `LLMWARD_STREAM_IDLE_TIMEOUT_MS` | `120000` | Maximum time between upstream body chunks after streaming response headers arrive |
| `LLMWARD_STREAM_MAX_DURATION_MS` | `1800000` | Absolute streaming lifetime from upstream dispatch to completion |

Invalid, zero, negative, non-integer, or unsafe-integer values fail startup using the existing configuration validation pattern.

Every legacy product-prefixed reference is removed from source, tests, scripts, examples, and documentation. There is no compatibility fallback. `npm.cmd run setup` continues to preserve an existing `.env`; operators with a customized old timeout must replace that entry manually before restarting or recreating the service.

## Request Lifecycle

All deadlines use the request's existing `AbortController`. Timer callbacks only abort the controller; the route's existing `catch` and `finally` path remains responsible for response handling, failure recording, reservation cleanup, concurrency release, and listener removal.

### Non-streaming requests

Immediately before upstream `fetch`, arm `LLMWARD_PROVIDER_TIMEOUT_MS`. It remains active while waiting for headers and consuming and validating the complete response body. Completion or any exit clears the timer. Expiration aborts the upstream and retains the existing HTTP 504 `provider_timeout` behavior.

### Streaming requests

Immediately before upstream `fetch`:

1. Arm the response-start deadline using `LLMWARD_PROVIDER_TIMEOUT_MS`.
2. Arm the non-resetting absolute deadline using `LLMWARD_STREAM_MAX_DURATION_MS`.

When upstream response headers arrive:

1. Clear the response-start deadline.
2. Reject redirects and non-success statuses through the existing provider error path.
3. Arm the stream idle deadline using `LLMWARD_STREAM_IDLE_TIMEOUT_MS` before waiting for the first body chunk.

For every raw upstream body chunk, reset the idle deadline. Activity is measured before SSE parsing or output filtering, so fragmented but progressing filtered events count as upstream progress. A downstream backpressure stall prevents further reads and therefore expires through the same idle protection if it lasts two minutes.

The absolute deadline never resets. A stream ends normally only if it completes before 30 minutes. Normal completion and every error path clear all remaining timers.

```text
upstream dispatch
    |-- 60 s without response headers --> abort
    |
response headers
    |-- 2 min without next raw chunk ----> abort
    |-- raw chunk ------------------------> reset idle timer
    |-- 30 min since dispatch ------------> abort
    `-- upstream completes ---------------> success
```

Both byte-transparent and output-filtered SSE relay paths use the same activity rule.

## Timeout Responses and Cleanup

- If downstream headers have not been sent, a Gateway deadline returns HTTP 504 with the existing `provider_timeout` response code.
- If SSE headers have already been sent, HTTP status cannot be changed. LLMWard aborts upstream and destroys the downstream connection without injecting an artificial SSE error event.
- Client disconnect continues to abort upstream without sending a response.
- All timeout variants remain `error_type=timeout` in request statistics; no schema or response-shape expansion is required.
- Timeout, disconnect, and shutdown converge on the existing idempotent cleanup path. No second reservation release or concurrency release path is introduced.

Quota reservation expiry must cover the request's possible lifetime plus the existing 30-second stale-cleanup cushion:

- non-streaming: `LLMWARD_PROVIDER_TIMEOUT_MS + 30000`
- streaming: `LLMWARD_STREAM_MAX_DURATION_MS + 30000`

The streaming/non-streaming lifetime is passed to quota reservation explicitly. A live request still deletes its reservation immediately when its normal cleanup runs.

## Deployment and Operations

`.env.example` uses only the three new LLMWard variables. README documentation explains their different roles and the breaking environment-variable rename.

Any reverse proxy or client in front of LLMWard must not impose a shorter deadline:

- upstream/read idle timeout must be greater than 120 seconds; 180 seconds is the recommended minimum;
- absolute request/connection lifetime must be greater than 30 minutes or disabled for this route;
- response buffering must remain disabled for SSE.

These are deployment requirements, not additional services or repository-managed proxy configuration.

## Tests

Use isolated local mock providers, temporary databases, and compressed test-only timeout values. Tests must cover:

1. New configuration defaults and rejection of invalid values.
2. A provider that does not send response headers before the response-start deadline returns 504 `provider_timeout`.
3. A non-streaming provider that sends headers but does not complete its body before the provider deadline returns 504.
4. An active byte-transparent SSE stream continues beyond `LLMWARD_PROVIDER_TIMEOUT_MS` and completes before the hard limit.
5. An active output-filtered SSE stream follows the same rule.
6. A stream that sends headers and then no body chunk expires at the idle deadline.
7. A stream that keeps sending chunks is still aborted at the absolute 30-minute-equivalent test deadline.
8. Idle and absolute deadline exits abort upstream and release quota reservations and user, model, and provider concurrency exactly once.
9. Existing disconnect, backpressure, filtering, and shutdown lifecycle tests remain green.
10. A repository search returns zero references to the legacy product prefix.

After focused timeout tests, run `npm.cmd test`. Run `npm.cmd run doctor`, `npm.cmd run benchmark`, and relevant Docker checks because configuration examples and container deployment behavior are affected.

## Acceptance Criteria

- A stream receiving upstream chunks more frequently than every two minutes is not terminated by the 60-second provider deadline.
- Such a stream can run for more than ten minutes but never beyond 30 minutes.
- A two-minute upstream silence and the 30-minute absolute limit both cancel the provider request and clean up resources.
- Non-streaming behavior retains its 60-second default limit.
- No source, test, script, example, or documentation contains the old product name.
- No prompts, generated content, provider error bodies, credentials, or raw user tokens are added to logs or persistence.
