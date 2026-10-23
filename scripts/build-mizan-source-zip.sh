#!/usr/bin/env bash
# Kept only so existing POSIX callers keep working.
#
# The archive is built by scripts/build-mizan-source-zip.mjs, which runs on
# Windows (PowerShell/cmd), macOS, Linux and CI alike and needs neither `bash`
# nor the `zip` binary. Do not reimplement the packaging rules here — there
# must stay exactly one definition of what goes into the archive.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build-mizan-source-zip.mjs" "$@"
