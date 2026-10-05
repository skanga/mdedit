use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAsset {
    pub relative_path: String,
    pub mime: String,
}

#[derive(Debug, Serialize)]
pub struct AssetContents {
    pub bytes: Vec<u8>,
    pub mime: String,
}

#[derive(Debug, Serialize)]
pub struct DocumentProbe {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

fn document_parent(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || !path.is_file() {
        return Err("Save the document to an existing absolute file path first".into());
    }
    // Relative links are resolved beside the opened document, including when
    // its parent directory is a symlink.
    path.parent()
        .unwrap()
        .canonicalize()
        .map_err(|e| e.to_string())
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_ASSET_BYTES as u64 {
        return Err("Attachments must be regular files no larger than 20 MiB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_ASSET_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err("Attachments must be no larger than 20 MiB".into());
    }
    Ok(bytes)
}

fn import_asset(document: &Path, name: &str, bytes: &[u8]) -> Result<ImportedAsset, String> {
    if bytes.len() > MAX_ASSET_BYTES {
        return Err("Attachments must be no larger than 20 MiB".into());
    }
    let directory = document_parent(document)?.join("assets");
    match fs::create_dir(&directory) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.to_string()),
    }
    // Do not follow a preexisting assets symlink, even if its target happens
    // to be inside the document directory.
    let metadata = fs::symlink_metadata(&directory).map_err(|e| e.to_string())?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || directory.canonicalize().map_err(|e| e.to_string())? != directory
    {
        return Err("The assets directory must not be a symbolic link".into());
    }
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("attachment");
    let clean: String = leaf
        .chars()
        .take(100)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let clean = clean.trim_matches('.');
    let clean = if clean.is_empty() {
        "attachment"
    } else {
        clean
    };
    // UUID prefix also avoids Windows reserved device names. create_new
    // ensures neither existing files nor dangling symlinks are overwritten.
    let filename = format!("{}-{clean}", uuid::Uuid::new_v4());
    let path = directory.join(&filename);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(error.to_string());
    }
    Ok(ImportedAsset {
        relative_path: format!("assets/{filename}"),
        mime: mime(&path).into(),
    })
}

fn decode_uri_path(reference: &str) -> Result<String, String> {
    let mut decoded = Vec::new();
    let mut input = reference.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = input.next().and_then(|v| (v as char).to_digit(16));
            let low = input.next().and_then(|v| (v as char).to_digit(16));
            match (high, low) {
                (Some(a), Some(b)) => decoded.push((a * 16 + b) as u8),
                _ => return Err("Invalid percent encoding in local asset reference".into()),
            }
        } else {
            decoded.push(byte);
        }
    }
    String::from_utf8(decoded).map_err(|e| e.to_string())
}

fn decode_reference(reference: &str) -> Result<String, String> {
    let decoded = decode_uri_path(reference)?;
    if decoded.is_empty()
        || decoded.contains([':', '\\', '\0'])
        || Path::new(&decoded).is_absolute()
        || decoded.starts_with('/')
    {
        return Err("Only relative local asset references are supported".into());
    }
    Ok(decoded)
}

/// Resolve local Markdown references without loading every linked document
/// into memory. Reading the selected target still goes through read_document.
#[tauri::command(async)]
pub fn resolve_markdown_link(document_path: String, reference: String) -> Option<String> {
    let decoded = decode_uri_path(reference.split(['?', '#']).next()?).ok()?;
    let windows_drive = decoded
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && decoded.as_bytes().get(1) == Some(&b':')
        && matches!(decoded.as_bytes().get(2), Some(b'/' | b'\\'));
    if decoded.is_empty()
        || decoded.contains('\0')
        || decoded.starts_with("//")
        || decoded.starts_with("\\\\")
        || (decoded.contains(':') && !windows_drive)
    {
        return None;
    }
    let reference_path = Path::new(&decoded);
    let extension = reference_path.extension()?.to_str()?.to_ascii_lowercase();
    if !matches!(extension.as_str(), "md" | "markdown" | "mdown" | "mkd") {
        return None;
    }
    let path = if reference_path.is_absolute() {
        reference_path.to_path_buf()
    } else {
        let source = Path::new(&document_path);
        if document_path.is_empty() || windows_drive {
            return None;
        }
        source.parent()?.join(reference_path)
    };
    // Check the file type before opening: opening a FIFO could block forever.
    let path = path.canonicalize().ok()?;
    if !path.is_file() || !File::open(&path).ok()?.metadata().ok()?.is_file() {
        return None;
    }
    path.to_str().map(str::to_owned)
}

fn read_asset(document: &Path, reference: &str) -> Result<AssetContents, String> {
    let path = document_parent(document)?.join(decode_reference(reference)?);
    Ok(AssetContents {
        bytes: read_bounded(&path)?,
        mime: mime(&path).into(),
    })
}

#[derive(PartialEq, Eq)]
struct Signature {
    size: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
    #[cfg(windows)]
    identity: Option<(u64, [u8; 16], i64)>,
}

impl Signature {
    fn from_metadata(metadata: &fs::Metadata, _file: &File) -> Self {
        Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (
                    metadata.dev(),
                    metadata.ino(),
                    metadata.ctime(),
                    metadata.ctime_nsec(),
                )
            },
            #[cfg(windows)]
            identity: windows_file_identity(_file),
        }
    }

    fn cacheable(&self) -> bool {
        #[cfg(windows)]
        if self.identity.is_none() {
            // Some filesystems do not expose identity/change time. Rehash there.
            return false;
        }
        self.modified.is_some()
    }
}

#[cfg(windows)]
fn windows_file_identity(file: &File) -> Option<(u64, [u8; 16], i64)> {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, FileIdInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO, FILE_ID_INFO,
    };

    let mut identity = FILE_ID_INFO::default();
    let mut basic = FILE_BASIC_INFO::default();
    // SAFETY: the live File owns the handle; each output pointer has the exact
    // structure and size required by its information class.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut identity as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        ) != 0
            && GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                (&mut basic as *mut FILE_BASIC_INFO).cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            ) != 0
    };
    success.then_some((
        identity.VolumeSerialNumber,
        identity.FileId.Identifier,
        basic.ChangeTime,
    ))
}

#[derive(Default)]
pub struct DocumentProbeCache {
    entries: Mutex<HashMap<PathBuf, (Signature, String)>>,
    #[cfg(test)]
    hash_reads: std::sync::atomic::AtomicUsize,
}

impl DocumentProbeCache {
    fn probe(&self, path: &Path, expected: &str) -> Result<DocumentProbe, String> {
        if !path.is_absolute() {
            return Err("Document path must be absolute".into());
        }
        let mut cache = self.entries.lock().map_err(|e| e.to_string())?;
        match fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Err("Document path is not a regular file".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                cache.remove(path);
                return Ok(DocumentProbe {
                    status: "missing",
                    sha256: None,
                });
            }
            Err(e) => return Err(e.to_string()),
        };
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("Document path is not a regular file".into());
        }
        let signature = Signature::from_metadata(&metadata, &file);
        let sha256 = match cache.get(path) {
            Some((cached, hash)) if cached == &signature && signature.cacheable() => hash.clone(),
            _ => {
                let before =
                    Signature::from_metadata(&file.metadata().map_err(|e| e.to_string())?, &file);
                let mut digest = Sha256::new();
                let mut buffer = [0; 64 * 1024];
                loop {
                    let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
                    if count == 0 {
                        break;
                    }
                    digest.update(&buffer[..count]);
                }
                #[cfg(test)]
                self.hash_reads
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let hash = format!("{:x}", digest.finalize());
                let after =
                    Signature::from_metadata(&file.metadata().map_err(|e| e.to_string())?, &file);
                if before == after {
                    // Bound the cache even across a long session of opened files.
                    if cache.len() >= 256 {
                        cache.clear();
                    }
                    cache.insert(path.to_path_buf(), (after, hash.clone()));
                } else {
                    cache.remove(path);
                    return Err("Document changed while checking; retry on the next check".into());
                }
                hash
            }
        };
        Ok(DocumentProbe {
            status: if sha256 == expected {
                "unchanged"
            } else {
                "changed"
            },
            sha256: Some(sha256),
        })
    }
}

#[tauri::command(async)]
pub fn import_document_asset(
    document_path: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<ImportedAsset, String> {
    import_asset(Path::new(&document_path), &name, &bytes)
}

#[tauri::command(async)]
pub fn import_document_attachment(
    document_path: String,
    source_path: String,
) -> Result<ImportedAsset, String> {
    let source = Path::new(&source_path);
    if !source.is_absolute() {
        return Err("Attachment path must be absolute".into());
    }
    let name = source
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("Attachment has no valid filename")?;
    import_asset(Path::new(&document_path), name, &read_bounded(source)?)
}

#[tauri::command(async)]
pub fn read_document_asset(
    document_path: String,
    reference: String,
) -> Result<AssetContents, String> {
    read_asset(Path::new(&document_path), &reference)
}

#[tauri::command(async)]
pub fn probe_document(
    path: String,
    expected_sha256: String,
    cache: tauri::State<'_, DocumentProbeCache>,
) -> Result<DocumentProbe, String> {
    cache.probe(Path::new(&path), &expected_sha256)
}

#[tauri::command(async)]
pub fn reveal_document(path: String) -> Result<(), String> {
    let path = Path::new(&path);
    let parent = document_parent(path)?;
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .status();
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let status = std::process::Command::new("xdg-open").arg(&parent).status();
    let _ = parent;
    if status
        .map_err(|e| format!("Could not open the file manager: {e}"))?
        .success()
    {
        Ok(())
    } else {
        Err("The file manager could not reveal this document".into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn document() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("document.md");
        fs::write(&path, "original").unwrap();
        (dir, path)
    }

    #[test]
    fn markdown_links_resolve_encoded_parent_and_absolute_paths() {
        let (dir, source) = document();
        let target = dir.path().join("My # Guide.MD");
        fs::write(&target, "# Guide").unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        let nested = dir.path().join("nested/source.md");
        fs::write(&nested, "source").unwrap();
        let expected = target.canonicalize().unwrap().to_str().unwrap().to_owned();
        for (document, reference) in [
            (&source, "My%20%23%20Guide.MD?view=1#intro".to_owned()),
            (&nested, "../My%20%23%20Guide.MD".to_owned()),
            (&source, target.to_str().unwrap().replace('#', "%23")),
        ] {
            assert_eq!(
                resolve_markdown_link(document.to_str().unwrap().into(), reference),
                Some(expected.clone())
            );
        }
        // Absolute references do not require a saved source document.
        assert_eq!(
            resolve_markdown_link(String::new(), target.to_str().unwrap().replace('#', "%23")),
            Some(expected)
        );
    }

    #[test]
    fn markdown_links_reject_missing_files_directories_and_nonlocal_references() {
        let (dir, source) = document();
        fs::create_dir(dir.path().join("folder.md")).unwrap();
        fs::write(dir.path().join("image.png"), "image").unwrap();
        for reference in [
            "missing.md",
            "folder.md",
            "image.png",
            "#intro",
            "",
            "%zz.md",
            "%00.md",
            "https://example.com/a.md",
            "//example.com/a.md",
            "data:text/markdown,hello.md",
            "file:///tmp/a.md",
        ] {
            assert_eq!(
                resolve_markdown_link(source.to_str().unwrap().into(), reference.into()),
                None,
                "{reference}"
            );
        }
        assert_eq!(
            resolve_markdown_link(String::new(), "document.md".into()),
            None
        );
    }

    #[test]
    fn markdown_links_resolve_from_a_relative_command_line_document_path() {
        let directory = tempfile::tempdir_in(".").unwrap();
        let source = directory.path().join("source.md");
        let target = directory.path().join("next.md");
        fs::write(&source, "[Next](next.md)").unwrap();
        fs::write(&target, "next").unwrap();
        let relative_source = source
            .strip_prefix(std::env::current_dir().unwrap())
            .unwrap();
        assert_eq!(
            resolve_markdown_link(relative_source.to_str().unwrap().into(), "next.md".into()),
            Some(target.canonicalize().unwrap().to_str().unwrap().to_owned())
        );
    }

    #[test]
    fn imports_unique_safe_names_and_reads_the_result() {
        let (dir, path) = document();
        let first = import_asset(&path, "../../a b.PNG", b"image").unwrap();
        let second = import_asset(&path, "../../a b.PNG", b"second").unwrap();
        assert_ne!(first.relative_path, second.relative_path);
        assert!(first.relative_path.starts_with("assets/"));
        assert!(!first.relative_path.contains(".."));
        assert_eq!(
            read_asset(&path, &first.relative_path).unwrap().bytes,
            b"image"
        );
        assert_eq!(first.mime, "image/png");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn reads_encoded_paths_and_parent_references_but_rejects_urls() {
        let (dir, path) = document();
        fs::write(dir.path().join("a b.png"), b"image").unwrap();
        fs::create_dir(dir.path().join("nested")).unwrap();
        let nested = dir.path().join("nested/doc.md");
        fs::write(&nested, "doc").unwrap();
        assert_eq!(read_asset(&path, "a%20b.png").unwrap().bytes, b"image");
        assert_eq!(
            read_asset(&nested, "../a%20b.png").unwrap().mime,
            "image/png"
        );
        for reference in [
            "https://host/a.png",
            "file:///tmp/a",
            "/tmp/a",
            "%2ftmp/a",
            "C:/a",
            "\\\\host\\a",
            "%00.png",
            "%zz",
        ] {
            assert!(read_asset(&path, reference).is_err(), "{reference}");
        }
    }

    #[test]
    fn rejects_missing_documents_and_oversized_imports() {
        let (dir, path) = document();
        assert!(import_asset(Path::new("relative.md"), "a.png", b"x").is_err());
        assert!(import_asset(&dir.path().join("missing.md"), "a.png", b"x").is_err());
        assert!(import_asset(&path, "a.png", &vec![0; MAX_ASSET_BYTES + 1]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_assets_directory_symlinks() {
        let (dir, path) = document();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("assets")).unwrap();
        assert!(import_asset(&path, "a.png", b"x").is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn probes_first_read_changes_same_content_and_missing() {
        let (_dir, path) = document();
        let cache = DocumentProbeCache::default();
        let expected = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(b"original"));
        assert_eq!(cache.probe(&path, "stale").unwrap().status, "changed");
        assert_eq!(cache.probe(&path, &expected).unwrap().status, "unchanged");
        assert_eq!(
            cache.hash_reads.load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        fs::write(&path, "changed content").unwrap();
        let changed = cache.probe(&path, &expected).unwrap();
        assert_eq!(changed.status, "changed");
        fs::write(&path, "changed content").unwrap();
        assert_eq!(
            cache.probe(&path, &changed.sha256.unwrap()).unwrap().status,
            "unchanged"
        );
        fs::remove_file(&path).unwrap();
        assert_eq!(cache.probe(&path, &expected).unwrap().status, "missing");
    }

    #[test]
    fn imports_picked_attachments_and_rejects_nonfiles() {
        let (dir, path) = document();
        let source = dir.path().join("report.pdf");
        fs::write(&source, b"pdf attachment").unwrap();
        let imported = import_document_attachment(
            path.to_string_lossy().into(),
            source.to_string_lossy().into(),
        )
        .unwrap();
        assert_eq!(imported.mime, "application/octet-stream");
        assert_eq!(
            read_asset(&path, &imported.relative_path).unwrap().bytes,
            b"pdf attachment"
        );
        assert!(read_asset(&path, "missing.png").is_err());
        assert!(read_asset(&path, "assets").is_err());
        assert!(import_document_attachment(
            path.to_string_lossy().into(),
            dir.path().to_string_lossy().into()
        )
        .is_err());
        let large = File::create(dir.path().join("large.png")).unwrap();
        large.set_len(MAX_ASSET_BYTES as u64 + 1).unwrap();
        assert!(read_asset(&path, "large.png").is_err());
        fs::write(dir.path().join("diagram.svg"), "<svg/>").unwrap();
        assert_eq!(
            read_asset(&path, "diagram.svg").unwrap().mime,
            "image/svg+xml"
        );
    }

    #[test]
    fn replacing_document_preserving_modified_time_invalidates_cached_hash() {
        let (dir, path) = document();
        let cache = DocumentProbeCache::default();
        let original = cache.probe(&path, "").unwrap().sha256.unwrap();
        let metadata = fs::metadata(&path).unwrap();
        let replacement = dir.path().join("replacement.md");
        fs::write(&replacement, "external").unwrap();
        File::options()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
            .unwrap();
        fs::remove_file(&path).unwrap();
        fs::rename(&replacement, &path).unwrap();
        assert_eq!(cache.probe(&path, &original).unwrap().status, "changed");
    }
}
