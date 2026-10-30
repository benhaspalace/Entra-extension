#!/usr/bin/env bash
set -euo pipefail
version=1.7.7
checksum=023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757
destination="${RUNNER_TEMP:?}/actionlint-bin"
mkdir -p "$destination"
archive="$destination/actionlint.tar.gz"
curl --fail --silent --show-error --location \
  "https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_linux_amd64.tar.gz" \
  --output "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$destination" actionlint
echo "$destination" >> "${GITHUB_PATH:?}"
