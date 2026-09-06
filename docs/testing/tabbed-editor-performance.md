# Tabbed editor performance evidence

The release workload is 50 restored documents with 5 MiB of Markdown content each (250 MiB total), followed by 200 loaded-tab activations. The reference browser environment is a GitHub-hosted `ubuntu-latest` x64 runner with Node.js 20 and headless Playwright Chromium. Release budgets are p95 tab activation at or below 100 ms and peak observed renderer JavaScript heap at or below 1 GiB. The 1 GiB ceiling leaves deliberate headroom over the approximately 435 MB observed baseline while still catching large regressions.

`npm run test:performance` writes `test-results/tab-activation-metrics.json`. This is browser fake-bridge evidence: it measures real DOM/editor activation and renderer heap, but the fake recovery invoke timing does not include native IPC or disk I/O. It must not be presented as native recovery evidence.

The ignored Rust `recovery_performance` diagnostic serializes a real 5 MiB recovery snapshot and passes it through `RecoveryStore::write_document`, including validation and the atomic disk write. The manual/tag-only performance CI job runs it in release mode and writes `test-results/native-recovery-metrics.json`. Its artifact reports durations without enforcing an unapproved storage-latency threshold. It does not include webview IPC.

Before release, run the packaged smoke checklist on Windows, macOS, and Linux and record an end-to-end 5 MiB checkpoint measurement from `window.__MDEDIT_RECOVERY_PERFORMANCE__`. Each bounded entry contains JS serialization, IPC-plus-native, native atomic-write, and combined end-to-end durations. These packaged measurements remain a manual release gate because the automated Rust diagnostic cannot honestly measure webview serialization and IPC across all three desktop runtimes.
