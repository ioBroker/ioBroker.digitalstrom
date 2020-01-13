const EventEmitter = require('events');

class DSS extends EventEmitter {

    constructor(options) {
        super();

        this.options = options || {
            logger: console.log
        };
        /* specify dss ip as parameter */
        this.wrapper = require('ds-wrapper')(this.options.host, 'warn');
        this.appToken = options.appToken;
        this.subScriptionId = options.subScriptionId || 42;
        this.subScriptionTimeout = options.subScriptionTimeout || 60 * 1000;

        this.subscriptions = {};

        this.sensortypes = {

        };
    }

    async createAppTokenAsync(username, password, readableName) {
        readableName = readableName || 'ioBroker';
        return new Promise((resolve, reject) => {
            this.wrapper.initializeAuthentication(readableName, username, password).then((token) => {
                this.appToken = token;
                resolve(token);
            }, (err) => {
                reject(err);
            });
        });
    }

    /**
     * Do Request to DSS
     * @param {string} dssClass
     * @param {string} dssFunction
     * @param {object} [params]
     * @returns {Promise} Promise: resolve(json) | reject(err, statusCode)
     */
    async requestAsync(dssClass, dssFunction, params) {
        return new Promise((resolve, reject) => {
            if (!this.appToken) {
                return void reject(new Error('You need to provide a appToken or do a login'));
            }
            this.wrapper.requestWithSessionFromDSS('/json/' + dssClass + '/' + dssFunction, params || {}, this.appToken).then((body) => {
                resolve(body);
            }, (err) => {
                reject(err);
            });
        });
    }

    pollEvent(eventName) {
        if (!this.subscriptions[eventName]) return;
        this.subscriptions[eventName].lastPollTime = Date.now();
        this.requestAsync('event', 'get', {subscriptionID: this.subscriptions[eventName].subscriptionId, timeout: this.subscriptions[eventName].timeout}).then( events => {
            //console.log('EVENT ' + JSON.stringify(events));
            if (events && events.result && events.result.events) {
                events.result.events.forEach(event => {
                    // TempFix: dSID ist eigentlich eine dSUID
                    if (typeof event.source.dsid !== 'undefined')
                        event.source['dSUID'] = event.source.dsid;
                    // TempFix: Schreibfehler
                    if (typeof event.properties.sceneId !== 'undefined')
                        event.properties['sceneID'] = event.properties.sceneId;

                    //! this.log.debug(`dSS - Event received: ${JSON.stringify(event)}`);
                    if (this.subscriptions[eventName]) {
                        this.emit(event.name, event);
                        this.subscriptions[eventName].errorCount = 0
                    }
                });
            }
            this.pollEvent(eventName);
        }, (err) => {
            if (this.subscriptions[eventName]) {
                this.subscriptions[eventName].errorCount = this.subscriptions[eventName].errorCount ? this.subscriptions[eventName].errorCount++ : 1;
                this.options.logger && this.options.logger.warn('Err: polling Event ' + eventName + ' (' + this.subscriptions[eventName].errorCount + '): ' + JSON.stringify(err));
                let delay = 5000 * this.subscriptions[eventName].errorCount;
                if (delay > 60000) {
                    delay = 60000;
                }
                this.emit('eventError', eventName, this.subscriptions[eventName].errorCount, err);
                setTimeout(() => this.pollEvent(eventName), delay);
            }
        });
    }

    subscribeEvent(eventName, subscriptionId, timeout, callback) {
        this.requestAsync('event' , 'subscribe', {subscriptionID: subscriptionId, name: eventName}).then( (body) => {
            if (!body || !body.ok) return;
            //console.log('Subscribed event ' + eventName + '('  + subscriptionId + '): ' + JSON.stringify(body));
            this.subscriptions[eventName] = {subscriptionId, timeout};
            this.pollEvent(eventName);
            callback && callback(null);
        }, (err) => {
            //console.log('Err:' + JSON.stringify(err));
            callback && callback(err);
        });
    }

    subscribeEvents(eventNames, startSubscriptionId, timeout, callback) {
        if (typeof startSubscriptionId === 'function') {
            callback = startSubscriptionId;
            timeout = undefined;
            startSubscriptionId = undefined;
        }
        if (typeof timeout === 'function') {
            callback = timeout;
            timeout = undefined;
        }
        timeout = timeout || this.subScriptionTimeout;
        startSubscriptionId = startSubscriptionId || this.subScriptionId;
        if (!Array.isArray(eventNames)) {
            eventNames = [eventNames];
        }
        let toSubscribe = eventNames.length;
        let errs = [];
        eventNames.forEach(eventName => this.subscribeEvent(eventName, startSubscriptionId++, timeout, (err) => {
            if (err) {
                errs.push(err);
            }
            if (!--toSubscribe) {
                if (!errs.length) {
                    // @ts-ignore
                    errs = null;
                }
                callback && callback(err);
            }
        }));
    }

    unsubscribeEvent(eventName, callback) {
        const sub = this.subscriptions[eventName];
        if (this.subscriptions[eventName]) {
            delete this.subscriptions[eventName];
        }
        this.requestAsync('event' , 'unsubscribe', {subscriptionID: sub.subscriptionId, name: eventName}).then( (body) => {
            if (!body || !body.ok) {
                return void callback && callback(JSON.stringify(body));
            }
            //console.log('Subscribed event ' + eventName + '('  + subscriptionId + '): ' + JSON.stringify(body));
            callback && callback(null);
        }, (err) => {
            //console.log('Err:' + JSON.stringify(err));
            callback && callback(err);
        });
    }

    unsubscribeAllEvents(callback) {
        let lastPollEnd = 0;
        const subscribedEvents = Object.keys(this.subscriptions);
        let openSubscriptions = subscribedEvents.length;
        if (!openSubscriptions) {
            this.subscriptions = {};
            return void callback && callback(0);
        }

        subscribedEvents.forEach(eventName => {
            const pollEnd = this.subscriptions[eventName].lastPollTime + this.subscriptions[eventName].timeout;
            if (pollEnd > lastPollEnd) {
                lastPollEnd = pollEnd;
            }
            this.unsubscribeEvent(eventName , () => {
                if (!--openSubscriptions) {
                    this.subscriptions = {};
                    callback && callback(lastPollEnd);
                }
            });
        });
    }
}

module.exports = DSS;