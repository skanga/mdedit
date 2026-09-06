use mdedit_lib::recovery::RecoveryStore;
use serde_json::json;
use std::fs;
use std::time::Instant;

const CONTENT_BYTES: usize = 5 * 1024 * 1024;
const DOCUMENT_ID: &str = "3e4f3832-7919-4bbe-8ddc-231ba2444555";

#[test]
#[ignore = "release performance diagnostic"]
fn serializes_and_atomically_writes_a_five_mib_recovery_snapshot() {
    let temporary = tempfile::tempdir().expect("create performance fixture directory");
    let store = RecoveryStore::new(temporary.path().join("session-v1"));
    let snapshot = json!({
        "schemaVersion": 1,
        "documentId": DOCUMENT_ID,
        "snapshotRevision": 1,
        "editRevision": 1,
        "displayName": "large.md",
        "path": null,
        "canonicalPath": null,
        "content": "x".repeat(CONTENT_BYTES),
        "savedContentSha256": "dba67a476fa78973aabb087f214a1010f3bebca053674e0af50dfe5a582112be",
        "expectedDiskSha256": null,
        "fileStatus": "normal",
        "workspace": {
            "selectionStart": 0,
            "selectionEnd": 0,
            "editorScrollTop": 0,
            "previewScrollTop": 0,
            "viewMode": "edit",
            "tocOpen": false,
            "find": { "open": false, "query": "", "replacement": "", "matchIndex": -1 }
        }
    });

    let serialization_started = Instant::now();
    let bytes = serde_json::to_vec(&snapshot).expect("serialize recovery snapshot");
    let serialization_duration_ms = serialization_started.elapsed().as_secs_f64() * 1_000.0;
    let write_started = Instant::now();
    store
        .write_document(DOCUMENT_ID, 1, &bytes)
        .expect("atomically write recovery snapshot");
    let atomic_write_duration_ms = write_started.elapsed().as_secs_f64() * 1_000.0;
    assert!(bytes.len() >= CONTENT_BYTES);
    assert_eq!(store.load_document(DOCUMENT_ID, 1).unwrap(), bytes);

    let metrics = json!({
        "schemaVersion": 1,
        "metric": "native RecoveryStore 5 MiB serialization and atomic disk write",
        "environment": {
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "cargoProfile": "release"
        },
        "workload": { "contentBytes": CONTENT_BYTES, "serializedBytes": bytes.len() },
        "serializationDurationMs": serialization_duration_ms,
        "atomicWriteDurationMs": atomic_write_duration_ms,
        "totalDurationMs": serialization_duration_ms + atomic_write_duration_ms,
        "includesWebviewIpc": false
    });
    let serialized = serde_json::to_string_pretty(&metrics).unwrap();
    println!("{serialized}");
    if let Ok(path) = std::env::var("MDEDIT_NATIVE_RECOVERY_METRICS_PATH") {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            fs::create_dir_all(parent).expect("create metrics directory");
        }
        fs::write(path, format!("{serialized}\n")).expect("write native performance metrics");
    }
}
