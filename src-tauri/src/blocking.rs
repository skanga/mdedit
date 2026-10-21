/// Keep filesystem access, hashing, and fsync off the webview/async dispatch threads.
pub(crate) async fn run<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Native I/O task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocking_operations_use_a_different_thread_and_preserve_results() {
        let caller = std::thread::current().id();
        let result = tauri::async_runtime::block_on(run(move || {
            assert_ne!(std::thread::current().id(), caller);
            Ok(42)
        }));
        assert_eq!(result, Ok(42));
    }

    #[test]
    fn blocking_operations_preserve_io_errors() {
        let result: Result<(), String> =
            tauri::async_runtime::block_on(run(|| Err("disk unavailable".into())));
        assert_eq!(result, Err("disk unavailable".into()));
    }
}
