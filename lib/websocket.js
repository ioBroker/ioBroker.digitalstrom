const EventEmitter = require('node:events');
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

/**
 * Minimal websocket client (RFC 6455), just enough for the notification endpoint of the
 * digitalSTROM Smart Home API.
 *
 * Why not a library: the adapter has no runtime dependency besides adapter-core, and the
 * endpoint needs exactly two things that the browser API cannot do anyway - an own
 * Authorization header for the handshake and a plain ws:// connection on port 8090.
 * What is left is a handshake, text frames and a pong. That is this file.
 */

/** Fixed by RFC 6455 for the handshake answer */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
    continuation: 0x0,
    text: 0x1,
    binary: 0x2,
    close: 0x8,
    ping: 0x9,
    pong: 0xa,
};

/** A single frame must not grow beyond this, otherwise the connection is dropped */
const MAX_FRAME_SIZE = 8 * 1024 * 1024;
/** A fragmented message must not grow beyond this in total either */
const MAX_MESSAGE_SIZE = MAX_FRAME_SIZE;
/** How long the connection may stay silent before the client pings */
const PING_INTERVAL = 30 * 1000;
/** No incoming data for this long - not even a pong - means the connection is dead */
const IDLE_TIMEOUT = 90 * 1000;

class WebsocketError extends Error {
    /**
     * @param {string} message
     * @param {ErrorOptions} [options]
     */
    constructor(message, options) {
        super(message, options);
        this.name = 'WebsocketError';
    }
}

/**
 * Events: 'message' (string), 'close', 'error' (Error).
 */
class MiniWebsocket extends EventEmitter {
    /**
     * @param {object} options
     * @param {string} options.host
     * @param {number} options.port
     * @param {string} options.path
     * @param {Record<string, string>} [options.headers] additional handshake headers
     * @param {boolean} [options.secure] use TLS
     * @param {boolean} [options.rejectUnauthorized] validate the certificate, default false
     * @param {number} [options.handshakeTimeout] ms until the handshake has to be through
     * @param {number} [options.pingInterval] ms of silence before the client pings
     * @param {number} [options.idleTimeout] ms of silence before the connection counts as dead
     */
    constructor(options) {
        super();
        this.host = options.host;
        this.port = options.port;
        this.path = options.path;
        this.headers = options.headers || {};
        this.secure = !!options.secure;
        this.rejectUnauthorized = !!options.rejectUnauthorized;
        this.handshakeTimeout = options.handshakeTimeout || 20000;
        this.pingInterval = options.pingInterval || PING_INTERVAL;
        this.idleTimeout = options.idleTimeout || IDLE_TIMEOUT;

        /** @type {import('node:net').Socket|null} */
        this.socket = null;
        this.buffer = Buffer.alloc(0);
        this.handshakeDone = false;
        this.closed = false;
        /** @type {Buffer[]} Payload of a fragmented message that is still being received */
        this.fragments = [];
        this.fragmentsSize = 0;
        this.fragmentOpcode = 0;
        /** @type {NodeJS.Timeout|null} */
        this.watchdogTimer = null;
        this.lastActivity = 0;
    }

    /**
     * Opens the connection and resolves once the server answered with 101.
     *
     * @returns {Promise<void>}
     */
    connect() {
        return new Promise((resolve, reject) => {
            const key = crypto.randomBytes(16).toString('base64');
            const expectedAccept = crypto
                .createHash('sha1')
                .update(key + WEBSOCKET_GUID)
                .digest('base64');

            const connectOptions = {
                host: this.host,
                port: this.port,
                rejectUnauthorized: this.rejectUnauthorized,
            };
            const socket = this.secure ? tls.connect(connectOptions) : net.connect(connectOptions);
            this.socket = socket;

            let settled = false;
            const fail = err => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                reject(err instanceof Error ? err : new WebsocketError(String(err)));
            };
            const succeed = () => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.setTimeout(0);
                this.lastActivity = Date.now();
                this.startWatchdog();
                resolve();
            };

            socket.setTimeout(this.handshakeTimeout, () =>
                fail(new WebsocketError(`Websocket handshake timed out after ${this.handshakeTimeout} ms`)),
            );

            socket.once(this.secure ? 'secureConnect' : 'connect', () => {
                const lines = [
                    `GET ${this.path} HTTP/1.1`,
                    `Host: ${this.host}:${this.port}`,
                    'Upgrade: websocket',
                    'Connection: Upgrade',
                    `Sec-WebSocket-Key: ${key}`,
                    'Sec-WebSocket-Version: 13',
                    ...Object.entries(this.headers).map(([name, value]) => `${name}: ${value}`),
                    '',
                    '',
                ];
                socket.write(lines.join('\r\n'));
            });

            socket.on('error', err => {
                if (settled) {
                    this.emit('error', err);
                } else {
                    fail(err);
                }
            });

            socket.on('close', () => {
                this.stopWatchdog();
                if (settled) {
                    if (!this.closed) {
                        this.closed = true;
                        this.emit('close');
                    }
                } else {
                    fail(new WebsocketError('Connection closed during the handshake'));
                }
            });

            socket.on('data', chunk => {
                this.lastActivity = Date.now();
                this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
                if (!this.handshakeDone) {
                    const end = this.buffer.indexOf('\r\n\r\n');
                    if (end === -1) {
                        // The answer may still be incomplete, but it must not grow without bounds
                        if (this.buffer.length > 64 * 1024) {
                            fail(new WebsocketError('Handshake answer is too long'));
                        }
                        return;
                    }
                    const head = this.buffer.subarray(0, end).toString('utf8');
                    this.buffer = this.buffer.subarray(end + 4);
                    if (!/^HTTP\/1\.1 101/.test(head)) {
                        const status = head.split('\r\n')[0];
                        return fail(new WebsocketError(`Websocket handshake rejected: ${status}`));
                    }
                    const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head);
                    if (!accept || accept[1] !== expectedAccept) {
                        return fail(new WebsocketError('Websocket handshake answered with a wrong accept key'));
                    }
                    this.handshakeDone = true;
                    succeed();
                }
                try {
                    this.drainFrames();
                } catch (err) {
                    this.emit('error', err);
                    this.close();
                }
            });
        });
    }

    /**
     * A half-open TCP connection (dSS power loss, router change) never emits 'close',
     * the socket just goes silent forever. Any incoming byte counts as life - the dSS
     * sends SignalR keep-alives on its own. When nothing arrived for pingInterval the
     * client pings, which forces the server to answer; when even that stays unanswered
     * for idleTimeout the connection is declared dead so that 'close' fires and the
     * owner can reconnect.
     */
    startWatchdog() {
        this.stopWatchdog();
        this.watchdogTimer = setInterval(() => {
            const idle = Date.now() - this.lastActivity;
            if (idle >= this.idleTimeout) {
                this.emit('error', new WebsocketError(`No data received for ${idle} ms, connection is dead`));
                this.close();
            } else if (idle >= this.pingInterval) {
                this.sendFrame(Buffer.alloc(0), OPCODE.ping);
            }
        }, this.pingInterval);
    }

    stopWatchdog() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
    }

    /**
     * Reads every complete frame out of the buffer. Fragmented messages are collected
     * until their final frame arrives.
     */
    drainFrames() {
        for (;;) {
            if (this.buffer.length < 2) {
                return;
            }
            const first = this.buffer[0];
            const second = this.buffer[1];
            const fin = (first & 0x80) !== 0;
            const opcode = first & 0x0f;
            const masked = (second & 0x80) !== 0;
            let length = second & 0x7f;
            let offset = 2;

            if (length === 126) {
                if (this.buffer.length < offset + 2) {
                    return;
                }
                length = this.buffer.readUInt16BE(offset);
                offset += 2;
            } else if (length === 127) {
                if (this.buffer.length < offset + 8) {
                    return;
                }
                const big = this.buffer.readBigUInt64BE(offset);
                if (big > BigInt(MAX_FRAME_SIZE)) {
                    throw new WebsocketError(`Frame of ${big} bytes exceeds the limit`);
                }
                length = Number(big);
                offset += 8;
            }
            if (length > MAX_FRAME_SIZE) {
                throw new WebsocketError(`Frame of ${length} bytes exceeds the limit`);
            }

            /** @type {Buffer|null} A server frame is unmasked as a rule, then there is no key */
            let maskKey = null;
            if (masked) {
                if (this.buffer.length < offset + 4) {
                    return;
                }
                maskKey = this.buffer.subarray(offset, offset + 4);
                offset += 4;
            }
            if (this.buffer.length < offset + length) {
                return;
            }

            let payload = this.buffer.subarray(offset, offset + length);
            this.buffer = this.buffer.subarray(offset + length);
            if (maskKey) {
                payload = Buffer.from(payload.map((byte, idx) => byte ^ maskKey[idx % 4]));
            }

            if (opcode === OPCODE.close) {
                this.close();
                return;
            }
            if (opcode === OPCODE.ping) {
                this.sendFrame(payload, OPCODE.pong);
                continue;
            }
            if (opcode === OPCODE.pong) {
                continue;
            }
            if (opcode === OPCODE.continuation) {
                this.fragments.push(payload);
                this.fragmentsSize += payload.length;
                // MAX_FRAME_SIZE only limits the single frame - without this a server
                // could stream continuation frames forever and grow the memory unbounded
                if (this.fragmentsSize > MAX_MESSAGE_SIZE) {
                    throw new WebsocketError(`Fragmented message of ${this.fragmentsSize} bytes exceeds the limit`);
                }
            } else {
                this.fragments = [payload];
                this.fragmentsSize = payload.length;
                this.fragmentOpcode = opcode;
            }
            if (!fin) {
                continue;
            }
            const message = Buffer.concat(this.fragments);
            this.fragments = [];
            this.fragmentsSize = 0;
            if (this.fragmentOpcode === OPCODE.text || this.fragmentOpcode === OPCODE.binary) {
                this.emit('message', message.toString('utf8'));
            }
        }
    }

    /**
     * @param {Buffer} payload
     * @param {number} opcode
     */
    sendFrame(payload, opcode) {
        if (!this.socket || this.closed) {
            return;
        }
        const maskKey = crypto.randomBytes(4);
        const header = [0x80 | opcode];
        if (payload.length < 126) {
            header.push(0x80 | payload.length);
        } else if (payload.length < 65536) {
            header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
        } else {
            header.push(
                0x80 | 127,
                0,
                0,
                0,
                0,
                (payload.length >>> 24) & 0xff,
                (payload.length >>> 16) & 0xff,
                (payload.length >>> 8) & 0xff,
                payload.length & 0xff,
            );
        }
        // A client always masks, that is not optional in RFC 6455
        const masked = Buffer.from(payload.map((byte, idx) => byte ^ maskKey[idx % 4]));
        this.socket.write(Buffer.concat([Buffer.from(header), maskKey, masked]));
    }

    /**
     * @param {string} text
     */
    send(text) {
        this.sendFrame(Buffer.from(text, 'utf8'), OPCODE.text);
    }

    close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.stopWatchdog();
        try {
            this.socket && this.socket.destroy();
        } catch {
            /* a socket that is already gone needs no closing */
        }
        this.emit('close');
    }
}

// The extras hang off the class so `require('./websocket').OPCODE` keeps working next to
// `require('./websocket')` itself. Written as statics instead of further export
// assignments: the multi-assignment form is what an export-assignment module may not do.
MiniWebsocket.WebsocketError = WebsocketError;
MiniWebsocket.OPCODE = OPCODE;
MiniWebsocket.WEBSOCKET_GUID = WEBSOCKET_GUID;

module.exports = MiniWebsocket;
