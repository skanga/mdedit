use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentDocument {
    pub path: String,
    pub canonical_path: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct History {
    schema_version: u32,
    documents: Vec<RecentDocument>,
}

pub struct RecentDocumentsStore {
    root: PathBuf,
    lock: Mutex<()>,
}

impl RecentDocumentsStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            lock: Mutex::new(()),
        }
    }
    fn read(&self) -> Result<Vec<RecentDocument>, String> {
        let current = self.root.join("recent-documents.json");
        let previous = self.root.join("recent-documents.previous.json");
        let mut errors = Vec::new();
        for path in [&current, &previous] {
            match fs::read(path) {
                Ok(bytes) => match decode(&bytes) {
                    Ok(history) => return Ok(history.documents),
                    Err(error) => errors.push(error),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => errors.push(error.to_string()),
            }
        }
        if errors.is_empty() {
            Ok(vec![])
        } else {
            Err(format!(
                "Could not load recent documents: {}",
                errors.join("; ")
            ))
        }
    }

    fn write(&self, documents: Vec<RecentDocument>) -> Result<(), String> {
        let bytes = serde_json::to_vec(&History {
            schema_version: 1,
            documents,
        })
        .map_err(|error| error.to_string())?;
        crate::recovery::atomic_rotate_write(
            &self.root.join("recent-documents.json"),
            &self.root.join("recent-documents.previous.json"),
            &bytes,
            |bytes| decode(bytes).map(|_| ()),
        )
    }

    pub fn list(&self) -> Result<Vec<RecentDocument>, String> {
        let _guard = self.lock.lock().map_err(|error| error.to_string())?;
        self.read()
    }

    pub fn remember(&self, path: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|error| error.to_string())?;
        if !Path::new(path).is_absolute() || !Path::new(path).is_file() {
            return Err("Recent document must be an absolute file path".into());
        }
        let canonical_path = crate::document_io::canonical_comparison_path(Path::new(path))?;
        let mut documents = self.read()?;
        documents.retain(|entry| entry.canonical_path != canonical_path);
        documents.insert(
            0,
            RecentDocument {
                path: path.into(),
                canonical_path,
            },
        );
        documents.truncate(20);
        self.write(documents)
    }

    pub fn remove(&self, canonical_path: &str) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|error| error.to_string())?;
        let mut documents = self.read()?;
        documents.retain(|entry| entry.canonical_path != canonical_path);
        self.write(documents)?;
        self.remove_previous()
    }

    fn remove_previous(&self) -> Result<(), String> {
        match fs::remove_file(self.root.join("recent-documents.previous.json")) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not remove previous recent history: {error}")),
        }
    }

    pub fn clear(&self) -> Result<(), String> {
        let _guard = self.lock.lock().map_err(|error| error.to_string())?;
        self.write(vec![])?;
        self.remove_previous()
    }
}

fn decode(bytes: &[u8]) -> Result<History, String> {
    let history: History = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let mut seen = std::collections::HashSet::new();
    if history.schema_version != 1
        || history.documents.len() > 20
        || history.documents.iter().any(|entry| {
            !Path::new(&entry.path).is_absolute()
                || entry.path.contains('\0')
                || !Path::new(&entry.canonical_path).is_absolute()
                || entry.canonical_path.contains('\0')
                || !seen.insert(&entry.canonical_path)
        })
    {
        return Err("Invalid recent document history".into());
    }
    Ok(history)
}

#[tauri::command(async)]
pub(crate) fn list_recent_documents(
    store: tauri::State<'_, RecentDocumentsStore>,
) -> Result<Vec<RecentDocument>, String> {
    store.list()
}

#[tauri::command(async)]
pub(crate) fn remember_recent_document(
    store: tauri::State<'_, RecentDocumentsStore>,
    path: String,
) -> Result<(), String> {
    store.remember(&path)
}

#[tauri::command(async)]
pub(crate) fn remove_recent_document(
    store: tauri::State<'_, RecentDocumentsStore>,
    canonical_path: String,
) -> Result<(), String> {
    store.remove(&canonical_path)
}

#[tauri::command(async)]
pub(crate) fn clear_recent_documents(
    store: tauri::State<'_, RecentDocumentsStore>,
) -> Result<(), String> {
    store.clear()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("mdedit-recents-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn store(&self) -> RecentDocumentsStore {
            RecentDocumentsStore::new(self.0.join("history"))
        }
        fn file(&self, name: &str) -> String {
            let path = self.0.join(name);
            fs::write(&path, "content").unwrap();
            path.to_str().unwrap().to_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn remembers_twenty_unique_files_in_most_recent_order_across_restarts() {
        let fixture = Fixture::new();
        let store = fixture.store();
        assert!(store.list().unwrap().is_empty());
        let paths: Vec<_> = (0..23).map(|n| fixture.file(&format!("{n}.md"))).collect();
        for path in &paths {
            store.remember(path).unwrap();
        }
        store.remember(&paths[5]).unwrap();
        let entries = fixture.store().list().unwrap();
        assert_eq!(entries.len(), 20);
        assert_eq!(entries[0].path, paths[5]);
        assert_eq!(entries[1].path, paths[22]);
        assert!(!entries.iter().any(|entry| entry.path == paths[0]));
    }

    #[test]
    fn remove_missing_file_and_clear_do_not_touch_documents() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let first = fixture.file("first.md");
        let second = fixture.file("second.md");
        store.remember(&first).unwrap();
        store.remember(&second).unwrap();
        let key = store.list().unwrap()[1].canonical_path.clone();
        fs::remove_file(&first).unwrap();
        assert_eq!(store.list().unwrap().len(), 2);
        store.remove(&key).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        store.clear().unwrap();
        assert!(fixture.store().list().unwrap().is_empty());
        assert!(Path::new(&second).exists());
        assert!(!store.root.join("recent-documents.previous.json").exists());
    }

    #[test]
    fn corrupt_history_can_be_cleared_and_invalid_paths_are_rejected() {
        let fixture = Fixture::new();
        let store = fixture.store();
        fs::create_dir_all(&store.root).unwrap();
        fs::write(store.root.join("recent-documents.json"), "broken").unwrap();
        assert!(store.list().is_err());
        store.clear().unwrap();
        assert!(store.list().unwrap().is_empty());
        assert!(store.remember("relative.md").is_err());
        assert!(store.remember(fixture.0.to_str().unwrap()).is_err());
    }

    #[test]
    fn failed_write_leaves_previous_history_readable() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let first = fixture.file("first.md");
        store.remember(&first).unwrap();
        fs::create_dir(store.root.join("recent-documents.previous.json")).unwrap();
        assert!(store.remember(&fixture.file("second.md")).is_err());
        assert_eq!(store.list().unwrap()[0].path, first);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_aliases_share_one_entry() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let path = fixture.file("original.md");
        let alias = fixture.0.join("alias.md");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        store.remember(&path).unwrap();
        store.remember(alias.to_str().unwrap()).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        assert_eq!(store.list().unwrap()[0].path, alias.to_str().unwrap());
    }
}
