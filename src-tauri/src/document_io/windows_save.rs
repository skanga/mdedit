//! Windows save policy. Native-permission changes on non-ACL filesystems
//! require explicit consent; failed queries and ACL errors never downgrade.

use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CreationPolicy {
    PreserveWindowsSecurity,
    NativeDefaults,
    CompatibilityRequired,
    NativeCompatibility,
}

pub(super) fn select_creation_policy(
    persistent_acls: io::Result<bool>,
    replacing: bool,
    consented: bool,
) -> io::Result<CreationPolicy> {
    match (persistent_acls?, replacing, consented) {
        (_, false, _) => Ok(CreationPolicy::NativeDefaults),
        (true, true, _) => Ok(CreationPolicy::PreserveWindowsSecurity),
        (false, true, false) => Ok(CreationPolicy::CompatibilityRequired),
        (false, true, true) => Ok(CreationPolicy::NativeCompatibility),
    }
}

#[cfg(windows)]
pub(super) fn creation_policy(
    directory: &std::path::Path,
    replacing: bool,
    consented: bool,
) -> io::Result<CreationPolicy> {
    select_creation_policy(inspect_persistent_acls(directory), replacing, consented)
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

/// The caller has synced and closed a same-directory temporary file. No
/// COPY_ALLOWED: this operation must never become a cross-volume copy/delete.
#[cfg(windows)]
pub(super) fn replace_compatible(
    temporary: &std::path::Path,
    destination: &std::path::Path,
) -> io::Result<()> {
    use super::{operation_error, windows_path};
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};
    if temporary.parent() != destination.parent() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "compatibility replacement must stay in the same directory",
        ));
    }
    let from = windows_path(temporary);
    let to = windows_path(destination);
    // SAFETY: both paths are live NUL-terminated UTF-16 buffers. No copy or
    // delete fallback is enabled, and the temporary handle has been closed.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) } == 0 {
        Err(operation_error(
            "compatibility replacement",
            "MoveFileExW(replace)",
            io::Error::last_os_error(),
        ))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn persistent_acls_keep_security_preserving_replacement() {
        assert_eq!(
            select_creation_policy(Ok(true), true, false).unwrap(),
            CreationPolicy::PreserveWindowsSecurity,
        );
    }

    #[test]
    fn new_documents_use_native_defaults_on_either_filesystem() {
        for persistent_acls in [true, false] {
            assert_eq!(
                select_creation_policy(Ok(persistent_acls), false, false).unwrap(),
                CreationPolicy::NativeDefaults,
            );
        }
    }

    #[test]
    fn absent_windows_acls_require_explicit_consent() {
        assert_eq!(
            select_creation_policy(Ok(false), true, false).unwrap(),
            CreationPolicy::CompatibilityRequired,
        );
        assert_eq!(
            select_creation_policy(Ok(false), true, true).unwrap(),
            CreationPolicy::NativeCompatibility,
        );
    }

    #[test]
    fn consent_never_weakens_acl_capable_saves() {
        assert_eq!(
            select_creation_policy(Ok(true), true, true).unwrap(),
            CreationPolicy::PreserveWindowsSecurity,
        );
    }

    #[test]
    fn failed_inspection_never_authorizes_weaker_creation() {
        // Windows: unsupported function, access denied, sharing violation,
        // network name deleted, disk full, unsupported operation.
        for code in [1, 5, 32, 64, 112, 50] {
            for replacing in [true, false] {
                for consented in [true, false] {
                    let error = select_creation_policy(
                        Err(io::Error::from_raw_os_error(code)),
                        replacing,
                        consented,
                    )
                    .unwrap_err();
                    assert_eq!(error.raw_os_error(), Some(code));
                }
            }
        }
    }
}
