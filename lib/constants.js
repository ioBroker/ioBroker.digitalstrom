module.exports = {

    availableEvents: {
        'buttonClick': true, //
        'buttonDeviceAction': false, //true,
        'deviceSensorEvent': false, //true, //
        'deviceBinaryInputEvent': true, // Never seen
        'deviceActionEvent': false,
        'deviceEventEvent': false, //true,
        'callScene': true, // DONE
        'callSceneBus': false,
        'undoScene': true, // DONE
        'stateChange': true, // DONE
        'addonStateChange': true, // DONE
        'sunshine': false, // true,
        'frostprotection': false, //true,
        'heating_mode_switch': false, //true,
        'building_service': false,
        'action_execute': false,
        'highlevelevent': false, //true,
        'model_ready': false, // true, // real startup done, reinit!!
        'running': false, // startup
        'blink': false, // irrelevant
        'deviceSensorValue': true, // DONE
        'deviceStateEvent': false, //true,
        'zoneSensorValue': true, // DONE
        'executionDenied': false, //true,
        'operation_lock': false, //true,
        'cluster_config_lock': false, //true,
        'devices_first_seen': false, //true,
        'scene_name_changed': false, //true,
        'dsMeter_ready': false, //true, // reinit!
        'system_trigger': false, //true,
        'heating-controller.operation-mode': false //true // OpenHab
    },

    outputModeToRoleMap: {
        0: 'value',  // No output or output disabled
        16: 'switch',  // Switched
        17: 'level',  // RMS (root mean square) dimmer
        18: 'level',  // RMS dimmer with characteristic curve
        19: 'level',  // Phase control dimmer
        20: 'level',  // Phase control dimmer with characteristic curve
        21: 'level',  // Reverse phase control dimmer
        22: 'level',  // Reverse phase control dimmer with characteristic curve
        23: 'level',  // PWM (pulse width modulation)
        24: 'level',  // PWM with characteristic curve
        33: 'level',  // Positioning control
        39: 'level',  // Relay with switched mode scene table configuration
        40: 'level',  // Relay with wiped mode scene table configuration
        41: 'level',  // Relay with saving mode scene table configuration
        42: 'level'  // Positioning control for uncalibrated shutter
    },

    sensorUnitRoleMap: {
        66: {name: 'Temperature', type: 'number', role: 'value.temperature', unit: '°C'}, // Temperature, Kelvin (K)
        68: {name: 'Relative Humidity', type: 'number', role: 'value.humidity', unit: '%'}, // Relative Humidity, Percent (%)
        67: {name: 'Brightness', type: 'number', role: 'value.brightness', unit: 'Lx'}, // Brightness, Lux (Lx)
        25: {name: 'Sound Pressure Level', type: 'number', role: 'value', unit: 'dB'}, // Sound Pressure Level, dB
        4: {name: 'Active Power', type: 'number', role: 'value', unit: 'W'}, // Active Power, Watt (W)
        65: {name: 'Apparent Power', type: 'number', role: 'value', unit: 'VA'}, // Apparent Power, Volt-Ampere (VA)
        5: {name: 'Output Current', type: 'number', role: 'value.current', unit: 'mA'}, // Output Current, Ampere (mA)
        64: {name: 'Output Current (High Range)', type: 'number', role: 'value.current', unit: 'mA'}, // Output Current (High Range), Ampere (mA)
        6: {name: 'Energy Meter', type: 'number', role: 'value.power.consumption', unit: 'kWh'}, // Energy Meter, Watthours (kWh)
        69: {name: 'Generated Active Power', type: 'number', role: 'value', unit: 'W'}, // Generated Active Power, Watt (W)
        70: {name: 'Generated Energy Meter', type: 'number', role: 'value', unit: 'kWh'}, // Generated Energy Meter, Watthours (kWh)
        71: {name: 'Water Quantity', type: 'number', role: 'value', unit: 'l'}, // Water Quantity, Liter (l)
        72: {name: 'Water Flow Rate', type: 'number', role: 'value', unit: 'l/s'}, // Water Flow Rate, Liter/Second (l/s)
        73: {name: 'Length', type: 'number', role: 'value', unit: 'm'}, // Length, Meter (m)
        74: {name: 'Mass', type: 'number', role: 'value', unit: 'g'}, // Mass, Gram (g)
        75: {name: 'Time', type: 'number', role: 'value', unit: 's'}, // Time, Second (s)
        9: {name: 'Room Temperature', type: 'number', role: 'value.temperature', unit: '°C'}, // Room Temperature, Kelvin (K)
        13: {name: 'Room Relative Humidity', type: 'number', role: 'value.humidity', unit: '%'}, // Room Relative Humidity, Percent (%)
        11: {name: 'Room Brightness', type: 'number', role: 'value.brightness', unit: 'Lx'}, // Room Brightness, Lux (Lx)
        21: {name: 'Room Carbon Dioxide CO2 Concentration', type: 'number', role: 'value.co2', unit: 'ppm'}, // Room Carbon Dioxide CO2 Concentration, ppm
        22: {name: 'Room Carbon Monoxide CO Concentration', type: 'number', role: 'value.co2', unit: 'ppm'}, // Room Carbon Monoxide CO Concentration, ppm
        50: {name: 'Room Temperature Set Point', type: 'number', role: 'level.temperature', unit: '°C'}, // Room Temperature Set Point, Kelvin (K)
        51: {name: 'Room Temperature Control Variable', type: 'number', role: 'level', unit: '%'}, // Room Temperature Control Variable, Percent (%)
        10: {name: 'Outdoor Temperature', type: 'number', role: 'value.temperature', unit: '°C'}, // Outdoor Temperature, Kelvin (K)
        14: {name: 'Outdoor Relative Humidity', type: 'number', role: 'value.humidity', unit: '°C'}, // Outdoor Relative Humidity, Percent (%)
        12: {name: 'Outdoor Brightness', type: 'number', role: 'value.brightness', unit: 'Lx'}, // Outdoor Brightness, Lux (Lx)
        15: {name: 'Air pressure', type: 'number', role: 'value.pressure', unit: 'hPa'}, // Air pressure, Pascal (hPa)
        16: {name: 'Wind gust speed', type: 'number', role: 'value.speed.wind.gust', unit: 'm/s'}, // Wind gust speed, m/s
        17: {name: 'Wind gust direction', type: 'number', role: 'value.direction.wind', unit: '°'}, // Wind gust direction, degrees
        18: {name: 'Wind speed (average)', type: 'number', role: 'value.speed.wind', unit: 'm/s'}, // Wind speed (average), m/s
        19: {name: 'Wind direction', type: 'number', role: 'value.direction.wind', unit: '°'}, // Wind direction, degrees
        20: {name: 'Precipitation intensity of last hour', type: 'number', role: 'value.precipitation.hour', unit: 'mm/m2'}, // Precipitation intensity of last hour, mm/m2
        76: {name: 'Sun Azimuth', type: 'number', role: 'value.sun.azimuth', unit: '°'}, // Sun azimuth, degrees
        77: {name: 'Sun Elevation', type: 'number', role: 'value.sun.elevation', unit: '°'}, // Sun Elevation, degrees
        60: {
            name: 'Apartment Ventilation Status',
            role: 'sensor',
            type: 'number',
            states: {0: 'OK', 1: 'Reserved', 2: 'Malfunction', 4: 'Service', 6: 'Malfunction+Service'}
        }, // Apartment Ventilation
        255: {name: 'Unknown', type: 'number', role: 'value', unit: ''}, // Unknown
    },

    outputChannelUnitRoleMap: {
        brightness: {
            name: 'Light Brightness',
            role: 'level.brightness',
            unit: '%',
            type: 'number',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255,
                channelIndex: 0
            }
        }, // Light Brightness
        hue: {
            name: 'Colored Light Hue',
            role: 'level.color.hue',
            unit: '°',
            type: 'number',
            min: 0,
            max: 360,
            native: {
                nativeMax: 65535
            }
        }, // Colored Light Hue
        saturation: {
            name: 'Colored Light Saturation',
            role: 'level.color.saturation',
            unit: '%',
            type: 'number',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255
            }
        }, // Colored Light Saturation
        colortemp: {
            name: 'Color Temperature',
            role: 'level.color.temperature',
            unit: 'mired',
            type: 'number',
            min: 100,
            max: 1000,
            native: {
                nativeMax: 65535
            }
        }, // Color Temperature
        x: {
            name: 'Light CIE Color Model x',
            role: 'level',
            unit: '',
            type: 'number',
            min: 0,
            max: 10000,
            native: {
                nativeMax: 65535
            }
        }, // Light CIE Color Model x
        y: {
            name: 'Light CIE Color Model y',
            role: 'level',
            unit: '',
            type: 'number',
            min: 0,
            max: 10000,
            native: {
                nativeMax: 65535
            }
        }, // Light CIE Color Model y
        shadePositionOutside: {
            name: 'Shade Position Outside (blinds)',
            role: 'level.curtain',
            unit: '%',
            type: 'number',
            min: 0,
            max: 100,
            native: {
                nativeMax: 65535,
                channelIndex: 2
            }
        }, // Shade Position Outside (blinds)
        shadePositionIndoor: {
            name: 'Shade Position Outside (curtains)',
            role: 'level.curtain',
            unit: '%',
            type: 'number',
            min: 0,
            max: 100,
            native: {
                nativeMax: 65535,
                channelIndex: 2
            }
        }, // Shade Position Outside (curtains)
        shadeOpeningAngleOutside: {
            name: 'Shade Opening Angle Outside (blinds)',
            role: 'level.tilt',
            unit: '%',
            type: 'number',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255,
                channelIndex: 4
            }
        }, // Shade Opening Angle Outside (blinds)
        shadeOpeningAngleIndoor: {
            name: 'Shade Opening Angle Indoor (curtains)',
            role: 'level.tilt',
            unit: '%',
            type: 'number',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255,
                channelIndex: 4
            }
        }, // Shade Opening Angle Indoor (curtains)
        transparency: {
            name: 'Transparency',
            role: 'level',
            type: 'number',
            unit: '%',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255
            }
        }, // Transparency (e.g. smart glass)
        airFlowIntensity: {
            name: 'Air Flow Intensity',
            role: 'level',
            type: 'number',
            unit: '%',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255
            }
        }, // Air Flow Intensity
        airFlowDirection: {
            name: 'Air Flow Direction',
            role: 'level',
            type: 'number',
            min: 0,
            max: 2,
            states: {0: 'in+out', 1: 'supply (in)', 2: 'exhaust (out)'},
            native: {}
        }, // Air Flow Direction
        airFlapPosition: {
            name: 'Flap Opening Angle',
            role: 'level',
            unit: '%',
            type: 'number',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255
            }
        }, // Flap Opening Angle
        airLouverPosition: {
            name: 'Ventilation Louver Position',
            role: 'level',
            type: 'number',
            unit: '%',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255
            }
        }, // Ventilation Louver Position
        heatingPower: {
            name: 'Heating Power',
            role: 'level',
            type: 'number',
            unit: '',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255
            }
        }, // Heating Power
        coolingCapacity: {
            name: 'Cooling Capacity',
            role: 'level',
            type: 'number',
            unit: '%',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255
            }
        }, // Cooling Capacity
        audioVolume: {
            name: 'Audio Volume',
            role: 'level.volume',
            type: 'number',
            unit: '%',
            min: 0,
            max: 100,
            native: {
                nativeMax: 255
            }
        }, // Audio Volume (loudness)
        powerState: {
            name: 'Power State',
            role: 'level',
            type: 'number',
            unit: '',
            min: 0,
            max: 2,
            states: {0: 'Off', 1: 'Power Save', 2: 'On'},
            native: {}
        } // Power State
    },

    sensorValuesRoleMapOutdoor: {
        temperature: {
            name: 'Temperature',
            role: 'value.temperature',
            unit: '°C',
            type: 'number',
            native: {
                sensorType: 10
            }
        }, // Temperature, Kelvin (K)
        humidity: {
            name: 'Relative Humidity',
            role: 'value.humidity',
            unit: '%',
            type: 'number',
            native: {
                sensorType: 14
            }
        }, // Relative Humidity, Percent (%)
        brightness: {
            name: 'Brightness',
            role: 'value.brightness',
            unit: 'Lx',
            type: 'number',
            native: {
                sensorType: 12
            }
        }, // Brightness, Lux (Lx)
        precipitation: {
            name: 'Precipitation intensity of last hour',
            role: 'value.precipitation.hour',
            type: 'number',
            unit: 'mm/m2',
            native: {
                sensorType: 20
            }
        }, // Precipitation intensity of last hour, mm/m2
        airpressure: {
            name: 'Air pressure',
            role: 'value.pressure',
            type: 'number',
            unit: 'hPa',
            native: {
                sensorType: 15
            }
        }, // Air pressure, Pascal (hPa)
        windspeed: {
            name: 'Wind speed',
            role: 'value.speed.wind',
            type: 'number',
            unit: 'm/s',
            native: {
                sensorType: 18
            }
        }, // Wind speed, m/s
        winddirection: {
            name: 'Wind direction',
            type: 'number',
            role: 'value.direction.wind',
            unit: '°',
            native: {
                sensorType: 19
            }
        }, // Wind direction, degrees
        windgust: {
            name: 'Wind gust speed?',
            type: 'number',
            role: 'value.speed.wind.gust',
            unit: 'm/s',
            native: {
                sensorType: 16
            }
        }, // Wind gust speed, m/s
        gustspeed: {
            name: 'Wind gust speed',
            type: 'number',
            role: 'value.speed.wind.gust',
            unit: 'm/s',
            native: {
                sensorType: 16
            }
        }, // Wind gust speed, m/s
        gustdirection: {
            name: 'Wind gust direction',
            type: 'number',
            role: 'value.direction.wind',
            unit: '°',
            native: {
                sensorType: 17
            }
        }, // Wind gust direction, degrees
        sunazimuth: {
            name: 'Sun Azimuth',
            type: 'number',
            role: 'value.sun.azimuth',
            unit: '°',
            native: {
                sensorType: 76
            }
        }, // Wind gust direction, degrees
        sunelevation: {
            name: 'Sun Elevation',
            type: 'number',
            role: 'value.sun.elevation',
            unit: '°',
            native: {
                sensorType: 77
            }
        } // Wind gust direction, degrees
    },

    sensorValuesRoleMapZone: {
        TemperatureValue: {
            name: 'Temperature',
            role: 'value.temperature',
            unit: '°C',
            type: 'number',
            native: {
                sensorType: 9
            }
        }, // Temperature, Kelvin (K)
        HumidityValue: {
            name: 'Relative Humidity',
            role: 'value.humidity',
            unit: '%',
            type: 'number',
            native: {
                sensorType: 13
            }
        }, // Relative Humidity, Percent (%)
        CO2ConcentrationValue: {
            name: 'CO2 Concentration',
            role: 'value.co2',
            unit: 'ppm',
            type: 'number',
            native: {
                sensorType: 21
            }
        }, // CO2 Concentration, ppm
        BrightnessValue: {
            name: 'Brightness',
            role: 'value.brightness',
            unit: 'Lx',
            type: 'number',
            native: {
                sensorType: 11
            }
        }, // Brightness, Lux (Lx)
        ControlValue: {
            name: 'Room Temperature Control Variable',
            role: 'level',
            unit: '%',
            type: 'number',
            read: true,
            write: false,
            native: {
                sensorType: 51
            }
        } // Room Temperature Control Variable, Percent (%)
    },

    binaryInputTypeNames: {
        1: 'Presence', // Presence detector
        2: 'Brightness',
        3: 'Presence in darkness', // Presence detector with activated in- ternal twilight sensor
        4: 'Twilight', // Twilight sensor
        5: 'Motion', // Motion detector
        6: 'Motion in darkness', // Motion detector with activated internal twilight sensor
        7: 'Smoke', // Smoke Detector
        8: 'Wind strength above limit', // Wind monitor with user-adjusted wind strength threshold
        9: 'Rain', // Rain monitor
        10: 'Sun radiation', // Sun light above threshold
        11: 'Temperature below limit', // Room thermostat with used-adjusted temperature threshold
        12: 'Battery status is low', // electric battery is running out of power
        13: 'Window is open', // Window contact
        14: 'Door is open', // Door contact
        15: 'Window is tilted', // Window handle; window is tilted in- stead of fully opened
        16: 'Garage door is open', // Garage door contact
        17: 'Sun protection', // Protect against too much sun light
        18: 'Frost', // Frost detector
        19: 'Heating system enabled', // Heating system activated
        20: 'Change-over signal', // Change-over signal between warm water (active) or cold water (inactive)
        21: 'Initialization status', // On power-up or startup not all func- tions may be ready (yet)
        22: 'Malfunction', // Connected device is broken and re- quires maintenance. Operation may have seized.
        23: 'Service' // Connected device requires mainte- nance. Normal operation still possi- ble.
    },

    zoneSceneCommands: {
        1: 'Area 1 Off', // Set output value to Preset Area 1 Off (Default: Off)
        6: 'Area 1 On', // Set output value to Preset Area 1 On (Default: On)
        43: 'Area 1 Increment', // Initial command to increment output value
        42: 'Area 1 Decrement', // Initial command to decrement output value
        52: 'Area 1 Stop', // Stop output value change at current position

        2: 'Area 2 Off', // Set output value to Area 2 Off (Default: Off)
        7: 'Area 2 On', // Set output value to Area 2 On (Default: On)
        45: 'Area 2 Increment', // Initial command to increment output value
        44: 'Area 2 Decrement', // Initial command to decrement output value
        53: 'Area 2 Stop', // Stop output value change at current position

        3: 'Area 3 Off', // Set output value to Area 3 Off (Default: Off)
        8: 'Area 3 On', // Set output value to Area 3 On (Default: On)
        47: 'Area 3 Increment', // Initial command to increment output value
        46: 'Area 3 Decrement', // Initial command to decrement output value
        54: 'Area 3 Stop', // Stop output value change at current position

        4: 'Area 4 Off', // Set output value to Area 4 Off (Default: Off)
        9: 'Area 4 On', // Set output value to Area 4 On (Default: On)
        49: 'Area 4 Increment', // Initial command to increment output value
        48: 'Area 4 Decrement', // Initial command to decrement output value
        55: 'Area 4 Stop', // Stop output value change at current position

        10: 'Area Stepping Continue', // Next step to increment or decrement

        // local pushbutton
        51: 'Local On', // Local on
        50: 'Local Off', // Local off

        // special scenes
        13: 'Minimum', // Minimum output value
        14: 'Maximum', // Maximum output value
        15: 'Stop', // Stop output value change at current position
        40: 'Auto-Off', // Slowly fade down to off value
        41: 'Impulse', // Short impulse on the output
        56: 'Sun Protection', // Sun Protection

        // stepping
        12: 'Increment', // Increment output value
        11: 'Decrement', // Decrement output value

        // presets
        0: 'Preset 0 (Default: Off)', // Set output value to Preset 0 (Default: Off)
        5: 'Preset 1 (Default: On)', // Set output value to Preset 1 (Default: On)
        17: 'Preset 2', // Set output value to Preset 2
        18: 'Preset 3', // Set output value to Preset 3
        19: 'Preset 4', // Set output value to Preset 4

        32: 'Preset 10 (Default: Off)', // Set output value to Preset 10 (Default: Off)
        33: 'Preset 11 (Default: On)', // Set output value to Preset 11 (Default: On)
        20: 'Preset 12', // Set output value to Preset 12
        21: 'Preset 13', // Set output value to Preset 13
        22: 'Preset 24', // Set output value to Preset 14

        34: 'Preset 20 (Default: Off)', // Set output value to Preset 20 (Default: Off)
        35: 'Preset 21 (Default: On)', // Set output value to Preset 21 (Default: On)
        23: 'Preset 22', // Set output value to Preset 22
        24: 'Preset 23', // Set output value to Preset 23
        25: 'Preset 24', // Set output value to Preset 24

        36: 'Preset 30 (Default: Off)', // Set output value to Preset 30 (Default: Off)
        37: 'Preset 31 (Default: On)', // Set output value to Preset 31 (Default: On)
        26: 'Preset 32', // Set output value to Preset 32
        27: 'Preset 33', // Set output value to Preset 33
        28: 'Preset 34', // Set output value to Preset 34

        38: 'Preset 40 (Default: Off)', // Set output value to Preset 40 (Default: Off)
        39: 'Preset 41 (Default: On)', // Set output value to Preset 41 (Default: On)
        29: 'Preset 42', // Set output value to Preset 42
        30: 'Preset 43', // Set output value to Preset 43
        31: 'Preset 44', // Set output value to Preset 44
    },

    groupTypes: {
        0: 'Broadcast',
        1: 'Light/Yellow',
        2: 'Shading/Gray',
        3: 'Heating/Blue',
        4: 'Audio/Cyan',
        5: 'Video/Magenta',
        6: 'Reserved1',
        7: 'Reserved2',
        8: 'Joker/Black',
        9: 'Cooling/Blue',
        10: 'Ventilation/Blue',
        11: 'Window/Blue',
        12: 'Air recirculation/Blue',
        48: 'Temperature Control/Blue',
        64: 'Apartment Ventilation',
    },

    temperatureControlScenes: {
        0: 'Heating Off',
        1: 'Heating Comfort',
        2: 'Heating Economy',
        3: 'Heating Not Used',
        4: 'Heating Night',
        5: 'Heating Holiday',
        6: 'Cooling Comfort',
        7: 'Cooling Off',
        8: 'Cooling Economy',
        9: 'Cooling Not Used',
        10: 'Cooling Night',
        11: 'Cooling Holiday'
    },

    ventilationControlScenes: {
        0: 'Off',
        5: 'Level 1',
        17: 'Level 2',
        18: 'Level 3',
        19: 'Level 4',
        33: 'Automatic (air flow intensity)',
        35: 'Auto (louver swing mode)',
        36: 'Boost',
        37: 'Noise Reduction (calm)'
    },

    apartmentScenes: {
        68: 'Deep Off',
        66: 'Energy overload',
        67: 'Standby',
        75: 'Zone active',
        64: 'Auto Standby',
        72: 'Absent',
        71: 'Present',
        69: 'Sleeping',
        70: 'Wakeup',
        73: 'Door Bell',
        65: 'Panic',
        76: 'Fire',
        74: 'Alarm-1',
        83: 'Alarm-2',
        84: 'Alarm-3',
        85: 'Alarm-4',
        86: 'Wind',
        87: 'No-Wind',
        88: 'Rain',
        89: 'No-Rain',
        90: 'Hail',
        91: 'No-Hail'
    },

    shadeSceneValueMap: {
        // not in list === don't care
        // do not set value, just get it
        // LP === Ignore Local Priority when set - means wins 100%.
        0: 0, // Preset 0
        1: 0, // LP Area 1 Off
        2: 0, // LP Area 2 Off
        3: 0, // LP Area 3 Off
        4: 0, // LP Area 4 Off
        5: 65535, // Preset 1
        6: 65535, // LP Area 1 On
        7: 65535, // LP Area 2 On
        8: 65535, // LP Area 3 On
        9: 65535, // LP Area 4 On
        10: null, //0, // LP Area Stepping Continue
        11: null, //0, // Decrement ??
        12: null, //0, // Increment ??
        13: 0, // LP Minimum
        14: 65535, // LP Maximum
        15: null, //0, // LP Stop ??
        17: 65535, // Preset 2
        18: 32768, // Preset 3
        19: 16384, // Preset 4
        20: 65535, // Preset 12
        21: 32768, // Preset 13
        22: 16384, // Preset 14
        23: 65535, // Preset 22
        24: 32768, // Preset 23
        25: 16384, // Preset 24
        26: 65535, // Preset 32
        27: 32768, // Preset 33
        28: 16384, // Preset 34
        29: 65535, // Preset 42
        30: 32768, // Preset 43
        31: 16384, // Preset 44
        32: 0, // Preset 10
        33: 65535, // Preset 11
        34: 0, // Preset 20
        35: 65535, // Preset 21
        36: 0, // Preset 30
        37: 65535, // Preset 31
        38: 0, // Preset 40
        39: 65535, // Preset 41
        40: 0, // Auto-Off
        42: 0, // LP Area 1 Decrement
        43: 0, // LP Area 1 Increment
        44: 0, // LP Area 2 Decrement
        45: 0, // LP Area 2 Increment
        46: 0, // LP Area 3 Decrement
        47: 0, // LP Area 3 Increment
        48: 0, // LP Area 4 Decrement
        49: 0, // LP Area 4 Increment
        50: 0, // LP Device Off
        51: 65535, // LP Device On
        52: 0, // LP Area 1 Stop
        53: 0, // LP Area 2 Stop
        54: 0, // LP Area 3 Stop
        55: 0, // LP Area 4 Stop
        64: 0, // LP reserved
        65: 65535, // LP Panic
        67: 0, // LP Standby
        68: 0, // LP Deep Off
        69: 0, // LP Sleeping
        72: 0, // LP Absent
        76: 65535, // LP Fire
        77: 65535, // LP Smoke
        90: 65535 // LP Hail
    },

    lightSceneValueMap: {
        // not in list === don't care
        // do not set value, just get it
        // LP === Ignore Local Priority when set - means wins 100%.
        0: 0, // Preset 0
        1: 0, // LP Area 1 Off
        2: 0, // LP Area 2 Off
        3: 0, // LP Area 3 Off
        4: 0, // LP Area 4 Off
        5: 255, // Preset 1
        6: 255, // LP Area 1 On
        7: 255, // LP Area 2 On
        8: 255, // LP Area 3 On
        9: 255, // LP Area 4 On
        10: null, //0, // LP Area Stepping Continue
        11: null, //0, // Decrement ??
        12: null, //0, // Increment ??
        13: 0, // LP Minimum
        14: 255, // LP Maximum
        15: null, //0, // LP Stop ??
        17: 192, // Preset 2
        18: 128, // Preset 3
        19: 64, // Preset 4
        20: 192, // Preset 12
        21: 128, // Preset 13
        22: 64, // Preset 14
        23: 192, // Preset 22
        24: 128, // Preset 23
        25: 64, // Preset 24
        26: 192, // Preset 32
        27: 128, // Preset 33
        28: 64, // Preset 34
        29: 192, // Preset 42
        30: 128, // Preset 43
        31: 64, // Preset 44
        32: 0, // Preset 10
        33: 255, // Preset 11
        34: 0, // Preset 20
        35: 255, // Preset 21
        36: 0, // Preset 30
        37: 255, // Preset 31
        38: 0, // Preset 40
        39: 255, // Preset 41
        40: 0, // Auto-Off
        42: 0, // LP Area 1 Decrement
        43: 0, // LP Area 1 Increment
        44: 0, // LP Area 2 Decrement
        45: 0, // LP Area 2 Increment
        46: 0, // LP Area 3 Decrement
        47: 0, // LP Area 3 Increment
        48: 0, // LP Area 4 Decrement
        49: 0, // LP Area 4 Increment
        50: 0, // LP Device Off
        51: 255, // LP Device On
        52: 0, // LP Area 1 Stop
        53: 0, // LP Area 2 Stop
        54: 0, // LP Area 3 Stop
        55: 0, // LP Area 4 Stop
        64: 0, // LP reserved
        65: 255, // LP Panic
        67: 0, // LP Standby
        68: 0, // LP Deep Off
        69: 0, // LP Sleeping
        72: 0, // LP Absent
        76: 255 // LP Fire
    },

    zoneStateRoleMap: {
        light: {
            name: 'light',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        heating: {
            name: 'heating',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        motion: {
            name: 'motion',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        presence: {
            name: 'presence',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        }
    },

    apartmentStateRoleMap: {
        presence: {
            name: 'presence',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'present',
                valueFalse: 'absent'
            }
        },
        hibernation: {
            name: 'hibernation',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'sleeping',
                valueFalse: 'awake'
            }
        },
        daynight_indoors: {
            name: 'daynight_indoors',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'true',
                valueFalse: 'false'
            }
        },
        daynight: {
            name: 'daynight',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'true',
                valueFalse: 'false'
            }
        },
        twilight: {
            name: 'twilight',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'true',
                valueFalse: 'false'
            }
        },
        daylight: {
            name: 'daylight',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'true',
                valueFalse: 'false'
            }
        },
        daynight_state: {
            name: 'daynight',
            role: 'indicator',
            type: 'boolean',
            native: {
                valueTrue: 'true',
                valueFalse: 'false'
            }
        },
        twilight_state: {
            name: 'twilight',
            role: 'indicator',
            type: 'boolean',
            native: {
                valueTrue: 'true',
                valueFalse: 'false'
            }
        },
        daylight_state: {
            name: 'daylight',
            role: 'indicator',
            type: 'boolean',
            native: {
                valueTrue: 'true',
                valueFalse: 'false'
            }
        },
        daynight_indoors_state: {
            name: 'daynight_indoors',
            role: 'indicator',
            type: 'boolean',
            native: {
                valueTrue: 'true',
                valueFalse: 'false'
            }
        },
        holiday: {
            name: 'holiday',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'on',
                valueFalse: 'off'
            }
        },
        alarm: {
            name: 'alarm',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        alarm2: {
            name: 'alarm2',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        alarm3: {
            name: 'alarm3',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        alarm4: {
            name: 'alarm4',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        panic: {
            name: 'panic',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        fireMuteEnabled: {
            name: 'fireMuteEnabled',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        fire: {
            name: 'fire',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        wind: {
            name: 'wind',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        rain: {
            name: 'rain',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        hail: {
            name: 'hail',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        frost: {
            name: 'frost',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        sunlight_east: {
            name: 'sunlight east',
            role: 'indicator',
            type: 'string',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        sunlight_nord: {
            name: 'sunlight nord',
            role: 'indicator',
            type: 'string',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        sunlight_south: {
            name: 'sunlight south',
            role: 'indicator',
            type: 'string',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        sunlight_west: {
            name: 'sunlight west',
            role: 'indicator',
            type: 'string',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        building_service: {
            name: 'building_service',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        heating_system: {
            name: 'heating_system',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        heating_system_mode: {
            name: 'heating_system_mode',
            role: 'indicator',
            type: 'boolean',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        },
        heating_water_system: {
            name: 'heating_water_system',
            role: 'indicator',
            type: 'number',
            read: true,
            write: false,
            native: {
                valueTrue: 'active',
                valueFalse: 'inactive'
            }
        }
    }
};