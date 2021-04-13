const dssConstants = require('./constants');

class DSSStructure {

    constructor(options) {
        this.options = options || {};
        this.dss = options.dss;
        this.adapter = options.adapter;
        this.dssQueue = options.dssQueue;

        this.stateMap = {};
        this.dssObjects = {};
        this.initialObjectValues = {};
        this.processedZones = {};
        this.zoneDevices = {};
        this.initialScenes = {};

        this.apartmentStructure = null;
        this.apartmentCircuits = null;
        this.sensorValues = null;
        this.temperatureControlStatus = null;
        this.propertyUserStates = null;
        this.propertyStates = null;
        this.userActions = null;
        this.reachableGroups = null;
        this.groupTypes = dssConstants.groupTypes;

        this.basicRoomScenes = [0, 5, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39];
    }

    init(callback) {
        this.dss.requestAsync('apartment', 'getStructure').then((res) => {
            if (!res || !res.ok || !res.result || !res.result.apartment) {
                return void (callback && setImmediate(() => callback('Error on apartment/getStructure: ' + (res.message || res.status_code || res))));
            }
            this.apartmentStructure = res.result.apartment;
            this.adapter.log.debug('getStructure:' + JSON.stringify(this.apartmentStructure));

            this.dss.requestAsync('apartment', 'getCircuits').then((res) => {
                if (!res || !res.ok || !res.result || !res.result.circuits) {
                    return void (callback && callback('Error on apartment/getCircuits: ' + (res.message || res.status_code || res)));
                }
                this.apartmentCircuits = res.result.circuits;
                this.adapter.log.debug('getCircuits:' + JSON.stringify(this.apartmentCircuits));

                this.dss.requestAsync('apartment', 'getSensorValues').then((res) => {
                    if (!res || !res.ok || !res.result) {
                        return void (callback && callback('Error on apartment/getSensorValues: ' + (res.message || res.status_code || res)));
                    }
                    this.sensorValues = res.result;
                    this.adapter.log.debug('getSensorValues: ' + JSON.stringify(this.sensorValues));

                    this.dss.requestAsync('apartment', 'getTemperatureControlStatus').then((res) => {
                        if (!res || !res.ok || !res.result) {
                            return void (callback && callback('Error on apartment/getTemperatureControlStatus: ' + (res.message || res.status_code || res)));
                        }
                        this.temperatureControlStatus = res.result;
                        this.adapter.log.debug('getTemperatureControlStatus: ' + JSON.stringify(this.temperatureControlStatus));

                        this.dss.requestAsync('property', 'query' , {query: '/usr/addon-states/system-addon-user-defined-states/*(*)'}).then((res) => {
                            if (!res || !res.ok || !res.result) {
                                return void (callback && callback('Error on query user-defined-states: ' + (res.message || res.status_code || res)));
                            }
                            this.propertyUserStates = res.result['system-addon-user-defined-states'] || [];
                            this.adapter.log.debug('property user states: ' + JSON.stringify(this.propertyUserStates));

                            this.dss.requestAsync('property', 'query' , {query: '/usr/states/*(*)'}).then((res) => {
                                if (!res || !res.ok || !res.result) {
                                    return void (callback && callback('Error on query states: ' + (res.message || res.status_code || res)));
                                }
                                this.propertyStates = res.result.states;
                                this.adapter.log.debug('property states: ' + JSON.stringify(this.propertyStates));

                                this.dss.requestAsync('property', 'query' , {query: '/usr/events/*(*)/*(*)/*(*)/*(*)/*(*)'}).then((res) => {
                                    if (!res || !res.ok || !res.result) {
                                        return void (callback && callback('Error on query user actions: ' + (res.message || res.status_code || res)));
                                    }
                                    this.userActions = res.result.events;
                                    this.adapter.log.debug('property user actions: ' + JSON.stringify(this.userActions));

                                    this.dss.requestAsync('apartment', 'getReachableGroups' , {id: 0}).then((res) => {
                                        if (!res || !res.ok || !res.result) {
                                            return void (callback && callback('Error on apartment/getReachableGroups: ' + (res.message || res.status_code || res)));
                                        }
                                        this.reachableGroups = res.result;
                                        this.adapter.log.debug('getReachableGroups: ' + JSON.stringify(this.reachableGroups));

                                        this.parseData(callback);
                                    }, (err) => {
                                        return void (callback && callback('Error on apartment/getReachableGroups: ' + JSON.stringify(err)));
                                    });
                                }, (err) => {
                                    return void (callback && callback('Error on apartment/getReachableGroups: ' + JSON.stringify(err)));
                                });
                            }, (err) => {
                                return void (callback && callback('Error on query states: ' + JSON.stringify(err)));
                            });
                        }, (err) => {
                            return void (callback && callback('Error on query user-defined-states: ' + JSON.stringify(err)));
                        });
                    }, (err) => {
                        return void (callback && callback('Error on apartment/getTemperatureControlStatus: ' + JSON.stringify(err)));
                    });
                }, (err) => {
                    return void (callback && callback('Error on apartment/getSensorValues: ' + JSON.stringify(err)));
                });
            }, (err) => {
                return void (callback && callback('Error on apartment/getCircuits: ' + JSON.stringify(err)));
            });
        }, (err) => {
            return void (callback && callback('Error on apartment/getStructure: ' + JSON.stringify(err)));
        });
    }

    convertObject(data, nameField, prefilled) {
        const res = prefilled || {};
        if (!data || !Array.isArray(data)) return res;
        data.forEach(el => {
            if (typeof el !== 'object' || el[nameField] === undefined) return;
            res[el[nameField]] = el;
        });
        return res;
    }

    parseData(callback) {
        const apt = {
            clusters: this.convertObject(this.apartmentStructure.clusters, 'id'),
            floors:   this.convertObject(this.apartmentStructure.floors, 'id'),
            zones:    this.convertObject(this.apartmentStructure.zones, 'id')
        };
        Object.keys(apt.clusters).forEach(groupId => {
            if (!this.groupTypes[groupId]) {
                this.groupTypes[groupId] = apt.clusters[groupId].name;
            }
        });
        if (apt.zones[0]) {
            apt.zone0 = apt.zones[0]; // Zone 0 contains everything
            delete apt.zones[0];
        }
        else {
            return void (callback && setImmediate(() => callback('No devices returned in Zone 0')));
        }
        apt.groups = this.convertObject(apt.zone0.groups, 'id'); // enhance groups from zone 0

        this.createUserActions();

        this.createDevices(apt.zone0.devices, () => {
            const reachableZoneGroups = this.convertObject(this.reachableGroups.zones, 'zoneID');
            this.sensorValues.zones = this.convertObject(this.sensorValues.zones, 'id');
            this.temperatureControlStatus.zones = this.convertObject(this.temperatureControlStatus.zones, 'id');
            this.createApartment(apt, reachableZoneGroups, () => {
                callback && callback(null);
            });
        });
    }

    findStates(checkRegEx) {
        const regEx = new RegExp(checkRegEx);
        const res = [];
        this.propertyStates.forEach(state => {
            const match = state.name.match(regEx);
            if (!match) return;
            if (match && match[1]) {
                state.matchedName = match[1];
            }
            res.push(state);
        });
        return res;
    }

    updateMeterData(callback) {
        let updateCounter = 0;
        this.apartmentCircuits.forEach(circuit => {
            if (!circuit.hasMetering) return;

            updateCounter++;
            this.dssQueue.pushQueryQueue(circuit.dSUID, 'getConsumption', {
                dssClass: 'circuit',
                dssFunction: 'getConsumption',
                params: {
                    dsuid: circuit.dSUID
                }
            }, 'low', (err, res) => {
                if (!err && (res && res.ok && res.result)) {
                    this.adapter.setState('devices.' + circuit.dSUID + '.PowerConsumption', res.result.consumption, true);
                }
                !--updateCounter && callback && callback();
            });

            updateCounter++;
            this.dssQueue.pushQueryQueue(circuit.dSUID, 'getEnergyMeterValue', {
                dssClass: 'circuit',
                dssFunction: 'getEnergyMeterValue',
                params: {
                    dsuid: circuit.dSUID
                }
            }, 'low', (err, res) => {
                if (!err && (res && res.ok && res.result)) {
                    this.adapter.setState('devices.' + circuit.dSUID + '.EnergyMeterValue', res.result.meterValue/3600/1000, true);
                }
                !--updateCounter && callback && callback();
            });
        });
        !updateCounter && callback && setImmediate(() => callback());
    }

    createDevices(devices, callback) {
        this.addFolderObject('devices', 'Devices');

        this.apartmentCircuits.forEach(circuit => {
            this.addFolderObject('devices.' + circuit.dSUID, circuit.name || 'Circuit');
            if (!circuit.hasMetering) return;
            this.addStateObject('devices.' + circuit.dSUID + '.PowerConsumption', {
                name: 'Power Consumption',
                role: 'value',
                unit: 'W',
                read: true,
                write: false
            });

            this.addStateObject('devices.' + circuit.dSUID + '.EnergyMeterValue', {
                name: 'Energy Meter',
                role: 'value.power.consumption',
                unit: 'kWh',
                read: true,
                write: false
            });

            const circuitStates = this.findStates('^dsm\\.' + circuit.dSUID + '\\.(.*)$');
            if (circuitStates && circuitStates.length) {
                this.addFolderObject('devices.' + circuit.dSUID + '.states', 'DSM States', 'channel');
                circuitStates.forEach(state => {
                    if (!state.matchedName) return;
                    const stateId = 'devices.' + circuit.dSUID + '.states.' + state.matchedName;
                    this.addStateObject(stateId, state.name, {
                        name: state.matchedName,
                        role: 'indicator',
                        type: 'string',
                        read: true,
                        write: false
                    }, value => {
                        value = !!value;
                        this.dssQueue.pushQueryQueue(circuit.dSUID, {
                            dssClass: 'state',
                            dssFunction: 'set',
                            params: {
                                name: state.name,
                                value: value
                            }
                        }, 'high', (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.adapter.log.warn('Error while set State for ' + circuit.dSUID + ': ' + (err || JSON.stringify(res)));
                            }
                        });
                    });
                    this.initialObjectValues[stateId] = state.state;
                });
            }
        });

        let deviceCounter = 0;
        devices.forEach(dev => {
            deviceCounter++;
            setImmediate(() => this.createDevice(dev, () => {
                !--deviceCounter && callback && callback(null);
            }));
        });
        !deviceCounter && callback && setImmediate(() => callback(null));
    }

    createDevice(dev, callback) {
        if (!dev.isValid || !dev.isPresent) {
            this.adapter.log.debug('IGNORE DEVICE ' + dev.dSUID + ' because invalid');
            callback && setImmediate(() => callback(null));
            return;
        }
        this.zoneDevices[dev.zoneID] = this.zoneDevices[dev.zoneID] || {};
        dev.groups && dev.groups.forEach(group => {
            this.zoneDevices[dev.zoneID][group] = this.zoneDevices[dev.zoneID][group] || [];
            this.zoneDevices[dev.zoneID][group].push(dev.dSUID);
        });
        const devId = 'devices.' + dev.meterDSUID + '.' + dev.dSUID;
        const devName = dev.name ? dev.name + '(' + dev.hwInfo + ')' : dev.hwInfo;

        this.addFolderObject(devId, devName + ' (' + dssConstants.outputModeToRoleMap[dev.outputMode] + ')', 'device');

        if (dev.sensorInputCount) {
            let realSensors = false;
            dev.sensors.forEach((sensor, idx) => {
                if (!dssConstants.sensorUnitRoleMap[sensor.type]) {
                    return;
                }
                if (!realSensors) {
                    this.addFolderObject(devId + '.sensors', 'Device Sensor Channels', 'channel');
                    realSensors = true;
                }
                const sensorId = devId + '.sensors.' + idx;
                this.addStateObject(sensorId, dev.dSUID + '.sensors.' + idx, dssConstants.sensorUnitRoleMap[sensor.type]);
                if (sensor.valid) {
                    this.initialObjectValues[sensorId] = sensor.value;
                }
            });
        }

        if (dev.binaryInputCount) {
            this.addFolderObject(devId + '.binaryInputs', 'Device Binary Inputs', 'channel');
            dev.binaryInputs.forEach((input, idx) => {
                if (!dssConstants.binaryInputTypeNames[input.inputType] && (input.inputType === 0 && !this.groupTypes[input.targetGroup])) {
                    this.adapter.log.warn('    INVALID BINARYINPUT TYPE ' + input.inputType + ' / ' + input.targetGroup);
                }
                const inputId = devId + '.binaryInputs.' + idx;
                this.addStateObject(inputId, dev.dSUID + '.binaryInputs.' + idx, {
                    name: dssConstants.binaryInputTypeNames[input.inputType] || this.groupTypes[input.targetGroup] || 'Unknown',
                    type: 'number',
                    read: true,
                    write: false
                });
                this.initialObjectValues[inputId] = input.state;
            });
        }

        const devStates = this.findStates('^dev\\.' + dev.dSUID + '\\.(.*)$');
        if (devStates && devStates.length) {
            this.addFolderObject(devId + '.states', 'Device States', 'channel');
            devStates.forEach(state => {
                if (!state.matchedName) return;
                const stateId = devId + '.states.' + state.matchedName;
                this.addStateObject(stateId, state.name, {
                    name: state.matchedName,
                    role: 'indicator',
                    type: 'string',
                    read: true,
                    write: false
                }, value => {
                    this.dssQueue.pushQueryQueue(dev.dSUID, {
                        dssClass: 'state',
                        dssFunction: 'set',
                        params: {
                            name: state.name,
                            value: value
                        }
                    }, 'high', (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.adapter.log.warn('Error while set State for ' + dev.dSUID + ': ' + (err || JSON.stringify(res)));
                        }
                    });
                });
                this.initialObjectValues[stateId] = state.state;
            });
        }

        dev.outputChannelList = {};
        if (dev.outputMode && dev.outputChannels && dev.outputChannels.length) {

            dev.outputChannels.forEach(output => {
                if (!dssConstants.outputChannelUnitRoleMap[output.channelType]) {
                    this.adapter.log.warn('    INVALID OUTPUTCHANNEL TYPE ' + output.channelType + ': ' + JSON.stringify(output));
                    return;
                }
                const outputChannelId = devId + '.' + output.channelId;
                this.addStateObject(outputChannelId, dev.dSUID + '.' + output.channelId, dssConstants.outputChannelUnitRoleMap[output.channelType]);
                dev.outputChannelList[output.channelType] = outputChannelId;

                // TODO find generic way to get Output value - currently implemented per device type later (light/shade)

                // TODO add way to SET values!!

                /* values:/device/getOutputChannelValue2?dsuid=5a11caa06212578280d826428d15c3d700 ((OPTIONAL &channels=brightness;saturation;hue))

                    const channelList = dev.outputChannels.map(output => output.channelId).join(';');
                    dss.requestAsync('device', 'getOutputChannelValue' , {dsid: dev.id, channels: channelList}).then((outputChannelValues) => {
                        this.adapter.log.debug('getOutputChannelValue for ' + dev.dSUID + ' AND ' + channelList + ': ' + JSON.stringify(outputChannelValues));
                        outputChannelValues = this.convertObject(outputChannelValues.result.channels, 'index');

                    queueUpdateOutputValue(dev, dssConstants.outputChannelUnitRoleMap[output.channelType].channelIndex, 'medium', (err, value) => {

                    });

                    set /device/setOutputChannelValue2?dsuid=5a11caa06212578280d826428d15c3d700&channels={”brightness”: {”value”: 10, ”automatic”: false}, ”saturation”: {”value”: 100}, ”hue”: {”value”: 235}}
                    */
            });
        }

        if (dev.outputMode) {
            // DEVICE. state (button) true= 5, false = 0
            // sendSceneCommand
            // setDeviceScene: '/device/callScene?dsid=%s&sceneNumber=%s&category=manual',
            // setDeviceValue: '/device/setConfig?&dsuid=%1&class=%2&index=%3&value=%4&category=manual'
            this.addFolderObject(devId + '.scenes', 'Device Scenes', 'channel');
            const sceneList = {};
            Object.keys(dssConstants.zoneSceneCommands).forEach(scene => {
                const sceneId = devId + '.scenes.' + this.convertSceneName(dssConstants.zoneSceneCommands[scene]);
                sceneList[scene] = dssConstants.zoneSceneCommands[scene];

                this.addStateObject(sceneId, dev.dSUID + '.scenes.' + scene, {
                    name: dssConstants.zoneSceneCommands[scene],
                    type: 'boolean',
                    role: 'switch'
                }, value => {
                    value = !!value;
                    this.dssQueue.pushQueryQueue(dev.meterDSUID, {
                        dssClass: 'device',
                        dssFunction: value ? 'callScene' : 'undoScene',
                        params: {
                            dsuid: dev.dSUID,
                            sceneNumber: scene,
                            category: 'manual'
                        }
                    }, 'high', (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for ' + dev.dSUID + ': ' + (err || JSON.stringify(res)));
                        }
                    });
                });
                this.initialObjectValues[sceneId] = false;
            });
            for (let sceneId = 67; sceneId <= 70; sceneId++) {
                const sceneStateId = devId + '.scenes.' + this.convertSceneName(dssConstants.apartmentScenes[sceneId]);
                sceneList[sceneId] = dssConstants.apartmentScenes[sceneId];

                this.addStateObject(sceneStateId, dev.dSUID + '.scenes.' + sceneId, {
                    name: dssConstants.apartmentScenes[sceneId],
                    type: 'boolean',
                    role: 'switch'
                }, value => {
                    value = !!value;
                    this.dssQueue.pushQueryQueue('zone', {
                        dssClass: 'device',
                        dssFunction: value ? 'callScene' : 'undoScene',
                        params: {
                            dsuid: dev.dSUID,
                            sceneNumber: sceneId,
                            category: 'manual'
                        }
                    }, 'high', (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for ' + dev.dSUID + ': ' + (err || JSON.stringify(res)));
                        }
                    });
                });
                this.initialObjectValues[sceneStateId] = false;
            }
            if (Object.keys(sceneList).length) {
                this.addStateObject(devId + '.scenes.sceneId', {
                    name: 'Device Scene ID',
                    type: 'number',
                    role: 'state',
                    states: sceneList
                },value => {
                    if (!sceneList[value]) {
                        this.adapter.log.warn('Invalid Scene ID ' + value + ' for ' + dev.dSUID + '.scenes.sceneId');
                        return;
                    }
                    this.dssQueue.pushQueryQueue(dev.meterDSUID, {
                        dssClass: 'device',
                        dssFunction: 'callScene',
                        params: {
                            dsuid: dev.dSUID,
                            sceneNumber: value,
                            category: 'manual'
                        }
                    }, 'high', (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.adapter.log.warn('Error while callScene for ' + dev.dSUID + ': ' + (err || JSON.stringify(res)));
                        }
                    });
                });
            }
        }

        if (dev.buttonActiveGroup > 0 && dev.buttonActiveGroup <= 8) {
            this.addStateObject(devId + '.button', dev.dSUID + '.0.button', {
                name: dev.name + ' Button State',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            });
            this.initialObjectValues[devId + '.button'] = false;
        }

        if (dev.hwInfo.startsWith('SW-')) { // Joker / Tasten
            this.createJokerDevice(dev, devId, callback);
        }
        else if (dev.hwInfo.startsWith('GE-')) { // Yellow: Light
            this.createLightDevice(dev, devId, callback);
        }
        else if (dev.hwInfo.startsWith('GR-')) { // Gray: Shades
            this.createShaderDevice(dev, devId, callback);
        }
        else {
            if (dev.outputMode && dev.outputChannels && dev.outputChannels.length) {
                if (dev.outputChannels.length === 1) {
                    const output = dev.outputChannels[0];
                    const outputStateId = devId + '.' + output.channelId;
                    if (dssConstants.outputChannelUnitRoleMap[output.channelType] && dssConstants.outputChannelUnitRoleMap[output.channelType].native) {

                        if (output && this.adapter.config.initializeOutputValues) {
                            this.dssQueue.queueUpdateOutputValue(dev, dssConstants.outputChannelUnitRoleMap[output.channelType].native.channelIndex, dssConstants.outputChannelUnitRoleMap[output.channelType].native.nativeMax, 'medium', (err, value) => {
                                if (!err) {
                                    if (dssConstants.outputChannelUnitRoleMap[output.channelType].native.nativeMax && dssConstants.outputChannelUnitRoleMap[output.channelType].max) {
                                        value = Math.round(value * dssConstants.outputChannelUnitRoleMap[output.channelType].max / dssConstants.outputChannelUnitRoleMap[output.channelType].native.nativeMax);
                                    }
                                    this.adapter.setState(outputStateId, value, true);
                                }
                            });
                        }
                        this.dssObjects[outputStateId].onChange = value => {
                            if (typeof value !== 'number') {
                                this.adapter.log.warn('Only numbers are allowed to set for ' + outputStateId);
                                return;
                            }
                            if (dssConstants.outputChannelUnitRoleMap[output.channelType].native.nativeMax) {
                                if ((dssConstants.outputChannelUnitRoleMap[output.channelType].max !== undefined && value === dssConstants.outputChannelUnitRoleMap[output.channelType].min) || (dssConstants.outputChannelUnitRoleMap[output.channelType].max !== undefined && value === dssConstants.outputChannelUnitRoleMap[output.channelType].max)) {
                                    value = (value > dssConstants.outputChannelUnitRoleMap[output.channelType].min);
                                    this.dssQueue.pushQueryQueue(dev.meterDSUID, {
                                        dssClass: 'device',
                                        dssFunction: 'callScene',
                                        params: {
                                            dsuid: dev.dSUID,
                                            sceneNumber: value ? 14 : 13,
                                            category: 'manual'
                                        }
                                    }, 'high', (err, res) => {
                                        if (err || (res && !res.ok)) {
                                            this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for ' + dev.dSUID + ': ' + (err || JSON.stringify(res)));
                                        } else {
                                            this.adapter.setState(outputStateId, value ? dssConstants.outputChannelUnitRoleMap[output.channelType].max : dssConstants.outputChannelUnitRoleMap[output.channelType].min, true);
                                        }
                                    });
                                }
                                else {
                                    const normalizedValue = Math.round(value * dssConstants.outputChannelUnitRoleMap[output.channelType].native.nativeMax / dssConstants.outputChannelUnitRoleMap[output.channelType].max);
                                    this.dssQueue.queueSetOutputValue(dev, dssConstants.outputChannelUnitRoleMap[output.channelType].native.channelIndex, dssConstants.outputChannelUnitRoleMap[output.channelType].native.nativeMax, normalizedValue, 'high', (err, _value)  => {
                                        if (err) {
                                            this.adapter.log.warn('Error when setting output value for ' + dev.dSUID + ': ' + err);
                                        }
                                        else {
                                            this.adapter.setState(outputStateId, value, true);
                                        }
                                    });
                                }
                            }
                            else {
                                // send value directly
                                this.dssQueue.queueSetOutputValue(dev, dssConstants.outputChannelUnitRoleMap[output.channelType].native.channelIndex, 1, value, 'high', (err, _value)  => {
                                    if (err) {
                                        this.adapter.log.warn('Error when setting output value for ' + dev.dSUID + ': ' + err);
                                    }
                                    else {
                                        this.adapter.setState(outputStateId, value, true);
                                    }
                                });
                            }
                        }
                    }
                    else {
                        this.adapter.log.warn('Invalid output channel definition for device ' + dev.dSUID + ': ' + JSON.stringify(output));
                    }
                }
                else {
                    this.adapter.log.info(dev.outputChannels.length + ' Output values for device ' + dev.dSUID + ' are unsupported');
                }
                if (dev.buttonActiveGroup === 8) {
                    this.createJokerDevice(dev, devId, callback);
                }
                else {
                    callback && setImmediate(() => callback());
                }
            }
            else {
                if (dev.buttonActiveGroup === 8) {
                    this.createJokerDevice(dev, devId, callback);
                }
                else {
                    callback && setImmediate(() => callback());
                }
            }
        }
    }

    createJokerDevice(dev, devId, callback) {
        this.addStateObject(devId + '.buttonClickType', dev.dSUID + '.0.buttonClickType', {
            name: dev.name + ' Button Click Type',
            type: 'number',
            role: 'indicator',
            state: {
                0:  'Single Tip',
                1:  'Double Tip',
                2:  'Triple Tip',
                3:  'Quadruple Tip',
                4:  'Hold Start',
                5:  'Hold Repeat',
                6:  'Hold End',
                7:  'Single Click',
                8:  'Double Click',
                9:  'Triple Click',
                10: 'Single Tip (Off)',
                11: 'Single Tip (On/Down)',
                12: 'Single Tip (On/Up)',
                14: 'Single Tip (Stop)'
            }
        });
        this.initialObjectValues[devId + '.buttonClickType'] = null;

        this.addStateObject(devId + '.buttonHoldCount', dev.dSUID + '.0.buttonHoldCount', {
            name: dev.name + ' Button Hold Count',
            type: 'number',
            role: 'indicator',
            unit: 'ms',
            read: true,
            write: false
        });
        this.initialObjectValues[devId + '.buttonHoldCount'] = 0;

        if (dev.buttonInputCount > 1) {
            for (let cnt = 1; cnt < dev.buttonInputCount;cnt ++) {
                this.addStateObject(devId + '.button-' + cnt, dev.dSUID + '.' + cnt + '.button', {
                    name: dev.name + ' Button State',
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: false
                });
                this.initialObjectValues[devId + '.button-' + cnt] = false;

                this.addStateObject(devId + '.buttonClickType-' + cnt, dev.dSUID + '.' + cnt + '.buttonClickType', {
                    name: dev.name + ' Button Click Type',
                    type: 'number',
                    role: 'indicator',
                    state: {
                        0:  'Single Tip',
                        1:  'Double Tip',
                        2:  'Triple Tip',
                        3:  'Quadruple Tip',
                        4:  'Hold Start',
                        5:  'Hold Repeat',
                        6:  'Hold End',
                        7:  'Single Click',
                        8:  'Double Click',
                        9:  'Triple Click',
                        10: 'Single Tip (Off)',
                        11: 'Single Tip (On/Down)',
                        12: 'Single Tip (On/Up)',
                        14: 'Single Tip (Stop)'
                    }
                });
                this.initialObjectValues[devId + '.buttonClickType-' + cnt] = null;

                this.addStateObject(devId + '.buttonHoldCount-' + cnt, dev.dSUID + '.' + cnt + '.buttonHoldCount', {
                    name: dev.name + ' Button Hold Count',
                    type: 'number',
                    role: 'indicator',
                    unit: 'ms',
                    read: true,
                    write: false
                });
                this.initialObjectValues[devId + '.buttonHoldCount-' + cnt] = 0;
            }
        }
        callback && setImmediate(() => callback());
    }

    createLightDevice(dev, devId, callback) {
        const setLightValue = (outputType, value) => {
            if (outputType !== 'brightness') {
                this.adapter.log.warn('Not supported ' + outputType + ' for ' + dev.dSUID);
                return;
            }
            const percentValue = Math.round(value * 100 / 255);
            if (dev.outputMode === 16 && dev.outputSwitchThreshold !== undefined) {
                this.adapter.setState(devId + '.state', (value >= dev.outputSwitchThreshold), true);
                this.initialObjectValues[devId + '.state'] = (value >= dev.outputSwitchThreshold);
            }
            else {
                this.adapter.setState(devId + '.state', !!percentValue, true);
                this.initialObjectValues[devId + '.state'] = !!percentValue;
            }

            if (this.stateMap[dev.dSUID + '.brightness']) {
                this.adapter.setState(this.stateMap[dev.dSUID + '.brightness'], percentValue, true);
                this.initialObjectValues[this.stateMap[dev.dSUID + '.brightness']] = percentValue
            }
        };

        if (dev.outputMode === 16 && dev.outputSwitchThreshold === undefined) {
            this.dssQueue.pushQueryQueue(dev.meterDSUID, {
                dssClass: 'device',
                dssFunction: 'getSwitchThreshold',
                params: {
                    dsuid: dev.dSUID,
                    category: 'manual'
                }
            }, 'high', (err, res) => {
                if (err || (res && !res.ok) || !res.result || res.result.threshold === undefined || typeof res.result.threshold !== 'number') {
                    this.adapter.log.warn('Can not get SwitchThreshold for ' + dev.dSUID + ', assume 50%');
                    dev.outputSwitchThreshold = 128;
                }
                else {
                    dev.outputSwitchThreshold = res.result.threshold;
                }
                this.createLightDevice(dev, devId, callback);
            });
            return;
        }

        this.addStateObject( devId + '.state', {
            name: dev.name + ' State',
            type: 'boolean',
            role: 'switch.light'
        }, value => {
            value = !!value;
            this.dssQueue.pushQueryQueue(dev.meterDSUID, {
                dssClass: 'device',
                dssFunction: 'callScene',
                params: {
                    dsuid: dev.dSUID,
                    sceneNumber: value ? 14 : 13,
                    category: 'manual'
                }
            }, 'high', (err, res) => {
                if (err || (res && !res.ok)) {
                    this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for ' + dev.dSUID + ': ' + (err || JSON.stringify(res)));
                }
                else {
                    setLightValue('brightness', value ? 255 : 0);
                }
            });
        });
        if (this.dssObjects[devId + '.brightness']) {
            this.dssObjects[devId + '.brightness'].onChange = value => {
                if (value === 0 || value === 100) {
                    value = !!value;
                    this.dssQueue.pushQueryQueue(dev.meterDSUID, {
                        dssClass: 'device',
                        dssFunction: 'callScene',
                        params: {
                            dsuid: dev.dSUID,
                            sceneNumber: value ? 14 : 13,
                            category: 'manual'
                        }
                    }, 'high', (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for ' + dev.dSUID + ': ' + (err || JSON.stringify(res)));
                        } else {
                            setLightValue('brightness', value ? 255 : 0);
                        }
                    });
                }
                else {
                    value = Math.round(value * dssConstants.outputChannelUnitRoleMap['brightness'].native.nativeMax / 100);
                    this.dssQueue.queueSetOutputValue(dev, dssConstants.outputChannelUnitRoleMap['brightness'].native.channelIndex, dssConstants.outputChannelUnitRoleMap['brightness'].native.nativeMax, value, 'high', (err, value)  => {
                        if (err) {
                            this.adapter.log.warn('Error when setting output value for ' + dev.dSUID + ': ' + err);
                        }
                        else {
                            setLightValue('brightness', value);
                        }
                    });
                }
            }
        }

        if (dev.outputChannelList && this.adapter.config.initializeOutputValues) {
            Object.keys(dev.outputChannelList).forEach(outputType => {
                this.dssQueue.queueUpdateOutputValue(dev, dssConstants.outputChannelUnitRoleMap[outputType].native.channelIndex, dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax, 'medium', (err, value) => {
                    if (!err) {
                        setLightValue(outputType, value);
                    }
                });
            })
        }

        this.dss.on(dev.dSUID, data => {
            this.adapter.log.debug('DEVICE event ' + JSON.stringify(data));
            if (data.name !== 'callScene' && data.name !== 'undoScene') return;
            let brightness;
            if (this.adapter.config.usePresetValues) {
                brightness = dssConstants.lightSceneValueMap[data.properties.sceneID];
                if (brightness !== null && brightness !== undefined) {
                    setLightValue('brightness', brightness);
                }
            }
            this.dssQueue.queueUpdateOutputValue(dev, 0, ((brightness !== null && brightness !== undefined) || data.source.isGroup) ? 'low' : 'medium', (err, value) => {
                if (!err) {
                    setLightValue('brightness', value);
                }
            });
        });

        callback && setImmediate(() => callback());
    }

    createShaderDevice(dev, devId, callback) {
        let positionName = null;
        let angleName = null;

        if (dev.outputChannelList && this.adapter.config.initializeOutputValues) {
            Object.keys(dev.outputChannelList).forEach(outputType => {
                let relevant = false;
                if (!positionName && outputType.includes('Position')) {
                    positionName = outputType;
                    relevant = true;
                }
                else if (!angleName && outputType.includes('Angle')) {
                    angleName = outputType;
                    relevant = true;
                }
                if (!relevant) return;
                this.dssObjects[dev.outputChannelList[outputType]].onChange = value => {
                    const originalValue = value;
                    if (outputType === positionName && (value === 0 || value === 100)) {
                        value = !!value;
                        this.dssQueue.pushQueryQueue(dev.meterDSUID, {
                            dssClass: 'device',
                            dssFunction: 'callScene',
                            params: {
                                dsuid: dev.dSUID,
                                sceneNumber: value ? 14 : 13,
                                category: 'manual'
                            }
                        }, 'high', (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for ' + dev.dSUID + ': ' + (err || JSON.stringify(res)));
                            } else {
                                this.adapter.setState(dev.outputChannelList[outputType], originalValue, true);
                            }
                        });
                    }
                    else {
                        value = Math.round(value * dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax / 100);
                        this.dssQueue.queueSetOutputValue(dev, dssConstants.outputChannelUnitRoleMap[outputType].native.channelIndex, dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax, value, 'high', (err, _value)  => {
                            if (err) {
                                this.adapter.log.warn('Error when setting output value for ' + dev.dSUID + ': ' + err);
                            }
                            else {
                                this.adapter.setState(dev.outputChannelList[outputType], originalValue, true);
                            }
                        });
                    }
                };
                this.dssQueue.queueUpdateOutputValue(dev, dssConstants.outputChannelUnitRoleMap[outputType].native.channelIndex, dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax, 'medium', (err, value) => {
                    if (!err) {
                        if (dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax) {
                            value = Math.round(value * 100 / dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax);
                        }
                        this.adapter.setState(dev.outputChannelList[outputType], value, true);
                        this.initialObjectValues[dev.outputChannelList[outputType]] = value;
                    }
                });
            })
        }

        const valueUpdateTimeouts = {};
        this.dss.on(dev.dSUID, data => {
            this.adapter.log.debug('DEVICE event ' + JSON.stringify(data));
            if (data.name !== 'callScene' && data.name !== 'undoScene') return;
            if (this.adapter.config.usePresetValues) {
                let shadePos = dssConstants.shadeSceneValueMap[data.properties.sceneID];
                if (shadePos !== null && shadePos !== undefined) {
                    shadePos = Math.round(shadePos * 100 / 65535);
                    positionName && this.adapter.setState(dev.outputChannelList[positionName], shadePos, true);
                    if (shadePos === 0 || shadePos === 100 && angleName && dev.outputChannelList[angleName]) {
                        if (!this.dssObjects[dev.outputChannelList[angleName]]) {
                            this.adapter.log.warn('Can not set unknown state ' + dev.outputChannelList[angleName]);
                        }
                        else {
                            this.adapter.setState(dev.outputChannelList[angleName], shadePos, true);
                            this.initialObjectValues[dev.outputChannelList[angleName]] = shadePos;
                        }
                    }

                }
            }
            if (dev.outputChannelList) {
                Object.keys(dev.outputChannelList).forEach(outputType => {
                    if (valueUpdateTimeouts[outputType]) {
                        clearTimeout(valueUpdateTimeouts[outputType]);
                        valueUpdateTimeouts[outputType] = null;
                    }
                    valueUpdateTimeouts[outputType] = setTimeout(() => {
                        valueUpdateTimeouts[outputType] = null;
                        this.dssQueue.queueUpdateOutputValue(dev, dssConstants.outputChannelUnitRoleMap[outputType].native.channelIndex, dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax, 'medium', (err, value) => {
                            if (!err) {
                                if (dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax) {
                                    value = Math.round(value * 100 / dssConstants.outputChannelUnitRoleMap[outputType].native.nativeMax);
                                }
                                this.adapter.setState(dev.outputChannelList[outputType], value, true);
                                this.initialObjectValues[dev.outputChannelList[outputType]] = value;
                            }
                        });
                    }, 2000);
                })
            }
        });

        callback && setImmediate(() => callback());
    }

    convertSceneName(name) {
        if (!name) {
            return name;
        }
        const brackets = name.indexOf(' (');
        if (brackets !== -1) {
            name = name.substr(0, brackets);
        }
        name = name.replace(/ /g, '');
        return name;
    }

    createUserActions() {
        if (!this.userActions || !this.userActions.length) return;

        this.addFolderObject('userActions', 'User Actions', 'channel');

        this.userActions.forEach(action => {
            this.addStateObject('userActions.' + action.id, {
                name: 'User Action ' + action.name,
                type: 'boolean',
                role: 'button'
            },value => {
                if (!value) return;
                this.dssQueue.pushQueryQueue('event-' + action.id, {
                    dssClass: 'event',
                    dssFunction: 'raise',
                    params: {
                        name: 'highlevelevent',
                        parameter: 'id=' + action.id
                    }
                }, 'high', (err, res) => {
                    if (err || (res && !res.ok)) {
                        this.adapter.log.warn('Error while raise event for apartment: ' + (err || JSON.stringify(res)));
                    }
                });
            });
            this.initialObjectValues['userActions.' + action.id] = false;
        });
    }

    createApartment(apartment, reachableZoneGroups, callback) {
        this.addFolderObject('apartment', 'Apartment');

        let callbackCounter = 0;
        // Create Floors and Zones and Groups inside
        Object.keys(apartment.floors).forEach(floorId => {
            const floor = apartment.floors[floorId];
            this.addFolderObject('apartment.' + floorId, floor.name || 'Floor ' + floorId);

            floor.zones.forEach(zoneId => {
                callbackCounter++;
                setImmediate(() => this.processZone('apartment.' + floorId, apartment.zones[zoneId], reachableZoneGroups[zoneId].groups, this.sensorValues.zones[zoneId], this.temperatureControlStatus.zones[zoneId], () => {
                    !--callbackCounter && callback && callback(null);
                }));
            });
        });

        // Check if we have available Zones that were not assigned to any floor (should not happen)
        Object.keys(apartment.zones).forEach(zoneId => {
            if (this.processedZones[zoneId] || !apartment.zones[zoneId].isValid) return;
            this.adapter.log.warn('EXTRANOUS ZONE found ' + zoneId);
        });

        this.addFolderObject('apartment.scenes', 'Apartment Scenes', 'channel');

        const sceneList = {};
        Object.keys(dssConstants.apartmentScenes).forEach(sceneId => {
            // @ts-ignore
            if (sceneId >= 67 && sceneId <= 70) return; // ignore Zone Scenes?
            const sceneStateId = 'apartment.scenes.' + this.convertSceneName(dssConstants.apartmentScenes[sceneId]);
            sceneList[sceneId] = dssConstants.apartmentScenes[sceneId];

            this.addStateObject(sceneStateId, '0.0.scenes.' + sceneId, {
                name: 'Apartment ' + dssConstants.apartmentScenes[sceneId],
                type: 'boolean',
                role: 'switch'
            },value => {
                value = !!value;
                this.dssQueue.pushQueryQueue('apartment', {
                    dssClass: 'apartment',
                    dssFunction: value ? 'callScene' : 'undoScene',
                    params: {
                        sceneNumber: sceneId
                    }
                }, 'high', (err, res) => {
                    if (err || (res && !res.ok)) {
                        this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for apartment: ' + (err || JSON.stringify(res)));
                    }
                });
            });
            this.initialObjectValues[sceneStateId] = false;
        });
        if (Object.keys(sceneList).length) {
            this.addStateObject('apartment.scenes.sceneId',  {
                name: 'Scene ID',
                type: 'number',
                role: 'state',
                states: sceneList
            },value => {
                if (!sceneList[value]) {
                    this.adapter.log.warn('Invalid Scene ID ' + value + ' for apartment.scenes.sceneId');
                    return;
                }
                this.dssQueue.pushQueryQueue('apartment', {
                    dssClass: 'apartment',
                    dssFunction: 'callScene',
                    params: {
                        sceneNumber: value
                    }
                }, 'high', (err, res) => {
                    if (err || (res && !res.ok)) {
                        this.adapter.log.warn('Error while callScene for apartment: ' + (err || JSON.stringify(res)));
                    }
                });
            });

            callbackCounter++;
            this.dssQueue.pushQueryQueue('apartment', {
                dssClass: 'zone',
                dssFunction: 'getLastCalledScene',
                params: {
                    id: 0
                }
            }, 'high', (err, res) => {
                if (err || (res && !res.ok) || !res.result || res.result.scene === undefined) {
                    this.adapter.log.warn('Error while getLastCalledScene for apartment: ' + (err || JSON.stringify(res)));
                }
                else {
                    this.initialObjectValues['apartment.scenes.sceneId'] = res.result.scene;
                    this.initialScenes['0.0'] = res.result.scene;
                    const sceneStateId = 'apartment.scenes.' + this.convertSceneName(dssConstants.apartmentScenes[res.result.scene]);
                    if (this.dssObjects[sceneStateId]) {
                        this.initialObjectValues[sceneStateId] = true;
                    }
                }
                !--callbackCounter && callback && callback(null);
            });
        }

        const aptStates = this.findStates('^([^.]*)$');
        if (aptStates && aptStates.length) {
            this.addFolderObject('apartment.states', 'Apartment States', 'channel');

            aptStates.forEach(state => {
                if (!state.matchedName) return;
                const stateId = 'apartment.states.' + state.matchedName;
                const stateName = state.matchedName;
                let stateValue = state.state;
                if (dssConstants.apartmentStateRoleMap[stateName] && dssConstants.apartmentStateRoleMap[stateName].native) {
                    if (dssConstants.apartmentStateRoleMap[stateName].native.valueTrue !== undefined && stateValue == dssConstants.apartmentStateRoleMap[stateName].native.valueTrue) {
                        stateValue = true;
                    } else if (dssConstants.apartmentStateRoleMap[stateName].native.valueFalse !== undefined && stateValue == dssConstants.apartmentStateRoleMap[stateName].native.valueFalse) {
                        stateValue = false;
                    }
                }
                this.addStateObject(stateId, state.name, dssConstants.apartmentStateRoleMap[stateName], value => {
                    value = !!value;
                    if (!this.dssObjects[stateId] || !this.dssObjects[stateId].native) return;
                    this.dssQueue.pushQueryQueue('apartment', {
                        dssClass: 'state',
                        dssFunction: 'set',
                        params: {
                            name: state.name,
                            value: value ? this.dssObjects[stateId].native.valueTrue : this.dssObjects[stateId].native.valueFalse
                        }
                    }, 'high', (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.adapter.log.warn('Error while set State for apartment: ' + (err || JSON.stringify(res)));
                        }
                    });
                });
                this.initialObjectValues[stateId] = stateValue;
            });
        }

        if (this.propertyUserStates && this.propertyUserStates.length) {
            this.addFolderObject('apartment.userStates', 'Apartment User States', 'channel');

            this.propertyUserStates.forEach(state => {
                const stateId = 'apartment.userStates.' + state.name.replace(/\./g, '-');
                let stateValue = state.state;
                const stateObj = {
                    name: state.displayName,
                    role: 'indicator',
                    type: 'string'
                };
                this.addStateObject(stateId, state.name, stateObj, stateValue, value => {
                    this.dssQueue.pushQueryQueue('apartment-user', {
                        dssClass: 'state',
                        dssFunction: 'set',
                        params: {
                            addon: 'system-addon-user-defined-states',
                            name: state.name,
                            value: value
                        }
                    }, 'high', (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.adapter.log.warn('Error while set State for apartment-user: ' + (err || JSON.stringify(res)));
                        }
                    });
                });
                this.initialObjectValues[stateId] = stateValue;
            });
        }

        this.addFolderObject('apartment.sensors', 'Apartment Sensors');

        // Ignore weather for now!
        if (this.sensorValues.outdoor && Object.keys(this.sensorValues.outdoor).length) {
            this.addFolderObject('apartment.sensors.outdoor', 'Apartment Outdoor Sensors', 'channel');

            Object.keys(this.sensorValues.outdoor).forEach(sensorName => {
                if (!dssConstants.sensorValuesRoleMapOutdoor[sensorName]) {
                    this.adapter.log.warn('INVALID Sensor Type! ' + sensorName);
                    return;
                }
                this.addStateObject('apartment.sensors.outdoor.' + sensorName, '0.sensors.' + dssConstants.sensorValuesRoleMapOutdoor[sensorName].native.sensorType, dssConstants.sensorValuesRoleMapOutdoor[sensorName]);
                this.initialObjectValues['apartment.sensors.outdoor.' + sensorName] = {
                    val: this.sensorValues.outdoor[sensorName].value,
                    ts: typeof this.sensorValues.outdoor[sensorName].time === 'number' ? this.sensorValues.outdoor[sensorName].time : new Date(this.sensorValues.outdoor[sensorName].time).getTime()
                };
            });
        }
        this.addStateObject('apartment.sensors.VentilationStatusValue', '0.sensors.60', {
            name: 'Ventilation Status',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: false
        });

        // Create Apartment groups, as soon as at least one device is present
        this.addFolderObject('apartment.groups', 'Apartment Groups');

        apartment.zone0.groups.forEach(group => {
            if (!group.devices || !group.devices.length) return;
            callbackCounter++;
            setImmediate(() => this.processGroup('apartment.groups.' + group.id, 0, group, () => {
                !--callbackCounter && callback && callback(null);
            }));

            // setApartmentScene: '/apartment/callScene?sceneNumber=%s&force=true',
            //  setZoneScene: '/zone/callScene?id=%s&sceneNumber=%s&force=true',
            //  setGroupScene: '/zone/callScene?id=%s&groupID=%s&sceneNumber=%s&force=true',
            // undoScene
        });
        !callbackCounter && callback && setImmediate(() => callback(null));
    }

    processZone(baseId, zone, reachableGroups, sensorValues, temperatureControlStatus, callback) {
        if (!zone) {
            this.adapter.log.debug('INVALID ZONE ' + zone.id);
            return callback && setImmediate(callback, null);
        }
        if (!zone.isPresent) {
            this.adapter.log.debug('Ignore not present zone ' + zone.id);
            return callback && setImmediate(callback, null);
        }
        if (this.processedZones[zone.id]) {
            this.adapter.log.debug('Zone ' + zone.id + ' already processec');
            return callback && setImmediate(callback, null);
        }

        const zoneBaseId = baseId + '.' + zone.id;
        this.addFolderObject(zoneBaseId, zone.name || 'Zone ' + zone.id);

        const zoneStates = this.findStates('^zone\\.' + zone.id + '\\.([^.]*)$');
        if (zoneStates && zoneStates.length) {
            this.addFolderObject(zoneBaseId + '.states', 'Zone States', 'channel');

            zoneStates.forEach(state => {
                if (!state.matchedName) return;
                const stateId = zoneBaseId + '.states.' + state.matchedName;
                const stateName = state.matchedName;
                let stateValue = state.state;
                if (dssConstants.zoneStateRoleMap[stateName] && dssConstants.zoneStateRoleMap[stateName].native) {
                    if (dssConstants.zoneStateRoleMap[stateName].native.valueTrue !== undefined && stateValue === dssConstants.zoneStateRoleMap[stateName].native.valueTrue) {
                        stateValue = true;
                    }
                    else if (dssConstants.zoneStateRoleMap[stateName].native.valueFalse !== undefined && stateValue === dssConstants.zoneStateRoleMap[stateName].native.valueFalse) {
                        stateValue = false;
                    }
                }
                this.addStateObject(stateId, state.name, dssConstants.zoneStateRoleMap[stateName], stateValue, value => {
                    value = !!value;
                    if (!this.dssObjects[stateId] || !this.dssObjects[stateId].native) return;
                    this.dssQueue.pushQueryQueue('zone', {
                        dssClass: 'state',
                        dssFunction: 'set',
                        params: {
                            name: state.name,
                            value: value ? this.dssObjects[stateId].native.valueTrue : this.dssObjects[stateId].native.valueFalse
                        }
                    }, 'high', (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.adapter.log.warn('Error while set State for zone: ' + (err || JSON.stringify(res)));
                        }
                    });
                });
                this.initialObjectValues[stateId] = stateValue;
            });
        }

        let groupCounter = 0;
        zone.groups.forEach(group => {
            if (!reachableGroups.includes(group.id)) return;
            groupCounter++;
            setImmediate(() => this.processGroup(zoneBaseId + '.' + group.id, zone.id, group, () => {
                !--groupCounter && callback && callback(null);
            }));
        });
        this.processedZones[zone.id] = true;

        this.addFolderObject(zoneBaseId + '.scenes', (zone.name || 'Zone ' + zone.id) + ' Scenes', 'channel');

        const sceneList = {};
        this.basicRoomScenes.forEach(sceneId => {
            const sceneStateId = zoneBaseId + '.scenes.' + this.convertSceneName(dssConstants.zoneSceneCommands[sceneId]);
            sceneList[sceneId] = dssConstants.zoneSceneCommands[sceneId];

            this.addStateObject(sceneStateId, zone.id + '.0.scenes.' + sceneId, {
                name: 'Zone ' + zone.id + ' ' + dssConstants.zoneSceneCommands[sceneId],
                type: 'boolean',
                role: 'switch'
            }, value => {
                value = !!value;
                this.dssQueue.pushQueryQueue('zone', {
                    dssClass: 'zone',
                    dssFunction: value ? 'callScene' : 'undoScene',
                    params: {
                        id: zone.id,
                        sceneNumber: sceneId
                    }
                }, 'high', (err, res) => {
                    if (err || (res && !res.ok)) {
                        this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for zone ' + zone.id + ': ' + (err || JSON.stringify(res)));
                    }
                });
            });
            this.initialObjectValues[sceneStateId] = false;
        });
        for (let sceneId = 67; sceneId <= 70; sceneId++) {
            const sceneStateId = zoneBaseId + '.scenes.' + this.convertSceneName(dssConstants.apartmentScenes[sceneId]);
            sceneList[sceneId] = dssConstants.apartmentScenes[sceneId];

            this.addStateObject(sceneStateId, zone.id + '.0.scenes.' + sceneId, {
                name: 'Zone ' + zone.id + ' ' + dssConstants.apartmentScenes[sceneId],
                type: 'boolean',
                role: 'switch'
            }, value => {
                value = !!value;
                this.dssQueue.pushQueryQueue('zone', {
                    dssClass: 'zone',
                    dssFunction: value ? 'callScene' : 'undoScene',
                    params: {
                        id: zone.id,
                        sceneNumber: sceneId
                    }
                }, 'high', (err, res) => {
                    if (err || (res && !res.ok)) {
                        this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for zone ' + zone.id + ': ' + (err || JSON.stringify(res)));
                    }
                });
            });
            this.initialObjectValues[sceneStateId] = false;
        }
        if (Object.keys(sceneList).length) {
            this.addStateObject(zoneBaseId + '.scenes.sceneId', {
                name: 'Scene ID',
                type: 'number',
                role: 'value',
                states: sceneList
            },value => {
                if (!sceneList[value]) {
                    this.adapter.log.warn('Invalid Scene ID ' + value + ' for Zone ' + zone.id + '.scenes.sceneId');
                    return;
                }
                this.dssQueue.pushQueryQueue('zone', {
                    dssClass: 'zone',
                    dssFunction: 'callScene',
                    params: {
                        id: zone.id,
                        sceneNumber: value
                    }
                }, 'high', (err, res) => {
                    if (err || (res && !res.ok)) {
                        this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for Zone ' + zone.id + ': ' + (err || JSON.stringify(res)));
                    }
                });
            });

            groupCounter++;
            this.dssQueue.pushQueryQueue('zone', {
                dssClass: 'zone',
                dssFunction: 'getLastCalledScene',
                params: {
                    id: zone.id
                }
            }, 'high', (err, res) => {
                if (err || (res && !res.ok) || !res.result || res.result.scene === undefined) {
                    this.adapter.log.warn('Error while getLastCalledScene for zone ' + zone.id + ': ' + (err || JSON.stringify(res)));
                }
                else {
                    this.initialObjectValues[zoneBaseId + '.scenes.sceneId'] = res.result.scene;
                    this.initialScenes[zone.id + '.0'] = res.result.scene;
                    const sceneStateId = zoneBaseId + '.scenes.' + this.convertSceneName(dssConstants.apartmentScenes[res.result.scene]);
                    if (this.dssObjects[sceneStateId]) {
                        this.initialObjectValues[sceneStateId] = true;
                    }
                }
                !--groupCounter && callback && callback(null);
            });
        }

        this.addFolderObject(zoneBaseId + '.sensors', (zone.name || 'Zone ' + zone.id) + ' Sensors', 'channel');

        //sensorValues.values = sensorValues.values || [];
        if (temperatureControlStatus) {
            sensorValues.values.push(temperatureControlStatus);
        }

        sensorValues = sensorValues || {};
        sensorValues.values = sensorValues.values || [];
        Object.keys(dssConstants.sensorValuesRoleMapZone).forEach(sensorValueName => {
            const sensor = sensorValues.values.find(val => val[sensorValueName] !== undefined) || {};

            this.addStateObject( zoneBaseId + '.sensors.' + sensorValueName, zone.id + '.sensors.' + dssConstants.sensorValuesRoleMapZone[sensorValueName].native.sensorType, dssConstants.sensorValuesRoleMapZone[sensorValueName], value => {
                this.dssQueue.pushQueryQueue('zone', {
                    dssClass: 'zone',
                    dssFunction: 'pushSensorValue',
                    params: {
                        id: zone.id,
                        groupID: 0,
                        sensorType: dssConstants.sensorValuesRoleMapZone[sensorValueName].native.sensorType,
                        sensorValue: value
                    }
                }, 'high', (err, res) => {
                    if (err || (res && !res.ok)) {
                        this.adapter.log.warn('Error while pushSensorValue for zone: ' + (err || JSON.stringify(res)));
                    }
                });
            });
            if (sensor) {
                this.initialObjectValues[zoneBaseId + '.sensors.' + sensorValueName] = sensor[sensorValueName];
            }
        });

        !groupCounter && callback && setImmediate(() => callback(null));
    }

    processGroup(groupBaseId, zoneId, group, callback) {
        if (!group.isPresent || !group.isValid) {
            return callback && setImmediate(callback, null);
        }
        this.dss.requestAsync('zone', 'getReachableScenes' , {id: zoneId, groupID: group.id}).then((reachableScenes) => {
            this.adapter.log.debug('getReachableScenes ' + zoneId + '-' + group.id + ': ' + JSON.stringify(reachableScenes));

            this.addFolderObject(groupBaseId, group.name || 'Group ' + group.id);
            this.addFolderObject(groupBaseId + '.scenes', (group.name || 'Group ' + group.id) + ' Scenes', 'channel');

            const sceneList = {};
            const scenesToProcess = reachableScenes.result.reachableScenes || [];
            this.basicRoomScenes.forEach(sceneId => scenesToProcess.push(sceneId)); // enhance
            if (scenesToProcess.length) {
                const userNames = this.convertObject(reachableScenes.result.userSceneNames, 'sceneNr');
                if (scenesToProcess.includes(0)) {
                    scenesToProcess.push(40); // Add Auto-Off if we support off
                }
                scenesToProcess.forEach(sceneId => {
                    let sceneStateId;
                    let sceneName;
                    if (zoneId === 0) {
                        if (!dssConstants.apartmentScenes[sceneId] && !dssConstants.zoneSceneCommands[sceneId]) {
                            this.adapter.log.warn('IGNORE INVALID SCENEID ' + sceneId);
                            return;
                        }
                        sceneStateId = groupBaseId + '.scenes.' + this.convertSceneName(dssConstants.apartmentScenes[sceneId] || dssConstants.zoneSceneCommands[sceneId]);
                        sceneName = dssConstants.apartmentScenes[sceneId] || dssConstants.zoneSceneCommands[sceneId];
                    } else {
                        if (!dssConstants.zoneSceneCommands[sceneId]) {
                            this.adapter.log.warn('IGNORE INVALID SCENEID ' + sceneId);
                            return;
                        }
                        sceneStateId = groupBaseId + '.scenes.' + this.convertSceneName(dssConstants.zoneSceneCommands[sceneId]);
                        sceneName = (userNames[sceneId] && userNames[sceneId].sceneName) ? userNames[sceneId].sceneName : dssConstants.zoneSceneCommands[sceneId];
                    }
                    sceneList[sceneId] = sceneName;

                    this.addStateObject(sceneStateId, zoneId + '.' + group.id + '.scenes.' + sceneId, {
                        name: 'Group ' + group.id + ' ' + sceneName,
                        type: 'boolean',
                        role: 'switch'
                    },value => {
                        value = !!value;
                        this.dssQueue.pushQueryQueue('zone', {
                            dssClass: 'zone',
                            dssFunction: value ? 'callScene' : 'undoScene',
                            params: {
                                sceneNumber: sceneId,
                                groupID: group.id,
                                id: zoneId
                            }
                        }, 'high', (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for group: ' + (err || JSON.stringify(res)));
                            }
                        });
                    });
                    this.initialObjectValues[sceneStateId] = false;
                });
                for (let sceneId = 67; sceneId <= 70; sceneId++) {
                    const sceneStateId = groupBaseId + '.scenes.' + this.convertSceneName(dssConstants.apartmentScenes[sceneId]);
                    sceneList[sceneId] = dssConstants.apartmentScenes[sceneId];

                    this.addStateObject(sceneStateId, zoneId + '.' + group.id + '.scenes.' + sceneId, {
                        name: 'Group ' + group.id + ' ' + dssConstants.apartmentScenes[sceneId],
                        type: 'boolean',
                        role: 'switch'
                    }, value => {
                        value = !!value;
                        this.dssQueue.pushQueryQueue('zone', {
                            dssClass: 'zone',
                            dssFunction: value ? 'callScene' : 'undoScene',
                            params: {
                                id: zoneId,
                                groupID: group.id,
                                sceneNumber: sceneId
                            }
                        }, 'high', (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for group: ' + (err || JSON.stringify(res)));
                            }
                        });
                    });
                    this.initialObjectValues[sceneStateId] = false;
                }
            }
            if (group.id === 48 && zoneId !== 0) {
                Object.keys(dssConstants.temperatureControlScenes).forEach(sceneId => {
                    const sceneStateId = groupBaseId + '.scenes.' + this.convertSceneName(dssConstants.temperatureControlScenes[sceneId]);
                    const sceneName = dssConstants.temperatureControlScenes[sceneId];
                    sceneList[sceneId] = sceneName;

                    this.addStateObject(sceneStateId, zoneId + '.' + group.id + '.scenes.' + sceneId, {
                        name: 'Group ' + group.id + ' ' + sceneName,
                        type: 'boolean',
                        role: 'switch'
                    }, value => {
                        value = !!value;
                        this.dssQueue.pushQueryQueue('zone', {
                            dssClass: 'zone',
                            dssFunction: value ? 'callScene' : 'undoScene',
                            params: {
                                sceneNumber: sceneId,
                                groupID: group.id,
                                id: zoneId
                            }
                        }, 'high', (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for group: ' + (err || JSON.stringify(res)));
                            }
                        });
                    });
                    this.initialObjectValues[sceneStateId] = false;
                });
            }
            if ((group.id === 10 || group.id === 64) && zoneId !== 0) {
                Object.keys(dssConstants.ventilationControlScenes).forEach(sceneId => {
                    const sceneStateId = groupBaseId + '.scenes.' + this.convertSceneName(dssConstants.ventilationControlScenes[sceneId]);
                    const sceneName = dssConstants.ventilationControlScenes[sceneId];
                    sceneList[sceneId] = sceneName;

                    this.addStateObject(sceneStateId, zoneId + '.' + group.id + '.scenes.' + sceneId, {
                        name: 'Group ' + group.id + ' ' + sceneName,
                        type: 'boolean',
                        role: 'switch'
                    }, value => {
                        value = !!value;
                        this.dssQueue.pushQueryQueue('zone', {
                            dssClass: 'zone',
                            dssFunction: value ? 'callScene' : 'undoScene',
                            params: {
                                sceneNumber: sceneId,
                                groupID: group.id,
                                id: zoneId
                            }
                        }, 'high', (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.adapter.log.warn('Error while ' + (value ? 'callScene' : 'undoScene') + ' for group: ' + (err || JSON.stringify(res)));
                            }
                        });
                    });
                    this.initialObjectValues[sceneStateId] = false;
                });
            }
            if (Object.keys(sceneList).length) {
                this.addStateObject(groupBaseId + '.scenes.sceneId', {
                    name: 'Group Scene ID',
                    type: 'number',
                    role: 'value',
                    states: sceneList
                },value => {
                    if (!sceneList[value]) {
                        this.adapter.log.warn('Invalid Scene ID ' + value + ' for ' + groupBaseId + '.scenes.sceneId');
                        return;
                    }
                    this.dssQueue.pushQueryQueue('zone', {
                        dssClass: 'zone',
                        dssFunction: 'callScene',
                        params: {
                            sceneNumber: value,
                            groupID: group.id,
                            id: zoneId
                        }
                    }, 'high', (err, res) => {
                        if (err || (res && !res.ok)) {
                            this.adapter.log.warn('Error while callScene for ' + groupBaseId + '.scenes.sceneId: ' + (err || JSON.stringify(res)));
                        }
                    });
                });

                this.dssQueue.pushQueryQueue('zone', {
                    dssClass: 'zone',
                    dssFunction: 'getLastCalledScene',
                    params: {
                        id: zoneId,
                        groupID: group.id
                    }
                }, 'high', (err, res) => {
                    if (err || (res && !res.ok) || !res.result || res.result.scene === undefined) {
                        this.adapter.log.warn('Error while getLastCalledScene for group ' + zoneId + '.' + group.id + ': ' + (err || JSON.stringify(res)));
                    }
                    else {
                        this.initialObjectValues[groupBaseId + '.scenes.sceneId'] = res.result.scene;
                        this.initialScenes[zoneId + '.' + group.id] = res.result.scene;
                        const sceneStateId = groupBaseId + '.scenes.' + this.convertSceneName(dssConstants.apartmentScenes[res.result.scene] || dssConstants.zoneSceneCommands[res.result.scene]);
                        if (this.dssObjects[sceneStateId]) {
                            this.initialObjectValues[sceneStateId] = true;
                        }
                    }
                    callback && callback(null);
                });
            }

            const groupStates = this.findStates('^zone\\.' + zoneId + '\\.group\\.' + group.id + '\\.([^.]*)$');
            if (groupStates && groupStates.length) {
                this.addFolderObject(groupBaseId + '.states', (group.name || 'Group ' + group.id) + ' Scenes', 'channel');

                groupStates.forEach(state => {
                    if (!state.matchedName) return;
                    const stateId = groupBaseId + '.states.' + state.matchedName;
                    this.addStateObject(stateId, state.name, {
                        name: state.matchedName,
                        role: 'indicator',
                        type: 'boolean',
                        read: true,
                        write: false,
                        native: {}
                    }, value => {
                        value = !!value;
                        if (!this.dssObjects[stateId] || !this.dssObjects[stateId].native) return;
                        this.dssQueue.pushQueryQueue('group', {
                            dssClass: 'state',
                            dssFunction: 'set',
                            params: {
                                name: state.name,
                                value: value ? this.dssObjects[stateId].native.valueTrue : this.dssObjects[stateId].native.valueFalse
                            }
                        }, 'high', (err, res) => {
                            if (err || (res && !res.ok)) {
                                this.adapter.log.warn('Error while set State for group: ' + (err || JSON.stringify(res)));
                            }
                        });
                    });
                    this.initialObjectValues[stateId] = state.state;
                });
            }

            !Object.keys(sceneList).length && callback && callback(null);
        }, (err) => {
            this.adapter.log.warn('Err getReachableScenes:' + JSON.stringify(err));
            callback && callback(err);
        });
    }

    addFolderObject(id, name, type) {
        const obj ={
            type: type || 'folder',
            common: {
                name
            }
        };
        this.dssObjects[id] = obj;

        const idLength = id.replace(/[^.]/g, '').length;
        const spacesStr = '                              ';
        this.adapter.log.debug(spacesStr.substr(0, idLength * 2) + 'CREATE ' + obj.type + ' ' + id + ' WITH ' + JSON.stringify(obj));
    }

    addStateObject(id, dssId, objData, value, onChange) {
        if (typeof dssId === 'object') {
            onChange = value;
            value = objData;
            objData = dssId;
            dssId = null;
        }
        if (typeof value === 'function') {
            onChange = value;
            value = undefined;
        }

        objData = JSON.parse(JSON.stringify(objData));
        let native = {};
        if (objData.native) {
            native = objData.native;
            delete objData.native;
        }
        const obj = {
            type: 'state',
            common: objData,
            native,
            value,
            onChange
        };
        this.dssObjects[id] = obj;
        if (dssId) {
            this.stateMap[dssId] = id;
        }

        const idLength = id.replace(/[^.]/g, '').length;
        const spacesStr = '                              ';
        this.adapter.log.debug(spacesStr.substr(0, idLength * 2) + 'CREATE state ' + id + ' value = ' + value + ' WITH ' + JSON.stringify(obj));
    }
}

module.exports = DSSStructure;