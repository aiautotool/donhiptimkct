#!/usr/bin/env bash
set -euo pipefail

DEVICE_NAME="${1:-Kct}"
CONFIGURATION="${2:-Debug}"

cd "$(dirname "$0")/.."

echo "Preparing native iOS project for ${DEVICE_NAME}..."
if [[ ! -d ios || "${FORCE_PREBUILD:-0}" == "1" ]]; then
  npx expo prebuild --platform ios
else
  echo "Using existing ios/ project. Set FORCE_PREBUILD=1 to regenerate it."
fi

echo "Building ${CONFIGURATION}, installing, and launching on ${DEVICE_NAME}..."
npx expo run:ios --device "${DEVICE_NAME}" --configuration "${CONFIGURATION}"
