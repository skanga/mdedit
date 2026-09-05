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

fn path_string(path: &Path, description: &str) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{description} is not valid UTF-8: {}", path.display()))
}

fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn comparison_string(path: &Path) -> Result<String, String> {
    let value = path_string(path, "canonical document path")?;
    #[cfg(windows)]
    {
        Ok(value.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        Ok(value)
    }
}

enum ResolvedDocumentPath {
    Target(PathBuf),
    DanglingSymlink,
}

fn resolve_document_path(path: &Path) -> Result<ResolvedDocumentPath, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => match fs::canonicalize(path) {
            Ok(canonical) => Ok(ResolvedDocumentPath::Target(canonical)),
            Err(error)
                if error.kind() == io::ErrorKind::NotFound && metadata.file_type().is_symlink() =>
            {
                Ok(ResolvedDocumentPath::DanglingSymlink)
            }
            Err(error) => Err(format!(
                "failed to canonicalize document path {}: {error}",
                path.display()
            )),
        },
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
            Ok(ResolvedDocumentPath::Target(
                canonical_parent.join(file_name),
            ))
        }
        Err(error) => Err(format!(
            "failed to inspect document path {}: {error}",
            path.display()
        )),
    }
}

pub fn canonical_comparison_path(path: &Path) -> Result<String, String> {
    let canonical = match resolve_document_path(path)? {
        ResolvedDocumentPath::Target(canonical) => canonical,
        ResolvedDocumentPath::DanglingSymlink => {
            return Err(format!(
                "cannot canonicalize dangling document symlink {}",
                path.display()
            ))
        }
    };

    comparison_string(&canonical)
}

fn symlink_target_bytes(path: &Path) -> io::Result<Vec<u8>> {
    let target = fs::read_link(path)?;

    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(target.as_os_str().as_bytes().to_vec())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        Ok(target
            .as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect())
    }
    #[cfg(not(any(unix, windows)))]
    {
        target
            .to_str()
            .map(|value| value.as_bytes().to_vec())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "symlink is not UTF-8"))
    }
}

fn fingerprint_symlink(path: &Path) -> Result<Fingerprint, String> {
    let bytes = symlink_target_bytes(path).map_err(|error| {
        format!(
            "failed to read document symlink {}: {error}",
            path.display()
        )
    })?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "failed to inspect document symlink {}: {error}",
            path.display()
        )
    })?;

    Ok(Fingerprint {
        sha256: sha256(&bytes),
        size: bytes.len() as u64,
        modified_ms: modified_ms(&metadata),
        permissions: metadata.permissions(),
    })
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
    let canonical = match resolve_document_path(path)? {
        ResolvedDocumentPath::Target(canonical) => canonical,
        ResolvedDocumentPath::DanglingSymlink => {
            return Err(format!("document {} is a dangling symlink", path.display()))
        }
    };
    let bytes = fs::read(&canonical)
        .map_err(|error| format!("failed to read document {}: {error}", path.display()))?;
    let content = String::from_utf8(bytes.clone())
        .map_err(|error| format!("document {} is not valid UTF-8: {error}", path.display()))?;
    let metadata = fs::metadata(&canonical)
        .map_err(|error| format!("failed to inspect document {}: {error}", path.display()))?;

    Ok(ReadDocumentResult {
        path: path_string(path, "document path")?,
        canonical_path: comparison_string(&canonical)?,
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
    permissions: Option<&fs::Permissions>,
) -> Result<(PathBuf, File), String> {
    write_temporary_with_writer(path, directory, permissions, |file| file.write_all(content))
}

fn write_temporary_with_writer<W>(
    path: &Path,
    directory: &Path,
    permissions: Option<&fs::Permissions>,
    writer: W,
) -> Result<(PathBuf, File), String>
where
    W: FnOnce(&mut File) -> io::Result<()>,
{
    // UUID collisions are extraordinarily unlikely, while create_new ensures a
    // collision can never overwrite an existing file.
    let temporary = temporary_path(directory);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(permissions) = permissions {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(permissions.mode());
    }
    let mut file = options.open(&temporary).map_err(|error| {
        format!(
            "failed to create temporary file for {}: {error}",
            path.display()
        )
    })?;

    let write_result = (|| -> io::Result<()> {
        if let Some(permissions) = permissions {
            file.set_permissions(permissions.clone())?;
        }
        writer(&mut file)?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn publish_new(temporary: &Path, destination: &Path) -> io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};

    renameat_with(CWD, temporary, CWD, destination, RenameFlags::NOREPLACE).map_err(io::Error::from)
}

#[cfg(windows)]
fn publish_new(temporary: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

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
    // the duration of this synchronous Windows API call. Omitting
    // MOVEFILE_REPLACE_EXISTING gives this operation no-clobber semantics.
    let result = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn publish_new(temporary: &Path, destination: &Path) -> io::Result<()> {
    // Some Unix targets lack an exclusive rename primitive in their standard
    // API. A same-directory hard link is the safe no-clobber fallback: it
    // atomically fails when the destination already exists.
    fs::hard_link(temporary, destination)?;
    let _ = fs::remove_file(temporary);
    Ok(())
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
    match expected_sha256 {
        Some(expected) => {
            save_document_path_with_installer(path, content, Some(expected), replace_existing)
        }
        None => save_document_path_with_installer(path, content, None, publish_new),
    }
}

fn save_document_path_with_installer<I>(
    path: &Path,
    content: &str,
    expected_sha256: Option<&str>,
    install: I,
) -> Result<SaveDocumentResult, String>
where
    I: FnOnce(&Path, &Path) -> io::Result<()>,
{
    let saved_sha256 = sha256(content.as_bytes());
    let saved_size = content.len() as u64;
    let destination = match resolve_document_path(path)? {
        ResolvedDocumentPath::Target(destination) => destination,
        ResolvedDocumentPath::DanglingSymlink => {
            return match expected_sha256 {
                Some(_) => Ok(SaveDocumentResult::Missing),
                None => {
                    let actual = fingerprint_symlink(path)?;
                    Ok(SaveDocumentResult::Conflict {
                        actual_sha256: actual.sha256,
                        size: actual.size,
                        modified_ms: actual.modified_ms,
                    })
                }
            }
        }
    };
    let canonical_path = comparison_string(&destination)?;
    let directory = parent_directory(&destination);
    let initial = match fingerprint(&destination) {
        Ok(actual) => Some(actual),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "failed to fingerprint document {}: {error}",
                path.display()
            ));
        }
    };

    match (expected_sha256, initial.as_ref()) {
        (Some(_), None) => return Ok(SaveDocumentResult::Missing),
        (Some(expected), Some(actual)) if actual.sha256 != expected => {
            return Ok(SaveDocumentResult::Conflict {
                actual_sha256: actual.sha256.clone(),
                size: actual.size,
                modified_ms: actual.modified_ms,
            });
        }
        (None, Some(actual)) => {
            return Ok(SaveDocumentResult::Conflict {
                actual_sha256: actual.sha256.clone(),
                size: actual.size,
                modified_ms: actual.modified_ms,
            });
        }
        _ => {}
    }

    let preserved_permissions = initial.as_ref().map(|actual| &actual.permissions);
    let (temporary, temporary_file) =
        write_temporary(path, directory, content.as_bytes(), preserved_permissions)?;

    // Fingerprint again after the temp file is fully synced so this guard stays
    // immediately adjacent to publication.
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
        (Some(_), Some(_)) => {
            drop(temporary_file);
            if let Err(error) = install(&temporary, &destination) {
                remove_temporary(&temporary, directory);
                return Err(format!(
                    "failed to replace document {}: {error}",
                    path.display()
                ));
            }
        }
        (None, None) => {
            // Recheck for a useful conflict fingerprint. The exclusive
            // installer below is still authoritative and closes the remaining
            // check-to-publication race without overwriting the other writer.
            match fingerprint(&destination) {
                Ok(actual) => {
                    drop(temporary_file);
                    remove_temporary(&temporary, directory);
                    return Ok(SaveDocumentResult::Conflict {
                        actual_sha256: actual.sha256,
                        size: actual.size,
                        modified_ms: actual.modified_ms,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    drop(temporary_file);
                    remove_temporary(&temporary, directory);
                    return Err(format!(
                        "failed to fingerprint document {}: {error}",
                        path.display()
                    ));
                }
            }
            drop(temporary_file);
            if let Err(error) = install(&temporary, &destination) {
                let conflict = fingerprint(&destination).ok();
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
        }
    }

    sync_directory(directory);
    let saved_metadata = fs::metadata(&destination).map_err(|error| {
        format!(
            "failed to inspect saved document {}: {error}",
            path.display()
        )
    })?;

    Ok(SaveDocumentResult::Saved {
        canonical_path,
        sha256: saved_sha256,
        size: saved_size,
        modified_ms: modified_ms(&saved_metadata),
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
    fn new_file_publication_reports_a_destination_created_inside_installer() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("new.md");

        let result = save_document_path_with_installer(&path, "editor", None, |source, target| {
            fs::write(target, "racer")?;
            publish_new(source, target)
        })
        .unwrap();

        assert!(matches!(
            result,
            SaveDocumentResult::Conflict {
                actual_sha256,
                size: 5,
                ..
            } if actual_sha256 == sha256(b"racer")
        ));
        assert_eq!(fs::read_to_string(path).unwrap(), "racer");
        assert_eq!(
            fs::read_dir(directory.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with(".mdedit-"))
                .count(),
            0
        );
    }

    #[test]
    fn atomic_new_file_publisher_never_replaces_an_existing_destination() {
        let directory = tempdir().unwrap();
        let temporary = directory.path().join("temporary.md");
        let destination = directory.path().join("destination.md");
        fs::write(&temporary, "editor").unwrap();
        fs::write(&destination, "racer").unwrap();

        let error = publish_new(&temporary, &destination).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(destination).unwrap(), "racer");
        assert_eq!(fs::read_to_string(temporary).unwrap(), "editor");
    }

    #[test]
    fn failed_new_file_installer_cleans_its_temporary_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("new.md");

        let error = save_document_path_with_installer(&path, "editor", None, |_source, _target| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "installer failed",
            ))
        })
        .unwrap_err();

        assert!(error.contains("installer failed"));
        assert!(!path.exists());
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn saved_fingerprint_describes_editor_bytes_even_if_destination_changes_after_install() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("document.md");
        fs::write(&path, "first").unwrap();
        let expected = read_document_path(&path).unwrap().sha256;

        let result = save_document_path_with_installer(
            &path,
            "editor",
            Some(&expected),
            |source, target| {
                fs::rename(source, target)?;
                fs::write(target, "later external content")
            },
        )
        .unwrap();

        assert!(matches!(
            result,
            SaveDocumentResult::Saved {
                sha256: actual_sha256,
                size: 6,
                ..
            } if actual_sha256 == sha256(b"editor")
        ));
        assert_eq!(fs::read_to_string(path).unwrap(), "later external content");
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
    fn temporary_file_has_preserved_mode_before_sensitive_content_is_written() {
        use std::cell::Cell;
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let permissions = fs::Permissions::from_mode(0o600);
        let observed_mode = Cell::new(0);

        let (temporary, file) = write_temporary_with_writer(
            &destination,
            directory.path(),
            Some(&permissions),
            |temporary_file| {
                observed_mode.set(temporary_file.metadata()?.permissions().mode() & 0o777);
                temporary_file.write_all(b"sensitive")
            },
        )
        .unwrap();
        drop(file);

        assert_eq!(observed_mode.get(), 0o600);
        assert_eq!(fs::read(&temporary).unwrap(), b"sensitive");
        remove_temporary(&temporary, directory.path());
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
    fn new_file_under_symlinked_parent_uses_one_canonical_target() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let real_parent = directory.path().join("real");
        let linked_parent = directory.path().join("linked");
        fs::create_dir(&real_parent).unwrap();
        symlink(&real_parent, &linked_parent).unwrap();
        let requested = linked_parent.join("new.md");
        let expected_target = real_parent.canonicalize().unwrap().join("new.md");

        let result =
            save_document_path_with_installer(&requested, "editor", None, |source, target| {
                assert_eq!(target, expected_target);
                assert_eq!(source.parent(), expected_target.parent());
                fs::rename(source, target)
            })
            .unwrap();

        assert!(matches!(
            result,
            SaveDocumentResult::Saved { canonical_path, .. }
                if canonical_path == expected_target.to_str().unwrap()
        ));
        assert_eq!(fs::read_to_string(expected_target).unwrap(), "editor");
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

    #[cfg(unix)]
    #[test]
    fn expected_existing_save_treats_dangling_leaf_symlink_as_missing() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let link = directory.path().join("dangling.md");
        symlink("missing-target.md", &link).unwrap();

        let result = save_document_path(&link, "editor", Some(&sha256(b"previous"))).unwrap();

        assert!(matches!(result, SaveDocumentResult::Missing));
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert!(!directory.path().join("missing-target.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn new_save_conflicts_with_dangling_leaf_symlink_without_clobbering_it() {
        use std::os::unix::fs::symlink;

        let directory = tempdir().unwrap();
        let link = directory.path().join("dangling.md");
        symlink("missing-target.md", &link).unwrap();

        let result = save_document_path(&link, "editor", None).unwrap();

        assert!(matches!(result, SaveDocumentResult::Conflict { .. }));
        assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(
            fs::read_link(&link).unwrap(),
            Path::new("missing-target.md")
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_comparison_path_rejects_non_utf8_paths() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let directory = tempdir().unwrap();
        let path = directory.path().join(OsString::from_vec(vec![b'f', 0xff]));
        fs::write(&path, "content").unwrap();

        let error = canonical_comparison_path(&path).unwrap_err();

        assert!(error.contains("UTF-8"));
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
