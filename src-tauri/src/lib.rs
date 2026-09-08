pub mod desktop_files;
pub mod document_io;
pub mod recent_documents;
pub mod recovery;

use desktop_files::{
    import_document_asset, import_document_attachment, probe_document, read_document_asset,
    reveal_document, DocumentProbeCache,
};
use document_io::{canonicalize_document_path, read_document, save_document};
use recent_documents::{
    clear_recent_documents, list_recent_documents, remember_recent_document,
    remove_recent_document, RecentDocumentsStore,
};
use recovery::{
    delete_recovery_document, load_recovery_document, load_recovery_manifest, recovery_directory,
    write_recovery_document, write_recovery_manifest, RecoveryStore,
};
use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// All OS file-open requests are queued before notifying the webview. Events
/// are only wakeups: startup and live listeners drain the same queue, so a
/// missing listener cannot lose a request or deliver it twice.
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

impl PendingFiles {
    fn push_and_notify(&self, path: String, notify: impl FnOnce()) {
        self.0.lock().unwrap().push(path);
        // Release the lock before notifying: the listener may immediately drain.
        notify();
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

fn is_existing_file(path: &str) -> bool {
    Path::new(path).is_file()
}

#[tauri::command]
fn take_pending_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    state.take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(PendingFiles::default())
        .manage(DocumentProbeCache::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch with a file (double-click) arrives here instead
            // of starting a new instance: open it in the running window.
            for path in args.iter().skip(1).filter(|a| is_existing_file(a)) {
                app.state::<PendingFiles>()
                    .push_and_notify(path.clone(), || {
                        let _ = app.emit("file-opened", ());
                    });
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            take_pending_files,
            import_document_asset,
            import_document_attachment,
            read_document_asset,
            probe_document,
            reveal_document,
            list_recent_documents,
            remember_recent_document,
            remove_recent_document,
            clear_recent_documents,
            read_document,
            save_document,
            canonicalize_document_path,
            load_recovery_manifest,
            write_recovery_manifest,
            load_recovery_document,
            write_recovery_document,
            delete_recovery_document,
            recovery_directory
        ])
        .setup(|app| {
            let data_root = app.path().app_local_data_dir()?;
            let recovery_root = data_root.join("session-v1");
            app.manage(RecoveryStore::new(recovery_root));
            app.manage(RecentDocumentsStore::new(data_root));

            for path in std::env::args().skip(1).filter(|a| is_existing_file(a)) {
                app.state::<PendingFiles>().push_and_notify(path, || {});
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        // On macOS the OS hands files over this event instead of the command line.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if path.is_file() {
                        _app_handle.state::<PendingFiles>().push_and_notify(
                            path.to_string_lossy().to_string(),
                            || {
                                let _ = _app_handle.emit("file-opened", ());
                            },
                        );
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_open_is_queued_before_notification_and_survives_no_listener() {
        let pending = PendingFiles::default();
        pending.push_and_notify("early.md".into(), || {});
        pending.push_and_notify("later.md".into(), || {
            assert_eq!(pending.take(), vec!["early.md", "later.md"]);
        });
        assert!(pending.take().is_empty());
    }

    #[test]
    fn overlapping_drains_deliver_each_native_open_once() {
        use std::sync::{Arc, Barrier};
        let pending = Arc::new(PendingFiles::default());
        pending.push_and_notify("early.md".into(), || {});
        let barrier = Arc::new(Barrier::new(3));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let pending = pending.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    pending.take()
                })
            })
            .collect();
        barrier.wait();
        let taken: Vec<_> = workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(taken, vec!["early.md"]);
        pending.push_and_notify("late.md".into(), || {});
        assert_eq!(pending.take(), vec!["late.md"]);
        assert!(pending.take().is_empty());
    }
}
