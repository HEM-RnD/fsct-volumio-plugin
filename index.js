// Copyright 2025 HEM Sp. z o.o.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// This file is part of an implementation of Ferrum Streaming Control Technology™,
// which is subject to additional terms found in the LICENSE-FSCT.md file.

'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var config = new (require('v-conf'))();
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;
const { FsctIpcClient } = require('@hemspzoo/fsct-client');

module.exports = FerrumStreamingControlTechnology;

const PLAYER_SELF_ID = 'com.hem-e.fsct-volumio-plugin';
const RECONNECT_DELAY_MS = 2000;

// Module-level singletons — Volumio loads only one instance of a plugin.
var ipcClient = null;
var playerId = null;
var reconnectTimer = null;
var stopping = false;
var lastState = emptyState();
var pluginLogger = null;

function emptyState() {
    return {
        status: 'unknown',
        timeline: null,
        texts: { title: null, artist: null, album: null, genre: null },
    };
}

function logInfo(msg) {
    if (pluginLogger) pluginLogger.info('[fsct] ' + msg);
}

function logError(msg) {
    if (pluginLogger) pluginLogger.error('[fsct] ' + msg);
}

function FerrumStreamingControlTechnology(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;
}

function mapStatus(volumioStatus) {
    switch (volumioStatus) {
        case 'play':  return 'playing';
        case 'pause': return 'paused';
        case 'stop':  return 'stopped';
        default:      return 'unknown';
    }
}

function buildTimeline(state) {
    // Volumio: state.seek is ms, state.duration is seconds.
    if (state.seek === undefined || state.duration === undefined) return null;
    const playing = state.status === 'play';
    return {
        positionMs: state.seek,
        updateUnixMs: Date.now(),
        durationMs: Math.round(state.duration * 1000),
        rate: playing ? 1.0 : 0.0,
    };
}

function buildPlayerState(state) {
    return {
        status: mapStatus(state && state.status),
        timeline: state ? buildTimeline(state) : null,
        texts: {
            title:  (state && state.title)  || null,
            artist: (state && state.artist) || null,
            album:  (state && state.album)  || null,
            genre:  null,
        },
    };
}

async function assignToAllDevices() {
    if (!ipcClient || playerId === null) return;
    try {
        const devices = await ipcClient.getDetectedDevices();
        for (const deviceId of devices) {
            try {
                await ipcClient.assignPlayerToDevice(playerId, deviceId);
                logInfo('assigned player to device ' + deviceId);
            } catch (e) {
                logError('assign to ' + deviceId + ' failed: ' + (e && e.message));
            }
        }
    } catch (e) {
        logError('getDetectedDevices failed: ' + (e && e.message));
    }
}

async function pushLastState() {
    if (!ipcClient || playerId === null) return;
    try {
        await ipcClient.updatePlayerState(playerId, lastState);
    } catch (e) {
        logError('updatePlayerState failed: ' + (e && e.message));
    }
}

function scheduleReconnect() {
    if (stopping || reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        connectAndRegister().catch(function (e) {
            logError('reconnect failed: ' + (e && e.message));
            scheduleReconnect();
        });
    }, RECONNECT_DELAY_MS);
}

async function connectAndRegister() {
    if (stopping) return;
    const client = await FsctIpcClient.connect();
    client.on('error', function (err) { logError('ipc error: ' + (err && err.message)); });
    client.on('close', function () {
        logInfo('ipc connection closed');
        ipcClient = null;
        playerId = null;
        scheduleReconnect();
    });
    client.on('deviceChanged', function (e) {
        if (e.event === 'added' && ipcClient && playerId !== null) {
            ipcClient.assignPlayerToDevice(playerId, e.deviceId).then(function () {
                logInfo('assigned player to newly added device ' + e.deviceId);
            }).catch(function (err) {
                logError('assign on add failed: ' + (err && err.message));
            });
        }
    });

    const id = await client.registerPlayer(PLAYER_SELF_ID);
    ipcClient = client;
    playerId = id;
    logInfo('registered player id=' + id + ', protocol=' + client.negotiatedVersion.major + '.' + client.negotiatedVersion.minor);

    await assignToAllDevices();
    await pushLastState();
}

FerrumStreamingControlTechnology.prototype.updateStateOnPlayer = function (state) {
    lastState = buildPlayerState(state);
    if (ipcClient && playerId !== null) {
        ipcClient.updatePlayerState(playerId, lastState).catch(function (e) {
            logError('updatePlayerState failed: ' + (e && e.message));
        });
    }
};

FerrumStreamingControlTechnology.prototype.onVolumioStart = function () {
    var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);

    pluginLogger = this.logger;
    return libQ.resolve();
};

FerrumStreamingControlTechnology.prototype.onStart = function () {
    var self = this;
    var defer = libQ.defer();

    stopping = false;
    pluginLogger = self.logger;

    var initialState = null;
    try {
        initialState = self.commandRouter.volumioGetState();
    } catch (e) {
        logError('volumioGetState failed: ' + (e && e.message));
    }
    if (initialState) lastState = buildPlayerState(initialState);

    connectAndRegister()
        .then(function () {
            logInfo('FSCT Started');
            defer.resolve();
        })
        .catch(function (err) {
            logError('initial connect failed: ' + (err && err.message));
            // Keep retrying in background; resolve so Volumio considers plugin started.
            scheduleReconnect();
            defer.resolve();
        });

    return defer.promise;
};

FerrumStreamingControlTechnology.prototype.onStop = function () {
    var self = this;
    stopping = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    var pendingClient = ipcClient;
    var pendingPlayerId = playerId;
    ipcClient = null;
    playerId = null;

    if (pendingClient && pendingPlayerId !== null) {
        pendingClient.unregisterPlayer(pendingPlayerId)
            .catch(function (e) { logError('unregisterPlayer failed: ' + (e && e.message)); })
            .then(function () {
                try { pendingClient.disconnect(); } catch (e) { /* ignore */ }
            });
    } else if (pendingClient) {
        try { pendingClient.disconnect(); } catch (e) { /* ignore */ }
    }

    self.logger.info('FSCT Stopped');
    return libQ.resolve();
};

FerrumStreamingControlTechnology.prototype.onRestart = function () {
    // Optional, use if you need it
};


// Configuration Methods -----------------------------------------------------------------------------

FerrumStreamingControlTechnology.prototype.getUIConfig = function () {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function (uiconf) {
            defer.resolve(uiconf);
        })
        .fail(function () {
            defer.reject(new Error());
        });

    return defer.promise;
};

FerrumStreamingControlTechnology.prototype.getConfigurationFiles = function () {
    return ['config.json'];
};

FerrumStreamingControlTechnology.prototype.setUIConfig = function (data) {
};

FerrumStreamingControlTechnology.prototype.getConf = function (varName) {
};

FerrumStreamingControlTechnology.prototype.setConf = function (varName, varValue) {
};

FerrumStreamingControlTechnology.prototype.pushState = function (state) {
    this.updateStateOnPlayer(state);
};
