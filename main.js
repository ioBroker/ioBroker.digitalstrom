'use strict';

/*
 * Digitalstrom ioBroker Adapter
 */

/*
Rule 5 When applications send a scene command to a set of digitalSTROM-Devices with more than one target device they have to use scene calls directed to a group, splitting into multiple calls to single devices has to be avoided due to latency and statemachine consistency issues.

Rule 8 Application processes that do automatic cyclic reads or writes of device parameters are subject to a request limit: at maximum one request per minute and circuit is allowed.

Rule 9 Application processes that do automatic cyclic reads of measured values are subject to a request limit: at maximum one request per minute and circuit is allowed.

Rule 10 The action command ”Set Output Value” must not be used for other than device configuration purposes.

Rule 13 Applications that automatically generate Call Scene action commands (see 6.1.1) must not execute the action commands at a rate faster than one request per second.
 */


const utils = require('@iobroker/adapter-core');
const ObjectHelper = require('@apollon/iobroker-tools'); // Get common adapter utils

const DSS = require('./lib/dss');
const DSSQueue = require('./lib/dssQueue');
const DSSStructure = require('./lib/dssStructure');
const dssConstants = require('./lib/constants');

const Sentry = require('@sentry/node');
const SentryIntegrations = require('@sentry/integrations');
const packageJson = require('./package.json');


class Digitalstrom extends utils.Adapter {

    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: 'digitalstrom',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.objectHelper = ObjectHelper.objectHelper;
        this.objectHelper.init(this);
        this.connected = null;

        this.dss = null;
        this.dssQueue = null;
        this.dssStruct = null;
        this.lastScenes = {};

        this.dataPollInterval = 60000;
        this.dataPollTimeout = null;

        this.restartTimeout = null;
        this.stopping = false;

        process.on('SIGINT', () => {
            this.stopAdapter();
        });

        process.on('uncaughtException', (err) => {
            console.log('Exception: ' + err + '/' + err.toString());
            this.log && this.log.warn('Exception: ' + err);

            this.stopAdapter();
        });
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        const sentryPathWhitelist = ['digitalstrom', '@apollon'];
        const sentryErrorBlacklist = ['SyntaxError'];
        Sentry.init({
            release: packageJson.name + '@' + packageJson.version,
            dsn: 'https://d1da9ebead4d4ec693b489c8ea02bc6e@home.fischer-ka.de:5900/2',
            integrations: [
                new SentryIntegrations.Dedupe()
            ]
        });
        Sentry.configureScope(scope => {
            scope.setTag('version', this.common.installedVersion || this.common.version);
            if (this.common.installedFrom) {
                scope.setTag('installedFrom', this.common.installedFrom);
            }
            else {
                scope.setTag('installedFrom', this.common.installedVersion || this.common.version);
            }
            scope.addEventProcessor(function(event, hint) {
                // Try to filter out some events
                if (event && event.metadata) {
                    if (event.metadata.function && event.metadata.function.startsWith('Module.')) {
                        return null;
                    }
                    if (event.metadata.type && sentryErrorBlacklist.includes(event.metadata.type)) {
                        return null;
                    }
                    if (event.metadata.filename && !sentryPathWhitelist.find(path => event.metadata.filename.includes(path))) {
                        return null;
                    }
                    if (event.exception && event.exception.values && event.exception.values[0] && event.exception.values[0].stacktrace && event.exception.values[0].stacktrace.frames) {
                        for (let i = 0; i < (event.exception.values[0].stacktrace.frames.length > 5 ? 5 : event.exception.values[0].stacktrace.frames.length); i++) {
                            let foundWhitelisted = false;
                            if (event.exception.values[0].stacktrace.frames[i].filename && sentryPathWhitelist.find(path => event.exception.values[0].stacktrace.frames[i].filename.includes(path))) {
                                foundWhitelisted = true;
                                break;
                            }
                            if (!foundWhitelisted) {
                                return null;
                            }
                        }
                    }
                }

                return event;
            });

            this.getForeignObject('system.config', (err, obj) => {
                if (obj && obj.common && obj.common.diag) {
                    this.getForeignObject('system.meta.uuid', (err, obj) => {
                        // create uuid
                        if (!err  && obj) {
                            Sentry.configureScope(scope => {
                                scope.setUser({
                                    id: obj.native.uuid
                                });
                            });
                        }
                        this.main();
                    });
                }
                else {
                    this.main();
                }
            });
        });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.stopAdapter(callback);
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.debug(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.debug(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.debug(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

            this.objectHelper.handleStateChange(id, state);
        } else {
            // The state was deleted
            this.log.debug(`state ${id} deleted`);
        }
    }

    /**
     * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
     * Using this method requires "common.message" property to be set to true in io-package.json
     * @param {ioBroker.Message} obj
     */
    onMessage(obj) {
    	if (typeof obj === 'object' && obj.message) {
    		if (obj.command === 'createAppToken') {
    		    if (!obj.callback) return;
    			// e.g. send email or pushover or whatever
                this.log.info('Try to retrieve AppToken for host ' + obj.message.host + ' and username ' + obj.message.username);

                const tokenConnection = new DSS({
                    host: obj.message.host,
                    logger: {
                        silly: this.log.silly.bind(this),
                        debug: this.log.debug.bind(this),
                        info: this.log.info.bind(this),
                        warn: this.log.warn.bind(this),
                        error: this.log.error.bind(this)
                    }
                });

                tokenConnection.createAppTokenAsync(obj.message.username, obj.message.password).then((appToken) => {
                    this.log.info('Return AppToken for host ' + obj.message.host + ' and username ' + obj.message.username + ': ' + appToken);
                    this.sendTo(obj.from, obj.command, {appToken}, obj.callback);
                }, (error) => {
                    this.log.warn('Error while retrieving AppToken for host ' + obj.message.host + ' and username ' + obj.message.username + ': ' + error);
                    this.sendTo(obj.from, obj.command, {error}, obj.callback);
                });
    		}
    	}
    }

    stopAdapter(callback) {
        if (this.stopping) return;
        this.stopping = true;
        this.log && this.log.info('stopping ... ' + Date.now());
        this.setConnected(false);

        if (this.dataPollTimeout) {
            clearTimeout(this.dataPollTimeout);
            this.dataPollTimeout = null;
        }

        // remove all queue entries and end timers
        this.dssQueue && this.dssQueue.clearQueues();

        // unsubscribe to all events
        this.dss && this.dss.unsubscribeAllEvents((time) => {
            this.log && this.log.info('cleaned everything up... ' + time);
            callback && callback();
        });
    }

    restartAdapter(timeout) {
        if (this.restartTimeout) return;
        this.restartTimeout = setTimeout(() => {
            this.terminate ? this.terminate(-100) : proces.exit(-100);
        }, timeout || 1000);
    }

    setConnected(isConnected) {
        if (this.connected !== isConnected) {
            this.connected = isConnected;
            this.setState('info.connection', this.connected, true);
        }
    }

    main() {
        // Reset the connection indicator during startup
        this.setConnected(false);

        if (!this.config.host || !this.config.appToken) {
            this.log.warn('Please open Admin page for this adapter to set the host and create an App Token.');
            return;
        }
        if (this.config.usePresetValues === undefined) {
            this.config.usePresetValues = true;
        }
        this.dss = new DSS({
            host: this.config.host,
            appToken: this.config.appToken,
            logger: {
                silly: this.log.silly.bind(this),
                debug: this.log.debug.bind(this),
                info: this.log.info.bind(this),
                warn: this.log.warn.bind(this),
                error: this.log.error.bind(this)
            }
        });
        this.dssQueue = new DSSQueue({
            logger: {
                silly: this.log.silly.bind(this),
                debug: this.log.debug.bind(this),
                info: this.log.info.bind(this),
                warn: this.log.warn.bind(this),
                error: this.log.error.bind(this)
            },
            dss: this.dss
        });
        this.dssStruct = new DSSStructure({
            dss: this.dss,
            dssQueue: this.dssQueue,
            adapter: this
        });

        if (this.dataPollInterval !== 0) {
            this.dataPollInterval = (this.config.dataPollInterval * 1000) || this.dataPollInterval;
        }

        this.dss.requestAsync('apartment', 'getName').then((dssName) => {
            this.log.debug('getName: ' + JSON.stringify(dssName));

            this.objectHelper.loadExistingObjects(() => {

                this.initializeDSSData(err => {
                    if (err) {
                        this.log.warn('Error while initializing Data: ' + err);
                        this.restartAdapter(60000);
                        return;
                    }

                    this.registerObjects();
                    this.objectHelper.processObjectQueue(() => {
                        this.setInitialValues(() => {
                            this.lastScenes = this.dssStruct.initialScenes;
                            setTimeout(() => {
                                this.initializeSubscriptions(() => {
                                    this.subscribeStates('*');
                                    this.setConnected(true);
                                    this.log.info('Subscribed to states ...');

                                    this.startDataPolling();

                                    this.clearAdditionalObjects();
                                });
                            }, 2000);
                        });
                    });

                });
            });
        }, (err) => {
            this.log.error('Error while checking DSS connection (getName):' + JSON.stringify(err));
            this.log.error('Please check the host and that the host is reachable and check the settings please! Adapter restarts in 5 minutes');
            this.restartAdapter(300000);
        });
    }

    initializeDSSData(callback) {
        this.dss.requestAsync('system', 'version').then((dssVersion) => {
            this.log.debug('version: ' + JSON.stringify(dssVersion));

            this.dssStruct.init((err) => {
                if (err) {
                    return void (callback && callback(err));
                }

                callback && callback(null);
            });

        }, (err) => {
            this.log.error('Error getVersion:' + JSON.stringify(err));
            callback && callback(err);
        });
    }

    startDataPolling(fromTimeout) {
        if (this.dataPollTimeout) {
            !fromTimeout && clearTimeout(this.dataPollTimeout);
            this.dataPollTimeout = null;
        }
        if (this.dataPollInterval === 0) {
            this.log.info('Data polling deactivated.');
            return;
        }
        this.dssStruct.updateMeterData(() => {
            this.dataPollTimeout = setTimeout(() => this.startDataPolling(true), this.dataPollInterval);
        });
    }

    initializeSubscriptions(callback) {
        const eventNames = Object.keys(dssConstants.availableEvents).filter(name => dssConstants.availableEvents[name]);
        this.dss && this.dss.subscribeEvents(eventNames, errs => {
            if (errs && Array.isArray(errs)) {
                this.log.warn('Error to subscribe to ' + errs.length + 'Events. See the following log lines.');
                errs.forEach((err, idx) => this.log.warn(idx + ': ' + err));
                this.restartAdapter(30000);
            }
            else {
                this.log.debug('Successfully subscribed to ' + eventNames.length + ' Events');
            }

            this.dss.on('deviceSensorValue', data => {
                this.eventLog(data.name, data, true);
                if (!data.source || !data.source.isDevice || data.properties.sensorValueFloat === undefined) {
                    this.log.info('--INVALID ' + JSON.stringify(data));
                    return;
                }
                const sourceDeviceId = this.dssStruct.stateMap[data.source.dSUID + '.sensors.' + data.properties.sensorIndex];
                if (!sourceDeviceId) {
                    this.log.info('INVALID Device Sensor update');
                    return;
                }
                this.setState(sourceDeviceId, data.properties.sensorValueFloat, true);
            });

            this.dss.on('deviceBinaryInputEvent', data => {
                this.eventLog(data.name, data, true);
                if (!data.source || !data.source.isDevice || data.properties.inputType === undefined) {
                    this.log.info('--INVALID ' + JSON.stringify(data));
                    return;
                }
                const sourceDeviceId = this.dssStruct.stateMap[data.source.dSUID + '.binaryInputs.' + data.properties.inputIndex];
                if (!sourceDeviceId) {
                    this.log.info('INVALID Device Binary input event');
                    return;
                }
                this.setState(sourceDeviceId, data.properties.inputState, true);
            });

            const handleStateChange = (data) => {
                this.eventLog(data.name, data, true);
                if (!data.properties || !data.properties.statename) {
                    this.log.info('--INVALID ' + JSON.stringify(data));
                    return;
                }
                const sourceDeviceId = this.dssStruct.stateMap[data.properties.statename];
                if (!sourceDeviceId) {
                    this.log.info('Unhandled State Change: ' + data.properties.statename);
                    return;
                }
                let stateValue = data.properties.state;
                if (this.dssStruct.dssObjects[sourceDeviceId] && this.dssStruct.dssObjects[sourceDeviceId].native) {
                    if (this.dssStruct.dssObjects[sourceDeviceId].native.valueTrue !== undefined && stateValue === this.dssStruct.dssObjects[sourceDeviceId].native.valueTrue) {
                        stateValue = true;
                    }
                    else if (this.dssStruct.dssObjects[sourceDeviceId].native.valueFalse !== undefined && stateValue === this.dssStruct.dssObjects[sourceDeviceId].native.valueFalse) {
                        stateValue = false;
                    }
                }
                this.setState(sourceDeviceId, stateValue, true);
            }
            this.dss.on('stateChange', handleStateChange);
            this.dss.on('addonStateChange', handleStateChange);

            this.dss.on('buttonClick', data => {
                this.eventLog(data.name, data, true);
                if (!data.source || !data.source.isDevice) {
                    this.log.info('--INVALID ' + JSON.stringify(data));
                    return;
                }
                if (!this.dssStruct.stateMap[data.source.dSUID + '.' + data.properties.buttonIndex + '.button']) {
                    this.log.info('INVALID Button click');
                    return;
                }
                this.setState(this.dssStruct.stateMap[data.source.dSUID + '.' + data.properties.buttonIndex + '.button'], true, true);
                this.setState(this.dssStruct.stateMap[data.source.dSUID + '.' + data.properties.buttonIndex + '.buttonClickType'], data.properties.clickType || -1, true);
                this.setState(this.dssStruct.stateMap[data.source.dSUID + '.' + data.properties.buttonIndex + '.buttonHoldCount'], data.properties.holdCount || 0, true);
            });

            this.dss.on('zoneSensorValue', data => {
                this.eventLog(data.name, data, true);
                if (!data.source || !data.properties || !data.properties.sensorType || data.properties.sensorValueFloat === undefined) {
                    this.log.info('--INVALID ' + JSON.stringify(data));
                    return;
                }
                let sourceDeviceId = this.dssStruct.stateMap[data.source.zoneID + '.sensors.' + data.properties.sensorType];
                if (!sourceDeviceId && data.properties.sensorType === 60) {
                    sourceDeviceId = this.dssStruct.stateMap['0.sensors.60'];
                }
                if (!sourceDeviceId) {
                    this.log.info('INVALID Zone Sensor update: ' + data.source.zoneID + '.sensors.' + data.properties.sensorType);
                    return;
                }
                this.setState(sourceDeviceId, data.properties.sensorValueFloat, true);
            });

            const handleScene = (data, value, forwarded) => {
                this.eventLog(data.name + (forwarded ? ' (forwarded)' : ''), data, true);
                if (!data.source) {
                    this.log.info('--INVALID ' + JSON.stringify(data));
                    return;
                }
                let sourceDeviceId;
                let lastSourceDeviceId;

                if (data.source.isDevice) {
                    sourceDeviceId = this.dssStruct.stateMap[data.source.dSUID + '.scenes.' + data.properties.sceneID];
                    if (this.lastScenes[data.source.dSUID] !== undefined) {
                        lastSourceDeviceId = this.dssStruct.stateMap[data.source.dSUID + '.scenes.' + this.lastScenes[data.source.dSUID]];
                    }
                    if (value) {
                        this.lastScenes[data.source.dSUID] = data.properties.sceneID;
                    }
                    else {
                        this.lastScenes[data.source.dSUID] = undefined;
                    }

                    this.dss.emit(data.source.dSUID, data);
                }
                else if (data.source.isGroup && (data.properties.zoneID !== '0' || data.properties.groupID !== '0')) {
                    sourceDeviceId = this.dssStruct.stateMap[data.properties.zoneID + '.' + data.properties.groupID + '.scenes.' + data.properties.sceneID];
                    if (this.lastScenes[data.properties.zoneID + '.' + data.properties.groupID] !== undefined) {
                        lastSourceDeviceId = this.dssStruct.stateMap[data.properties.zoneID + '.' + data.properties.groupID + '.scenes.' + this.lastScenes[data.properties.zoneID + '.' + data.properties.groupID]];
                    }
                    if (value) {
                        this.lastScenes[data.properties.zoneID + '.' + data.properties.groupID] = data.properties.sceneID;
                    }
                    else {
                        this.lastScenes[data.source.dSUID] = undefined;
                    }

                    if (this.config.initializeOutputValues && !forwarded && this.dssStruct.zoneDevices[data.properties.zoneID] && this.dssStruct.zoneDevices[data.properties.zoneID][data.properties.groupID]) {
                        this.dssStruct.zoneDevices[data.properties.zoneID][data.properties.groupID].forEach(dSUID => this.dss.emit(dSUID, data));
                    }
                }
                else if (data.source.isApartment || (data.source.isGroup && data.properties.zoneID === '0' && data.properties.groupID === '0')) {
                    sourceDeviceId = this.dssStruct.stateMap['0.0.scenes.' + data.properties.sceneID];
                    if (this.lastScenes['0.0'] !== undefined) {
                        lastSourceDeviceId = this.dssStruct.stateMap['0.0.scenes.' + this.lastScenes['0.0']];
                    }
                    if (value) {
                        this.lastScenes['0.0'] = data.properties.sceneID;
                    }
                    else {
                        this.lastScenes['0.0'] = undefined;
                    }

                    if (this.config.initializeOutputValues && !forwarded) {
                        const handledDevices = {};
                        Object.keys(this.dssStruct.zoneDevices).forEach(zoneId => {
                            Object.keys(this.dssStruct.zoneDevices[zoneId]).forEach(groupId => {
                                this.dssStruct.zoneDevices[zoneId][groupId].forEach(dSUID => {
                                    //console.log('Check handled device: ' + dSUID + ' : ' + handledDevices[dSUID]);
                                    if (!handledDevices[dSUID]) {
                                        this.dss.emit(dSUID, data);
                                        handledDevices[dSUID] = true;
                                    }
                                });
                            });
                        });
                    }
                }

                if (!sourceDeviceId) {
                    !forwarded && this.log.info('INVALID scenecall');
                    return;
                }
                this.setState(sourceDeviceId, value, true);
                lastSourceDeviceId && lastSourceDeviceId !== sourceDeviceId && value && this.setState(lastSourceDeviceId, false, true);
                const idArr = sourceDeviceId.split('.');
                idArr[idArr.length - 1] = 'sceneId';
                const sceneIdState = idArr.join('.');
                if (value) {
                    this.setState(sceneIdState, data.properties.sceneID, true);
                }
                else {
                    this.setState(sceneIdState, null, true);
                }

                // When Scene is called on zone level we also update all groups in that zone
                if (data.source.isGroup && data.properties.zoneID !== '0' && data.properties.groupID === '0') {
                    Object.keys(this.dssStruct.zoneDevices[data.properties.zoneID]).forEach(group => {
                        data.properties.groupID = group.toString();
                        handleScene(data, value, true);
                    });
                }
                else if (data.source.isGroup && data.properties.zoneID === '0' && data.properties.groupID === '0') {
                    this.dssStruct.apartmentStructure.zones.forEach(zone => {
                        if (!this.dssStruct.zoneDevices[zone.id]) return;
                        data.properties.zoneID = zone.id.toString();
                        Object.keys(this.dssStruct.zoneDevices[zone.id]).forEach(group => {
                            data.properties.groupID = group.toString();
                            handleScene(data, value, true);
                        });
                    })
                }

//console.log('Check Button: ' + this.dssStruct.stateMap[data.properties.originDSUID + '.0.button']);
                if (!forwarded && data.properties.callOrigin === '9') {
                    if (data.properties.originDSUID && this.dssStruct.stateMap[data.properties.originDSUID + '.0.button']) {
                        this.setState(this.dssStruct.stateMap[data.properties.originDSUID + '.0.button'], true, true);
                        this.dssStruct.stateMap[data.properties.originDSUID + '.0.buttonClickType'] && this.setState(this.dssStruct.stateMap[data.properties.originDSUID + '.0.buttonClickType'], 0, true);
                        this.dssStruct.stateMap[data.properties.originDSUID + '.0.buttonHoldCount'] && this.setState(this.dssStruct.stateMap[data.properties.originDSUID + '.0.buttonHoldCount'], 0, true);
                    }
                    else if (data.source.dSUID && this.dssStruct.stateMap[data.source.dSUID + '.0.button']) {
                        this.setState(this.dssStruct.stateMap[data.source.dSUID + '.0.button'], true, true);
                        this.dssStruct.stateMap[data.source.dSUID + '.0.buttonClickType'] && this.setState(this.dssStruct.stateMap[data.source.dSUID + '.0.buttonClickType'], 0, true);
                        this.dssStruct.stateMap[data.source.dSUID + '.0.buttonHoldCount'] && this.setState(this.dssStruct.stateMap[data.source.dSUID + '.0.buttonHoldCount'], 0, true);
                    }
                }
            };

            this.dss.on('callScene', data => handleScene(data, true));
            this.dss.on('undoScene', data => handleScene(data, false));

            this.dss.on('eventError', (eventName, errorCount, err) => {
                this.log.warn('Too many event polling errors, restarting adapter');
                this.restartAdapter();
            });
            // Log unhandled Events to see what happens so at all
            eventNames.forEach(eventName => this.dss.listenerCount(eventName) === 0 && this.dss.on(eventName, data => this.eventLog(eventName, data, false)));

            callback && callback(null);
        });
    }

    eventLog(eventName, event, handled) {
        this.log.debug((handled ? '' : 'UNHANDLED ') + 'EVENT: ' + eventName + ': ' + JSON.stringify(event));
    }

    registerObjects() {
        const objNames = Object.keys(this.dssStruct.dssObjects);
        this.log.info('Create ' + objNames.length + ' objects ...');
        objNames.forEach(id => {
            const obj = this.dssStruct.dssObjects[id];
            const initValue = obj.value;
            const onChange = obj.onChange;
            delete obj.value;
            delete obj.onChange;

            this.objectHelper.setOrUpdateObject(id, obj, ['name'], initValue, onChange);
        });
    }

    setInitialValues(callback, list) {
        if (list === undefined) {
            list = Object.keys(this.dssStruct.initialObjectValues);
        }
        if (list && !list.length) {
            return callback && callback();
        }
        const id = list.shift();
        //console.log('SET INITIAL: ' + id + ' = ' + this.dssStruct.initialObjectValues[id] + ', obj = ' + JSON.stringify(this.dssStruct.dssObjects[id]));
        this.setState(id, this.dssStruct.initialObjectValues[id], true, () => this.setInitialValues(callback, list));
    }

    clearAdditionalObjects(delIds, callback) {
        if (typeof delIds === 'function') {
            callback = delIds;
            delIds = null;
        }
        if (!delIds && this.objectHelper.existingStates) {
            delIds = Object.keys(this.objectHelper.existingStates);
            delIds.length && this.log.info('Deleting the following states: ' + JSON.stringify(delIds));
        }
        if (!delIds || !delIds.length) {
            return void (callback && callback());
        }
        const del = delIds.shift();
        this.delObject(del, err => {
            if (err) {
                this.log.info(' Could not delete ' + del + ': ' + err);
            }
            delete this.objectHelper[del];
            setImmediate(() => this.clearAdditionalObjects(delIds, callback));
        });
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Digitalstrom(options);
} else {
    // otherwise start the instance directly
    new Digitalstrom();
}