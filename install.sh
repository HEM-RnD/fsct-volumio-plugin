#!/bin/bash
set -e

# Keep this version in sync with the @hemspzoo/fsct-client version in package.json.
FSCT_DRIVER_VERSION="0.2.14-alpha.290"

DPKG_ARCH=$(dpkg --print-architecture)
DEB_FILE="fsct-driver_${FSCT_DRIVER_VERSION}_${DPKG_ARCH}.deb"
DEB_URL="https://github.com/HEM-RnD/fsct-host/releases/download/v${FSCT_DRIVER_VERSION}/${DEB_FILE}"

echo "Installing Ferrum Streaming Control Technology dependencies"
echo "Architecture: ${DPKG_ARCH}"
echo "Driver version: ${FSCT_DRIVER_VERSION}"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Downloading ${DEB_URL}"
if ! curl -fL --retry 3 -o "${TMP_DIR}/${DEB_FILE}" "${DEB_URL}"; then
    echo "Failed to download fsct-driver .deb from ${DEB_URL}"
    exit 1
fi

echo "Installing ${DEB_FILE}"
if ! sudo dpkg -i "${TMP_DIR}/${DEB_FILE}"; then
    echo "dpkg reported errors, attempting to fix missing dependencies"
    sudo apt-get -y -f install
fi

# required to end the plugin install
echo "plugininstallend"
