"""Failure diagnostics must not mask the original desktop smoke failure."""
import importlib.util
from pathlib import Path
import unittest
import subprocess
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("smoke_desktop", Path(__file__).with_name("smoke-desktop.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class DiagnosticsTests(unittest.TestCase):
    def test_collects_webview_state(self):
        state = {"editors": [{"value": "# Native smoke"}], "preview": "old preview",
                 "status": "Markdown worker failed", "events": [{"type": "worker-error"}]}
        calls = []

        def script(source):
            calls.append(source)
            return state

        self.assertEqual(smoke.collect_diagnostics(script), state)
        for expression in ("textarea", "#preview", "#status", "securitypolicyviolation"):
            self.assertIn(expression, calls[0])

    def test_input_targets_the_selected_tabs_managed_editor(self):
        calls = []
        smoke.set_editor_content(lambda *args: calls.append(args), "# Native smoke")
        source, content = calls[0]
        harness = """
          const assert = require('node:assert/strict');
          const legacy = {value: 'legacy'};
          const editor = {value: 'welcome', focus() {}, getClientRects() {return [{}]},
            dispatchEvent(event) {assert.equal(event.type, 'input'); this.changed = true;}};
          const document = {
            querySelector(selector) {
              assert.equal(selector, '[role=tab][aria-selected=true]');
              return {getAttribute(name) {assert.equal(name, 'aria-controls'); return 'active-panel';}};
            },
            getElementById(id) {
              assert.equal(id, 'active-panel');
              return {querySelector(selector) {assert.equal(selector, 'textarea.document-editor'); return editor;}};
            }
          };
          new Function('document', 'return function(){' + process.argv[1] + '}')(document)(process.argv[2]);
          assert.equal(editor.value, '# Native smoke');
          assert.equal(editor.changed, true);
          assert.equal(legacy.value, 'legacy');
        """
        subprocess.run(['node', '-e', harness, source, content], check=True)

    def test_collection_failure_is_reported_not_raised(self):
        def script(source):
            raise RuntimeError("WebView disconnected")

        self.assertEqual(smoke.collect_diagnostics(script), {"diagnosticsError": "WebView disconnected"})


if __name__ == "__main__":
    unittest.main()
