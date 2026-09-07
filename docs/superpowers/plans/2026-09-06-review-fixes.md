# Review fixes implementation plan

Goal: fix the five issues accepted in the code review without changing storage schemas or adding dependencies.

1. Add browser regressions for stale Find/Replace offsets, Unicode matches, native/browser reload previews, and PDF export from Edit mode. Run against the existing generated assets to confirm failure.
2. Search the original text with escaped, case-insensitive literal regular expressions. Store original match spans; refresh on input and before replacement. Keep find state synchronized after disk reloads.
3. Refresh the active preview after successful native/browser reloads using the controller's revision guards. Allow an explicit render while the editor is in Edit mode for PDF printing; retain stale-capture checks and restore the theme after printing or failure.
4. Queue all native file-open requests before emitting a wake-up event. Drain the same queue at startup and on notifications. Test pre-listener delivery, overlapping drains, and late arrivals without duplicate opens.
5. Regenerate both HTML assets and stage the desktop frontend. Run Node, Rust, browser tests, Rust formatting and Clippy, and inspect the final diff.

Done when: replacements modify only current matches, reload shows current content in both panes, PDF works from Edit mode without changing the selected view, native opens survive listener startup, and all relevant checks pass.

Verification notes: the original browser regressions failed before implementation. The native queue regression also fails under notification-only delivery, verified with a temporary mutation that was restored. Added coverage for delayed listener registration, overlapping drains, PDF cancellation, and print failure. An existing Save All test's setup was made atomic after a post-tab-switch fill intermittently appended instead of replacing its starting text. Native Finder launch and actual OS print dialogs require platform smoke tests.
