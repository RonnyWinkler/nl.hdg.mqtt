'use strict';

const DEBUG = process.env.DEBUG === '1';
if (DEBUG) {
    require('inspector').open(9229, '0.0.0.0', false);
}

const Homey = require('homey');
const { HomeyAPI } = require('athom-api');
const MQTTClient = require('./mqtt/MQTTClient.js');
const Topic = require('./mqtt/Topic.js');

// Services
const Log = require("./Log.js");
const DeviceManager = require("./DeviceManager.js");
//const MessageHandler = require("./MessageHandler.js");

// Dispatchers
const SystemStateDispatcher = require("./dispatchers/SystemStateDispatcher.js");
const HomieDispatcher = require("./dispatchers/HomieDispatcher.js");

// Commands
const CommandHandler = require("./commands/CommandHandler.js");

/*
const defaultSettings = {
    "protocol": "homie3",
    "topicRoot": "homie",
    "deviceId": "homey",
    "topicIncludeClass": false,
    "topicIncludeZone": false,
    "propertyScaling": "default",
    "colorFormat": "hsv",
    "broadcastDevices": true,
    "broadcastSystemState": true,
};
*/

function getRootTopic(settings) {
    return typeof settings === 'object'
        ? [settings.topicRoot, settings.deviceId].filter(x => x).join('/')
        : undefined;
}

class MQTTHub extends Homey.App {

    async onInit() {
        Log.info('MQTT Hub is running...');

        this.settings = Homey.ManagerSettings.get('settings') || {};

        Log.debug(this.settings, false, false);

        this.api = await HomeyAPI.forCurrentHomey();
        this.system = await this._getSystemInfo();

        if (this.settings.deviceId === undefined) {
            this.settings.deviceId = Topic.normalize(this.system.name || 'homey');
            Log.debug("Settings initial deviceId: " + this.settings.deviceId);
            Homey.ManagerSettings.set('settings', this.settings);
            Log.debug("Settings updated");
        }

        Log.debug("Initialize MQTT Client");
        this.mqttClient = new MQTTClient(getRootTopic(this.settings));
        
        // Suppress memory leak warning
        Log.debug("Suppress memory leak warning");
        this.api.devices.setMaxListeners(9999); // HACK

        // devices
        Log.debug("Initialize DeviceManager");
        this.deviceManager = new DeviceManager(this);

        Log.debug("Register DeviceManager");
        await this.deviceManager.register();

        // run
        Log.debug("Launch!");
        this.start();
    }

    start() {
        Log.info('app start');
        this.mqttClient.connect();

        this._startCommands();
        this._startBroadcasters();

        const protocol = this.settings.protocol || 'homie3';
        if (this.protocol !== protocol) {
            Log.info("Changing protocol from '" + this.protocol + "' to '" + protocol + "'");
            this._stopCommunicationProtocol(this.protocol);
            this._startCommunicationProtocol(protocol);
        }

        Log.info('app running: true');
    }

    stop() {
        Log.info('app stop');
        this.mqttClient.disconnect();
        this._stopCommands();
        this._stopBroadcasters();
        this._stopCommunicationProtocol();
        delete this.protocol;
        Log.info('app running: false');
    }

    _startCommunicationProtocol(protocol) {
        this.protocol = protocol || this.protocol;
        Log.info('start communication protocol: ' + this.protocol );
        if (protocol) {
            switch (protocol) {
                case 'ha':
                    // TODO: Implement HA Discovery
                    break;
                case 'custom': // NOTE: Fallthrough => Custom protocol uses the homie dispacher
                case 'homie3': // NOTE: Fallthrough => Homie3 is default protocol
                default:
                    this.homieDispatcher = new HomieDispatcher(this);
                    break;
            }
        }
    }

    _stopCommunicationProtocol(protocol) {
        protocol = protocol || this.protocol;
        if (protocol) {
            Log.info('stop communication protocol: ' + this.protocol);
            if (protocol) {
                switch (protocol) {
                    case 'ha':
                        // TODO: Destroy HA Discovery
                        break;
                    case 'custom': // NOTE: Fallthrough => Custom protocol uses the homie dispacher
                    case 'homie3': // NOTE: Fallthrough => Homie3 is default protocol
                    default:
                        if (this.homieDispatcher) {
                            this.homieDispatcher.destroy();
                            delete this.homieDispatcher;
                        }
                        break;
                }
            }
        }
    }

    _startCommands() {
        this._stopCommands();
        this.commandHandler = new CommandHandler(this); // TODO: Refactor

        //this.messageHandler = new MessageHandler(this);
        //this.messageHandler.addMessageHandler(new SetCommandHandler(this));
    }
    _stopCommands() {
        if (this.commandHandler) {
            this.commandHandler.destroy();
            delete this.commandHandler;
        }
        //if (this.messageHandler) {
        //    this.messageHandler.destroy();
        //    delete this.messageHandler;
        //}
    }

    _startBroadcasters() {
        Log.info("start broadcasters");
        if (this.homieDispatcher) {
            const broadcast = this.settings.broadcastDevices !== false;
            Log.info("homie dispatcher broadcast: " + broadcast);
            this.homieDispatcher.broadcast = broadcast;
        }
        if (!this.systemStateDispatcher && this.settings.broadcastSystemState) {
            Log.info("start system dispatcher");
            this.systemStateDispatcher = new SystemStateDispatcher(this);
        }
    }

    _stopBroadcasters() {
        Log.info("stop broadcasters");
        if (this.homieDispatcher) {
            Log.info("stop homie dispatcher");
            this.homieDispatcher.broadcast = false;
        }

        if (this.systemStateDispatcher) {
            Log.info("stop system dispatcher");
            this.systemStateDispatcher.destroy();
            delete this.systemStateDispatcher;
        }
    }

    async _getSystemInfo() {
        Log.info("get system info");
        const info = await this.api.system.getInfo();
        return {
            name: info.hostname,
            version: info.homey_version
        };
    }

    async getDevices() {
        Log.info("get devices");
        if (this.deviceManager && this.deviceManager.devices)
            return this.deviceManager.devices;

        const api = await HomeyAPI.forCurrentHomey();
        return await api.devices.getDevices();
    }

    async getZones() {
        Log.info("get zones");
        if (this.deviceManager && this.deviceManager.zones)
            return this.deviceManager.zones;

        const api = await HomeyAPI.forCurrentHomey();
        return await api.zones.getZones();
    }

    isRunning() {
        return this.mqttClient && this.mqttClient.isRegistered() && !this.pause;
    }

    setRunning(running) {
        Log.info(running ? 'switch on' : 'switch off');
        if (this.mqttClient) {
            if (running)
                this.start();
            else
                this.stop();
        }
    }

    /**
     * Publish all device states
     * */
    refresh() {
        Log.info('refresh');
        if (this.homieDispatcher) {
            this.homieDispatcher.dispatchState();
        }
    }

    async settingsChanged() {
        Log.info("Settings changed");
        this.settings = Homey.ManagerSettings.get('settings') || {};
        Log.debug(this.settings);

        // deviceId
        if (this.mqttClient) {
            this.mqttClient.topicRoot = this.settings.deviceId;
        }

        // devices, topicRoot
        let deviceChanges = null;
        if (this.deviceManager) {
            deviceChanges = this.deviceManager.computeChanges(this.settings.devices);
            this.deviceManager.setEnabledDevices(this.settings.devices);
        }
        //Log.debug(deviceChanges);

        if (this.homieDispatcher) {
            this.homieDispatcher.updateSettings(this.settings, deviceChanges);
        }

        // protocol, broadcasts
        this.start(); // NOTE: Changes are detected in the start method(s)
    }
}

module.exports = MQTTHub;