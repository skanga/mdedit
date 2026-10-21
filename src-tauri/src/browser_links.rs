//! Only web URLs and existing local HTML files may leave the application.
use std::path::{Path, PathBuf};
use tauri::Url;

fn browser_target(document_path: &str, reference: &str) -> Result<Url, String> {
    let reference = reference.trim();
    if reference.is_empty() || reference.starts_with('#') || reference.chars().any(char::is_control) {
        return Err("Invalid browser link".into());
    }
    let lower = reference.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || reference.starts_with("//") {
        let url = Url::parse(&if reference.starts_with("//") {
            format!("https:{reference}")
        } else {
            reference.to_owned()
        }).map_err(|error| error.to_string())?;
        if url.host_str().is_none() || !matches!(url.scheme(), "http" | "https") {
            return Err("Invalid web URL".into());
        }
        return Ok(url);
    }

    let (path, query, fragment) = if lower.starts_with("file:") {
        let url = Url::parse(reference).map_err(|error| error.to_string())?;
        if url.host_str().is_some_and(|host| !host.is_empty() && host != "localhost") {
            return Err("Network file links are not supported".into());
        }
        let path = url.to_file_path().map_err(|_| "Invalid local file URL")?;
        (path, url.query().map(str::to_owned), url.fragment().map(str::to_owned))
    } else {
        let (before_fragment, fragment) = reference.split_once('#')
            .map_or((reference, None), |(path, fragment)| (path, Some(fragment.to_owned())));
        let (encoded_path, query) = before_fragment.split_once('?')
            .map_or((before_fragment, None), |(path, query)| (path, Some(query.to_owned())));
        let decoded = crate::desktop_files::decode_uri_path(encoded_path)?;
        let bytes = decoded.as_bytes();
        let drive = bytes.first().is_some_and(u8::is_ascii_alphabetic)
            && bytes.get(1) == Some(&b':') && matches!(bytes.get(2), Some(b'/' | b'\\'));
        if decoded.is_empty() || decoded.chars().any(char::is_control)
            || decoded.starts_with("//") || decoded.starts_with("\\\\")
            || (decoded.contains(':') && !drive) {
            return Err("Unsupported browser link scheme or path".into());
        }
        let path = PathBuf::from(decoded);
        let path = if path.is_absolute() {
            path
        } else {
            if drive || document_path.is_empty() {
                return Err("Save the Markdown document before opening relative HTML links".into());
            }
            Path::new(document_path).parent().ok_or("Document has no parent folder")?.join(path)
        };
        (path, query, fragment)
    };

    // Validate the actual canonical target too, so an .html symlink cannot
    // launch an executable or another file type through OS associations.
    let path = path.canonicalize().map_err(|error| format!("HTML file could not be opened: {error}"))?;
    if !path.is_file() || !path.extension().and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")) {
        return Err("Only existing local .html and .htm files can open in the browser".into());
    }
    let mut url = Url::from_file_path(path).map_err(|_| "Invalid HTML file path")?;
    url.set_query(query.as_deref());
    url.set_fragment(fragment.as_deref());
    Ok(url)
}

fn launch_browser(url: &Url) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let target: Vec<u16> = std::ffi::OsStr::new(url.as_str()).encode_wide().chain(Some(0)).collect();
        // Both UTF-16 buffers are NUL terminated and live through this call.
        let result = unsafe {
            ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), target.as_ptr(),
                std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL)
        } as isize;
        if result <= 32 { return Err(format!("Default browser could not be opened (Windows error {result})")); }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = std::process::Command::new("open");
            command.arg("--");
            command
        };
        #[cfg(not(target_os = "macos"))]
        let mut command = std::process::Command::new("xdg-open");
        let status = command.arg(url.as_str()).status().map_err(|error| format!("Default browser could not be opened: {error}"))?;
        if status.success() { Ok(()) } else { Err(format!("Default browser opener failed: {status}")) }
    }
}

#[tauri::command]
pub(crate) async fn open_browser_link(document_path: String, reference: String) -> Result<(), String> {
    crate::blocking::run(move || launch_browser(&browser_target(&document_path, &reference)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn web_links_preserve_query_and_fragment_and_protocol_relative_uses_https() {
        for reference in ["https://example.com/docs?q=1#intro", "http://example.com/a.md"] {
            assert_eq!(browser_target("", reference).unwrap().as_str(), reference);
        }
        assert_eq!(browser_target("", "//example.com/page").unwrap().as_str(), "https://example.com/page");
    }

    #[test]
    fn local_html_paths_and_file_urls_resolve_without_losing_escaping_or_suffixes() {
        let root = tempdir().unwrap();
        let notes = root.path().join("notes");
        fs::create_dir(&notes).unwrap();
        let page = root.path().join("a # ü.HTML");
        fs::write(&page, "<h1>Local</h1>").unwrap();
        let source = notes.join("main.md");
        let url = browser_target(source.to_str().unwrap(), "../a%20%23%20%C3%BC.HTML?q=1#intro").unwrap();
        assert_eq!(url.to_file_path().unwrap().canonicalize().unwrap(), page.canonicalize().unwrap());
        assert_eq!(url.query(), Some("q=1"));
        assert_eq!(url.fragment(), Some("intro"));
        assert_eq!(browser_target("", url.as_str()).unwrap(), url);
        let htm = root.path().join("page.htm");
        fs::write(&htm, "HTML").unwrap();
        assert!(browser_target("", htm.to_str().unwrap()).is_ok());
    }

    #[test]
    fn unsafe_missing_unsaved_and_non_html_targets_fail_closed() {
        for reference in ["javascript:alert(1)", "data:text/html,test", "mailto:a.html", "custom:a.html",
            "file://remote/share/page.html", "\\\\server\\share\\page.html", "relative.html", "#intro", "", "%zz.html", "a%00.html"] {
            assert!(browser_target("", reference).is_err(), "{reference}");
        }
        let root = tempdir().unwrap();
        for name in ["launch.exe", "notes.md", "folder.html"] {
            let path = root.path().join(name);
            if name == "folder.html" { fs::create_dir(&path).unwrap(); }
            else { fs::write(&path, "test").unwrap(); }
            assert!(browser_target("", path.to_str().unwrap()).is_err());
        }
        assert!(browser_target("", root.path().join("missing.html").to_str().unwrap()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn html_symlink_to_another_file_type_cannot_launch() {
        let root = tempdir().unwrap();
        let target = root.path().join("script.sh");
        fs::write(&target, "echo no").unwrap();
        let link = root.path().join("page.html");
        std::os::unix::fs::symlink(target, &link).unwrap();
        assert!(browser_target("", link.to_str().unwrap()).is_err());
    }
}
