//! Windows-native integration tests. Provider tests are explicitly ignored
//! unless a runner supplies a disposable parent via MDEDIT_SAVE_TEST_ROOT.

use super::*;

fn provider_directory() -> PathBuf {
    let root = std::env::var_os("MDEDIT_SAVE_TEST_ROOT")
        .filter(|root| !root.is_empty())
        .expect("set MDEDIT_SAVE_TEST_ROOT to an existing disposable Windows-accessible parent");
    let directory = tempfile::Builder::new()
        .prefix("mdedit-provider-")
        .tempdir_in(PathBuf::from(root))
        .expect("create provider fixture directory")
        .keep();
    // Keep only our random child, never remove or mutate the supplied parent.
    // Keeping evidence also avoids deleting recovery artifacts after a panic.
    eprintln!("fixture retained at {}", directory.display());
    directory
}

#[test]
fn native_windows_existing_save_round_trip() {
    let directory = tempfile::tempdir().unwrap();
    assert!(windows_save::inspect_persistent_acls(directory.path()).unwrap());
    let destination = directory.path().join("document.md");
    fs::write(&destination, "original").unwrap();
    let original = read_document_path(&destination).unwrap();
    let result = save_document_path(&destination, "editor", Some(&original.sha256)).unwrap();
    assert!(matches!(result, SaveDocumentResult::Saved { .. }));
    assert_eq!(fs::read(&destination).unwrap(), b"editor");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn native_windows_compatibility_primitive_replaces_without_backup() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("document.md");
    let temporary = directory.path().join("temporary.md");
    fs::write(&destination, "original").unwrap();
    let mut file = File::create(&temporary).unwrap();
    file.write_all(b"editor").unwrap();
    file.sync_all().unwrap();
    drop(file);
    let original = DocumentIdentity {
        sha256: sha256(b"original"),
        size: 8,
    };
    let editor = DocumentIdentity {
        sha256: sha256(b"editor"),
        size: 6,
    };
    complete_compatibility_replacement(
        windows_save::replace_compatible(&temporary, &destination),
        &temporary,
        &destination,
        directory.path(),
        &original,
        &editor,
    )
    .unwrap();
    assert_eq!(fs::read(&destination).unwrap(), b"editor");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn native_windows_compatibility_primitive_rejects_different_directories() {
    let source = tempfile::tempdir().unwrap();
    let target = tempfile::tempdir().unwrap();
    let temporary = source.path().join("temporary.md");
    let destination = target.path().join("document.md");
    fs::write(&temporary, "editor").unwrap();
    fs::write(&destination, "original").unwrap();
    assert_eq!(
        windows_save::replace_compatible(&temporary, &destination)
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidInput,
    );
    assert_eq!(fs::read(&destination).unwrap(), b"original");
    assert_eq!(fs::read(&temporary).unwrap(), b"editor");
}

#[test]
#[ignore = "requires MDEDIT_SAVE_TEST_ROOT on a configured Windows provider runner"]
fn provider_new_save_round_trip_and_no_clobber() {
    let directory = provider_directory();
    let acls = windows_save::inspect_persistent_acls(&directory).unwrap();
    eprintln!("persistent Windows ACLs: {acls}");
    let destination = directory.join("new-unicode-\u{03b1}.md");
    let result = save_document_path(&destination, "editor", None).unwrap();
    assert!(matches!(result, SaveDocumentResult::Saved { .. }));
    assert_eq!(fs::read(&destination).unwrap(), b"editor");
    let conflict = save_document_path(&destination, "must not overwrite", None).unwrap();
    assert!(matches!(conflict, SaveDocumentResult::Conflict { .. }));
    assert_eq!(fs::read(&destination).unwrap(), b"editor");
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
}

#[test]
#[ignore = "requires MDEDIT_SAVE_TEST_ROOT on a configured Windows provider runner"]
fn provider_existing_save_obeys_security_policy() {
    let directory = provider_directory();
    let destination = directory.join("existing.md");
    fs::write(&destination, "original").unwrap();
    let original = read_document_path(&destination).unwrap();
    let acls = windows_save::inspect_persistent_acls(&directory).unwrap();
    eprintln!("persistent Windows ACLs: {acls}");
    let result = save_document_path(&destination, "editor", Some(&original.sha256));
    eprintln!("save result: {result:?}");
    if acls {
        assert!(matches!(result, Ok(SaveDocumentResult::Saved { .. })));
        assert_eq!(fs::read(&destination).unwrap(), b"editor");
    } else {
        let token = match result.unwrap() {
            SaveDocumentResult::CompatibilityRequired { compatibility_path } => compatibility_path,
            other => panic!("expected consent request, got {other:?}"),
        };
        assert_eq!(fs::read(&destination).unwrap(), b"original");
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        // Consent for another resolved destination must not transfer here.
        let wrong_token = format!("{token}-other");
        assert!(matches!(
            save_document_path_with_compatibility(
                &destination,
                "editor",
                Some(&original.sha256),
                Some(&wrong_token),
            )
            .unwrap(),
            SaveDocumentResult::CompatibilityRequired { .. },
        ));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        let saved = save_document_path_with_compatibility(
            &destination,
            "editor",
            Some(&original.sha256),
            Some(&token),
        )
        .unwrap();
        assert!(matches!(saved, SaveDocumentResult::Saved { .. }));
        assert_eq!(fs::read(&destination).unwrap(), b"editor");
        // Retrying with consent must not discard the expected-content guard.
        assert!(matches!(
            save_document_path_with_compatibility(
                &destination,
                "stale",
                Some(&original.sha256),
                Some(&token),
            )
            .unwrap(),
            SaveDocumentResult::Conflict { .. },
        ));
        assert_eq!(fs::read(&destination).unwrap(), b"editor");
    }
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
}
