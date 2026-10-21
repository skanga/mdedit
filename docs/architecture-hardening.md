# Architecture hardening work log

## Scope and constraints

Preserve self-contained full/lite builds, native undo history, document formats, conflict checks, and recovery ordering. No frontend framework or dependencies were added. Changes are local; no commit, push, or release was requested for this pass.

## Ordered work completed

1. **Blocking execution:** document read/save/canonicalization and recovery IPC wrappers now dispatch to native blocking tasks. Recovery-store clones share their operation lock. Regex searches run in disposable blob workers with a 500 ms deadline, cancellation, stale-result guards, cached results, and fail-closed behavior if workers are unavailable. Literal/regex search allocation is bounded at 10,000 matches; limit errors never expose partial replacements.
2. **Build/test alignment:** CI validates pushes to main as well as PRs/tags. Browser/performance npm commands rebuild inputs first. `bash ./build.sh --check` verifies both generated HTML files and PWA sidecars without writing them. A negative check confirmed that stale output is rejected.
3. **State ownership and module boundaries:** Find state, matching coordination, replacement, and keyboard handling moved into `src/find-controller.js`, with worker lifecycle in `src/search-runner.js`. The bootstrap no longer assigns dirty flags directly or maintains a second browser-handle map. The controller owns writable-handle lookup, rebinding/close cleanup, and rename detachment. View rendering/reload hooks are supplied at construction instead of patched afterward. This is a bounded extraction, not a wholesale controller/export rewrite.
4. **Desktop CSP:** scripts require self/bundled hashes, blob workers are allowed, and objects/frames/forms/base overrides are blocked. Chromium enforcement tests cover both builds, math/diagrams, workers, PNG export, and injected-script rejection. See [security.md](security.md) for the explicit privileged-frontend trust model and remaining filesystem authorization limits.
5. **Coverage:** added worker lifecycle tests, ownership tests, pathological-regex and excessive-match regressions, enforced-CSP browser tests, and separate typing-handler/mixed-preview performance cases. Linux CI now installs tauri-driver/WebKitWebDriver and smoke-tests the actual release executable/WebView using a Python standard-library client.

## Phase 1 local verification

- 367 Node tests passed, excluding the Cargo-dependent metadata check because Cargo is not installed.
- 99 browser tests passed using an existing Chromium executable through an external temporary config.
- The two new responsiveness cases passed. Five-MiB typing-handler p95 was 2 ms (50 ms application-handler budget); complete frame latency remained roughly 278–687 ms. Ten mixed Markdown/math/diagram sections completed in about 992 ms (10-second preview budget).
- Both frontend builds and all PWA sidecars passed `build.sh --check`; a deliberately stale in-memory build failed as expected.
- Python smoke client syntax and CLI help were checked; the actual native client was not executed locally.
- `git diff --check` passed.

## Phase 2: service boundaries and a bounded performance fix

Goal: move browser recovery storage and captured-export coordination out of SessionController without changing public exports, storage keys/formats, fallback behavior, receiver binding, cancellation, or stale-capture handling. Four additional characterization tests pass before extraction. Existing recovery/export tests and the full browser suite are the behavior baseline.

After extraction, profile avoidable application work in the large-session path and add a failing regression before any optimization. Do not change editor engines, undo semantics, or the existing 100 ms activation benchmark. Per-file native grant tokens remain a separate cross-platform design milestone.

Completed:

- Extracted `src/browser-recovery.js`; SessionController re-exports the original adapter API for compatibility. Current/previous rotation, key prefixes, schema validation, failure propagation, and in-memory fallback remain unchanged.
- Extracted captured-export preparation and outcome coordination into `src/export-service.js`. The controller retains document ownership/capture policy and delegates flow through explicit guard/status callbacks. Receiver binding, frozen captures, stale completion, cancellation, and error behavior have characterization and service-level tests.
- Removed avoidable textarea-value materialization from empty Find refreshes and workspace restoration. Selection clamping prefers native `textLength` (including normalized CRLF lengths), while managed editors use their existing content mirror as fallback. Regression tests failed before the optimization and pass afterward; the browser activation test observes zero value reads in the measured path.
- The browser suite exposed dropped rapid Enter requests while regex matching was pending. A deterministic delayed-worker test reproduced it. Replacement requests now serialize, retain replacement-field focus across asynchronous recomputation, and invalidate queued actions when query/replacement/options or workspace context changes.

Phase 2 verification:

- 380 Node tests passed (`node --test --test-skip-pattern="Cargo metadata identifies"`); Cargo metadata remains excluded because Cargo is unavailable locally.
- 102 functional/security browser tests passed, plus 15 repeated replacement concurrency checks and all three responsiveness cases. Local Playwright runs use the installed Chromium through the external temporary config.
- Both full/lite outputs and PWA sidecars pass `bash ./build.sh --check`; `git diff --check` passes.
- The unchanged 250 MiB benchmark still fails its 100 ms p95 budget locally. The observed phase 2 run measured p50 17 ms/p95 615 ms; no threshold was relaxed or skipped. See remaining limits below.
- No native code changed during phase 2. Native compilation, WebView smoke verification, and per-file authorization remain pending/separate work.

## Phase 3: off-thread Markdown preparation

Goal: move Marked parsing, footnote expansion, and math placeholder extraction into a cancellable worker using the existing vendored Marked source. Preserve self-contained full/lite files, sanitized DOM insertion, preview scroll, document/revision guards, and isolated exports. Keep DOMPurify, KaTeX DOM rendering, syntax highlighting, and Mermaid on the main thread for this bounded milestone; do not claim all rendering is off-thread.

Verification: a regression must show preview/export still work when main-thread `marked.parse` is forbidden. Characterize GFM/footnotes/math output, then test worker cancellation/errors/timeouts, delayed parse/scroll behavior, export independence, and both builds under CSP. No dependency installation, native permission changes, benchmark relaxation, or commits/releases are part of this phase.

Completed:

- Added `src/markdown-parser.js`: a self-contained engine for GFM, footnotes, and math preparation plus a warm, cancellable worker client. It reuses the trusted vendored Marked script already embedded in each build, without duplicate vendoring, runtime fetches, a module loader, or `eval`.
- Preview supersession terminates obsolete work. Worker errors/timeouts release resources and never fall back to main-thread parsing. A canceled page can resume parsing after BFCache restoration; isolated exports have independent workers disposed in `finally`.
- Kept DOMPurify on the UI thread before insertion. Preview ownership changes at actual DOM commit, scroll is sampled at that moment, and switching to Edit while a worker is pending skips hidden DOM work. PDF's explicit render-while-hidden path remains supported.
- Removed the old bootstrap footnote/math parser and obsolete shared render-promise state. Full/lite builds remain self-contained; CSP checks include the new worker path.
- Clarified performance-memory labels: page heap excludes worker isolates/native allocations and cannot substantiate a total-memory reduction claim.

Phase 3 verification:

- The initial full/lite tests failed when main-thread parsing was forbidden; both pass after integration. A delayed-worker test also failed for hidden Edit-mode commits before the commit guard was added.
- 389 Node tests passed with the Cargo metadata check excluded; 110 functional/security browser tests and all four responsiveness cases passed using the installed Chromium/external temporary config.
- The 5 MiB worker-render case reached complete preview text in an observed 956 ms (15-second case budget aligned with the existing benchmark's preview timeout). It is not an isolated parser-time measurement or a whole-application latency guarantee.
- Worker tests cover actual execution of the bundled parser in a module-loader-free context, reuse, cancellation, stale errors, timeout, malformed results, error recovery, and disposal. Browser tests cover output semantics, sanitization, stale edits, in-flight scrolling, hidden-mode commits, independent exports, and unavailable workers.
- Both generated HTML files/PWA sidecars pass `build.sh --check`; `git diff --check` passes. No native code or permission policy changed in this phase. The known 250 MiB activation benchmark was not rerun or relaxed in phase 3.

## Phase 4: recovery snapshot encoding

Goal: offload large snapshot JSON encoding while preserving captured revisions, snapshot-before-manifest ordering, failure/retry behavior, disposal, and quit durability. Inject the encoder into SessionController so the core can be tested independently; retain a synchronous default for non-browser hosts and small snapshots. The production worker must not fall back to main-thread encoding for large inputs when unavailable.

Capture model snapshots and establish transaction barriers synchronously before awaiting encoding. Use a single worker and bounded dispatch, propagate encoding failures through recovery's existing sticky failure/retry path, and prevent writes after controller disposal. Keep the persisted schema/key formats and existing manifest transaction rules unchanged.

Scope limits: manifest encoding remains synchronous; browser storage validation/localStorage operations and Tauri's IPC payload construction are not moved off-thread by this phase. Encoding latency diagnostics distinguish asynchronous startup/queue/transfer latency from worker CPU time.

Completed:

- Added injected snapshot encoding to SessionController, retaining synchronous JSON encoding for non-browser hosts. Captured DTOs, revisions and transaction barriers survive asynchronous encoding; snapshot writes and acknowledgements precede manifest publication. New edits during encoding are persisted by the existing catch-up path, and restore-on-quit waits for the latest checkpoint rather than treating pending encoding as durable.
- Added `src/snapshot-serializer.js`: production snapshots whose estimated string fields total at least 256 Ki UTF-16 code units use one reusable worker, with only one payload dispatched at a time. Small snapshots remain synchronous. Startup/errors/timeouts/malformed responses reject queued work, permit explicit retry, and never silently encode large inputs on the UI thread.
- A worker readiness handshake completes before bulk restoration. Large-session validation exposed cold-start timeouts amid expensive native layout; merely yielding a task at the watchdog deadline did not fix cold startup. Prewarming before restoration fixed that failure. Startup and active-job watchdogs each retain a 10-second deadline, with a task-turn grace for already-queued replies. One instrumented replay showed a 5 MiB worker handler finishing in 12 ms while main-thread message delivery lagged roughly 14 seconds; that is host-delay evidence, not a general encoding-performance guarantee.
- Added a visible **Retry recovery** status-bar action, including retry-after-failure and keyboard-focus checks. Recovery risk remains sticky until retry succeeds. Disposal rejects pending preparation/encoding and ignores late scheduler status notifications; lifecycle guards prevent new post-encoding writes/publication after disposal.
- Added held-encoding, revision-ordering, failure/retry, quit, readiness, disposal, worker-format and metric-label tests. Browser cases cover automatic recovery in both builds, prohibit large main-thread snapshot encoding, and exercise workers under CSP. The Linux desktop smoke client now checks a large encoded recovery snapshot, but native execution remains pending CI.
- Full-suite validation exposed a cached-preview click race: detached local Markdown anchors could bypass delegated cancellation and navigate out of the app. Direct default-navigation guards now survive detachment; a deterministic regression and repeated existing link flows cover it.

Phase 4 verification:

- 415 Node tests passed with the Cargo metadata check excluded; 115 functional/security browser tests and all five responsiveness cases passed after the readiness/focus fixes. Browser validation uses the installed Chromium via the external temporary config. Ten repeated link-race checks also passed.
- The 5 MiB recovery case reached the fake bridge in an observed 88 ms including queue/transfer, frontend checkpoint and driver round-trip time; it excludes native disk I/O and is not isolated encoding CPU time or a latency guarantee.
- Both generated HTML files/PWA sidecars pass `build.sh --check`. Smoke-client Python syntax, README image references and `git diff --check` pass. Cargo/native execution remains unavailable locally. All accumulated changes remain uncommitted.
- The unchanged 250 MiB benchmark reached recovery writes and measured 200 activations after the readiness fix: observed p50 16.5 ms, p95 2,165 ms (100 ms budget), main-page heap 304 MB. The official run then hit its unchanged 120-second timeout during final metrics collection and reported `ENOSPC` while writing failure artifacts. A separate instrumented replay completed but also failed the p95 assertion (2,623 ms). Neither is a passing performance result; no budget was relaxed.

## Phase 5: browser recovery write validation

Goal: remove large JSON parsing from the browser snapshot write/rotation path without changing storage keys, schema validation, current/previous fallback, quota failure behavior, or snapshot-before-manifest ordering. Reuse the existing worker rather than adding another worker pool, library or schema implementation.

Constraints and completion criteria:

- Inject a synchronous-or-asynchronous write parser into the browser adapter. Large incoming and current copies must validate before storage mutation. Keep bounded `DocumentModel.fromSnapshot()` checks on the UI thread.
- Order writes, reads and deletion per document within one adapter so an asynchronous write cannot overtake another write or resurrect a deleted document. Independent document queues remain separate. Recheck a current slot changed during validation, with one optimistic retry; repeated churn fails closed rather than waiting indefinitely.
- Keep recovery reads independent of worker availability. Parsing existing drafts on restore remains synchronous in this phase, deliberately preserving recovery access in unsupported/failed-worker environments. Manifest handling and localStorage commits also stay synchronous. The per-adapter queue is not a cross-window storage transaction or a filesystem authorization boundary.
- Distinguish invalid JSON (normal input failure that permits previous-copy handling) from worker/protocol/timeout failure (reject the write without treating stored data as corrupt). Preserve explicit Retry recovery and existing controller ownership guards; already-started I/O is not made cancelable by this phase.

Implemented:

- Extended the snapshot worker with queued JSON parsing alongside encoding. A syntax error rejects only that parse job; worker/runtime/protocol failures reject active and queued work. Startup, dispatch bounds, stale-event checks and disposal remain shared.
- Browser writes await the injected parser for incoming and current data, then commit rotation without an intervening await. Removed redundant JSON parsing from the rotation helper. Production wires this to the prewarmed shared serializer; legacy callers retain the synchronous default parser.
- Added storage-ordering/failure tests, real worker parsing tests, full/lite browser guards forbidding large main-thread write parsing, held validation/manifest tests, corrupt-current fallback, explicit retry, and restore with unavailable workers. Added a controlled 5 MiB parser-policy diagnostic and CSP coverage. Extended the native smoke client with a worker-parsing check; execution remains pending CI.

Phase 5 verification:

- 434 Node tests passed with the Cargo metadata check excluded. The initial storage/parser regressions and browser main-thread parse guard failed before implementation; all now pass. A separate churn regression failed before bounding optimistic validation retries.
- 121 functional/security browser tests, all six responsiveness cases, and 18 repeated storage checks passed using the installed Chromium/external temporary config. Full/lite rotation, held validation and newer edits, corrupt JSON, worker failure/retry and unavailable-worker restoration are exercised.
- The controlled two-write 5 MiB diagnostic observed three large main-thread parsing calls with the explicit synchronous parser (5 ms total parse CPU duration), versus zero with the worker policy. Worker checkpoint latency was about 23 ms including queue/transfer and schema checks. These are different duration measures, not a direct speedup comparison; in-memory storage excludes localStorage, native IPC and disk I/O.
- Both generated HTML files/PWA sidecars pass `build.sh --check`; README image references and `git diff --check` pass. Python smoke syntax, all ten embedded WebDriver scripts and CLI help were checked. The native smoke check was extended but not executed: Cargo/native tooling remains unavailable.
- The resource-heavy 250 MiB benchmark was not rerun in phase 5 after phase 4's timeout/storage-error result. Its budgets remain unchanged and it is not claimed passing. No native permissions, native IPC transport, dependencies, commits or releases were changed.

## Phase 6: manifest-pinned browser snapshot retention

Goal: preserve the snapshot referenced by the selected last valid manifest when later snapshot writes are unpublished, retried, or followed by a restart. Keep the current/previous keys and snapshot/manifest schemas unchanged. Reuse phase 5's queued parser, validation rules and per-document ordering.

Done when: adapter regressions and real browser reloads retain the committed draft after repeated failed publication; publishing a new manifest advances the retained revision; quota/parser failures preserve the committed copy; changes to slots or manifest during awaited validation are rechecked with a bounded retry. Reject attempts to replace an already-committed revision with different bytes rather than making that revision ambiguous. Exact retries remain allowed.

Limits: protect the selected valid manifest (current, or previous if current is invalid), not arbitrary historical manifests or already-lost data. Two slots cannot also retain every older manifest generation during an unpublished write. Cross-window transactions and native storage are separate work. Existing accumulated changes remain local/uncommitted.

Implemented:

- Browser rotation validates the current copy and, when needed, the previous copy using the existing injected parser. It retains the selected manifest's referenced revision instead of blindly rotating the newest snapshot, which may be unpublished. Revision zero is a valid pin. No new storage keys or schema migration are required; callers without a valid manifest retain the legacy rotation policy.
- Slot and manifest strings are captured/rechecked around asynchronous validation. One optimistic retry recomputes retention; continued churn fails closed. Worker failures validating a pinned previous copy cannot be treated as corruption or mutate storage.
- Before an actual snapshot rotation can retire older data, the selected current manifest is backed up to the previous manifest slot. This retires an obsolete fallback header along with its older data, so subsequent current-manifest corruption can still select metadata referencing the retained committed draft. A failed metadata backup aborts before snapshot rotation. Managed tab-close cleanup also backs up the published removal manifest before deleting that tab's data, so fallback cannot resurrect an entry whose snapshots have been removed. Backup failure leaves the data untouched; callers explicitly deleting a still-referenced document retain the legacy destructive API behavior.
- Different bytes cannot replace a valid committed revision. Unpublished revision reuse after restart remains supported. Exact retries do not rotate copies or discard an older fallback; successful manifest publication advances the pin and normal cleanup/deletion remain bounded.
- The initial ten adapter regressions failed before implementation. The browser regression against phase 5's generated build restored an empty editor after the second failed publication/reload; the updated full/lite builds restore the committed draft. Additional regressions caught non-idempotent exact retries and an obsolete fallback-manifest reference before those cases were fixed.

Phase 6 verification:

- 451 Node tests passed with the Cargo metadata check excluded. Regression coverage includes repeated unpublished revision reuse/restart, zero revisions, pin advancement, invalid slots/manifest fallback, snapshot and metadata-backup quota failures, worker failure, manifest changes during validation, immutable committed revisions, exact retries and tab-close cleanup.
- 125 functional/security browser tests, all six responsiveness cases and 30 repeated storage checks passed using the installed Chromium/external temporary config. Full/lite reloads retain the committed draft after repeated failed publication; corruption falls back to coherent metadata/data. A real tab-close/reload regression initially resurrected a deleted recovery entry, and now retains only the remaining tab.
- Generated full/lite HTML and PWA sidecars pass `build.sh --check`; README image references and `git diff --check` pass. No storage key/schema migration, dependencies, native code/permissions or release actions changed. All accumulated changes remain uncommitted.
- Cargo/native WebView verification remains unavailable locally. The known-failing 250 MiB activation benchmark was not rerun in this browser-correctness milestone, and no performance threshold was relaxed. Cross-window transactions and OS/power-loss storage guarantees remain outside these tests.

## Phase 7: independent recovery, preview and operation status

Goal: prevent preview/export/save messages from impersonating or clearing recovery state. Recovery badges must be driven only by explicit recovery updates (plus supported legacy recovery strings), while preview failures and ordinary messages remain independently visible in tab descriptions and announcements.

Done when: operation progress/failure/clearing cannot remove a recovery failure; recovery success cannot hide an unresolved preview failure; current preview success clears its own error while stale results cannot affect newer status; transient footer timers clear only their own document/message and cannot steal another tab's announcement. Persistent storage warnings remain visible. Legacy string `clean`/null resets remain supported; new operation cleanup uses the explicit operation channel.

Constraints: UI status is not a new source of document dirty/durable state. Preserve revision/capture guards, save/recovery formats, self-contained builds, native undo and existing retry policy. No framework, dependency, native permission, release or performance-budget changes. Verify failing unit/browser regressions before implementation, followed by complete Node/browser/build checks. Native verification and the resource-heavy 250 MiB benchmark remain separate.

Implemented:

- WorkspaceView stores separate recovery, preview and operation layers per document. Recovery styling/badges come only from the recovery layer; generic failed/writing messages no longer impersonate recovery. Combined tab descriptions preserve dirty/conflict state, and announcements retain active recovery failures and the persistent storage-warning prefix.
- Explicit channel cleanup clears only its own layer. Legacy recovery strings and `clean`/null full resets remain supported. Removed documents and disposal release runtime state, but recreating an editor surface does not erase its document's recovery channel.
- SessionController reports preview results at one capture-owned boundary. Successful current/cached results clear preview errors; stale success/rejection cannot change newer status. Repeated caller-side generic error reporters were removed while render promises still reject for API callers.
- Bootstrap timers are per document, retain originating status-object identity, and clear only their own operation. View announcement ownership prevents expired messages from clearing a newer tab announcement; startup fallback timers cannot erase an established document's status. No-op preview cleanup avoids unnecessary tab text mutations.
- Unit and browser regressions demonstrated the old false recovery styling, masking/clearing failures, stale preview results and cross-tab timer behavior. Review also added a failing surface-recreation regression before correcting cleanup ownership. A pre-existing Save All browser selector was anchored to the filename because retained operation descriptions legitimately mention other documents.

Phase 7 verification:

- 463 Node tests passed with the Cargo metadata check excluded. New channel/preview/timer/lifecycle regressions failed before their respective changes and now pass; no-op preview cleanup and surface recreation have explicit coverage.
- 128 functional/security browser tests and all six responsiveness cases passed. Nine repeated preview/recovery/timer checks and three repeated Save All conflict/quit checks also passed. Runs use the installed Chromium/external temporary config; final browser suites used one worker to limit local resource pressure, without changing any test budgets.
- Full/lite HTML and PWA sidecars pass `build.sh --check`; README image references and `git diff --check` pass. A transient Windows write error during one build resolved on retry; the final rebuilt outputs are verified.
- No document dirty/durable authority, persisted format, native policy, dependency or release action changed. All accumulated changes remain uncommitted. Cargo/native execution remains unavailable locally; the known-failing 250 MiB activation benchmark was not rerun under the low-disk conditions, and its thresholds remain unchanged.

## Phase 8: off-thread syntax highlighting

Goal: move Highlight.js CPU work off the main thread while preserving explicit-language highlighting (including raw HTML code blocks), code text/copy controls, Mermaid fences, sanitization, preview ownership and isolated exports. Reuse the vendored Highlight.js source already embedded in each self-contained build; no duplicate vendoring, runtime fetch/eval, dependency or native-policy change.

Done when: full/lite preview and rendered exports highlight code while main-thread `hljs.highlight` is forbidden; supported aliases match the existing engine; unknown/no-language/Mermaid blocks remain appropriate plain/diagram content; worker cancellation, failure, timeout and disposal release resources. Optional highlighting failures leave code plain, never run a blocking fallback. Delayed/stale/hidden results cannot mutate newer preview DOM, and export highlighting cannot cancel live preview highlighting.

Constraints: keep DOMPurify on the main thread before inserting worker-produced markup. Prepare Mermaid DOM synchronously before copy-tool wrapping, preserving its existing UI; Mermaid and other DOM rendering remain main-thread work. Do not claim total-memory reduction or a passing 250 MiB activation budget. Establish failing regressions and a controlled highlighting diagnostic, then verify the complete suites and builds. Accumulated changes remain uncommitted.

Implemented:

- `src/syntax-highlighter.js` reuses the embedded vendored Highlight.js source in one reusable preview worker; rendered exports get independently disposed workers. Explicit-language output/aliases match the existing engine; unknown/unlabelled/Mermaid code retains its existing policy. Grammar failures leave individual blocks plain; startup/runtime/protocol failures and the 10-second watchdog leave the request plain with no main-thread highlighting fallback.
- Supersession terminates obsolete work, stale replies/errors cannot affect a newer worker, and pagehide cancellation permits later BFCache requests. Empty work starts no worker. No dependency, runtime fetch/eval, recovery format or native permission changed.
- Worker HTML passes main-thread DOMPurify with only spans/class attributes allowed. Sanitized text and current code text must match captured text before replacement. Current-preview/containment checks reject stale or hidden updates. Existing noncollapsed code selections are left intact (optional styling is skipped); copy buttons retain exact code text. Mermaid preparation remains synchronous before copy-tool wrapping, with diagram rendering independent of highlighting.
- Failing browser acceptance established that the old UI-thread implementation lost highlighting when that API was forbidden. Review also reproduced late styling destroying a code selection before adding the selection guard. Selection tests compare actual browser selection before/after, not DOM textContent's trailing-newline representation.

Phase 8 verification:

- 472 Node tests passed using `node --test --test-skip-pattern="Cargo metadata identifies"`. New coverage includes the real vendored engine in a DOM-free worker VM, aliases/plain policy, per-grammar errors, reuse, supersession, stale events, malformed replies, timeout, retry, unavailable workers, disposal and invalid inputs.
- 137 functional/security browser tests and seven responsiveness cases passed using the installed Chromium/external config. All nine highlighting cases passed three additional repetitions (27 checks). Full/lite preview and HTML export forbid parent-thread highlighting; coverage includes raw HTML code, exact copy text, sanitization/text integrity, hidden/stale ownership, selected text and independent exports. CSP checks include highlighting and unwrapped full-build Mermaid diagrams.
- Controlled 147,456-code-unit JavaScript diagnostic: direct vendored engine took 48.5 ms; cold worker elapsed time was about 64.9 ms, with identical markup and zero parent-thread highlighter calls during worker work. These are different latency/CPU measures, not an end-to-end speedup claim; DOM sanitization/insertion, total isolate memory and native I/O are excluded.
- Full/lite HTML and PWA sidecars pass `build.sh --check`; README images and `git diff --check` pass. Native smoke now requires highlighted code with parent highlighting forbidden; its Python syntax, 11 embedded driver scripts and CLI help check pass. Actual Cargo/WebView execution remains unavailable locally.
- All accumulated changes remain uncommitted. The known-failing 250 MiB activation benchmark was not rerun: moving Highlight.js does not establish a faster Edit-only/native-textarea activation path. Its unchanged 100 ms p95 target and native authorization/IPC/cross-window milestones remain separate.

## Unresolved / not claimed complete

- **Browser recovery is not a cross-window transaction, version-history store or hardware-durability guarantee.** Phase 6 fixes the reproduced unpublished-write retention gap, but cannot reconstruct previously evicted data or disambiguate pre-existing conflicting bytes at the same revision. The selected valid manifest is protected, not every older generation. Actual OS/power-loss durability of localStorage remains browser-dependent.
- **Native compilation and smoke verification are pending CI.** New Rust dispatch/locking tests cannot run here without Cargo. Static source-contract checks do not prove runtime responsiveness.
- **The existing 250 MiB session performance test fails on this local Windows/Chromium environment.** Phase 1 p95 activation was 2,183 ms against the unchanged 100 ms budget. After the phase 2 value-read optimization, one local run measured p50 17 ms and p95 615 ms, with observed peak JS heap 304 MB versus 435 MB in the earlier phase 1 run. These are individual observations, not stable speedup guarantees; the benchmark still fails. An isolated checkout of the unchanged v0.3.14 source also failed at 2,006 ms. This predates the changes; the reference budget is for GitHub-hosted Linux. The threshold was not relaxed or skipped.
- **Native textarea/layout costs remain significant for multi-megabyte documents**, even with Find closed. Handler and frame metrics are intentionally separated; a fast handler is not a claim of a fast painted frame. Addressing this comprehensively may require a different editor/undo architecture, not just another debounce.
- **Per-file native authorization tokens were not introduced.** Custom filesystem commands still trust the main frontend; CSP is defense in depth, not a filesystem sandbox. Dialogs, OS launch paths, recents, restored sessions, and relative linked documents need one coordinated grant model before that boundary can change safely.
- Large snapshot encoding moved to a worker in phase 4, and large browser write-validation JSON parsing moved there in phase 5. Small snapshots, schema checks, recovery-read parsing, manifest handling, browser storage commits, and native IPC argument construction remain on the UI thread. Markdown parsing, footnotes, and math preparation moved to workers in phase 3, and syntax highlighting moved to workers in phase 8, but library initialization, DOMPurify, DOM insertion, KaTeX rendering and Mermaid DOM work remain on the UI thread. Existing debouncing and preview budgets remain in place; this is not a claim that all rendering is off-thread. Browser recovery and captured-export coordination were extracted in phase 2.
- Native WebView automation is Linux-only; Windows/macOS retain native-core tests and the manual smoke checklist.
