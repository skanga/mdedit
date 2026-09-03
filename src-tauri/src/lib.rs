#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(
            tauri::generate_context!(),
            |app_handle, event| {
                if let tauri::RunEvent::Opened(paths) = event {
                    for p in paths {
                        let _ = app_handle.emit("file-opened", p.to_string_lossy().to_string());
                    }
                }
            },
        )
        .expect("error while running tauri application");
}
