#!/bin/sh
# Builds dist/zen-space-scope-<version>.xpi from the repository and prints its
# path. The version comes from manifest.json, unless given as the first
# argument (tests use that to build an update); the manifest inside the XPI
# then carries that version.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' manifest.json | head -n 1)
if [ -z "$version" ]; then
  echo "build.sh: no version in manifest.json" >&2
  exit 1
fi
override=${1:-}
if [ -n "$override" ]; then
  case "$override" in
    *[!0-9.]* | .* | *. | *..*)
      echo "build.sh: bad version: $override" >&2
      exit 1
      ;;
  esac
fi

files="manifest.json LICENSE src"
if [ -d options ]; then
  files="$files options"
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# shellcheck disable=SC2086
find $files -type f ! -name '.*' | LC_ALL=C sort > "$stage/files"
while IFS= read -r f; do
  mkdir -p "$stage/root/$(dirname "$f")"
  cp "$f" "$stage/root/$f"
done < "$stage/files"
if [ -n "$override" ]; then
  sed "s/^\( *\"version\": *\"\)[^\"]*\"/\1$override\"/" manifest.json > "$stage/root/manifest.json"
  version=$override
fi

mkdir -p dist
xpi="$root/dist/zen-space-scope-$version.xpi"
rm -f "$xpi"
# -X: no extra file attributes; sorted names keep the archive order stable.
(cd "$stage/root" && zip -X -q "$xpi" -@ < "$stage/files")
echo "$xpi"
