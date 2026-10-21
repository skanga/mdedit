# Desktop trust boundary

## Controls

- Markdown is sanitized with DOMPurify before entering the preview. Sanitization is still required even with CSP.
- The packaged desktop CSP restricts scripts to bundled/self resources. Tauri adds hashes for bundled inline scripts during packaging; neither `unsafe-inline` nor `unsafe-eval` is allowed for scripts. Blob workers are permitted for timeout-controlled regex searches, Markdown preparation, syntax highlighting, and large recovery snapshot encoding and browser write-validation parsing. Highlight markup is sanitized to spans/class attributes and must preserve code text before insertion; optional highlighting failures leave plain code. The Markdown worker reuses the existing bundled Marked source, captured from the trusted inline script at startup; it does not fetch a parser or use `eval`. Worker output is still sanitized with DOMPurify before DOM insertion.
- Objects, frames, base-URL overrides, and form submissions are disabled. Inline styles remain allowed for KaTeX, Mermaid, themes, and dynamic editor layout. Data/blob images and fonts are supported. Remote HTTP(S) images remain supported and can make network requests.
- Tauri's default capability applies to the main window, with no remote capability origins configured. The filesystem plugin grants raw export writes through native save-dialog selections, not a static wildcard path scope.
- Browser opening is an explicit native command: only HTTP(S) URLs and canonical existing local `.html`/`.htm` files are accepted. Relative HTML paths resolve beside the source document; file URLs with remote hosts, other schemes, directories, and HTML symlinks resolving to another file type are rejected. URLs are passed as individual arguments to OS launch APIs, not interpolated into a shell command. Clicking a local HTML link runs that page in the external browser, not the privileged MDedit WebView. The user's browser and OS determine tab/window behavior and file associations.
- Rust validates document fingerprints, conflict expectations, recovery envelopes/IDs, and attachment inputs. Recovery tasks share one lock across worker-store clones so snapshot/manifest rotation remains serialized.

## Explicit trust assumptions and remaining limits

The main application frontend is privileged. Custom document/asset commands are not governed by the filesystem plugin's export-path scope: they accept application-supplied paths. CSP and sanitization reduce the chance of executing hostile code, but **do not constitute per-file filesystem authorization**. An attacker who executes code in the trusted frontend could still invoke these commands. Introducing native file-grant tokens would require coordinated changes to dialogs, OS launch queues, recovery restoration, recents, and linked-document navigation; this change does not claim to provide that sandbox.

Relative image and attachment references intentionally allow `../` paths. HTML export embeds readable linked attachments. Treat documents from untrusted sources accordingly, especially before exporting and sharing them. Markdown navigation links themselves are not embedded as attachments.

Global Tauri APIs remain enabled because the current native bridge and window lifecycle adapters use them. Disabling the flag alone would break those features without removing the underlying IPC authority.

## Verification layers

- `tests/browser/security.spec.js` enforces the desktop CSP in Chromium, adding inline script hashes as Tauri does when packaging. It checks full/lite startup, math/diagrams, regex, Markdown, highlighting and snapshot workers, PNG export, and rejection of an injected inline script. This is not a packaged WebView test.
- `tools/smoke-desktop.py` uses `tauri-driver` against the actual Linux release executable and WebKit WebView in CI. It exercises frontend startup/rendering, regex and snapshot workers, real document read/save/conflict IPC, loading a large encoded recovery snapshot, worker JSON parsing/highlighting, and packaged CSP enforcement. The browser-launch check substitutes an `xdg-open` recorder to verify the packaged command's validated URLs without launching a browser on the headless runner; it does not test a real user's browser configuration. Python uses only the standard library.
- Rust tests cover worker thread dispatch and shared recovery locking. They must be run with Cargo; static source-contract checks are not a substitute.
- Windows and macOS native WebView automation remains outside this smoke path; their build/native-core checks and manual smoke checklist still apply.
