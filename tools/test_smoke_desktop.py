"""Failure diagnostics must not mask the original desktop smoke failure."""
import importlib.util
from pathlib import Path
import unittest

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

    def test_collection_failure_is_reported_not_raised(self):
        def script(source):
            raise RuntimeError("WebView disconnected")

        self.assertEqual(smoke.collect_diagnostics(script), {"diagnosticsError": "WebView disconnected"})


if __name__ == "__main__":
    unittest.main()
