# Per-Model Defaults and Admin CRUD Modals Design

**Date:** 2026-08-13

## Problem

LLMWard's OpenAI-compatible chat route is stateless. It forwards the `messages` supplied by the client and does not retain conversation history, so a client that reconnects without resending prior messages appears to start a new conversation. The existing model field named `max_tokens` is an output-token ceiling used by quota enforcement; it is not the model's total context window.

Administrators also cannot record a model's effective context window or define a small set of safe generation defaults. The current dashboard creates users, models, and providers in permanent inline forms, while edits and destructive actions use browser `prompt()` and `confirm()` dialogs. These interactions provide weak validation feedback, poor field context, and no consistent accessible workflow.

## Goals

- Record the effective context window for each registered model without claiming to reconfigure the provider runtime.
- Allow administrators to define typed, per-model defaults for five standard generation parameters.
- Apply a model default only when the client omitted that exact request field.
- Preserve the existing `max_tokens` quota and model-cap behavior as a separate maximum-output setting.
- Replace user, model, and provider inline create forms and CRUD prompts with accessible modal workflows.
- Preserve current authorization, deletion guards, one-time token handling, credential protection, XSS protection, audit behavior, and request passthrough compatibility.

## Non-goals

- No conversation, prompt, message array, system prompt, or generated-response persistence.
- No server-side session reconstruction after a client reconnects.
- No tokenization, prompt trimming, input-plus-output context preflight, or automatic retry.
- No provider runtime reconfiguration. LLMWard will not send `context_window`, Ollama `num_ctx`, vLLM `max_model_len`, llama.cpp `n_ctx`, or equivalent launch/load options upstream.
- No arbitrary JSON defaults, provider-specific defaults, launch arguments, SDKs, adapters, or plugin framework.
- No default values for `messages`, `model`, `stream`, `max_tokens`, tools, tool choice, response format, or vendor extension fields.
- No unrelated redesign of filters, usage, audit, or dashboard navigation.

## Design Decisions

### Model ownership

Context capacity and generation behavior belong to a registered model, not to a provider connection. One provider can expose models with different context limits and preferred generation settings. The new values therefore live on `models` and are managed through the existing model CRUD API.

`context_window` is declared metadata: it records the effective limit configured at the provider. It does not change that limit. Dashboard help text must state this explicitly.

### Typed allowlist

Only the following nullable fields are added:

| Field | SQLite type | Accepted non-null value | Runtime behavior |
|---|---|---|---|
| `context_window` | `INTEGER` | Positive safe integer | Metadata only; never forwarded upstream |
| `default_temperature` | `REAL` | Finite number from 0 through 2 | Supplies `temperature` when omitted |
| `default_top_p` | `REAL` | Finite number from 0 through 1 | Supplies `top_p` when omitted |
| `default_presence_penalty` | `REAL` | Finite number from -2 through 2 | Supplies `presence_penalty` when omitted |
| `default_frequency_penalty` | `REAL` | Finite number from -2 through 2 | Supplies `frequency_penalty` when omitted |
| `default_seed` | `INTEGER` | Safe integer | Supplies `seed` when omitted |

All fields default to `NULL`. An existing or newly registered model with a null generation default leaves that parameter entirely to the client or provider.

The existing `model_config` text column remains unused. A generic JSON merge would create ambiguous precedence, allow reserved request fields to be overwritten, and persist unreviewed provider-specific values.

### Precedence

The effective precedence is:

1. Gateway-enforced security, routing, size, quota, and concurrency rules.
2. A client field that is present in the JSON request, including `0` or `null`.
3. The corresponding non-null model default.
4. The provider's own default.

Presence is checked with an own-property test, not truthiness or nullish coalescing. Explicit `temperature: 0`, `seed: 0`, and explicit null values are preserved and forwarded. LLMWard validates stored defaults, but it does not newly validate or normalize explicit client generation fields; the provider retains responsibility for unsupported client values.

`max_tokens` remains outside this default merge. It continues to be the maximum output-token setting and is clamped by the existing request, model, and remaining-quota calculation. The final gateway-controlled `model` routing and `max_tokens` values cannot be overridden by stored defaults.

## Database Migration

Increase `SCHEMA_VERSION` from 3 to 4 while leaving `CONTENT_FILTER_SCHEMA_VERSION` unchanged. Add the six nullable columns to the canonical `models` table definition, required-column manifest, and idempotent missing-column upgrade path.

Existing rows receive `NULL`; the migration must not infer model capabilities or generation preferences. The migration uses the existing atomic integrity-check flow and preserves all model, permission, pricing, provider, filter, usage, and audit data.

Application validation enforces value ranges. When `context_window` is non-null, the effective model row must also satisfy `max_tokens <= context_window`. A create or update that would violate the relationship returns HTTP 400 instead of silently changing either value. A partial update validates the proposed value together with the unchanged value already stored on the row.

Migration fixtures must cover an empty database, a v3 database with preserved data, a legacy or partial schema, repeated execution, an already-current v4 database, and refusal of a future v5 database.

## Admin Model API

`GET /admin/models` returns all six fields for every model, using numbers or `null`.

`POST /admin/models` accepts the fields as optional. Omission and explicit null both store `NULL`. Existing defaults for unrelated fields, including `max_tokens = 4096`, remain unchanged. If a supplied context window is smaller than the effective maximum output tokens, creation fails with HTTP 400.

`PUT /admin/models/:id` accepts each field independently. Omission leaves a stored value unchanged; explicit null clears it. The response includes the complete updated model, including all six fields. Validation occurs before the update, and the existing transactional model-rename permission update remains intact.

Audit records include only the names of changed fields through the existing allowlist mechanism. They never contain field values, credentials, prompts, or request content.

`GET /v1/models` adds `context_window` to each existing model result. It continues to expose the existing maximum-output field. The five generation defaults remain admin-only configuration and are not advertised through the public model listing.

## Chat Request Data Flow

The existing request lifecycle remains authoritative:

1. Authenticate the caller and resolve model access.
2. Load the registered model row, including the five generation defaults.
3. Apply existing input content filters without storing request content.
4. Create the upstream payload and fill each allowlisted generation field only if the filtered request has no own property for that field and the model default is non-null.
5. Reserve quota using the original requested `max_tokens`, the model maximum output tokens, and the remaining output quota.
6. Overwrite the upstream payload's `max_tokens` with the reservation result and preserve the existing validated model identifier and credential behavior. Stored defaults cannot alter either one.
7. Run the existing serialized payload-size check after filtering and default insertion, then dispatch through the registered provider URL.

The merge does not mutate `req.body`. Unknown and vendor-specific client fields continue to pass through unchanged. `context_window` is never inserted into the upstream request. Adding defaults must not introduce prompt or response logging.

## Dashboard Modal Design

### Structure

Remove the permanent inline create cards from the Users, Models, and Providers tabs. Each tab presents its existing table plus a clear create button. Use three native `<dialog>` elements, one create/edit dialog per resource, and one reusable confirmation dialog for destructive user/model/provider actions. No new UI dependency or modal framework is introduced.

Each resource dialog changes its title, submit label, initial values, and request method between create and edit modes. Opening records the trigger element; successful completion or cancellation returns focus to it. Dialog titles and descriptions are programmatically associated, Escape closes through native dialog behavior, and initial focus goes to the first actionable field. Clicking the backdrop does not discard an in-progress form.

During submission, the submit control is disabled to prevent duplicate requests. A failed request leaves the dialog open, preserves inputs, and displays the existing sanitized API error in an `aria-live` status region inside the dialog. A successful request refreshes the relevant table, closes the dialog, restores focus, and reports success through the dashboard's global status region.

### User dialog

Create mode contains the current username, daily input quota, daily output quota, and allowed-model controls. Edit mode identifies the username but edits only fields already supported by the current dashboard/API; it does not invent username renaming.

After successful creation, the dialog switches from the form to a one-time token result with a copy button and an explicit warning that the token cannot be retrieved again. The raw token is not written to storage or logs and is removed from the DOM when the result is closed. Token rotation reuses the shared confirmation and the same one-time-token result; token-management API semantics do not change.

The existing user DELETE endpoint is a soft deactivation. The UI labels it `Deactivate user`, names the target in the confirmation dialog, and does not imply data erasure. Reactivation remains a direct, non-destructive table action.

### Model dialog

Create and edit modes contain the current identifier, display name, provider, maximum output tokens, and pricing fields. The table label changes from ambiguous `Max tokens` to `Max output` and adds a `Context` column whose null display is `Not configured`.

The selected A layout places `Context window (tokens)` with the main model-capacity fields and puts the five generation defaults in a collapsed `<details>` section titled `Advanced generation defaults`. Blank advanced inputs map to null. Help text states that defaults apply only when the client omits the field and that the context value records, but does not reconfigure, the provider's effective limit.

`Discover models` remains a provider table action but reuses the model create dialog instead of browser prompts. The chosen provider is preselected and locked for that operation. The identifier input is prefilled with the first result and associated with the discovered list; discovery-mode validation accepts only an identifier returned by that discovery call. If no unregistered model is found, the dashboard reports that result without opening the dialog. Normal server-side model validation and submission remain unchanged.

Model deactivation uses the shared confirmation dialog; activation remains direct. Hard deletion names the target and calls the existing DELETE endpoint. If any user permission references the model, the server continues to reject deletion. The UI does not automatically detach permissions or cascade user changes.

### Provider dialog

Create and edit modes replace the current inline form and prompt sequence. Create mode preserves the preset, identifier, display name, registered Base URL, authentication type, credential environment-variable name, and optional stored credential controls. Edit mode preserves the current dashboard's identifier, display name, Base URL, authentication type, and stored-credential replacement scope; it does not add environment-variable-name editing.

A stored credential is never returned or prefilled. In edit mode, an empty password input means `leave the stored credential unchanged` and is omitted from the request. An explicit `Remove saved credential` control sends the existing clear representation. Entering a replacement and requesting removal are mutually exclusive in the UI. The credential is never placed in status text, audit values, logs, or reusable client storage.

Provider deactivation uses the shared confirmation dialog; activation remains direct. Hard deletion keeps the existing server guard: a provider with attached models cannot be deleted. The dialog remains open and shows that error; the UI does not detach or delete models automatically.

### Scope of browser-dialog removal

User, model, and provider create, edit, discovery registration, deactivation, deletion, and token-rotation flows no longer use `window.prompt()` or `window.confirm()`. Filter-management dialogs and other unrelated dashboard flows are outside this change.

All dynamic labels and values continue to use safe DOM construction and `textContent`; no administrator-controlled value is interpolated as executable HTML.

## Error Handling

- Invalid model-default values or an invalid context/output relationship return HTTP 400 using the existing API error shape.
- Missing users, models, and providers retain HTTP 404 behavior.
- Model-assignment and provider-attachment delete guards retain HTTP 400 behavior.
- Dialog errors remain local to the active operation and do not clear user input.
- A list refresh failure after a successful mutation is reported without repeating the mutation.
- No modal introduces optimistic deletion or client-side cascading.

## Tests

Use the existing Node test runner, fake dashboard DOM harness, local mock providers, temporary directories, and temporary SQLite databases.

### Migration and model API

1. Schema v4 creation and all required migration fixtures described above.
2. Existing row preservation with all six new fields null.
3. Admin create, read, update, partial update, and explicit-null clearing for every field.
4. Boundary acceptance and rejection for context, temperature, top-p, penalties, and seed.
5. Create and partial-update rejection when effective `max_tokens` exceeds `context_window`.
6. Audit changed-field names without values.
7. Public model listing includes context metadata but omits generation defaults.

### Runtime

1. Each omitted generation field receives its configured model default.
2. Explicit client values, including zero and null, win over defaults.
3. A null model default leaves the request field absent.
4. `context_window` is never forwarded upstream.
5. Gateway routing and quota-clamped `max_tokens` remain authoritative.
6. Unknown and vendor-extension field values and structures remain unchanged after JSON parsing and serialization.
7. The post-merge payload-size limit still fails closed.
8. Streaming and non-streaming requests follow identical default precedence.
9. No request or response content is added to persistence or logs.

### Dashboard

1. Static markup contains labelled native dialogs, descriptions, numeric constraints, help associations, and local status regions.
2. Create buttons open empty resource forms; edit buttons populate the supported fields.
3. A successful user creation displays and then clears the one-time token safely.
4. Model forms serialize blanks as null and preserve numeric zero where valid.
5. The advanced model section and context warning are present, and the table uses `Max output` and `Context` labels.
6. Provider edit omits an empty credential, replaces a supplied credential, and clears only through the explicit removal control.
7. Destructive confirmations identify the target and use the correct deactivate or delete endpoint.
8. Server-side delete-guard failures keep the dialog and its error visible.
9. Pending submissions cannot be duplicated; success refreshes data; cancellation and success restore focus.
10. User/model/provider flows contain no browser prompts or confirms and continue to render untrusted values safely.

Run focused migration, admin API, gateway, and dashboard tests first, followed by `npm.cmd test`. Run `npm.cmd run doctor` and `npm.cmd run backup` because the schema changes. Run the relevant startup health check to verify that a migrated database opens normally.

## Documentation

- Update the administrator UI/API documentation with the new model fields, ranges, null-clearing behavior, and precedence.
- Rename user-facing `Max tokens` descriptions to `Maximum output tokens` where they describe the existing cap.
- Explain that Chat Completions remains stateless and clients must resend conversation history.
- Explain that `context_window` is informational metadata and provider runtime configuration remains an operator responsibility.
- Keep compatibility documentation explicit that verified unknown request fields pass through but stored arbitrary request-default JSON is unsupported.

## Acceptance Criteria

- Administrators can create or edit a model with a declared context window and any subset of the five typed defaults, and can clear each default.
- A client omission receives the configured default while any present client value is preserved.
- Output quota enforcement and model routing behave exactly as before.
- Neither context metadata nor any unapproved stored option is sent upstream.
- User, model, and provider registration and editing use accessible forms in native modals.
- Destructive actions clearly distinguish user deactivation from model/provider deletion and retain all current server guards.
- User tokens and provider credentials remain protected and are never persisted in browser storage or exposed through list APIs.
- The gateway remains stateless and never stores prompts, message arrays, or generated content.
- All focused and full regression tests pass on an atomically migrated v4 database.
