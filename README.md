# MDedit

MDedit is a fast, private, cross-platform Markdown editor built with Tauri. It combines a focused source editor and live preview with native file handling, Mermaid diagrams, KaTeX math, and offline exports. Your documents stay local.

## Features

- Native **Open**, **Save**, and **Save As** for Markdown documents.
- Synchronized **Edit**, **Split**, and **Preview** modes.
- GitHub-flavored Markdown, task lists, tables, footnotes, and callouts.
- Syntax highlighting, Mermaid diagrams, and KaTeX math.
- Find and replace, table of contents, reader controls, and light/dark themes.
- HTML, PNG, PDF, CSV, and SVG exports.
- Draft restoration and Markdown file associations.

## Download

Download the [latest stable build from GitHub Releases](https://github.com/skanga/mdedit/releases/latest).

| Download | Platform | Description |
| --- | --- | --- |
| `MDedit_<version>_x64-setup.exe` | Windows x64 | Recommended NSIS installer |
| `MDedit_<version>_x64_en-US.msi` | Windows x64 | Managed/administrator MSI installer |
| `MDedit-portable-x64.exe` | Windows x64 | Portable executable; no installation required |
| `MDedit_<version>_aarch64.dmg` | macOS Apple silicon | Disk image |
| `MDedit_<version>_amd64.deb` | Ubuntu/Debian x64 | Debian package |

These are unsigned builds, so your operating system may show a warning.

## Windows installers

For most Windows users, choose the NSIS installer: `MDedit_0.1.0_x64-setup.exe`. For managed or administrator-led deployment, use the MSI installer: `MDedit_0.1.0_x64_en-US.msi`. Either installer registers Markdown file associations.

For a portable option, download and run `MDedit-portable-x64.exe` directly. It requires no installation, shortcuts, or file associations, but it does require the system Microsoft Edge WebView2 runtime. If WebView2 is missing or needs repair, use the NSIS installer to install or repair it. Portable preferences and restored drafts may still use the normal Windows app-data location. The NSIS installer is still recommended for most Windows users.

## Development

Install Node.js LTS, Python 3, Rust/Cargo, and the [official Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows, also install Bash through Git Bash.

```bash
npm ci
npm test

# Build the desktop frontend and run MDedit in development.
npm run build:desktop
npm run tauri -- dev

# Create desktop bundles.
npm run tauri -- build

# Create a Windows NSIS installer.
npm run tauri -- build --bundles nsis
```

## Project structure

| Path | Purpose |
| --- | --- |
| `src/index.template.html` | Source template for the desktop frontend |
| `src/native-bridge.js` | Native Tauri bridge used by the frontend |
| `src-tauri/` | Tauri application, Rust code, and bundle configuration |
| `vendor/` | Vendored frontend dependencies and KaTeX fonts |
| `build.sh` | Generates the frontend HTML assets |
| `tools/build-desktop.sh` | Builds and stages the frontend for Tauri |
| `.github/workflows/desktop.yml` | Desktop build and GitHub Release workflow |

`index.html` and `index-lite.html` are generated internals used as Tauri assets. Modify `src/index.template.html` and run `bash ./build.sh`; do not hand-edit generated files.

## Privacy

MDedit has no account, telemetry, document upload, or server-side rendering. Documents remain local. Remote transmission of documents is out of scope.

## Contributing

Issues and pull requests are welcome at [github.com/skanga/mdedit](https://github.com/skanga/mdedit). Before opening a change, run:

```bash
npm test
npm run build:desktop
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

When changing frontend source, commit the generated artifacts as well.

## License

MDedit is licensed under [MIT](LICENSE). See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and [`licenses/`](licenses/) for third-party notices and licenses.
