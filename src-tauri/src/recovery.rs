use serde::Deserialize;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use uuid::Uuid;

const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_PREVIOUS_FILE: &str = "manifest.previous.json";
const DOCUMENTS_DIRECTORY: &str = "documents";
const RECOVERY_SCHEMA_VERSION: u64 = 1;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestMetadata {
    schema_version: u64,
    generation: u64,
    active_document_id: String,
    next_untitled_number: u64,
    tabs: Vec<ManifestTab>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestTab {
    document_id: String,
    display_name: String,
    snapshot_revision: u64,
    #[serde(default)]
    canonical_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentMetadata {
    schema_version: u64,
    document_id: String,
    snapshot_revision: u64,
    edit_revision: u64,
    display_name: String,
    path: NullableString,
    canonical_path: NullableString,
    content: String,
    saved_content_sha256: String,
    expected_disk_sha256: NullableString,
    file_status: FileStatus,
    workspace: Workspace,
    #[serde(default)]
    recovery_status: Option<RecoveryStatus>,
}

#[derive(Debug, Deserialize)]
struct NullableString(Option<String>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum FileStatus {
    Normal,
    ExternallyChanged,
    Missing,
    ReadError,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RecoveryStatus {
    Clean,
    Pending,
    Writing,
    Failed,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Workspace {
    selection_start: u64,
    selection_end: u64,
    editor_scroll_top: f64,
    preview_scroll_top: f64,
    view_mode: ViewMode,
    toc_open: bool,
    find: FindState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ViewMode {
    Split,
    Edit,
    Preview,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FindState {
    open: bool,
    query: String,
    replacement: String,
    match_index: i64,
}

pub struct RecoveryStore {
    root: PathBuf,
    operation_lock: Mutex<()>,
}

impl RecoveryStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            operation_lock: Mutex::new(()),
        }
    }

    pub fn load_manifest(&self) -> Result<Vec<u8>, String> {
        self.load_manifest_optional()?
            .ok_or_else(|| "no recovery manifest found".to_string())
    }

    fn load_manifest_optional(&self) -> Result<Option<Vec<u8>>, String> {
        self.load_manifest_optional_with_cleanup(cleanup_stale_temps)
    }

    fn load_manifest_optional_with_cleanup<C>(&self, cleanup: C) -> Result<Option<Vec<u8>>, String>
    where
        C: FnOnce(&Path) -> Result<(), String>,
    {
        let _guard = self.lock()?;
        let current = self.manifest_path();
        let previous = self.manifest_previous_path();
        let _ = cleanup(&current);
        if !path_exists(&current)? && !path_exists(&previous)? {
            return Ok(None);
        }
        load_first_valid([current, previous], |bytes| {
            validate_manifest(bytes, None).map(|metadata| metadata.generation)
        })
        .map(Some)
    }

    pub fn write_manifest(&self, generation: u64, bytes: &[u8]) -> Result<(), String> {
        let _guard = self.lock()?;
        validate_manifest(bytes, Some(generation))?;

        atomic_rotate_write(
            &self.manifest_path(),
            &self.manifest_previous_path(),
            bytes,
            |current| validate_manifest(current, None).map(|_| ()),
        )
    }

    pub fn load_document(&self, id: &str, revision: u64) -> Result<Vec<u8>, String> {
        self.load_document_with_cleanup(id, revision, cleanup_stale_temps)
    }

    fn load_document_with_cleanup<C>(
        &self,
        id: &str,
        revision: u64,
        cleanup: C,
    ) -> Result<Vec<u8>, String>
    where
        C: FnOnce(&Path) -> Result<(), String>,
    {
        let _guard = self.lock()?;
        let current = self.document_path(id)?;
        let previous = self.document_previous_path(id)?;
        let _ = cleanup(&current);
        load_first_valid([current, previous], |bytes| {
            validate_document(bytes, id, Some(revision)).map(|_| ())
        })
    }

    pub fn write_document(&self, id: &str, revision: u64, bytes: &[u8]) -> Result<(), String> {
        let _guard = self.lock()?;
        validate_document(bytes, id, Some(revision))?;

        atomic_rotate_write(
            &self.document_path(id)?,
            &self.document_previous_path(id)?,
            bytes,
            |current| validate_document(current, id, None).map(|_| ()),
        )
    }

    pub fn delete_document(&self, id: &str) -> Result<(), String> {
        let _guard = self.lock()?;
        let current = self.document_path(id)?;
        let previous = self.document_previous_path(id)?;
        remove_if_exists(&current)?;
        remove_if_exists(&previous)?;
        sync_directory(current.parent());
        Ok(())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn lock(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.operation_lock
            .lock()
            .map_err(|_| "recovery store lock is poisoned".to_string())
    }

    fn manifest_path(&self) -> PathBuf {
        self.root.join(MANIFEST_FILE)
    }

    fn manifest_previous_path(&self) -> PathBuf {
        self.root.join(MANIFEST_PREVIOUS_FILE)
    }

    fn document_path(&self, id: &str) -> Result<PathBuf, String> {
        validate_document_id(id)?;
        Ok(self
            .root
            .join(DOCUMENTS_DIRECTORY)
            .join(format!("{id}.json")))
    }

    fn document_previous_path(&self, id: &str) -> Result<PathBuf, String> {
        validate_document_id(id)?;
        Ok(self
            .root
            .join(DOCUMENTS_DIRECTORY)
            .join(format!("{id}.previous.json")))
    }
}

fn validate_manifest(
    bytes: &[u8],
    expected_generation: Option<u64>,
) -> Result<ManifestMetadata, String> {
    let metadata: ManifestMetadata = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid recovery manifest: {error}"))?;
    if metadata.schema_version != RECOVERY_SCHEMA_VERSION {
        return Err(format!(
            "unsupported recovery manifest schema version: {}",
            metadata.schema_version
        ));
    }
    if metadata.generation > MAX_SAFE_INTEGER {
        return Err("manifest generation is not a JavaScript safe integer".to_string());
    }
    if let Some(expected) = expected_generation {
        if metadata.generation != expected {
            return Err(format!(
                "manifest generation mismatch: expected {expected}, found {}",
                metadata.generation
            ));
        }
    }
    if metadata.next_untitled_number == 0 || metadata.next_untitled_number > MAX_SAFE_INTEGER {
        return Err("next untitled number must be a positive JavaScript safe integer".to_string());
    }
    if metadata.tabs.is_empty() {
        return Err("recovery manifest tabs must not be empty".to_string());
    }

    let mut document_ids = HashSet::with_capacity(metadata.tabs.len());
    let mut canonical_paths = HashSet::with_capacity(metadata.tabs.len());
    let mut untitled_numbers = HashSet::with_capacity(metadata.tabs.len());
    let mut max_untitled_number = 0;
    for tab in &metadata.tabs {
        validate_document_id(&tab.document_id)?;
        if tab.display_name.is_empty() {
            return Err("recovery manifest tab display name must not be empty".to_string());
        }
        if tab.snapshot_revision > MAX_SAFE_INTEGER {
            return Err("tab snapshot revision is not a JavaScript safe integer".to_string());
        }
        if matches!(&tab.canonical_path, Some(path) if path.is_empty()) {
            return Err("recovery manifest canonical path must not be empty".to_string());
        }
        if let Some(path) = &tab.canonical_path {
            if !canonical_paths.insert(path.as_str()) {
                return Err("recovery manifest contains duplicate canonical paths".to_string());
            }
        }
        if let Some(number) = parse_generated_untitled_number(&tab.display_name)? {
            if !untitled_numbers.insert(number) {
                return Err("recovery manifest contains duplicate untitled labels".to_string());
            }
            max_untitled_number = max_untitled_number.max(number);
        }
        if !document_ids.insert(tab.document_id.as_str()) {
            return Err("recovery manifest contains duplicate document ids".to_string());
        }
    }
    if metadata.next_untitled_number <= max_untitled_number {
        return Err("recovery manifest untitled label state is inconsistent".to_string());
    }
    validate_document_id(&metadata.active_document_id)?;
    if !document_ids.contains(metadata.active_document_id.as_str()) {
        return Err("recovery manifest active document is not present in tabs".to_string());
    }

    Ok(metadata)
}

fn parse_generated_untitled_number(display_name: &str) -> Result<Option<u64>, String> {
    let Some(digits) = display_name.strip_prefix("Untitled ") else {
        return Ok(None);
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }

    // JavaScript Number accepts arbitrarily many leading zeroes, so remove
    // them before parsing while retaining zero as an invalid generated label.
    let significant_digits = digits.trim_start_matches('0');
    if significant_digits.is_empty() {
        return Err("untitled label must be a positive JavaScript safe integer".to_string());
    }
    let number = significant_digits
        .parse::<u64>()
        .map_err(|_| "untitled label is not a JavaScript safe integer".to_string())?;
    if number >= MAX_SAFE_INTEGER {
        return Err("untitled label must leave room for the next generated label".to_string());
    }

    Ok(Some(number))
}

fn validate_document(
    bytes: &[u8],
    expected_id: &str,
    expected_revision: Option<u64>,
) -> Result<DocumentMetadata, String> {
    validate_document_id(expected_id)?;
    let metadata: DocumentMetadata = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid recovery document: {error}"))?;
    if metadata.schema_version != RECOVERY_SCHEMA_VERSION {
        return Err(format!(
            "unsupported recovery document schema version: {}",
            metadata.schema_version
        ));
    }
    validate_document_id(&metadata.document_id)?;
    if metadata.document_id != expected_id {
        return Err(format!(
            "document id mismatch: expected {expected_id}, found {}",
            metadata.document_id
        ));
    }
    if let Some(expected) = expected_revision {
        if metadata.snapshot_revision != expected {
            return Err(format!(
                "snapshot revision mismatch: expected {expected}, found {}",
                metadata.snapshot_revision
            ));
        }
    }
    if !metadata.workspace.editor_scroll_top.is_finite()
        || metadata.workspace.editor_scroll_top < 0.0
        || !metadata.workspace.preview_scroll_top.is_finite()
        || metadata.workspace.preview_scroll_top < 0.0
    {
        return Err("document scroll positions must be non-negative finite numbers".to_string());
    }

    // Reading these fields makes the contract explicit: deserialization above
    // establishes the same required primitive types as DocumentModel.fromSnapshot.
    let _ = (
        metadata.edit_revision,
        &metadata.display_name,
        &metadata.path.0,
        &metadata.canonical_path.0,
        &metadata.content,
        &metadata.saved_content_sha256,
        &metadata.expected_disk_sha256.0,
        &metadata.file_status,
        metadata.workspace.selection_start,
        metadata.workspace.selection_end,
        &metadata.workspace.view_mode,
        metadata.workspace.toc_open,
        metadata.workspace.find.open,
        &metadata.workspace.find.query,
        &metadata.workspace.find.replacement,
        metadata.workspace.find.match_index,
        &metadata.recovery_status,
    );

    Ok(metadata)
}

pub(crate) fn validate_document_id(id: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(id).map_err(|_| "document id must be a UUID".to_string())?;
    if parsed.hyphenated().to_string() != id {
        return Err("document id must be a canonical lowercase UUID".to_string());
    }
    Ok(())
}

fn load_first_valid<T, F>(paths: [PathBuf; 2], validate: F) -> Result<Vec<u8>, String>
where
    F: Fn(&[u8]) -> Result<T, String>,
{
    let mut errors = Vec::with_capacity(paths.len());
    for path in paths {
        match fs::read(&path) {
            Ok(bytes) => match validate(&bytes) {
                Ok(_) => return Ok(bytes),
                Err(error) => errors.push(format!("{}: {error}", path.display())),
            },
            Err(error) => errors.push(format!("{}: {error}", path.display())),
        }
    }

    Err(format!(
        "no valid recovery copy found ({})",
        errors.join("; ")
    ))
}

fn atomic_rotate_write<V>(
    current: &Path,
    previous: &Path,
    bytes: &[u8],
    validate_current: V,
) -> Result<(), String>
where
    V: Fn(&[u8]) -> Result<(), String>,
{
    atomic_rotate_write_with_installer(
        current,
        previous,
        bytes,
        validate_current,
        |source, target| fs::rename(source, target),
    )
}

fn atomic_rotate_write_with_installer<V, I>(
    current: &Path,
    previous: &Path,
    bytes: &[u8],
    validate_current: V,
    install: I,
) -> Result<(), String>
where
    V: Fn(&[u8]) -> Result<(), String>,
    I: FnOnce(&Path, &Path) -> io::Result<()>,
{
    atomic_rotate_write_with_hooks(
        current,
        previous,
        bytes,
        validate_current,
        install,
        cleanup_stale_temps,
        sync_directory,
    )
}

fn atomic_rotate_write_with_hooks<V, I, C, S>(
    current: &Path,
    previous: &Path,
    bytes: &[u8],
    validate_current: V,
    install: I,
    cleanup: C,
    sync: S,
) -> Result<(), String>
where
    V: Fn(&[u8]) -> Result<(), String>,
    I: FnOnce(&Path, &Path) -> io::Result<()>,
    C: FnOnce(&Path) -> Result<(), String>,
    S: FnOnce(Option<&Path>),
{
    let directory = current
        .parent()
        .ok_or_else(|| "recovery path has no parent directory".to_string())?;
    fs::create_dir_all(directory).map_err(|error| {
        format!(
            "failed to create recovery directory {}: {error}",
            directory.display()
        )
    })?;

    let file_name = current
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "recovery path has no valid file name".to_string())?;
    let temporary = directory.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));

    let write_result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "failed to write temporary recovery file {}: {error}",
            temporary.display()
        ));
    }

    match fs::read(current) {
        Ok(current_bytes) if validate_current(&current_bytes).is_ok() => {
            if let Err(error) = remove_if_exists(previous) {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
            if let Err(error) = fs::rename(current, previous) {
                let _ = fs::remove_file(&temporary);
                return Err(format!(
                    "failed to rotate recovery file {} to {}: {error}",
                    current.display(),
                    previous.display()
                ));
            }
        }
        Ok(_) => {
            if let Err(error) = remove_if_exists(current) {
                let _ = fs::remove_file(&temporary);
                return Err(error);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(format!(
                "failed to inspect recovery file {}: {error}",
                current.display()
            ));
        }
    }

    if let Err(error) = install(&temporary, current) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "failed to install recovery file {}: {error}",
            current.display()
        ));
    }

    sync(Some(directory));
    let _ = cleanup(current);
    Ok(())
}

fn cleanup_stale_temps(target: &Path) -> Result<(), String> {
    let directory = target
        .parent()
        .ok_or_else(|| "recovery path has no parent directory".to_string())?;
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "recovery path has no valid file name".to_string())?;
    let prefix = format!(".{target_name}.");

    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "failed to inspect recovery directory {}: {error}",
                directory.display()
            ))
        }
    };

    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "failed to inspect recovery directory {}: {error}",
                directory.display()
            )
        })?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "failed to inspect recovery temp {}: {error}",
                entry.path().display()
            )
        })?;
        if !file_type.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(uuid) = file_name
            .strip_prefix(&prefix)
            .and_then(|name| name.strip_suffix(".tmp"))
        else {
            continue;
        };
        let Ok(parsed) = Uuid::parse_str(uuid) else {
            continue;
        };
        if parsed.hyphenated().to_string() != uuid {
            continue;
        }
        remove_if_exists(&entry.path())?;
    }

    Ok(())
}

fn remove_if_exists(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove recovery file {}: {error}",
            path.display()
        )),
    }
}

fn path_exists(path: &Path) -> Result<bool, String> {
    path.try_exists().map_err(|error| {
        format!(
            "failed to inspect recovery file {}: {error}",
            path.display()
        )
    })
}

fn sync_directory(directory: Option<&Path>) {
    #[cfg(unix)]
    if let Some(directory) = directory {
        let _ = File::open(directory).and_then(|file| file.sync_all());
    }

    #[cfg(not(unix))]
    let _ = directory;
}

#[tauri::command]
pub(crate) fn load_recovery_manifest(
    store: tauri::State<'_, RecoveryStore>,
) -> Result<Option<String>, String> {
    store
        .load_manifest_optional()?
        .map(|bytes| {
            String::from_utf8(bytes)
                .map_err(|error| format!("recovery manifest is not UTF-8: {error}"))
        })
        .transpose()
}

#[tauri::command]
pub(crate) fn write_recovery_manifest(
    store: tauri::State<'_, RecoveryStore>,
    generation: u64,
    json: String,
) -> Result<(), String> {
    store.write_manifest(generation, json.as_bytes())
}

#[tauri::command]
pub(crate) fn load_recovery_document(
    store: tauri::State<'_, RecoveryStore>,
    document_id: String,
    snapshot_revision: u64,
) -> Result<String, String> {
    String::from_utf8(store.load_document(&document_id, snapshot_revision)?)
        .map_err(|error| format!("recovery document is not UTF-8: {error}"))
}

#[tauri::command]
pub(crate) fn write_recovery_document(
    store: tauri::State<'_, RecoveryStore>,
    document_id: String,
    revision: u64,
    json: String,
) -> Result<(), String> {
    store.write_document(&document_id, revision, json.as_bytes())
}

#[tauri::command]
pub(crate) fn delete_recovery_document(
    store: tauri::State<'_, RecoveryStore>,
    document_id: String,
) -> Result<(), String> {
    store.delete_document(&document_id)
}

fn recovery_directory_path(store: &RecoveryStore) -> Result<String, String> {
    store
        .root()
        .to_str()
        .map(|path| path.to_owned())
        .ok_or_else(|| "recovery directory path is not valid UTF-8".to_string())
}

#[tauri::command]
pub(crate) fn recovery_directory(store: tauri::State<'_, RecoveryStore>) -> Result<String, String> {
    recovery_directory_path(&store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::fs;
    use tempfile::tempdir;

    const DOCUMENT_ID: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER_DOCUMENT_ID: &str = "22222222-2222-4222-8222-222222222222";

    fn manifest(generation: u64) -> Vec<u8> {
        format!(
            r#"{{"schemaVersion":1,"generation":{generation},"activeDocumentId":"{DOCUMENT_ID}","nextUntitledNumber":1,"tabs":[{{"documentId":"{DOCUMENT_ID}","displayName":"Document","snapshotRevision":1}}]}}"#
        )
        .into_bytes()
    }

    fn manifest_with_tabs(
        generation: u64,
        next_untitled_number: u64,
        tabs: &[(&str, &str, Option<&str>)],
    ) -> Vec<u8> {
        let tabs: Vec<_> = tabs
            .iter()
            .map(|(document_id, display_name, canonical_path)| {
                serde_json::json!({
                    "documentId": document_id,
                    "displayName": display_name,
                    "snapshotRevision": 1,
                    "canonicalPath": canonical_path,
                })
            })
            .collect();
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "generation": generation,
            "activeDocumentId": tabs[0]["documentId"],
            "nextUntitledNumber": next_untitled_number,
            "tabs": tabs,
        }))
        .unwrap()
    }

    fn assert_invalid_current_manifest_falls_back(invalid: &[u8]) {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));
        store.write_manifest(1, &manifest(1)).unwrap();
        store.write_manifest(2, &manifest(2)).unwrap();
        fs::write(store.manifest_path(), invalid).unwrap();

        assert_eq!(store.load_manifest().unwrap(), manifest(1));
    }

    fn document(revision: u64) -> Vec<u8> {
        document_for(DOCUMENT_ID, revision)
    }

    fn document_for(document_id: &str, revision: u64) -> Vec<u8> {
        format!(
            r#"{{"schemaVersion":1,"documentId":"{document_id}","snapshotRevision":{revision},"editRevision":{revision},"displayName":"Document","path":null,"canonicalPath":null,"content":"revision {revision}","savedContentSha256":"","expectedDiskSha256":null,"fileStatus":"normal","workspace":{{"selectionStart":0,"selectionEnd":0,"editorScrollTop":0,"previewScrollTop":0,"viewMode":"split","tocOpen":false,"find":{{"open":false,"query":"","replacement":"","matchIndex":-1}}}}}}"#
        )
        .into_bytes()
    }

    #[test]
    fn recovery_directory_returns_utf8_root() {
        let store = RecoveryStore::new(tempdir().unwrap().path().join("session-v1"));
        assert_eq!(
            recovery_directory_path(&store).unwrap(),
            store.root().to_str().unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn recovery_directory_rejects_non_utf8_root() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let store = RecoveryStore::new(PathBuf::from(OsString::from_vec(vec![0xff, b's', b'e'])));
        assert_eq!(
            recovery_directory_path(&store).unwrap_err(),
            "recovery directory path is not valid UTF-8"
        );
    }

    #[test]
    fn document_ids_must_be_canonical_lowercase_uuids() {
        assert!(validate_document_id("../../outside").is_err());
        assert!(validate_document_id("not-a-uuid").is_err());
        assert!(validate_document_id("11111111-1111-4111-8111-111111111111").is_ok());
        assert!(validate_document_id("11111111-1111-4111-8111-11111111111A").is_err());
    }

    #[test]
    fn document_writes_rotate_the_current_revision() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_document(DOCUMENT_ID, 1, &document(1)).unwrap();
        store.write_document(DOCUMENT_ID, 2, &document(2)).unwrap();

        assert_eq!(store.load_document(DOCUMENT_ID, 2).unwrap(), document(2));
        assert!(store.document_previous_path(DOCUMENT_ID).unwrap().exists());
        assert_eq!(
            fs::read(store.document_previous_path(DOCUMENT_ID).unwrap()).unwrap(),
            document(1)
        );
    }

    #[test]
    fn corrupt_current_document_falls_back_to_requested_previous_revision() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_document(DOCUMENT_ID, 1, &document(1)).unwrap();
        store.write_document(DOCUMENT_ID, 2, &document(2)).unwrap();
        fs::write(store.document_path(DOCUMENT_ID).unwrap(), b"not json").unwrap();

        assert_eq!(store.load_document(DOCUMENT_ID, 1).unwrap(), document(1));
    }

    #[test]
    fn document_loader_uses_the_copy_matching_the_requested_revision() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_document(DOCUMENT_ID, 1, &document(1)).unwrap();
        store.write_document(DOCUMENT_ID, 2, &document(2)).unwrap();

        assert_eq!(store.load_document(DOCUMENT_ID, 1).unwrap(), document(1));
        assert!(store.load_document(DOCUMENT_ID, 3).is_err());
    }

    #[test]
    fn manifest_writes_rotate_and_load_the_latest_generation() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_manifest(1, &manifest(1)).unwrap();
        store.write_manifest(2, &manifest(2)).unwrap();

        assert_eq!(store.load_manifest().unwrap(), manifest(2));
        assert!(store.manifest_previous_path().exists());
        assert_eq!(
            fs::read(store.manifest_previous_path()).unwrap(),
            manifest(1)
        );
    }

    #[test]
    fn corrupt_current_manifest_falls_back_to_previous_generation() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_manifest(1, &manifest(1)).unwrap();
        store.write_manifest(2, &manifest(2)).unwrap();
        fs::write(store.manifest_path(), b"not json").unwrap();

        assert_eq!(store.load_manifest().unwrap(), manifest(1));
    }

    #[test]
    fn unsupported_current_manifest_falls_back_to_complete_previous_manifest() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_manifest(1, &manifest(1)).unwrap();
        store.write_manifest(2, &manifest(2)).unwrap();
        fs::write(
            store.manifest_path(),
            br#"{"schemaVersion":999,"generation":2}"#,
        )
        .unwrap();

        assert_eq!(store.load_manifest().unwrap(), manifest(1));
    }

    #[test]
    fn duplicate_canonical_paths_in_current_manifest_fall_back_to_previous() {
        let invalid = manifest_with_tabs(
            2,
            1,
            &[
                (DOCUMENT_ID, "First", Some("/same.md")),
                (OTHER_DOCUMENT_ID, "Second", Some("/same.md")),
            ],
        );

        assert_invalid_current_manifest_falls_back(&invalid);
    }

    #[test]
    fn duplicate_generated_untitled_numbers_in_current_manifest_fall_back_to_previous() {
        let invalid = manifest_with_tabs(
            2,
            2,
            &[
                (DOCUMENT_ID, "Untitled 1", None),
                (OTHER_DOCUMENT_ID, "Untitled 01", None),
            ],
        );

        assert_invalid_current_manifest_falls_back(&invalid);
    }

    #[test]
    fn inconsistent_next_untitled_number_in_current_manifest_falls_back_to_previous() {
        let invalid = manifest_with_tabs(2, 7, &[(DOCUMENT_ID, "Untitled 7", Some("/draft.md"))]);

        assert_invalid_current_manifest_falls_back(&invalid);
    }

    #[test]
    fn invalid_generated_untitled_bounds_in_current_manifest_fall_back_to_previous() {
        for label in ["Untitled 0", "Untitled 9007199254740991"] {
            let invalid = manifest_with_tabs(2, MAX_SAFE_INTEGER, &[(DOCUMENT_ID, label, None)]);
            assert_invalid_current_manifest_falls_back(&invalid);
        }
    }

    #[test]
    fn valid_generated_untitled_edge_manifests_are_accepted() {
        let leading_zero_and_non_namespace = manifest_with_tabs(
            2,
            2,
            &[
                (DOCUMENT_ID, "Untitled 01", None),
                (OTHER_DOCUMENT_ID, "Untitled 1.0", None),
            ],
        );
        let terminal_progressable = manifest_with_tabs(
            3,
            MAX_SAFE_INTEGER,
            &[(DOCUMENT_ID, "Untitled 9007199254740990", None)],
        );

        assert!(validate_manifest(&leading_zero_and_non_namespace, None).is_ok());
        assert!(validate_manifest(&terminal_progressable, None).is_ok());
    }

    #[test]
    fn incomplete_current_document_falls_back_to_complete_previous_document() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_document(DOCUMENT_ID, 1, &document(1)).unwrap();
        store.write_document(DOCUMENT_ID, 2, &document(2)).unwrap();
        fs::write(
            store.document_path(DOCUMENT_ID).unwrap(),
            format!(r#"{{"schemaVersion":1,"documentId":"{DOCUMENT_ID}","snapshotRevision":1}}"#),
        )
        .unwrap();

        assert_eq!(store.load_document(DOCUMENT_ID, 1).unwrap(), document(1));
    }

    #[test]
    fn document_id_mismatch_is_rejected_on_write() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        assert!(store
            .write_document(DOCUMENT_ID, 1, &document_for(OTHER_DOCUMENT_ID, 1))
            .is_err());
        assert!(!store.root().exists());
    }

    #[test]
    fn mismatched_current_document_id_falls_back_to_expected_document() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_document(DOCUMENT_ID, 1, &document(1)).unwrap();
        store.write_document(DOCUMENT_ID, 2, &document(2)).unwrap();
        fs::write(
            store.document_path(DOCUMENT_ID).unwrap(),
            document_for(OTHER_DOCUMENT_ID, 1),
        )
        .unwrap();

        assert_eq!(store.load_document(DOCUMENT_ID, 1).unwrap(), document(1));
    }

    #[test]
    fn corrupt_current_is_not_promoted_over_a_valid_previous_copy() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_document(DOCUMENT_ID, 1, &document(1)).unwrap();
        store.write_document(DOCUMENT_ID, 2, &document(2)).unwrap();
        fs::write(store.document_path(DOCUMENT_ID).unwrap(), b"not json").unwrap();
        store.write_document(DOCUMENT_ID, 3, &document(3)).unwrap();

        assert_eq!(store.load_document(DOCUMENT_ID, 1).unwrap(), document(1));
    }

    #[test]
    fn failed_install_after_corrupt_current_preserves_valid_previous_copy() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));
        let current = store.document_path(DOCUMENT_ID).unwrap();
        let previous = store.document_previous_path(DOCUMENT_ID).unwrap();
        fs::create_dir_all(current.parent().unwrap()).unwrap();
        fs::write(&current, b"not json").unwrap();
        fs::write(&previous, document(1)).unwrap();

        let result = atomic_rotate_write_with_installer(
            &current,
            &previous,
            &document(2),
            |bytes| {
                serde_json::from_slice::<DocumentMetadata>(bytes)
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            },
            |_, _| Err(io::Error::new(io::ErrorKind::PermissionDenied, "injected")),
        );

        assert!(result.is_err());
        assert_eq!(store.load_document(DOCUMENT_ID, 1).unwrap(), document(1));
    }

    #[test]
    fn loading_removes_only_same_target_uuid_temp_files() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));
        store.write_document(DOCUMENT_ID, 1, &document(1)).unwrap();
        let documents = store.document_path(DOCUMENT_ID).unwrap();
        let documents = documents.parent().unwrap();
        let stale = documents.join(format!(
            ".{DOCUMENT_ID}.json.{}.tmp",
            "33333333-3333-4333-8333-333333333333"
        ));
        let unrelated = documents.join(format!(
            ".other.json.{}.tmp",
            "44444444-4444-4444-8444-444444444444"
        ));
        let malformed = documents.join(format!(".{DOCUMENT_ID}.json.not-a-uuid.tmp"));
        fs::write(&stale, b"stale").unwrap();
        fs::write(&unrelated, b"unrelated").unwrap();
        fs::write(&malformed, b"malformed").unwrap();

        store.load_document(DOCUMENT_ID, 1).unwrap();

        assert!(!stale.exists());
        assert!(unrelated.exists());
        assert!(malformed.exists());
    }

    #[test]
    fn cleanup_failure_does_not_block_a_valid_manifest_load() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));
        store.write_manifest(1, &manifest(1)).unwrap();

        let loaded = store
            .load_manifest_optional_with_cleanup(|_| Err("injected cleanup failure".to_string()));

        assert_eq!(loaded.unwrap(), Some(manifest(1)));
    }

    #[test]
    fn cleanup_failure_does_not_veto_an_installed_write_or_directory_sync() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));
        let current = store.document_path(DOCUMENT_ID).unwrap();
        let previous = store.document_previous_path(DOCUMENT_ID).unwrap();
        let directory_synced = Cell::new(false);

        let result = atomic_rotate_write_with_hooks(
            &current,
            &previous,
            &document(1),
            |bytes| validate_document(bytes, DOCUMENT_ID, None).map(|_| ()),
            |source, target| fs::rename(source, target),
            |_| Err("injected cleanup failure".to_string()),
            |_| directory_synced.set(true),
        );

        assert!(result.is_ok());
        assert!(directory_synced.get());
        assert_eq!(fs::read(current).unwrap(), document(1));
    }

    #[test]
    fn startup_manifest_load_distinguishes_absent_from_corrupt_storage() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        assert_eq!(store.load_manifest_optional().unwrap(), None);

        fs::create_dir_all(store.root()).unwrap();
        fs::write(store.manifest_path(), b"not json").unwrap();
        assert!(store.load_manifest_optional().is_err());
    }

    #[test]
    fn writes_reject_json_with_a_mismatched_version() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        assert!(store.write_manifest(1, &manifest(2)).is_err());
        assert!(store.write_document(DOCUMENT_ID, 1, &document(2)).is_err());
        assert!(!store.root().exists());
    }

    #[test]
    fn deleting_a_document_removes_both_generations() {
        let directory = tempdir().unwrap();
        let store = RecoveryStore::new(directory.path().join("session-v1"));

        store.write_document(DOCUMENT_ID, 1, &document(1)).unwrap();
        store.write_document(DOCUMENT_ID, 2, &document(2)).unwrap();
        store.delete_document(DOCUMENT_ID).unwrap();

        assert!(!store.document_path(DOCUMENT_ID).unwrap().exists());
        assert!(!store.document_previous_path(DOCUMENT_ID).unwrap().exists());
        assert!(store.load_document(DOCUMENT_ID, 2).is_err());
    }
}
