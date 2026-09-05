use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocumentResult {
    pub path: String,
    pub canonical_path: String,
    pub content: String,
    pub sha256: String,
    pub size: u64,
    pub modified_ms: Option<u128>,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SaveDocumentResult {
    Saved {
        canonical_path: String,
        sha256: String,
        size: u64,
        modified_ms: Option<u128>,
    },
    Conflict {
        actual_sha256: String,
        size: u64,
        modified_ms: Option<u128>,
    },
    Missing,
}

struct Fingerprint {
    sha256: String,
    size: u64,
    modified_ms: Option<u128>,
    permissions: fs::Permissions,
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn path_display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn comparison_string(path: PathBuf) -> String {
    let value = path.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        value.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}

pub fn canonical_comparison_path(path: &Path) -> Result<String, String> {
    let canonical = match fs::symlink_metadata(path) {
        Ok(_) => fs::canonicalize(path).map_err(|error| {
            format!(
                "failed to canonicalize document path {}: {error}",
                path.display()
            )
        })?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = parent_directory(path);
            let canonical_parent = fs::canonicalize(parent).map_err(|parent_error| {
                format!(
                    "failed to canonicalize parent for document path {}: {parent_error}",
                    path.display()
                )
            })?;
            let file_name = path
                .file_name()
                .ok_or_else(|| format!("document path {} has no file name", path.display()))?;
            canonical_parent.join(file_name)
        }
        Err(error) => {
            return Err(format!(
                "failed to inspect document path {}: {error}",
                path.display()
            ))
        }
    };

    Ok(comparison_string(canonical))
}

fn fingerprint(path: &Path) -> io::Result<Fingerprint> {
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let metadata = file.metadata()?;

    Ok(Fingerprint {
        sha256: sha256(&bytes),
        size: bytes.len() as u64,
        modified_ms: modified_ms(&metadata),
        permissions: metadata.permissions(),
    })
}

pub fn read_document_path(path: &Path) -> Result<ReadDocumentResult, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("failed to read document {}: {error}", path.display()))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|error| format!("document {} is not valid UTF-8: {error}", path.display()))?;
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to inspect document {}: {error}", path.display()))?;

    Ok(ReadDocumentResult {
        path: path_display(path),
        canonical_path: canonical_comparison_path(path)?,
        content,
        sha256: sha256(&bytes),
        size: bytes.len() as u64,
        modified_ms: modified_ms(&metadata),
    })
}

fn temporary_path(directory: &Path) -> PathBuf {
    directory.join(format!(".mdedit-{}.tmp", Uuid::new_v4()))
}

fn remove_temporary(path: &Path, directory: &Path) {
    let _ = fs::remove_file(path);
    sync_directory(directory);
}

fn write_temporary(
    path: &Path,
    directory: &Path,
    content: &[u8],
) -> Result<(PathBuf, File), String> {
    // UUID collisions are extraordinarily unlikely, while create_new ensures a
    // collision can never overwrite an existing file.
    let temporary = temporary_path(directory);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| {
            format!(
                "failed to create temporary file for {}: {error}",
                path.display()
            )
        })?;

    if let Err(error) = file.write_all(content).and_then(|()| file.sync_all()) {
        drop(file);
        remove_temporary(&temporary, directory);
        return Err(format!(
            "failed to write temporary file for {}: {error}",
            path.display()
        ));
    }

    Ok((temporary, file))
}

#[cfg(not(windows))]
fn replace_existing(temporary: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_existing(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    let replacement: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // SAFETY: both pointers refer to live, NUL-terminated UTF-16 buffers for
    // the duration of this synchronous Windows API call.
    let result = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn sync_directory(directory: &Path) {
    #[cfg(unix)]
    let _ = File::open(directory).and_then(|file| file.sync_all());

    #[cfg(not(unix))]
    let _ = directory;
}

pub fn save_document_path(
    path: &Path,
    content: &str,
    expected_sha256: Option<&str>,
) -> Result<SaveDocumentResult, String> {
    // Validate/canonicalize the destination before creating any temporary data.
    canonical_comparison_path(path)?;
    let destination = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::canonicalize(path).map_err(|error| {
                format!(
                    "failed to resolve document symlink {}: {error}",
                    path.display()
                )
            })?
        }
        _ => path.to_path_buf(),
    };
    let directory = parent_directory(&destination);
    let (temporary, temporary_file) = write_temporary(path, directory, content.as_bytes())?;

    let actual = match fingerprint(&destination) {
        Ok(actual) => Some(actual),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            drop(temporary_file);
            remove_temporary(&temporary, directory);
            return Err(format!(
                "failed to fingerprint document {}: {error}",
                path.display()
            ));
        }
    };

    // Standard filesystems do not expose a portable compare-and-swap rename.
    // Keep this fingerprint check as close as possible to replacement; a
    // cooperating writer should still use the same digest guard.
    match (expected_sha256, actual) {
        (Some(_), None) => {
            drop(temporary_file);
            remove_temporary(&temporary, directory);
            return Ok(SaveDocumentResult::Missing);
        }
        (Some(expected), Some(actual)) if actual.sha256 != expected => {
            drop(temporary_file);
            remove_temporary(&temporary, directory);
            return Ok(SaveDocumentResult::Conflict {
                actual_sha256: actual.sha256,
                size: actual.size,
                modified_ms: actual.modified_ms,
            });
        }
        (None, Some(actual)) => {
            drop(temporary_file);
            remove_temporary(&temporary, directory);
            return Ok(SaveDocumentResult::Conflict {
                actual_sha256: actual.sha256,
                size: actual.size,
                modified_ms: actual.modified_ms,
            });
        }
        (Some(_), Some(actual)) => {
            if let Err(error) = fs::set_permissions(&temporary, actual.permissions) {
                drop(temporary_file);
                remove_temporary(&temporary, directory);
                return Err(format!(
                    "failed to preserve permissions for document {}: {error}",
                    path.display()
                ));
            }
            drop(temporary_file);
            if let Err(error) = replace_existing(&temporary, &destination) {
                remove_temporary(&temporary, directory);
                return Err(format!(
                    "failed to replace document {}: {error}",
                    path.display()
                ));
            }
        }
        (None, None) => {
            drop(temporary_file);
            if let Err(error) = fs::hard_link(&temporary, &destination) {
                let conflict = if error.kind() == io::ErrorKind::AlreadyExists {
                    fingerprint(&destination).ok()
                } else {
                    None
                };
                remove_temporary(&temporary, directory);
                if let Some(actual) = conflict {
                    return Ok(SaveDocumentResult::Conflict {
                        actual_sha256: actual.sha256,
                        size: actual.size,
                        modified_ms: actual.modified_ms,
                    });
                }
                return Err(format!(
                    "failed to create document {}: {error}",
                    path.display()
                ));
            }
            remove_temporary(&temporary, directory);
        }
    }

    sync_directory(directory);
    let saved = fingerprint(&destination).map_err(|error| {
        format!(
            "failed to fingerprint saved document {}: {error}",
            path.display()
        )
    })?;

    Ok(SaveDocumentResult::Saved {
        canonical_path: canonical_comparison_path(path)?,
        sha256: saved.sha256,
        size: saved.size,
        modified_ms: saved.modified_ms,
    })
}

#[tauri::command]
pub(crate) fn read_document(path: String) -> Result<ReadDocumentResult, String> {
    read_document_path(Path::new(&path))
}

#[tauri::command]
pub(crate) fn save_document(
    path: String,
    content: String,
    expected_sha256: Option<String>,
) -> Result<SaveDocumentResult, String> {
    save_document_path(Path::new(&path), &content, expected_sha256.as_deref())
}

#[tauri::command]
pub(crate) fn canonicalize_document_path(path: String) -> Result<String, String> {
    canonical_comparison_path(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs;
    use tempfile::tempdir;

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn read_preserves_line_endings_and_reports_disk_fingerprint() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("mixed.md");
        fs::write(&path, b"a\r\nb\n").unwrap();

        let result = read_document_path(&path).unwrap();

        assert_eq!(result.path, path.to_string_lossy());
        assert_eq!(
            result.canonical_path,
            canonical_comparison_path(&path).unwrap()
        );
        assert_eq!(result.content, "a\r\nb\n");
        assert_eq!(result.sha256, sha256(b"a\r\nb\n"));
        assert_eq!(result.size, 5);
        assert!(result.modified_ms.is_some());
    }

    #[test]
    fn guarded_save_detects_external_change_and_preserves_it() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("document.md");
        fs::write(&path, "first").unwrap();
        let expected = read_document_path(&path).unwrap().sha256;
        fs::write(&path, "external").unwrap();

        let result = save_document_path(&path, "editor", Some(&expected)).unwrap();

        assert!(matches!(
            result,
            SaveDocumentResult::Conflict {
                actual_sha256,
                size: 8,
                ..
            } if actual_sha256 == sha256(b"external")
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    }

    #[test]
    fn guarded_save_replaces_unchanged_file_atomically() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("document.md");
        fs::write(&path, "first").unwrap();
        let expected = read_document_path(&path).unwrap().sha256;

        let result = save_document_path(&path, "editor", Some(&expected)).unwrap();

        assert!(matches!(
            result,
            SaveDocumentResult::Saved {
                ref canonical_path,
                sha256: ref saved_sha256,
                size: 6,
                ..
            } if canonical_path == &canonical_comparison_path(&path).unwrap()
                && saved_sha256 == &sha256(b"editor")
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "editor");
    }

    #[test]
    fn guarded_save_reports_missing_without_creating_expected_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("missing.md");

        let result = save_document_path(&path, "editor", Some(&sha256(b"first"))).unwrap();

        assert!(matches!(result, SaveDocumentResult::Missing));
        assert!(!path.exists());
    }

    #[test]
    fn new_file_save_conflicts_with_existing_destination() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("existing.md");
        fs::write(&path, "external").unwrap();

        let result = save_document_path(&path, "editor", None).unwrap();

        assert!(matches!(
            result,
            SaveDocumentResult::Conflict {
                actual_sha256,
                size: 8,
                ..
            } if actual_sha256 == sha256(b"external")
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "external");
    }

    #[test]
    fn new_file_save_uses_canonical_parent_and_utf8_content() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("new 文件.md");

        let result = save_document_path(&path, "café 📝", None).unwrap();

        let canonical_path = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("new 文件.md")
            .to_string_lossy()
            .into_owned();
        assert!(matches!(
            result,
            SaveDocumentResult::Saved {
                canonical_path: ref actual,
                size: 10,
                ..
            } if actual == &canonical_path
        ));
        assert_eq!(fs::read_to_string(path).unwrap(), "café 📝");
    }

    #[test]
    fn read_rejects_invalid_utf8_and_names_the_path() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("invalid.md");
        fs::write(&path, [0xff, 0xfe]).unwrap();

        let error = read_document_path(&path).unwrap_err();

        assert!(error.contains(&path.to_string_lossy().into_owned()));
        assert!(error.contains("UTF-8"));
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_file_preserves_its_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let path = directory.path().join("permissions.md");
        fs::write(&path, "first").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let expected = read_document_path(&path).unwrap().sha256;

        save_document_path(&path, "editor", Some(&expected)).unwrap();

        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_comparison_path_resolves_existing_symlinks() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let target = directory.path().join("target.md");
        let link = directory.path().join("link.md");
        fs::write(&target, "content").unwrap();
        symlink(&target, &link).unwrap();

        assert_eq!(
            canonical_comparison_path(&link).unwrap(),
            target.canonicalize().unwrap().to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn guarded_save_follows_an_existing_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let target = directory.path().join("target.md");
        let link = directory.path().join("link.md");
        fs::write(&target, "first").unwrap();
        symlink(&target, &link).unwrap();
        let expected = read_document_path(&link).unwrap().sha256;

        save_document_path(&link, "editor", Some(&expected)).unwrap();

        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(target).unwrap(), "editor");
    }

    #[test]
    fn canonical_comparison_path_rejects_new_path_with_missing_parent() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("missing").join("document.md");

        let error = canonical_comparison_path(&path).unwrap_err();

        assert!(error.contains(&path.to_string_lossy().into_owned()));
    }

    #[test]
    fn save_result_serializes_with_tagged_kebab_case_status_and_camel_case_fields() {
        let result = SaveDocumentResult::Saved {
            canonical_path: "/tmp/document.md".to_string(),
            sha256: "abc".to_string(),
            size: 3,
            modified_ms: Some(42),
        };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({
                "status": "saved",
                "canonicalPath": "/tmp/document.md",
                "sha256": "abc",
                "size": 3,
                "modifiedMs": 42,
            })
        );
    }
}
