# Filter Page Usage Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible guide above the Filters form so administrators can understand literal matching, actions, scope, activation, and a safe masking example without leaving the page.

**Architecture:** Keep the change static and local to the existing admin dashboard. Add semantic HTML to the Filters tab, a small CSS treatment using the current palette, and extend the existing safe-DOM regression test; do not add JavaScript or change filter APIs/runtime behavior.

**Tech Stack:** Static HTML, CSS, Node.js built-in test runner, existing CommonJS test suite

## Global Constraints

- Reuse the existing dashboard card and typography patterns.
- Add no JavaScript, dependency, API, validation, database, or runtime-filter changes.
- Use only fictional `.test` example data and keep the existing plaintext-storage warning.
- Preserve safe DOM rendering, CSP compatibility, and accessible semantic structure.

---

### Task 1: Add the always-visible Filters usage guide

**Files:**
- Modify: `test/admin-filters.test.js:215`
- Modify: `public/admin-dashboard.html:34`
- Modify: `public/admin-dashboard.css:1`

**Interfaces:**
- Consumes: the existing `#tab-filters` tab panel and `.card`, `.help` dashboard styles
- Produces: static `#filter-usage-guide` content referenced only by the dashboard and its regression test

- [ ] **Step 1: Write the failing static UI test**

Add these assertions to `dashboard exposes an accessible safe-DOM filter editor without rendering pattern values in the list` immediately after the `id="tab-filters"` assertion:

```js
  assert.match(html, /<section[^>]+id="filter-usage-guide"[^>]+aria-labelledby="filter-guide-title"/);
  assert.match(html, /<h2[^>]+id="filter-guide-title"[^>]*>How filters work<\/h2>/);
  assert.match(html, /<ol[^>]+class="filter-steps"/);
  assert.match(html, /Block[^<]*<\/strong> rejects matching input with HTTP 400/);
  assert.match(html, /Mask[^<]*<\/strong> replaces matching text with <code>\[FILTERED\]<\/code>/);
  assert.match(html, /employee@example\.test/);
  assert.match(html, /Contact <code>\[FILTERED\]<\/code>/);
  assert.match(html, /literal substrings, not regular expressions/);
  assert.match(html, /New filters are inactive by default/);
  assert.match(html, /Global scope ignores model selection/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test --test-name-pattern="dashboard exposes" test/admin-filters.test.js
```

Expected: FAIL because `#filter-usage-guide` and its content do not exist.

- [ ] **Step 3: Add the semantic guide card**

Insert this card as the first child of `#tab-filters`, before the Create filter card:

```html
<section id="filter-usage-guide" class="card filter-guide" aria-labelledby="filter-guide-title">
  <h2 id="filter-guide-title">How filters work</h2>
  <ol class="filter-steps">
    <li>Enter one case-insensitive literal pattern per line.</li>
    <li>Choose an input action and, when needed, output masking.</li>
    <li>Select global or model scope, review the rule, and then activate it.</li>
  </ol>
  <div class="filter-guide-grid">
    <div>
      <h3>Actions</h3>
      <p><strong>Block</strong> rejects matching input with HTTP 400.</p>
      <p><strong>Mask</strong> replaces matching text with <code>[FILTERED]</code>.</p>
      <p><strong>None</strong> leaves that direction unchanged.</p>
    </div>
    <div>
      <h3>Masking example</h3>
      <p>Pattern: <code>employee@example.test</code></p>
      <p>Before: <code>Contact employee@example.test</code></p>
      <p>After: Contact <code>[FILTERED]</code></p>
    </div>
  </div>
  <p class="help">Patterns are literal substrings, not regular expressions. They are stored in plaintext in SQLite and backups. New filters are inactive by default. Global scope ignores model selection.</p>
</section>
```

Append these styles to `public/admin-dashboard.css`:

```css
.filter-guide{background:#f8faff}.filter-guide h3{margin:.1rem 0 .5rem;font-size:.95rem}.filter-guide p{margin:.35rem 0}.filter-steps{margin:0 0 1rem;padding-left:1.35rem}.filter-guide-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;margin-bottom:.8rem}.filter-guide code{background:#e8eefc;border-radius:4px;padding:.1rem .3rem}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
node --test --test-name-pattern="dashboard exposes" test/admin-filters.test.js
```

Expected: PASS with the existing unsafe-sink checks still green.

- [ ] **Step 5: Run the full regression suite**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Check the diff and commit**

Run:

```powershell
git diff --check
git status --short
git add -- public/admin-dashboard.html public/admin-dashboard.css test/admin-filters.test.js docs/superpowers/plans/2026-08-12-filter-page-usage-guide.md
git commit -m "feat: add filter usage guide"
```
