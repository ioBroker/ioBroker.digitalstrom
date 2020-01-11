class DSSQueue {

    constructor(options) {
        this.options = options || {
            logger: console.log
        };
        this.options.prioTimeouts = this.options.prioTimeouts || {
            'high': 2000,
            'medium': 15000,
            'low': 30000
        };
        this.dss = options.dss;

        this.queryQueue = {};
        this.nextEntryTimeout = {};
        this.lastProcessed = {};
    }

    clearQueue(circuit) {
        if (this.nextEntryTimeout[circuit]) {
            clearTimeout(this.nextEntryTimeout[circuit]);
            this.nextEntryTimeout[circuit] = null;
        }

        this.queryQueue[circuit] = [];
    }

    clearQueues() {
        Object.keys(this.queryQueue).forEach(circuit => this.clearQueue(circuit));
    }

    findNextPrioEntry(circuit, prio) {
        prio = prio || 'high';

        const found = this.queryQueue[circuit].findIndex(entry => entry.prio === prio);
        if (found === -1) {
            switch (prio) {
                case 'high':
                    prio = 'medium';
                    break;
                case 'medium':
                    prio = 'low';
                    break;
                case 'low':
                    prio = null;
                    break;
            }
            if (prio) {
                return this.findNextPrioEntry(circuit, prio);
            }
            return -1;
        } else {
            return found;
        }
    }

    pushQueryQueue(circuit, entryId, entry, prio, callback) {
        if (typeof entryId !== 'string') {
            callback = prio;
            prio = entry;
            entry = entryId;
            entryId = entry.dssClass + '-' + entry.dssFunction + '-' + entry.params.dsuid + '-' + (entry.params.id || entry.params.index || entry.params.offset || entry.params.sceneNumber);
        }
        prio = prio || 'low';
        this.queryQueue[circuit] = this.queryQueue[circuit] || [];
        this.lastProcessed[circuit] = this.lastProcessed[circuit] || Date.now();

        const found = this.queryQueue[circuit].findIndex(entry => entry.entryId === entryId);
        let nextProcessIndex = this.findNextPrioEntry(circuit);

        if (found !== -1) {
            if (
                (prio === 'high' && this.queryQueue[circuit][found].prio !== 'high') ||
                (prio === 'medium' && this.queryQueue[circuit][found].prio === 'low')
            ) {
                this.queryQueue[circuit][found].prio = prio;
            }
            this.queryQueue[circuit][found].callbacks.push(callback);
        } else {
            this.queryQueue[circuit].push({
                prio,
                entryId,
                entry,
                callbacks: [callback]
            });
        }

        nextProcessIndex = this.findNextPrioEntry(circuit);

        if (nextProcessIndex !== -1) {
            const sinceLastProcessed = Date.now() - this.lastProcessed[circuit];
            let nextEntryTimeout = this.options.prioTimeouts[this.queryQueue[circuit][nextProcessIndex].prio];
            if (sinceLastProcessed < nextEntryTimeout) {
                nextEntryTimeout = nextEntryTimeout - sinceLastProcessed;
            }
            else {
                nextEntryTimeout = 500;
            }
            if (this.nextEntryTimeout[circuit]) {
                clearTimeout(this.nextEntryTimeout[circuit]);
                this.nextEntryTimeout[circuit] = null;
            }
            this.nextEntryTimeout[circuit] = setTimeout(() => {
                this.nextEntryTimeout[circuit] = null;
                this.processQueryQueue(circuit);
            }, nextEntryTimeout);
        }
    }

    processQueryQueue(circuit) {
        //console.log(circuit + ': ' + this.queryQueue[circuit].length + ': ' + JSON.stringify(this.queryQueue[circuit]));
        const toProcess = this.findNextPrioEntry(circuit);
        if (toProcess === -1) return;

        const query = this.queryQueue[circuit][toProcess];
        this.options.logger && this.options.logger.debug(Date.now() + ' PROCESS Queued query ' + query.entry.dssClass + '/' + query.entry.dssFunction + ' and ' + JSON.stringify(query.entry.params));
        this.dss.requestAsync(query.entry.dssClass, query.entry.dssFunction, query.entry.params).then((res) => {
            this.lastProcessed[circuit] = Date.now();
            const query = this.queryQueue[circuit].splice(toProcess, 1)[0];

            this.options.logger && this.options.logger.debug(Date.now() + ' Queued Query processed ' + query.entry.dssClass + '/' + query.entry.dssFunction + ' and ' + JSON.stringify(query.entry.params) + ': ' + JSON.stringify(res));

            query.callbacks && query.callbacks.forEach(callback => callback(null, res));

            const nextProcessIndex = this.findNextPrioEntry(circuit);

            const nextEntryTimeout = nextProcessIndex !== -1 ? this.options.prioTimeouts[this.queryQueue[circuit][nextProcessIndex].prio] : 500;
            this.nextEntryTimeout[circuit] = setTimeout(() => {
                this.nextEntryTimeout[circuit] = null;
                this.processQueryQueue(circuit);
            }, nextEntryTimeout);
        }, (err) => {
            const query = this.queryQueue[circuit].splice(toProcess, 1)[0];

            this.options.logger && this.options.logger.warn('Queued Query ERROR ' + query.entry.dssClass + '/' + query.entry.dssFunction + ' and ' + JSON.stringify(query.entry.params) + ': ' + JSON.stringify(err));

            query.callbacks && query.callbacks.forEach(callback => callback(err));
            setImmediate(() => this.processQueryQueue(circuit));
        });
    }

    queueUpdateOutputValue(dev, index, length, prio, callback) {
        if (typeof length === 'string') {
            callback = prio;
            prio = length;
            length = 1;
        }
        if (typeof prio === 'function') {
            callback = prio;
            prio = null;
        }
        if (length > 4) {
            if (length === 255) {
                length = 1;
            } else if (length === 65535) {
                length = 2;
            }
        }
        const callEntry = {
            dssClass: 'device',
            dssFunction: 'getOutputValue',
            params: {
                dsuid: dev.dSUID,
                offset: index,
                category: 'manual'
            }
        };

        if (length === 2 || index > 0) {
            callEntry.dssFunction = length === 2 ? 'getConfigWord' : 'getConfig';
            callEntry.params.class = 64;
            callEntry.params.index = callEntry.params.offset;
            delete callEntry.params.offset;
        }
        this.pushQueryQueue(dev.meterDSUID, callEntry, prio, (err, res) => {
            if (err) {
                callback && callback(err);
            } else if (res && (res.ok === false || !res.result)) {
                callback && callback(res.message || res.status_code || res);
            } else {
                callback && callback(null, res.result.value);
            }
        });
    }

    queueSetOutputValue(dev, index, length, value, prio, callback) {
        if (typeof value === 'string') {
            callback = prio;
            prio = value;
            length = 1;
        }
        if (typeof prio === 'function') {
            callback = prio;
            prio = null;
        }
        if (length > 4) {
            if (length === 255) {
                length = 1;
            } else if (length === 65535) {
                length = 2;
            }
        }
        const callEntry = {
            dssClass: 'device',
            dssFunction: 'setOutputValue',
            params: {
                dsuid: dev.dSUID,
                offset: index,
                value,
                category: 'manual'
            }
        };

        if (length === 2 || index > 0) {
            callEntry.dssFunction = 'setConfig';
            callEntry.params.class = 64;
            callEntry.params.index = callEntry.params.offset;
            delete callEntry.params.offset;
        }
        this.pushQueryQueue(dev.meterDSUID, callEntry, prio, (err, res) => {
            if (err) {
                callback && callback(err);
            } else if (res && (res.ok === false)) {
                callback && callback(res.message || res.status_code || res);
            } else {
                callback && callback(null, value);
            }
        });
    }
}

module.exports = DSSQueue;