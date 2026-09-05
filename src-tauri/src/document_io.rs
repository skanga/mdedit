use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(not(windows))]
use std::fs::OpenOptions;
use std::fs::{self, File};
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct DocumentIdentity {
    sha256: String,
    size: u64,
}

impl Fingerprint {
    fn identity(&self) -> DocumentIdentity {
        DocumentIdentity {
            sha256: self.sha256.clone(),
            size: self.size,
        }
    }
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

fn fingerprint_reader<R: Read>(reader: &mut R) -> io::Result<(String, u64)> {
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| io::Error::other("document size overflow"))?;
    }
    Ok((format!("{:x}", digest.finalize()), size))
}

fn fingerprint(path: &Path) -> io::Result<Fingerprint> {
    let mut file = File::open(path)?;
    let (sha256, size) = fingerprint_reader(&mut file)?;
    let metadata = file.metadata()?;

    Ok(Fingerprint {
        sha256,
        size,
        modified_ms: modified_ms(&metadata),
        permissions: metadata.permissions(),
    })
}

pub fn read_document_path(path: &Path) -> Result<ReadDocumentResult, String> {
    read_document_path_with_open_hook(path, |_| Ok(()))
}

fn read_document_path_with_open_hook<F>(
    path: &Path,
    after_open: F,
) -> Result<ReadDocumentResult, String>
where
    F: FnOnce(&Path) -> io::Result<()>,
{
    let canonical = match resolve_document_path(path)? {
        ResolvedDocumentPath::Target(canonical) => canonical,
        ResolvedDocumentPath::DanglingSymlink => {
            return Err(format!("document {} is a dangling symlink", path.display()))
        }
    };
    let mut file = File::open(&canonical)
        .map_err(|error| format!("failed to read document {}: {error}", path.display()))?;
    after_open(&canonical)
        .map_err(|error| format!("failed after opening document {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read document {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("failed to inspect document {}: {error}", path.display()))?;
    let content_sha256 = sha256(&bytes);
    let size = bytes.len() as u64;
    let content = String::from_utf8(bytes)
        .map_err(|error| format!("document {} is not valid UTF-8: {error}", path.display()))?;

    Ok(ReadDocumentResult {
        path: path_string(path, "document path")?,
        canonical_path: comparison_string(&canonical)?,
        content,
        sha256: content_sha256,
        size,
        modified_ms: modified_ms(&metadata),
    })
}

fn temporary_path(directory: &Path) -> PathBuf {
    directory.join(format!(".mdedit-{}.tmp", Uuid::new_v4()))
}

#[cfg(any(windows, test))]
fn replacement_backup_path(directory: &Path) -> PathBuf {
    // Recovery only ever cleans this exact per-attempt path; broad stale-file
    // sweeping could delete the sole surviving copy after a partial replace.
    directory.join(format!(".mdedit-{}.bak", Uuid::new_v4()))
}

fn remove_temporary(path: &Path, directory: &Path) {
    remove_file_best_effort(path);
    sync_directory(directory);
}

#[cfg(not(windows))]
fn remove_file_best_effort(path: &Path) {
    let _ = fs::remove_file(path);
}

#[cfg(windows)]
fn remove_file_best_effort(path: &Path) {
    if fs::remove_file(path).is_err() {
        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            if permissions.readonly() {
                permissions.set_readonly(false);
                let _ = fs::set_permissions(path, permissions);
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[cfg(any(windows, test))]
fn with_prepared_security<S, C, Security, Output>(
    prepare_security: S,
    create_file: C,
) -> io::Result<Output>
where
    S: FnOnce() -> io::Result<Security>,
    C: FnOnce(Security) -> io::Result<Output>,
{
    let security = prepare_security()?;
    create_file(security)
}

#[cfg(not(windows))]
fn open_temporary_file(
    directory: &Path,
    permissions: Option<&fs::Permissions>,
    _security_source: Option<&Path>,
) -> io::Result<(PathBuf, File)> {
    let temporary = temporary_path(directory);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(permissions) = permissions {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(permissions.mode());
    }
    options.open(&temporary).map(|file| (temporary, file))
}

#[cfg(test)]
fn write_temporary_with_writer<W>(
    path: &Path,
    directory: &Path,
    permissions: Option<&fs::Permissions>,
    writer: W,
) -> Result<(PathBuf, File), String>
where
    W: FnOnce(&mut File) -> io::Result<()>,
{
    write_temporary_with_hooks(path, directory, permissions, None, |_, _| Ok(()), writer)
}

fn write_temporary_with_hooks<P, W>(
    path: &Path,
    directory: &Path,
    permissions: Option<&fs::Permissions>,
    security_source: Option<&Path>,
    prepare: P,
    writer: W,
) -> Result<(PathBuf, File), String>
where
    P: FnOnce(&File, &Path) -> io::Result<()>,
    W: FnOnce(&mut File) -> io::Result<()>,
{
    let (temporary, mut file) = open_temporary_file(directory, permissions, security_source)
        .map_err(|error| {
            format!(
                "failed to create temporary file for {}: {error}",
                path.display()
            )
        })?;

    let write_result = (|| -> io::Result<()> {
        if let Some(permissions) = permissions {
            file.set_permissions(permissions.clone())?;
        }
        prepare(&file, &temporary)?;
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

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplacementRecovery {
    DestinationPreserved,
    BackupRestored,
    TemporaryPublished,
}

#[cfg(any(windows, test))]
impl ReplacementRecovery {
    fn description(self) -> &'static str {
        match self {
            Self::DestinationPreserved => "existing destination preserved",
            Self::BackupRestored => "original backup restored",
            Self::TemporaryPublished => "editor temporary file published",
        }
    }
}

#[derive(Debug)]
enum DestinationIdentity {
    Missing,
    Original,
    Editor,
    ThirdParty,
    Unreadable(io::Error),
}

impl DestinationIdentity {
    fn is_editor(&self) -> bool {
        match self {
            Self::Editor => true,
            Self::Unreadable(error) => {
                let _ = error.kind();
                false
            }
            Self::Missing | Self::Original | Self::ThirdParty => false,
        }
    }
}

fn classify_destination(
    path: &Path,
    original: &DocumentIdentity,
    editor: &DocumentIdentity,
) -> DestinationIdentity {
    match fingerprint(path) {
        Ok(actual) if actual.sha256 == editor.sha256 && actual.size == editor.size => {
            DestinationIdentity::Editor
        }
        Ok(actual) if actual.sha256 == original.sha256 && actual.size == original.size => {
            DestinationIdentity::Original
        }
        Ok(_) => DestinationIdentity::ThirdParty,
        Err(error) if error.kind() == io::ErrorKind::NotFound => DestinationIdentity::Missing,
        Err(error) => DestinationIdentity::Unreadable(error),
    }
}

#[cfg(any(windows, test))]
fn path_matches_identity(path: &Path, expected: &DocumentIdentity) -> bool {
    fingerprint(path)
        .map(|actual| actual.sha256 == expected.sha256 && actual.size == expected.size)
        .unwrap_or(false)
}

#[cfg(any(windows, test))]
fn cleanup_for_editor_destination(temporary: &Path, backup: &Path, directory: &Path) {
    remove_file_best_effort(temporary);
    remove_file_best_effort(backup);
    sync_directory(directory);
}

#[cfg(any(windows, test))]
fn cleanup_for_original_destination(backup: &Path, directory: &Path, original: &DocumentIdentity) {
    if path_matches_identity(backup, original) {
        remove_file_best_effort(backup);
    }
    sync_directory(directory);
}

#[cfg(any(windows, test))]
fn retained_replacement_paths(temporary: &Path, backup: &Path) -> String {
    let paths: Vec<String> = [temporary, backup]
        .into_iter()
        .filter(|path| fs::symlink_metadata(path).is_ok())
        .map(|path| path.display().to_string())
        .collect();
    if paths.is_empty() {
        "none".to_owned()
    } else {
        paths.join(", ")
    }
}

fn retain_or_cleanup_failed_temporary(
    temporary: &Path,
    destination: &Path,
    directory: &Path,
    original: &DocumentIdentity,
    editor: &DocumentIdentity,
) -> bool {
    if classify_destination(destination, original, editor).is_editor() {
        remove_temporary(temporary, directory);
        false
    } else {
        sync_directory(directory);
        temporary.exists()
    }
}

#[cfg(any(windows, test))]
fn finish_successful_replacement(
    temporary: &Path,
    destination: &Path,
    backup: &Path,
    directory: &Path,
    identities: (&DocumentIdentity, &DocumentIdentity),
) -> Result<(), String> {
    let (original, editor) = identities;
    match classify_destination(destination, original, editor) {
        DestinationIdentity::Editor => {
            cleanup_for_editor_destination(temporary, backup, directory);
            Ok(())
        }
        DestinationIdentity::Original => {
            cleanup_for_original_destination(backup, directory, original);
            Err(format!(
                "replacement reported success but destination {} still contains the original document; retained recovery paths: {}",
                destination.display(),
                retained_replacement_paths(temporary, backup)
            ))
        }
        DestinationIdentity::ThirdParty => Err(format!(
            "replacement reported success but a third-party destination exists at {}; retained recovery paths: {}",
            destination.display(),
            retained_replacement_paths(temporary, backup)
        )),
        DestinationIdentity::Missing => Err(format!(
            "replacement reported success but destination {} is missing; retained recovery paths: {}",
            destination.display(),
            retained_replacement_paths(temporary, backup)
        )),
        DestinationIdentity::Unreadable(error) => Err(format!(
            "replacement reported success but destination {} cannot be identified: {error}; retained recovery paths: {}",
            destination.display(),
            retained_replacement_paths(temporary, backup)
        )),
    }
}

#[cfg(any(windows, test))]
fn recover_failed_replacement<P>(
    temporary: &Path,
    destination: &Path,
    backup: &Path,
    directory: &Path,
    identities: (&DocumentIdentity, &DocumentIdentity),
    mut publish: P,
) -> Result<ReplacementRecovery, String>
where
    P: FnMut(&Path, &Path) -> io::Result<()>,
{
    let (original, editor) = identities;
    match classify_destination(destination, original, editor) {
        DestinationIdentity::Editor => {
            cleanup_for_editor_destination(temporary, backup, directory);
            return Ok(ReplacementRecovery::DestinationPreserved);
        }
        DestinationIdentity::Original => {
            cleanup_for_original_destination(backup, directory, original);
            return Ok(ReplacementRecovery::DestinationPreserved);
        }
        DestinationIdentity::ThirdParty => {
            return Err(format!(
                "third-party destination exists at {}; retained recovery paths: {}",
                destination.display(),
                retained_replacement_paths(temporary, backup)
            ));
        }
        DestinationIdentity::Unreadable(error) => {
            return Err(format!(
                "destination {} cannot be identified: {error}; retained recovery paths: {}",
                destination.display(),
                retained_replacement_paths(temporary, backup)
            ));
        }
        DestinationIdentity::Missing => {}
    }

    let mut failures = Vec::new();
    for (candidate, expected, recovered) in [
        (backup, original, ReplacementRecovery::BackupRestored),
        (temporary, editor, ReplacementRecovery::TemporaryPublished),
    ] {
        if !path_matches_identity(candidate, expected) {
            continue;
        }
        match publish(candidate, destination) {
            Ok(()) => match classify_destination(destination, original, editor) {
                DestinationIdentity::Editor => {
                    cleanup_for_editor_destination(temporary, backup, directory);
                    return Ok(recovered);
                }
                DestinationIdentity::Original => {
                    cleanup_for_original_destination(backup, directory, original);
                    return Ok(recovered);
                }
                DestinationIdentity::ThirdParty => {
                    return Err(format!(
                        "publishing {} raced with a third-party destination at {}; retained recovery paths: {}",
                        candidate.display(),
                        destination.display(),
                        retained_replacement_paths(temporary, backup)
                    ));
                }
                DestinationIdentity::Missing => failures.push(format!(
                    "publishing {} reported success without producing a destination",
                    candidate.display()
                )),
                DestinationIdentity::Unreadable(error) => failures.push(format!(
                    "published recovery copy {} cannot be identified: {error}",
                    candidate.display()
                )),
            },
            Err(error) => match classify_destination(destination, original, editor) {
                DestinationIdentity::Editor => {
                    cleanup_for_editor_destination(temporary, backup, directory);
                    return Ok(ReplacementRecovery::DestinationPreserved);
                }
                DestinationIdentity::Original => {
                    cleanup_for_original_destination(backup, directory, original);
                    return Ok(ReplacementRecovery::DestinationPreserved);
                }
                DestinationIdentity::ThirdParty => {
                    return Err(format!(
                        "failed to publish recovery copy {}: {error}; a third-party destination exists at {}; retained recovery paths: {}",
                        candidate.display(),
                        destination.display(),
                        retained_replacement_paths(temporary, backup)
                    ));
                }
                DestinationIdentity::Missing => failures.push(format!(
                    "failed to publish recovery copy {}: {error}",
                    candidate.display()
                )),
                DestinationIdentity::Unreadable(identity_error) => failures.push(format!(
                    "failed to publish recovery copy {}: {error}; destination identity check failed: {identity_error}",
                    candidate.display()
                )),
            },
        }
    }

    let detail = if failures.is_empty() {
        "no recovery publication was possible".to_owned()
    } else {
        failures.join("; ")
    };
    Err(format!(
        "no known document copy could be restored at {}; {detail}; retained recovery paths: {}",
        destination.display(),
        retained_replacement_paths(temporary, backup)
    ))
}

#[cfg(any(windows, test))]
fn complete_replacement<P>(
    replacement_result: io::Result<()>,
    temporary: &Path,
    destination: &Path,
    backup: &Path,
    directory: &Path,
    identities: (&DocumentIdentity, &DocumentIdentity),
    publish: P,
) -> io::Result<()>
where
    P: FnMut(&Path, &Path) -> io::Result<()>,
{
    match replacement_result {
        Ok(()) => {
            finish_successful_replacement(temporary, destination, backup, directory, identities)
                .map_err(io::Error::other)
        }
        Err(replacement_error) => {
            let original_kind = replacement_error.kind();
            let original_message = replacement_error.to_string();
            let recovery = match recover_failed_replacement(
                temporary,
                destination,
                backup,
                directory,
                identities,
                publish,
            ) {
                Ok(outcome) => format!("recovery completed: {}", outcome.description()),
                Err(error) => format!("recovery failed: {error}"),
            };
            let retained = retained_replacement_paths(temporary, backup);
            let retained = if retained == "none" {
                String::new()
            } else {
                format!("; retained recovery paths: {retained}")
            };
            Err(io::Error::new(
                original_kind,
                format!("{original_message}; {recovery}{retained}"),
            ))
        }
    }
}

#[cfg(unix)]
fn restrictive_replacement_permissions() -> Option<fs::Permissions> {
    use std::os::unix::fs::PermissionsExt;
    Some(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrictive_replacement_permissions() -> Option<fs::Permissions> {
    None
}

fn apply_replacement_permissions(file: &File, permissions: fs::Permissions) -> io::Result<()> {
    #[cfg(not(windows))]
    file.set_permissions(permissions)?;

    // ReplaceFileW preserves the destination's ACL and attributes. Changing
    // the replacement temp on Windows would not be an equivalent substitute.
    #[cfg(windows)]
    let _ = permissions;

    file.sync_all()
}

#[cfg(windows)]
fn windows_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn read_document_security_descriptor(source: &Path) -> io::Result<Vec<usize>> {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::Security::{
        GetFileSecurityW, GetSecurityDescriptorControl, DACL_SECURITY_INFORMATION,
        SE_DACL_PROTECTED,
    };

    let source = windows_path(source);
    let mut bytes_needed = 0_u32;
    // SAFETY: source is a live, NUL-terminated UTF-16 path; the null
    // descriptor and zero size intentionally query the required buffer size.
    let query_result = unsafe {
        GetFileSecurityW(
            source.as_ptr(),
            DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut bytes_needed,
        )
    };
    if query_result == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) {
            return Err(error);
        }
    }
    if bytes_needed == 0 {
        return Err(io::Error::other(
            "GetFileSecurityW returned an empty DACL security descriptor",
        ));
    }

    let word_size = std::mem::size_of::<usize>();
    let word_count = (bytes_needed as usize).div_ceil(word_size);
    let mut descriptor = vec![0_usize; word_count];
    let descriptor_pointer = descriptor.as_mut_ptr().cast();
    // SAFETY: descriptor is aligned and large enough for bytes_needed bytes;
    // all pointers remain live for the duration of these synchronous calls.
    if unsafe {
        GetFileSecurityW(
            source.as_ptr(),
            DACL_SECURITY_INFORMATION,
            descriptor_pointer,
            bytes_needed,
            &mut bytes_needed,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let mut control = 0_u16;
    let mut revision = 0_u32;
    // SAFETY: descriptor_pointer refers to the validated security descriptor
    // returned above, and both output pointers are live.
    if unsafe { GetSecurityDescriptorControl(descriptor_pointer, &mut control, &mut revision) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // The self-relative descriptor carries both its DACL and the protected or
    // inherited control state. Keeping the buffer intact preserves that state
    // when CreateFileW consumes it through SECURITY_ATTRIBUTES.
    let _dacl_is_protected = control & SE_DACL_PROTECTED != 0;
    Ok(descriptor)
}

#[cfg(windows)]
fn open_temporary_file(
    directory: &Path,
    _permissions: Option<&fs::Permissions>,
    security_source: Option<&Path>,
) -> io::Result<(PathBuf, File)> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL};

    with_prepared_security(
        || {
            security_source
                .map(read_document_security_descriptor)
                .transpose()
        },
        |mut descriptor| {
            // The security descriptor is obtained before this UUID path is
            // created, so no visible file ever has the parent default DACL.
            let temporary = temporary_path(directory);
            let temporary_path = windows_path(&temporary);
            let mut security_attributes =
                descriptor.as_mut().map(|descriptor| SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                    lpSecurityDescriptor: descriptor.as_mut_ptr().cast(),
                    bInheritHandle: 0,
                });
            let security_pointer: *const SECURITY_ATTRIBUTES = match security_attributes.as_mut() {
                Some(attributes) => attributes,
                None => std::ptr::null(),
            };
            // SAFETY: path and optional security descriptor buffers remain live
            // for this synchronous call. CREATE_NEW prevents collisions, share
            // mode zero makes the temp non-shareable, and ownership of a valid
            // handle is immediately transferred to File.
            let handle = unsafe {
                CreateFileW(
                    temporary_path.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    security_pointer,
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: CreateFileW returned a unique owned handle, and File takes
            // sole responsibility for closing it on all subsequent paths.
            let file = unsafe { File::from_raw_handle(handle) };
            Ok((temporary, file))
        },
    )
}

#[cfg(not(windows))]
fn replace_existing(
    temporary: &Path,
    destination: &Path,
    _original: &DocumentIdentity,
    _editor: &DocumentIdentity,
) -> io::Result<()> {
    fs::rename(temporary, destination)
}

#[cfg(windows)]
fn replace_existing(
    temporary: &Path,
    destination: &Path,
    original: &DocumentIdentity,
    editor: &DocumentIdentity,
) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

    let directory = parent_directory(destination);
    let backup = replacement_backup_path(directory);
    let replaced = windows_path(destination);
    let replacement = windows_path(temporary);
    let backup_path = windows_path(&backup);
    // SAFETY: all path pointers refer to live, NUL-terminated UTF-16 buffers
    // for this synchronous call. Exclude and reserved are null as required.
    // Windows does not support REPLACEFILE_WRITE_THROUGH, so the temp handle
    // is synced before this call and no unsupported flags are requested.
    let result = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            backup_path.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    let replacement_result = if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    };
    complete_replacement(
        replacement_result,
        temporary,
        destination,
        &backup,
        directory,
        (original, editor),
        publish_new,
    )
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn publish_new(temporary: &Path, destination: &Path) -> io::Result<()> {
    use rustix::fs::{renameat_with, RenameFlags, CWD};

    renameat_with(CWD, temporary, CWD, destination, RenameFlags::NOREPLACE).map_err(io::Error::from)
}

#[cfg(windows)]
fn publish_new(temporary: &Path, destination: &Path) -> io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let existing = windows_path(temporary);
    let replacement = windows_path(destination);
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
        Some(expected) => save_document_path_with_identity_hooks(
            path,
            content,
            Some(expected),
            |file, _destination| file.write_all(content.as_bytes()),
            |temporary, destination, original, editor| {
                let original = original.ok_or_else(|| {
                    io::Error::other("existing replacement is missing its original identity")
                })?;
                replace_existing(temporary, destination, original, editor)
            },
        ),
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
    save_document_path_with_hooks(
        path,
        content,
        expected_sha256,
        |file, _destination| file.write_all(content.as_bytes()),
        install,
    )
}

fn save_document_path_with_hooks<W, I>(
    path: &Path,
    content: &str,
    expected_sha256: Option<&str>,
    writer: W,
    install: I,
) -> Result<SaveDocumentResult, String>
where
    W: FnOnce(&mut File, &Path) -> io::Result<()>,
    I: FnOnce(&Path, &Path) -> io::Result<()>,
{
    save_document_path_with_identity_hooks(
        path,
        content,
        expected_sha256,
        writer,
        |temporary, destination, _original, _editor| install(temporary, destination),
    )
}

fn save_document_path_with_identity_hooks<W, I>(
    path: &Path,
    content: &str,
    expected_sha256: Option<&str>,
    writer: W,
    install: I,
) -> Result<SaveDocumentResult, String>
where
    W: FnOnce(&mut File, &Path) -> io::Result<()>,
    I: FnOnce(&Path, &Path, Option<&DocumentIdentity>, &DocumentIdentity) -> io::Result<()>,
{
    let saved_sha256 = sha256(content.as_bytes());
    let saved_size = content.len() as u64;
    let saved_identity = DocumentIdentity {
        sha256: saved_sha256.clone(),
        size: saved_size,
    };
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

    let restrictive_permissions = expected_sha256
        .is_some()
        .then(restrictive_replacement_permissions)
        .flatten();
    let (temporary, temporary_file) = write_temporary_with_hooks(
        path,
        directory,
        restrictive_permissions.as_ref(),
        expected_sha256.is_some().then_some(destination.as_path()),
        |_, _| Ok(()),
        |file| writer(file, &destination),
    )?;

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
    let saved_modified_ms;
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
            let original_identity = actual.identity();
            if let Err(error) = apply_replacement_permissions(&temporary_file, actual.permissions) {
                drop(temporary_file);
                remove_temporary(&temporary, directory);
                return Err(format!(
                    "failed to preserve permissions for document {}: {error}",
                    path.display()
                ));
            }
            saved_modified_ms = temporary_file
                .metadata()
                .ok()
                .and_then(|metadata| modified_ms(&metadata));
            drop(temporary_file);
            if let Err(error) = install(
                &temporary,
                &destination,
                Some(&original_identity),
                &saved_identity,
            ) {
                let retained = retain_or_cleanup_failed_temporary(
                    &temporary,
                    &destination,
                    directory,
                    &original_identity,
                    &saved_identity,
                );
                let recovery = if retained {
                    format!("; temporary document retained at {}", temporary.display())
                } else {
                    String::new()
                };
                return Err(format!(
                    "failed to replace document {}: {error}{recovery}",
                    path.display(),
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
            saved_modified_ms = temporary_file
                .metadata()
                .ok()
                .and_then(|metadata| modified_ms(&metadata));
            drop(temporary_file);
            if let Err(error) = install(&temporary, &destination, None, &saved_identity) {
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

    Ok(SaveDocumentResult::Saved {
        canonical_path,
        sha256: saved_sha256,
        size: saved_size,
        modified_ms: saved_modified_ms,
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

    fn identity(bytes: &[u8]) -> DocumentIdentity {
        DocumentIdentity {
            sha256: sha256(bytes),
            size: bytes.len() as u64,
        }
    }

    struct ChunkedReader {
        bytes: std::io::Cursor<Vec<u8>>,
        chunk_size: usize,
    }

    impl Read for ChunkedReader {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let limit = buffer.len().min(self.chunk_size);
            self.bytes.read(&mut buffer[..limit])
        }
    }

    #[test]
    fn fingerprint_reader_hashes_large_input_across_short_chunks() {
        let bytes: Vec<u8> = (0..200_000).map(|index| (index % 251) as u8).collect();
        let mut reader = ChunkedReader {
            bytes: std::io::Cursor::new(bytes.clone()),
            chunk_size: 7,
        };

        let (actual_sha256, actual_size) = fingerprint_reader(&mut reader).unwrap();

        assert_eq!(actual_sha256, sha256(&bytes));
        assert_eq!(actual_size, bytes.len() as u64);
    }

    #[test]
    fn successful_replacement_keeps_destination_before_cleaning_backup() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let temporary = directory.path().join("temporary.md");
        let backup = replacement_backup_path(directory.path());
        fs::write(&destination, "editor").unwrap();
        fs::write(&backup, "original").unwrap();

        complete_replacement(
            Ok(()),
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |source, target| fs::rename(source, target),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(destination).unwrap(), "editor");
        assert!(!backup.exists());
        assert_eq!(backup.parent(), Some(directory.path()));
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(".mdedit-"));
        assert_eq!(
            backup.extension().and_then(|value| value.to_str()),
            Some("bak")
        );
    }

    #[test]
    fn ordinary_replacement_failure_preserves_existing_destination() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let temporary = directory.path().join("temporary.md");
        let backup = directory.path().join("backup.md");
        fs::write(&destination, "original").unwrap();
        fs::write(&temporary, "editor").unwrap();

        let outcome = recover_failed_replacement(
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |source, target| fs::rename(source, target),
        )
        .unwrap();

        assert_eq!(outcome, ReplacementRecovery::DestinationPreserved);
        assert_eq!(fs::read_to_string(destination).unwrap(), "original");
        assert_eq!(fs::read_to_string(temporary).unwrap(), "editor");
    }

    #[test]
    fn partial_replacement_failure_restores_original_backup_first() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let temporary = directory.path().join("temporary.md");
        let backup = directory.path().join("backup.md");
        fs::write(&temporary, "editor").unwrap();
        fs::write(&backup, "original").unwrap();

        let outcome = recover_failed_replacement(
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |source, target| fs::rename(source, target),
        )
        .unwrap();

        assert_eq!(outcome, ReplacementRecovery::BackupRestored);
        assert_eq!(fs::read_to_string(destination).unwrap(), "original");
        assert_eq!(fs::read_to_string(temporary).unwrap(), "editor");
        assert!(!backup.exists());
    }

    #[test]
    fn partial_replacement_failure_publishes_editor_temp_without_backup() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let temporary = directory.path().join("temporary.md");
        let backup = directory.path().join("missing-backup.md");
        fs::write(&temporary, "editor").unwrap();

        let outcome = recover_failed_replacement(
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |source, target| fs::rename(source, target),
        )
        .unwrap();

        assert_eq!(outcome, ReplacementRecovery::TemporaryPublished);
        assert_eq!(fs::read_to_string(destination).unwrap(), "editor");
        assert!(!temporary.exists());
    }

    #[test]
    fn replacement_failure_reports_original_error_and_recovery_result() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let temporary = directory.path().join("temporary.md");
        let backup = directory.path().join("backup.md");
        fs::write(&temporary, "editor").unwrap();
        fs::write(&backup, "original").unwrap();

        let error = complete_replacement(
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "ReplaceFileW failed with error 1177",
            )),
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |source, target| fs::rename(source, target),
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("error 1177"));
        assert!(error.to_string().contains("original backup restored"));
        assert!(error
            .to_string()
            .contains(&temporary.to_string_lossy().into_owned()));
        assert_eq!(fs::read_to_string(destination).unwrap(), "original");
        assert_eq!(fs::read_to_string(temporary).unwrap(), "editor");
    }

    #[test]
    fn failed_replacement_retains_known_copies_behind_third_party_destination() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let temporary = directory.path().join("temporary.md");
        let backup = directory.path().join("backup.md");
        fs::write(&destination, "third party").unwrap();
        fs::write(&temporary, "editor").unwrap();
        fs::write(&backup, "original").unwrap();

        let error = complete_replacement(
            Err(io::Error::other("ReplaceFileW failed")),
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |source, target| fs::rename(source, target),
        )
        .unwrap_err();

        assert!(error.to_string().contains("third-party destination"));
        assert!(error
            .to_string()
            .contains(&temporary.to_string_lossy().into_owned()));
        assert!(error
            .to_string()
            .contains(&backup.to_string_lossy().into_owned()));
        assert_eq!(fs::read_to_string(destination).unwrap(), "third party");
        assert_eq!(fs::read_to_string(temporary).unwrap(), "editor");
        assert_eq!(fs::read_to_string(backup).unwrap(), "original");
    }

    #[test]
    fn failed_recovery_publication_rechecks_third_party_destination_identity() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let temporary = directory.path().join("temporary.md");
        let backup = directory.path().join("backup.md");
        fs::write(&temporary, "editor").unwrap();
        fs::write(&backup, "original").unwrap();

        let error = complete_replacement(
            Err(io::Error::other("ReplaceFileW failed")),
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |_source, target| {
                fs::write(target, "third party")?;
                Err(io::Error::other("recovery publication raced"))
            },
        )
        .unwrap_err();

        assert!(error.to_string().contains("third-party destination"));
        assert_eq!(fs::read_to_string(destination).unwrap(), "third party");
        assert_eq!(fs::read_to_string(temporary).unwrap(), "editor");
        assert_eq!(fs::read_to_string(backup).unwrap(), "original");
    }

    #[test]
    fn successful_replacement_retains_candidates_if_destination_turns_third_party() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let temporary = directory.path().join("temporary.md");
        let backup = directory.path().join("backup.md");
        fs::write(&destination, "third party").unwrap();
        fs::write(&temporary, "editor").unwrap();
        fs::write(&backup, "original").unwrap();

        let error = complete_replacement(
            Ok(()),
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |source, target| fs::rename(source, target),
        )
        .unwrap_err();

        assert!(error.to_string().contains("third-party destination"));
        assert_eq!(fs::read_to_string(temporary).unwrap(), "editor");
        assert_eq!(fs::read_to_string(backup).unwrap(), "original");
    }

    #[test]
    fn destination_matching_editor_allows_redundant_copy_cleanup() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let temporary = directory.path().join("temporary.md");
        let backup = directory.path().join("backup.md");
        fs::write(&destination, "editor").unwrap();
        fs::write(&temporary, "editor").unwrap();
        fs::write(&backup, "original").unwrap();

        complete_replacement(
            Ok(()),
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |source, target| fs::rename(source, target),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(destination).unwrap(), "editor");
        assert!(!temporary.exists());
        assert!(!backup.exists());
    }

    #[test]
    fn unrecoverable_replacement_state_does_not_delete_remaining_paths() {
        let directory = tempdir().unwrap();
        let destination = directory.path().join("missing-document.md");
        let temporary = directory.path().join("temporary-directory");
        let backup = directory.path().join("backup-directory");
        fs::create_dir(&temporary).unwrap();
        fs::create_dir(&backup).unwrap();

        let error = recover_failed_replacement(
            &temporary,
            &destination,
            &backup,
            directory.path(),
            (&identity(b"original"), &identity(b"editor")),
            |source, target| fs::rename(source, target),
        )
        .unwrap_err();

        assert!(error.contains("no known document copy"));
        assert!(temporary.is_dir());
        assert!(backup.is_dir());
        assert!(!destination.exists());
    }

    #[test]
    fn temporary_preparation_runs_while_file_is_empty_before_content_write() {
        use std::cell::Cell;

        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        let prepared = Cell::new(false);

        let (temporary, file) = write_temporary_with_hooks(
            &destination,
            directory.path(),
            None,
            None,
            |temporary_file, temporary_path| {
                assert_eq!(temporary_file.metadata()?.len(), 0);
                assert!(temporary_path.exists());
                prepared.set(true);
                Ok(())
            },
            |temporary_file| {
                assert!(prepared.get());
                temporary_file.write_all(b"sensitive")
            },
        )
        .unwrap();
        drop(file);

        assert_eq!(fs::read(&temporary).unwrap(), b"sensitive");
        remove_temporary(&temporary, directory.path());
    }

    #[test]
    fn security_material_is_prepared_before_temporary_file_creation() {
        use std::cell::Cell;

        let directory = tempdir().unwrap();
        let temporary = directory.path().join("temporary.md");
        let security_ready = Cell::new(false);

        let marker = with_prepared_security(
            || {
                assert!(!temporary.exists());
                security_ready.set(true);
                Ok(42_u8)
            },
            |security| {
                assert!(security_ready.get());
                assert!(!temporary.exists());
                fs::write(&temporary, [])?;
                Ok(security)
            },
        )
        .unwrap();

        assert_eq!(marker, 42);
        assert!(temporary.exists());
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
    fn failed_existing_installer_retains_temp_when_destination_is_missing() {
        use std::cell::RefCell;

        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, "original").unwrap();
        let expected = sha256(b"original");
        let observed_temporary = RefCell::new(None);

        let error = save_document_path_with_installer(
            &destination,
            "editor",
            Some(&expected),
            |temporary, target| {
                observed_temporary.replace(Some(temporary.to_owned()));
                fs::remove_file(target)?;
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "installer failed after destination disappeared",
                ))
            },
        )
        .unwrap_err();

        let temporary = observed_temporary.into_inner().unwrap();
        assert!(error.contains("temporary document retained"));
        assert!(!destination.exists());
        assert_eq!(fs::read_to_string(&temporary).unwrap(), "editor");
        remove_temporary(&temporary, directory.path());
    }

    #[test]
    fn failed_existing_installer_retains_editor_temp_behind_third_party_destination() {
        use std::cell::RefCell;

        let directory = tempdir().unwrap();
        let destination = directory.path().join("document.md");
        fs::write(&destination, "original").unwrap();
        let expected = sha256(b"original");
        let observed_temporary = RefCell::new(None);

        let error = save_document_path_with_installer(
            &destination,
            "editor",
            Some(&expected),
            |temporary, target| {
                observed_temporary.replace(Some(temporary.to_owned()));
                fs::write(target, "third party")?;
                Err(io::Error::other("installer raced with third party"))
            },
        )
        .unwrap_err();

        let temporary = observed_temporary.into_inner().unwrap();
        assert!(error.contains("temporary document retained"));
        assert_eq!(fs::read_to_string(&destination).unwrap(), "third party");
        assert_eq!(fs::read_to_string(&temporary).unwrap(), "editor");
        remove_temporary(&temporary, directory.path());
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
    fn saved_result_uses_temp_metadata_when_destination_disappears_after_install() {
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
                fs::remove_file(target)
            },
        )
        .unwrap();

        assert!(matches!(
            result,
            SaveDocumentResult::Saved {
                sha256: actual_sha256,
                size: 6,
                modified_ms: Some(_),
                ..
            } if actual_sha256 == sha256(b"editor")
        ));
        assert!(!path.exists());
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
    fn read_content_and_metadata_come_from_one_open_file() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("document.md");
        let replacement = directory.path().join("replacement.md");
        fs::write(&path, "first").unwrap();
        fs::write(&replacement, "later external content").unwrap();

        let result = read_document_path_with_open_hook(&path, |_opened_path| {
            fs::rename(&replacement, &path)
        })
        .unwrap();

        assert_eq!(result.content, "first");
        assert_eq!(result.sha256, sha256(b"first"));
        assert_eq!(result.size, 5);
        assert_eq!(fs::read_to_string(path).unwrap(), "later external content");
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
    fn replacement_uses_permissions_from_immediately_before_publication() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let path = directory.path().join("document.md");
        fs::write(&path, "same").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        let expected = sha256(b"same");

        save_document_path_with_hooks(
            &path,
            "editor",
            Some(&expected),
            |temporary_file, destination| {
                assert_eq!(
                    temporary_file.metadata()?.permissions().mode() & 0o777,
                    0o600
                );
                temporary_file.write_all(b"editor")?;
                fs::set_permissions(destination, fs::Permissions::from_mode(0o600))
            },
            |source, target| fs::rename(source, target),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "editor");
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn replacement_stays_restrictive_until_a_late_permission_widening() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().unwrap();
        let path = directory.path().join("document.md");
        fs::write(&path, "same").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let expected = sha256(b"same");

        save_document_path_with_hooks(
            &path,
            "editor",
            Some(&expected),
            |temporary_file, destination| {
                assert_eq!(
                    temporary_file.metadata()?.permissions().mode() & 0o777,
                    0o600
                );
                temporary_file.write_all(b"editor")?;
                fs::set_permissions(destination, fs::Permissions::from_mode(0o644))
            },
            |source, target| fs::rename(source, target),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "editor");
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o644
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
