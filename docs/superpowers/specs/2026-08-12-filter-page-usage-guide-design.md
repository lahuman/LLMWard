# Filter page usage guide design

## Goal

Make the Filters tab understandable without requiring administrators to read the API documentation. The page should explain the safe creation flow, action meanings, scope, activation, and one fictional masking example before the form.

## Scope

Add one always-visible, static guide card above the existing Create filter card. Reuse the current HTML and CSS patterns. Do not add JavaScript, sample-loading controls, new API behavior, dependencies, or changes to filter execution.

## Content

The guide card contains:

1. A three-step ordered flow:
   1. Enter one case-insensitive literal pattern per line.
   2. Select an input action and, when needed, output masking.
   3. Select global or model scope, review the rule, and then activate it.
2. Action definitions:
   - `Block`: reject matching input with HTTP 400.
   - `Mask`: replace matching text with `[FILTERED]`.
   - `None`: do not filter that direction.
3. A fictional example that is safe to copy:
   - Pattern: `employee@example.test`
   - Before: `Contact employee@example.test`
   - After: `Contact [FILTERED]`
4. Operational cautions:
   - Patterns are literal substrings, not regular expressions.
   - Patterns are stored in plaintext in SQLite and backups.
   - New filters are inactive by default.
   - Global scope ignores model selection.

The example must not use a real secret, prompt, response, domain, or personal identifier.

## Accessibility and safety

- Use a semantic section with an accessible heading, an ordered list for the workflow, and text elements for definitions and examples.
- Keep sufficient contrast through the existing dashboard palette.
- Do not render dynamic pattern values or introduce HTML string sinks.
- Keep the existing plaintext-storage warning beside the pattern field.

## Verification

Extend the existing static dashboard regression test to require the guide heading, ordered workflow, action definitions, fictional example, and plaintext warning. Keep the existing safe-DOM checks. Run the focused admin-filter test first, then the complete test suite.

## Non-goals

- Interactive tutorials, popovers, modals, or collapsible help
- Automatically filling or saving sample rules
- Changing filter defaults, validation, APIs, or runtime behavior
