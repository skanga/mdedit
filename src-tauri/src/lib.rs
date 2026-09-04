use std::path::Path;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Files the OS hands to the app at startup (command-line args on Windows and
/// Linux) arrive before the webview has loaded its script, so they are queued
/// here until the app pulls them with the `take_pending_files` command.
/// Files that arrive later (second instance, macOS Opened event) are emitted
/// directly, since the webview is already listening by then.
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

fn is_existing_file(path: &str) -> bool {
    Path::new(path).is_file()
}

#[tauri::command]
fn take_pending_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    state.0.lock().unwrap().drain(..).collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch with a file (double-click) arrives here instead
            // of starting a new instance: open it in the running window.
            for path in args.iter().skip(1).filter(|a| is_existing_file(a)) {
                let _ = app.emit("file-opened", path.clone());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(PendingFiles::default())
        .invoke_handler(tauri::generate_handler![take_pending_files])
        .setup(|app| {
            for path in std::env::args().skip(1).filter(|a| is_existing_file(a)) {
                if let Ok(mut queue) = app.state::<PendingFiles>().0.lock() {
                    queue.push(path);
                }
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
                        let _ = _app_handle.emit("file-opened", path.to_string_lossy().to_string());
                    }
                }
            }
        }
    });
}
