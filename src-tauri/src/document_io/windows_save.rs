//! Windows filesystem inspection and fail-closed temporary-creation policy.
//!
//! Persistent Windows ACL support says nothing about native Linux modes or
//! ownership. In particular, do not turn an unsupported security query into
//! permission to replace a WSL file with a parent-default temporary file.

use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CreationPolicy {
    PreserveWindowsSecurity,
    NativeDefaults,
}

pub(super) fn select_creation_policy(
    persistent_acls: io::Result<bool>,
    replacing: bool,
) -> io::Result<CreationPolicy> {
    match (persistent_acls?, replacing) {
        (_, false) => Ok(CreationPolicy::NativeDefaults),
        (true, true) => Ok(CreationPolicy::PreserveWindowsSecurity),
        (false, true) => Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "safe replacement is unavailable: this filesystem does not support Windows ACLs \
             and preservation of native permissions cannot be established; \
             use Save As with a new filename or a filesystem-native editor",
        )),
    }
}

#[cfg(windows)]
pub(super) fn creation_policy(
    directory: &std::path::Path,
    replacing: bool,
) -> io::Result<CreationPolicy> {
    select_creation_policy(inspect_persistent_acls(directory), replacing)
}

/// Query the resolved directory for each save; never cache by drive letter or
/// mistake a failed query for a successful query with no capability flags.
#[cfg(windows)]
pub(super) fn inspect_persistent_acls(directory: &std::path::Path) -> io::Result<bool> {
    use super::{operation_error, windows_path};
    use windows_sys::Win32::Storage::FileSystem::{GetVolumeInformationW, GetVolumePathNameW};
    use windows_sys::Win32::System::SystemServices::FILE_PERSISTENT_ACLS;

    let directory = windows_path(directory);
    // Accommodate extended-length paths, including canonical UNC paths.
    let mut root = vec![0_u16; 32_768];
    // SAFETY: directory is NUL-terminated, and root has the advertised writable
    // capacity. Both buffers remain live for this synchronous call.
    if unsafe { GetVolumePathNameW(directory.as_ptr(), root.as_mut_ptr(), root.len() as u32) } == 0
    {
        return Err(operation_error(
            "inspect filesystem capabilities",
            "GetVolumePathNameW",
            io::Error::last_os_error(),
        ));
    }

    let mut flags = 0;
    // SAFETY: root was filled by GetVolumePathNameW. flags is a live output;
    // unused optional outputs are null with zero buffer lengths.
    if unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut flags,
            std::ptr::null_mut(),
            0,
        )
    } == 0
    {
        return Err(operation_error(
            "inspect filesystem capabilities",
            "GetVolumeInformationW",
            io::Error::last_os_error(),
        ));
    }
    Ok(flags & FILE_PERSISTENT_ACLS != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn persistent_acls_keep_security_preserving_replacement() {
        assert_eq!(
            select_creation_policy(Ok(true), true).unwrap(),
            CreationPolicy::PreserveWindowsSecurity,
        );
    }

    #[test]
    fn new_documents_use_native_defaults_on_either_filesystem() {
        for persistent_acls in [true, false] {
            assert_eq!(
                select_creation_policy(Ok(persistent_acls), false).unwrap(),
                CreationPolicy::NativeDefaults,
            );
        }
    }

    #[test]
    fn absent_windows_acls_do_not_prove_native_security_can_be_preserved() {
        let error = select_creation_policy(Ok(false), true).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Unsupported);
        assert!(error.to_string().contains("native permissions"));
        assert!(error.to_string().contains("Save As"));
    }

    #[test]
    fn failed_inspection_never_authorizes_weaker_creation() {
        // Windows: unsupported function, access denied, sharing violation,
        // network name deleted, disk full, unsupported operation.
        for code in [1, 5, 32, 64, 112, 50] {
            for replacing in [true, false] {
                let error =
                    select_creation_policy(Err(io::Error::from_raw_os_error(code)), replacing)
                        .unwrap_err();
                assert_eq!(error.raw_os_error(), Some(code));
            }
        }
    }
}
