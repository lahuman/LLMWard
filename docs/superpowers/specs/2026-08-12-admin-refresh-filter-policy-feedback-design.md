# Admin refresh and filter policy feedback design

## Goal

Make successful administration changes visible immediately and identify the filter policy that blocked an authenticated chat request.

## Confirmed causes

- The model and provider submit handlers read `event.currentTarget` after an `await`. Browser event dispatch clears `currentTarget`, so `reset()` throws after the server has already committed the create request. The following dashboard reload never runs.
- Configuration CRUD reloads are coupled to the current Usage date form through one `Promise.all()`. An invalid custom statistics range can therefore prevent every configuration list from rendering even though the mutation succeeded.
- The effective filter snapshot flattens block patterns and discards their policy names. The public error serializer consequently has no safe policy identifier to return.

## Considered approaches

### 1. Preserve the form, separate statistics loading, and attribute blocked input by policy name

This is the recommended approach. Capture the submitted form element before the first `await`, keep configuration loading independent from Usage statistics, and add ordered block-policy metadata to the in-memory filter snapshot. Preserve the existing aggregate matcher for normal requests; only after it reports a block, find the first matching policy and attach its validated name to the fixed `content_filtered` error.

This changes no schema, adds no dependency, and keeps the extra matching work on rejected requests only.

### 2. Optimistically update every dashboard collection from mutation responses

This avoids most reloads but duplicates server normalization and relationship handling in browser state. It would require separate update logic for create, edit, activation, deletion, provider/model relationships, and onboarding state. The additional state machinery is not justified for this dashboard.

### 3. Add a separate public policy code

A dedicated public code would keep internal names private, but it requires a versioned migration, new CRUD validation, form fields, backup documentation, and migration fixtures. The administrator explicitly approved exposing the existing policy name, so this is unnecessary.

## Admin dashboard behavior

- Model and provider creation store `event.currentTarget` in a local variable before awaiting the API and call `reset()` through that stable reference.
- Configuration loading fetches users, models, providers, filters, onboarding, and presets. Statistics have a separate loader used during initial sign-in and when the Usage form is submitted.
- CRUD refreshes configuration only. A missing or invalid custom Usage range cannot cancel a successful configuration render.
- Mutation success is shown after the relevant reload finishes, so a loading message does not immediately erase it.

## Filter block attribution

`getEffectiveFilterSnapshot(modelId)` continues to return immutable flattened pattern arrays and additionally keeps immutable `{ name, patterns }` entries for active block policies in database ID order.

`applyInputFilters(body, snapshot)` first runs the existing combined block matcher against the original request text. When it finds blocked text, it checks the ordered block policies against that same text and throws the existing HTTP 400 error with an internal `filterName` property.

The global error handler allowlists that property only when all of these are true:

- the error code is `content_filtered`;
- the value is a non-empty string;
- the response is the normal pre-provider HTTP 400 path.

The response becomes:

```json
{
  "error": "Request content was filtered",
  "code": "content_filtered",
  "filter_name": "Organization PII"
}
```

If several policies match, `filter_name` is the first matching active policy in filter ID order. Patterns, matched text, message position, prompts, responses, provider bodies, and policy names are not written to application logs or request logs.

## Filter page guidance

- Explain next to the Name field that the value is returned to API clients on input block and must not contain secrets.
- Add a concrete block example showing policy name, literal pattern, activation/scope, and the resulting `filter_name` response.
- State that a non-global rule with no selected model is a no-op and that filters inspect supported chat text fields rather than acting as a general DLP engine.
- Keep safe DOM rendering, the plaintext pattern warning, and existing accessibility semantics.

## Testing

- Dashboard regression tests require stable form capture before `await`, a statistics loader independent of configuration reloads, and the new policy-name help/example.
- Filter unit tests verify immutable ordered block-policy metadata, deterministic name selection, and the absence of patterns or matched input in error metadata.
- Runtime integration tests verify `filter_name`, no provider call, zero-token filter logging, and no persistence of the policy name or request content.
- Existing authentication, authorization, filter corruption, masking, streaming, and full regression suites remain green.

## Non-goals

- Polling or real-time synchronization across browser sessions
- New database columns or migrations
- Returning patterns, matched content, or all simultaneously matching policies
- Storing policy attribution in request or audit logs
- Changing output masking or streaming behavior
