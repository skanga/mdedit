"""Smoke-test the real Linux release WebView/IPC using tauri-driver (no Python deps)."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def request(base, method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            value = json.load(response).get("value")
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(str(value))
    return value


def wait_until(check, timeout=20):
    deadline = time.monotonic() + timeout
    last_error = None
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (urllib.error.URLError, RuntimeError) as error:
            last_error = error
        time.sleep(0.1)
    raise RuntimeError(f"Timed out waiting for desktop smoke condition: {last_error}")


def collect_diagnostics(script):
    try:
        return script("""
            return {
              url: location.href,
              visibility: document.visibilityState,
              focused: document.hasFocus(),
              editors: [...document.querySelectorAll('textarea')].map(editor => ({
                value: editor.value.slice(0, 500), length: editor.value.length,
                connected: editor.isConnected, hidden: !editor.getClientRects().length,
                surface: editor.closest('.editor-surface')?.className
              })),
              activeTab: document.querySelector('[role=tab][aria-selected=true]')?.outerHTML,
              mode: document.querySelector('[data-mode].active')?.dataset.mode,
              preview: document.querySelector('#preview')?.innerHTML.slice(0, 2000),
              status: document.querySelector('#status')?.textContent,
              events: window.__smokeDiagnostics || [],
              eventTypes: ['error', 'unhandledrejection', 'securitypolicyviolation', 'worker-error']
            };
        """)
    except Exception as error:
        return {"diagnosticsError": str(error)}


def smoke(application, port):
    base = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="mdedit-smoke-") as directory:
        root = Path(directory)
        env = {**os.environ, "XDG_DATA_HOME": str(root / "data"),
               "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache")}
        session = None
        script = None
        with (root / "driver.log").open("w+") as log:
            driver = subprocess.Popen(["tauri-driver", "--port", str(port)], env=env,
                                      stdout=log, stderr=subprocess.STDOUT)
            try:
                wait_until(lambda: request(base, "GET", "/status"))
                created = request(base, "POST", "/session", {"capabilities": {"alwaysMatch": {
                    "tauri:options": {"application": str(application)}
                }}})
                session = created["sessionId"]
                prefix = f"/session/{session}"

                def script(source, *args):
                    return request(base, "POST", prefix + "/execute/sync",
                                   {"script": source, "args": list(args)})

                def invoke(command, arguments):
                    result = request(base, "POST", prefix + "/execute/async", {
                        "script": "const done=arguments[arguments.length-1];"
                                  "window.__TAURI__.core.invoke(arguments[0],arguments[1])"
                                  ".then(value=>done({value}),error=>done({failure:String(error)}));",
                        "args": [command, arguments],
                    })
                    if "failure" in result:
                        raise RuntimeError(result["failure"])
                    return result.get("value")

                script("""
                    window.__smokeDiagnostics = [];
                    const record = (type, detail) => {
                      window.__smokeDiagnostics.push({type, detail: String(detail).slice(0, 1000)});
                      if (window.__smokeDiagnostics.length > 40) window.__smokeDiagnostics.shift();
                    };
                    window.addEventListener('error', event => record('error', event.message), true);
                    window.addEventListener('unhandledrejection', event => record('unhandledrejection', event.reason));
                    document.addEventListener('securitypolicyviolation', event =>
                      record('securitypolicyviolation', event.effectiveDirective + ': ' + event.blockedURI));
                    window.Worker = new Proxy(window.Worker, {
                      construct(target, args) {
                        const worker = Reflect.construct(target, args);
                        record('worker-start', args[0]);
                        worker.addEventListener('error', event => record('worker-error', event.message));
                        worker.addEventListener('message', event => {
                          if (event.data?.error) record('worker-response-error', event.data.error);
                        });
                        return worker;
                      }
                    });
                """)
                wait_until(lambda: script("return !!document.querySelector('[role=tab][aria-selected=true]') && !!document.querySelector('#preview h1')"))
                script("hljs.highlight=()=>{throw new Error('UI highlighting forbidden');};"
                       "const editor=document.querySelector('.editor-surface:not(.is-inactive) textarea');"
                       "editor.value='# Native smoke\\n\\nneedle\\n\\n```js\\nconst worker=1;\\n```';"
                       "editor.dispatchEvent(new Event('input',{bubbles:true}));")
                wait_until(lambda: script("return document.querySelector('#preview h1')?.textContent==='Native smoke'"))
                wait_until(lambda: script("return document.querySelector('#preview code .hljs-keyword')?.textContent==='const'"))
                script("window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true}));"
                       "const regex=document.querySelector('#find-regex'); regex.checked=true;"
                       "regex.dispatchEvent(new Event('change',{bubbles:true}));"
                       "const input=document.querySelector('#find-input'); input.value='n.edle';"
                       "input.dispatchEvent(new Event('input',{bubbles:true}));")
                wait_until(lambda: script("return document.querySelector('#find-count').textContent==='1/1'"))

                # Real commands, serialization, and OS writes, not a mocked bridge.
                note = root / "note.md"
                note.write_text("original", encoding="utf-8")
                opened = invoke("read_document", {"path": str(note)})
                if opened["content"] != "original":
                    raise RuntimeError("Native read returned incorrect content")
                saved = invoke("save_document", {"path": str(note), "content": "updated",
                                                    "expectedSha256": opened["sha256"]})
                if saved["status"] != "saved" or note.read_text(encoding="utf-8") != "updated":
                    raise RuntimeError("Native guarded save did not write the document")
                conflict = invoke("save_document", {"path": str(note), "content": "overwrite",
                                                       "expectedSha256": opened["sha256"]})
                if conflict["status"] != "conflict" or note.read_text(encoding="utf-8") != "updated":
                    raise RuntimeError("Native conflict protection failed")
                script("document.querySelector('[data-mode=edit]').click();"
                       "const stringify=JSON.stringify;"
                       "JSON.stringify=function(value,...args){"
                       "if(value?.schemaVersion===1 && typeof value.content==='string' && value.content.length>=262144)"
                       "throw new Error('Large snapshot encoded on UI thread');"
                       "return stringify.call(this,value,...args);};"
                       "const editor=document.querySelector('.editor-surface:not(.is-inactive) textarea');"
                       "editor.value='Worker recovery\\n'+'x'.repeat(300*1024);"
                       "editor.dispatchEvent(new Event('input',{bubbles:true}));")

                def large_recovery_saved():
                    raw = invoke("load_recovery_manifest", {})
                    if not raw:
                        return False
                    manifest = json.loads(raw)
                    tab = next(tab for tab in manifest["tabs"]
                               if tab["documentId"] == manifest["activeDocumentId"])
                    recovered = json.loads(invoke("load_recovery_document", {
                        "documentId": tab["documentId"], "snapshotRevision": tab["snapshotRevision"]
                    }))
                    return recovered["content"] == "Worker recovery\n" + "x" * (300 * 1024)

                wait_until(large_recovery_saved)
                decoded = request(base, "POST", prefix + "/execute/async", {
                    "script": "const done=arguments[arguments.length-1];"
                              "const codec=window.MDEdit.createSnapshotSerializer({window});"
                              "const parse=JSON.parse;JSON.parse=(raw,...args)=>{"
                              "if(typeof raw==='string'&&raw.length>=262144)throw new Error('Large JSON parsed on UI thread');"
                              "return parse(raw,...args);};"
                              "codec.parse(arguments[0]).then(value=>done({length:value.content.length}),"
                              "error=>done({failure:String(error)})).finally(()=>{JSON.parse=parse;codec.dispose();});",
                    "args": [json.dumps({"content": "x" * (300 * 1024)})],
                })
                if decoded.get("length") != 300 * 1024:
                    raise RuntimeError(f"Snapshot parsing worker failed: {decoded}")
                script("const script=document.createElement('script');"
                       "script.textContent='window.__smokeInjection=true';document.body.append(script);")
                if script("return window.__smokeInjection===true"):
                    raise RuntimeError("Packaged CSP allowed an injected inline script")
                print("Desktop smoke passed: real WebView, Markdown/highlighting/search/snapshot encoding and parsing workers, native read/save/conflict, large recovery, CSP")
            except Exception:
                if script:
                    print("Desktop smoke diagnostics: " + json.dumps(collect_diagnostics(script), indent=2), flush=True)
                log.flush()
                log.seek(0)
                print(log.read())
                raise
            finally:
                if session:
                    try:
                        request(base, "DELETE", f"/session/{session}")
                    except (urllib.error.URLError, RuntimeError):
                        pass
                driver.terminate()
                try:
                    driver.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    driver.kill()
                    driver.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("application", type=Path, help="Path to the built release mdedit executable")
    parser.add_argument("--port", type=int, default=4444)
    args = parser.parse_args()
    application = args.application.resolve()
    if not application.is_file():
        parser.error(f"Application not found: {application}")
    smoke(application, args.port)
