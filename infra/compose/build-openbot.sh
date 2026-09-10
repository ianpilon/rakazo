#!/bin/bash
# Build the Open Bot app image with a cached dependency layer.
# Usage: bash infra/compose/build-openbot.sh   (from the repo root)
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
# Stage every package.json under manifests/ with its workspace path so the
# install layer only changes when a manifest changes.
rm -rf manifests && mkdir -p manifests
while IFS= read -r f; do
  mkdir -p "manifests/$(dirname "$f")"
  cp "$f" "manifests/$f"
done < <(git ls-files '*/package.json' 'package.json' | grep -v '^package.json$')
ls .npmrc >/dev/null 2>&1 || touch .npmrc
docker build -f infra/compose/Dockerfile.openbot -t openbot/app:local --build-arg GIT_SHA="$(git rev-parse --short HEAD)" .
rm -rf manifests
