# Signal Grid Admin Redesign Design

**Date:** 2026-08-14
**Status:** Approved
**Selected concept:** B — Signal Grid

## Goal

Redesign the existing LLMWard administrator dashboard as a compact dark operations console that makes the Gateway path immediately understandable:

`users, tokens, and quotas → filters → registered model routes → approved providers`

The redesign must improve visual hierarchy, navigation, state recognition, responsive behavior, and accessibility without changing LLMWard's single-process product boundary or adding a frontend framework.

## Scope

- Restyle the login, application shell, navigation, resource tables, forms, dialogs, status messages, filter guidance, usage summaries, onboarding, and empty/error states.
- Replace the top button row with a labelled Signal Grid navigation rail on desktop and a labelled horizontal navigation bar on narrow screens.
- Add an Overview section that composes data already returned by the existing admin list and statistics APIs.
- Keep Users, Models, Providers, Filters, and Usage as separate administration sections with their current operations and response shapes.
- Keep the current English interface copy. Localization is outside this change.
- Use only the existing static HTML, CSS, vanilla JavaScript, native browser elements, existing dependencies, and existing admin APIs.
- Remove the current `sessionStorage` administrator-key retention. Keep the raw key only in JavaScript memory until sign-out, an authentication failure, or page unload; a reload requires sign-in again.

## Non-goals

- No new backend endpoint, database column, migration, dependency, build step, icon library, external font, or remote asset.
- No real-time event stream, polling loop, telemetry, live log viewer, prompt history, response preview, or request-body inspection.
- No new `Inspect request` action. Recent activity remains metadata-only.
- No bulk `Test all providers` action. Connection testing remains the existing per-provider operation.
- No distributed-node status, fallback or load balancing, billing, credit sales, SSO, provider SDK behavior, or plugin framework.
- No change to server-side authentication, authorization, quota, filtering, routing, credential, migration, retention, backup, or audit semantics. The browser-key retention hardening above is the only authentication-client behavior change.
- No removal or shortening of warnings about one-time tokens, credentials, plaintext filter patterns, filter scope, estimated cost, or the limits of the built-in PII filter.

## Visual Direction

Signal Grid uses an operations-console tone without imitating a terminal at the expense of readability.

### Color tokens

| Token | Value | Use |
|---|---|---|
| `--surface-root` | `#080b0f` | browser and navigation background |
| `--surface-page` | `#0e1319` | page background |
| `--surface-panel` | `#111821` | cards, tables, form fields, dialogs |
| `--border` | `#596777` | structural borders and separators with 3:1 non-text contrast |
| `--text` | `#e7ecf2` | primary text |
| `--text-muted` | `#96a2b1` | secondary text with AA contrast at normal sizes |
| `--accent` | `#ffb454` | current navigation, primary actions, focus indication |
| `--on-accent` | `#241406` | text and icons on an accent background |
| `--success` | `#58d597` | healthy and successful states |
| `--danger` | `#f17c74` | failures and destructive actions |
| `--on-danger` | `#210b0a` | text and icons on a danger background |
| `--info` | `#78a9ff` | neutral informational state when needed |

State is never communicated by color alone. Every state includes a text label such as `Healthy`, `Active`, `Inactive`, `Failed`, or `No models assigned`.

Normal text must meet WCAG AA contrast of at least 4.5:1. Focus indicators and other non-text UI boundaries must meet at least 3:1 against adjacent colors.

### Typography and density

- Use the system UI stack for body copy, forms, help text, and tables.
- Use `ui-monospace`, `SFMono-Regular`, `Consolas`, or the platform fallback for metrics, short operational labels, identifiers, and status values.
- Do not fetch or bundle a font.
- Use an 8 px spacing rhythm, compact panels, and low-radius 4–6 px controls.
- Keep production body text at least 14 px and interactive targets at least 36 px high. The small type in the concept board is illustrative, not an implementation size.
- Avoid glow effects and decorative animation. Short hover and panel transitions must honor `prefers-reduced-motion`.

## Information Architecture

### Authentication and onboarding

Before authentication, show only the LLMWard Gateway identity, the administrator-key form, and authentication feedback in a centered dark panel. Do not expose provider health, resource counts, usage, or other administrator data before a successful sign-in.

After authentication, preserve the existing first-time setup steps and API example. Render incomplete onboarding as a prominent Overview callout above operational metrics; hide it when the existing onboarding response reports completion. The redesign changes presentation only and does not change setup order or completion rules.

### Desktop shell

At widths of 840 px and above, the dashboard uses a two-column shell:

1. A 176 px navigation rail containing the LLMWard mark, labelled section buttons, resource counts where useful, and the sign-out action.
2. A flexible content region containing the section heading, contextual status, global live region, and active page.

Navigation order is:

1. Overview
2. Users
3. Models
4. Providers
5. Filters
6. Usage

The rail always displays text labels. Single-letter marks may accompany labels but never replace them on desktop.

### Narrow screens

Below 840 px, the shell becomes a single column. The brand and sign-out action form a compact top row, followed by a horizontally scrollable labelled navigation row. This avoids a new drawer component and extra menu state. Tables keep semantic table markup inside horizontal scroll containers. Dialogs remain within the viewport and scroll internally.

### Navigation semantics

The section controls remain native buttons inside a labelled `nav`. Every control uses `aria-controls`; only the active control uses `aria-current="page"`, and inactive controls do not expose invalid `aria-selected` state. Every content section uses `aria-labelledby` to reference its navigation control. Keyboard users can reach every section through normal Tab navigation without custom arrow-key behavior.

## Overview Section

Overview becomes the initial authenticated section. It is a read-only summary, not a new management subsystem.

### Resource path

Four native button nodes show currently usable or effective resource counts from the existing list responses:

1. **Users:** `is_active` users whose permissions are valid. The node's secondary label is `tokens and quotas`.
2. **Policies:** the active built-in filter when enabled, active global custom filters, and active model-scoped custom filters assigned to at least one currently available model.
3. **Models:** active models whose registered provider is also active.
4. **Providers:** active registered providers. Health is displayed separately and does not change this count.

An active model-scoped filter without an available assigned model is excluded from the effective policy count and remains explicitly labelled on the Filters page. These calculations use only the existing list responses.

The nodes render in Gateway order and use labelled arrows. Every node is a native `button` with `aria-controls` pointing to its corresponding section. Activating a node opens that existing section; it does not create a new API call or edit flow.

### Operational summary

Use `GET /admin/stats?range=7d` for the existing seven-day summary:

- total requests
- success rate
- p95 response time
- estimated cost, explicitly labelled as an estimate and not billing

When `total_requests` is zero, success rate and p95 display `No requests` instead of a misleading percentage or `0 ms`. Otherwise, success rate is `successful_requests / total_requests × 100`, formatted to one decimal place. Estimated cost uses the existing `cost_configured` flag: false displays `Not configured`; true displays the formatted USD value, including a legitimate zero.

Overview uses a fixed seven-day window. Custom date controls remain in Usage.

### Provider and activity snapshot

- Show the latest stored health state for each provider from the existing provider list. Testing remains a per-row action on the Providers page.
- Show at most five recent requests from the existing statistics response using only time, user, model, status/error type, token counts, and latency.
- Show the existing empty state when there are no recent requests.
- Never show prompts, message arrays, generated content, provider error bodies, credentials, raw tokens, or administrator keys.
- The compact activity strip is a snapshot of existing metadata. It must not be labelled or implemented as a live log.

## Existing Sections

### Users

- Preserve the current table columns, create/edit dialog, activation state, token rotation, quota fields, model access display, and one-time token result.
- Give the one-time token result a high-contrast warning panel. Continue clearing the raw token from the DOM when the result closes.
- Destructive styling applies to deactivation and token rotation confirmation without implying data deletion.

### Models

- Preserve model discovery, create/edit dialog, advanced generation defaults, active state, deletion guard, prices, maximum output, and context metadata.
- Keep provider and model concepts visually separate. A model row identifies its registered provider but never implies fallback routing.

### Providers

- Preserve create/edit, per-provider connection test, model discovery, activation, credential replacement/removal, and deletion guard.
- A health badge always contains the text status and, when available, latency and last-check time.
- Never prefill or display a stored credential.

### Filters

- Preserve all current safety and scope explanations, the built-in Korean PII and secret filter, the literal filter form, model selection, activation behavior, and plaintext-storage warnings.
- Use bordered operational callouts and compact numbered steps, but do not hide safety text behind hover-only UI or remove it for visual density.
- Distinguish `Active globally`, `Active for N models`, `Inactive`, and `Active but no models assigned` with explicit text.

### Usage

- Preserve the current date controls, summary metrics, per-user/model/provider tables, recent-request table, and estimated-cost wording.
- Use the same numeric metric treatment as Overview. Precise tables remain authoritative; no chart library is added.
- Keep recent requests metadata-only and capped by the existing API behavior.

## Components and States

### Panels and tables

- Panels use a dark surface, one-pixel border, square operational hierarchy, and a textual heading.
- Tables keep native `table`, `thead`, `tbody`, and `th` markup. Add a descriptive caption, visually hidden when repetition would be distracting, and `scope="col"` to column headers.
- A horizontally scrollable table wrapper is keyboard-focusable with `tabindex="0"`, has an accessible name derived from the table caption, and receives the same visible focus treatment as other interactive regions.
- Row actions use text buttons. Primary, secondary, and destructive actions remain visually distinct and use both color and labels.

### Forms and dialogs

- Keep the existing native `<dialog>` elements and focus placement/restoration behavior.
- Inputs retain persistent labels, associated help text, browser validation, and clear disabled/pending styles.
- Dialog-local errors remain in the existing polite live regions and do not clear entered values.
- Primary submit controls use amber with `--on-accent` text. Destructive confirmation uses red with `--on-danger` text and names the target action.

### Feedback

- The existing global `role="status"` live region remains available for load, success, and failure messages.
- Loading state uses text plus a subtle indicator; it never relies on animation alone.
- Empty and error states occupy the affected panel instead of collapsing the layout. Partial loading is introduced only for Overview statistics; configuration lists keep the existing all-or-error behavior.
- Every interactive element receives a visible two-pixel amber `:focus-visible` outline with offset.

## Data Flow

1. The administrator submits a key, which is held only in the page's JavaScript state.
2. Verify the key through the existing authenticated request. Do not write it to `sessionStorage`, `localStorage`, cookies, URLs, logs, or the DOM outside the password input while it is being entered.
3. After successful verification, show the dashboard and start the existing configuration load plus one `GET /admin/stats?range=7d` request.
4. Render resource counts and the Gateway path when configuration succeeds.
5. Use the single initial seven-day statistics response to render both Overview and the initial Usage view. Do not issue a duplicate Usage request on first entry.
6. A Usage `Apply` action fetches its selected range and updates Usage only. It does not replace Overview's fixed seven-day snapshot.
7. If the initial statistics request fails for a non-authentication reason, keep successfully loaded configuration and navigation usable, render an inline statistics error in Overview and Usage, and retain no failed payload.
8. Navigating back to Overview, or activating Overview while its statistics error is visible, performs one guarded seven-day retry. A successful retry updates Overview and the initial seven-day Usage view only if Usage has not since applied another range.
9. Any `401` or `403` from configuration, Overview, Usage, or a mutation clears the in-memory key and returns to the login screen through the existing fail-closed path. Authentication errors are never localized as a recoverable Overview error.
10. Resource mutations continue through the existing API methods. Flows that already have pending-operation guards retain them; this redesign does not claim that every existing filter action is guarded.

There is no browser key persistence, background polling, optimistic deletion, or new request cache.

## Security and Privacy

- Continue safe DOM construction with `textContent`, `createTextNode`, and existing node helpers. Do not introduce administrator-controlled `innerHTML`.
- Do not place the administrator key, raw user tokens, provider credentials, filter patterns, prompts, responses, or provider error bodies in metrics, activity strips, DOM data attributes, logs, URLs, cookies, or browser storage.
- Keep registered Base URL validation, credential isolation, authorization, quota enforcement, fail-closed filtering, and destructive confirmations unchanged.
- Use same-origin CSS and markup only. The existing Content Security Policy does not need to be relaxed.

## Error Handling

- Any `401` or `403` remains an authentication failure: clear the in-memory administrator key, hide administrator data, and return to login.
- A non-authentication Overview statistics failure is local to the statistics-dependent panels and does not discard successfully loaded resource data.
- Existing configuration list loading keeps its current all-or-error behavior; the redesign does not independently recover each list request.
- Dialog submission failures keep the dialog open, preserve inputs, and restore enabled controls.
- A successful mutation followed by a refresh failure reports the refresh failure without repeating the mutation.
- Provider health, inactive resources, ineffective model-scoped filters, empty statistics, and unavailable cost configuration receive explicit non-misleading labels.

## Implementation Footprint

The intended production change is limited to:

- `public/admin-dashboard.html`
- `public/admin-dashboard.css`
- `public/admin-dashboard.js`
- focused dashboard regression tests under `test/`

No backend, schema, package, Docker, or deployment change is expected.

## Verification

### Automated

- Extend static dashboard tests for the Overview structure, labelled navigation, `aria-controls`/`aria-current`/`aria-labelledby` associations, onboarding placement, table captions/scopes, focus styling hooks, and preserved security warnings.
- Extend the fake-DOM dashboard tests for the four count formulas, native node-button navigation, one initial seven-day statistics request, zero-request and unconfigured-cost displays, non-authentication statistics failure, guarded retry, and no duplicate initial Usage request.
- Replace the stored-key restoration expectation with tests that the raw administrator key is never written to browser storage and that a reload starts at login.
- Preserve tests for modal focus restoration, resource-dialog and confirmation duplicate-submit protection, token clearing, provider credential handling, safe DOM construction, and destructive confirmations.
- Test that `401` and `403` from Overview or Usage clear the key and return to login rather than rendering a local error.
- Run focused dashboard tests, then `npm.cmd test`.

### Manual visual and accessibility checks

- Check the authenticated dashboard at approximately 1440, 1024, 768, and 390 CSS pixels.
- At each width, verify there is no page-level horizontal overflow; horizontal scrolling is confined to labelled table wrappers and the narrow-screen navigation row.
- Navigate login, all six sections, four Gateway node buttons, resource actions, dialogs, and confirmation flows with keyboard only.
- Confirm focus visibility, the 4.5:1 text and 3:1 non-text contrast thresholds, text-labelled states, keyboard table scrolling, dialog viewport containment, reduced-motion behavior, and 200% zoom usability.
- Confirm the Overview and Usage pages never render prompt or response content.
- Confirm no external network or asset request occurs and page reload requires administrator sign-in.

## Acceptance Criteria

- Login shows no administrator data before successful authentication, the raw administrator key is absent from browser storage, and reload returns to login.
- Desktop shows six labelled rail controls; narrow screens show the same six labels in a horizontal navigation row. Every control and corresponding section has the specified accessible association, and only the active control has `aria-current="page"`.
- Overview renders four native resource buttons in Gateway order, each button opens the correct existing section, and each count follows the documented formula.
- Overview renders `No requests` and `Not configured` exactly for the documented empty conditions and never implies billing or live telemetry.
- Users, Models, Providers, Filters, Usage, onboarding, dialogs, and feedback states use the defined surfaces, typography roles, labelled statuses, focus treatment, and action colors without removing existing controls or warnings.
- At 1440, 1024, 768, and 390 CSS pixels there is no page-level horizontal overflow; only named navigation and table regions may scroll horizontally.
- Every existing administrator operation retains its current API behavior and safety boundary, and `401`/`403` remains fail-closed across all sections.
- No new dependency, external asset, backend endpoint, database change, live telemetry, prompt storage, or unsupported product capability is introduced.
- Focused dashboard regressions and the full test suite pass.
