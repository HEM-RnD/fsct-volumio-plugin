#!/bin/bash

echo "Removing fsct-driver package"
if dpkg -s fsct-driver >/dev/null 2>&1; then
    sudo dpkg -r fsct-driver || true
fi

echo "Done"
echo "pluginuninstallend"
