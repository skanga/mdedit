use serde::Deserialize;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const MANIFEST_FILE: &str = "manifest.json";
const MANIFEST_PREVIOUS_FILE: &str = "manifest.previous.json";
const DOCUMENTS_DIRECTORY: &str = "documents";

#[derive(Debug, Deserialize)]
struct ManifestMetadata {
    generation: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentMetadata {
    snapshot_revision: u64,
}

pub struct RecoveryStore {
    root: PathBuf,
}

impl RecoveryStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn load_manifest(&self) -> Result<Vec<u8>, String> {
        load_first_valid(
            [self.manifest_path(), self.manifest_previous_path()],
            |bytes| {
                serde_json::from_slice::<ManifestMetadata>(bytes)
                    .map(|metadata| metadata.generation)
                    .map_err(|error| format!("invalid recovery manifest: {error}"))
            },
        )
    }

    pub fn write_manifest(&self, generation: u64, bytes: &[u8]) -> Result<(), String> {
        let metadata: ManifestMetadata = serde_json::from_slice(bytes)
            .map_err(|error| format!("invalid recovery manifest: {error}"))?;
        if metadata.generation != generation {
            return Err(format!(
                "manifest generation mismatch: expected {generation}, found {}",
                metadata.generation
            ));
        }

        atomic_rotate_write(&self.manifest_path(), &self.manifest_previous_path(), bytes)
    }

    pub fn load_document(&self, id: &str, revision: u64) -> Result<Vec<u8>, String> {
        load_first_valid(
            [self.document_path(id)?, self.document_previous_path(id)?],
            |bytes| {
                let metadata: DocumentMetadata = serde_json::from_slice(bytes)
                    .map_err(|error| format!("invalid recovery document: {error}"))?;
                if metadata.snapshot_revision != revision {
                    return Err(format!(
                        "snapshot revision mismatch: expected {revision}, found {}",
                        metadata.snapshot_revision
                    ));
                }
                Ok(metadata.snapshot_revision)
            },
        )
    }

    pub fn write_document(&self, id: &str, revision: u64, bytes: &[u8]) -> Result<(), String> {
        let metadata: DocumentMetadata = serde_json::from_slice(bytes)
            .map_err(|error| format!("invalid recovery document: {error}"))?;
        if metadata.snapshot_revision != revision {
            return Err(format!(
                "snapshot revision mismatch: expected {revision}, found {}",
                metadata.snapshot_revision
            ));
        }

        atomic_rotate_write(
            &self.document_path(id)?,
            &self.document_previous_path(id)?,
            bytes,
        )
    }

    pub fn delete_document(&self, id: &str) -> Result<(), String> {
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

fn atomic_rotate_write(current: &Path, previous: &Path, bytes: &[u8]) -> Result<(), String> {
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

    if current.exists() {
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

    if let Err(error) = fs::rename(&temporary, current) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "failed to install recovery file {}: {error}",
            current.display()
        ));
    }

    sync_directory(Some(directory));
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
) -> Result<String, String> {
    String::from_utf8(store.load_manifest()?)
        .map_err(|error| format!("recovery manifest is not UTF-8: {error}"))
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
    revision: u64,
) -> Result<String, String> {
    String::from_utf8(store.load_document(&document_id, revision)?)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    const DOCUMENT_ID: &str = "11111111-1111-4111-8111-111111111111";

    fn manifest(generation: u64) -> Vec<u8> {
        format!(r#"{{"generation":{generation},"tabs":[]}}"#).into_bytes()
    }

    fn document(revision: u64) -> Vec<u8> {
        format!(
            r#"{{"documentId":"{DOCUMENT_ID}","snapshotRevision":{revision},"content":"revision {revision}"}}"#
        )
        .into_bytes()
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
