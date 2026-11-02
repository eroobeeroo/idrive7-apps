'use strict';
/**
 * direct.js - the car's gateway straight over Ethernet, the way tools on the OBD port talk to it (ENET cable /
 * Wi-Fi adapter: a request in milliseconds instead of ~300 ms through the head unit's own diagnostic transport).
 * For a head unit joined to a Wi-Fi network the car's gateway is on (an ENET cable in a travel router's LAN port).
 *
 * Same interface as kit/diag.js's Diag for what LampLink uses: available, physical(target, sid, data, timeoutMs,
 * accept) -> the unit's UDS reply or null. Two protocols, the one the gateway answers is kept:
 *
 *   HSFZ (BMW, TCP 6801):  [length 4][control 2][payload]   length = payload bytes
 *       control 0x0001 diagnostic message, payload [source][target][UDS...]  (tester source 0xF4)
 *       the gateway acks with control 0x0002 (the request echoed), then answers with 0x0001 [unit][F4][UDS reply]
 *   DoIP (ISO 13400, TCP 13400):  [02 FD][type 2][length 4][payload]
 *       routing activation 0x0005 [source 2][00][00 00 00 00] -> 0x0006 [tester 2][entity 2][code 1 (0x10 ok)]...
 *       diagnostic message 0x8001 [source 2][target 2][UDS...] -> 0x8002 ack, then 0x8001 [unit 2][tester 2][reply]
 *       (the unit's logical address: its diagnostic address, 0x0040 for the body controller)
 *
 * "Response pending" (7F xx 78) replies wait longer, as diag.js does. Nothing is sent but what the caller asks:
 * LampLink's check() vets every request before it gets here.
 */
const net = require('net');
const EventEmitter = require('events');

const HSFZ_PORT = 6801, DOIP_PORT = 13400;
const HSFZ_TESTER = 0xF4;
const DOIP_TESTERS = [0x0EF3, 0x0E80, 0x00F4];     // tester addresses tried for DoIP routing activation

class DirectDiag extends EventEmitter {
    constructor(log, opts) {
        super();
        this.log = log; this.opts = opts || {};
        this.available = false; this.proto = null; this.host = null; this.sock = null;
        this.buf = Buffer.alloc(0); this.tester = null; this.error = null;
        this.connectTimeoutMs = this.opts.connectTimeoutMs || 1500;
    }
    /** connects to host: HSFZ first, then DoIP; resolves true when one is up */
    async connect(host) {
        this.close();
        this.host = host;
        for (const proto of ['hsfz', 'doip']) {
            try {
                await this._open(proto === 'hsfz' ? (this.opts.hsfzPort || HSFZ_PORT) : (this.opts.doipPort || DOIP_PORT));
                this.proto = proto;
                if (proto === 'doip' && !(await this._activate())) { this.close(); continue; }
                // a first request that every gateway answers: proof the link works (22 F1 90 VIN from the gateway 0x10)
                this.available = true;
                const vin = await this.physical(0x10, 0x22, [0xF1, 0x90], 1500);
                if (!vin) { this.available = false; this.close(); this.error = proto + ': no answer from the gateway'; continue; }
                this.vin = vin[0] === 0x62 ? Buffer.from(vin.slice(3)).toString('latin1') : null;
                this.log.info('direct: ' + proto + ' ' + host + (this.vin ? ' VIN ' + this.vin : ''));
                this.emit('available', true);
                return true;
            } catch (e) {
                this.error = proto + ': ' + (e.message || e);
                this.close();
            }
        }
        return false;
    }
    _open(port) {
        return new Promise((resolve, reject) => {
            const s = net.connect({ host: this.host, port });
            const t = setTimeout(() => { s.destroy(); reject(new Error('no connection on ' + port)); }, this.connectTimeoutMs);
            s.on('connect', () => { clearTimeout(t); s.setNoDelay(true); this.sock = s; resolve(); });
            s.on('error', (e) => { clearTimeout(t); if (this.sock === s) { this.available = false; this.emit('available', false); } reject(e); });
            s.on('close', () => { if (this.sock === s) { this.sock = null; this.available = false; this.emit('available', false); } });
            s.on('data', (d) => this._data(d));
        });
    }
    async _activate() {
        for (const src of DOIP_TESTERS) {
            const r = await this._exchange(this._doip(0x0005, Buffer.from([src >> 8, src & 255, 0x00, 0, 0, 0, 0])), (m) => m.type === 0x0006, 1500);
            if (r && r.payload.length >= 5 && r.payload[4] === 0x10) { this.tester = src; return true; }
        }
        this.error = 'doip: routing activation refused';
        return false;
    }
    _doip(type, payload) {
        const h = Buffer.alloc(8);
        h[0] = 0x02; h[1] = 0xFD; h.writeUInt16BE(type, 2); h.writeUInt32BE(payload.length, 4);
        return Buffer.concat([h, payload]);
    }
    _hsfz(control, payload) {
        const h = Buffer.alloc(6);
        h.writeUInt32BE(payload.length, 0); h.writeUInt16BE(control, 4);
        return Buffer.concat([h, payload]);
    }
    /** incoming bytes -> messages { type, payload } (HSFZ: type = control) */
    _data(d) {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
            if (this.proto === 'doip' || (this.proto === null && this.buf[0] === 0x02 && this.buf[1] === 0xFD)) {
                if (this.buf.length < 8) return;
                const len = this.buf.readUInt32BE(4);
                if (this.buf.length < 8 + len) return;
                const m = { type: this.buf.readUInt16BE(2), payload: this.buf.slice(8, 8 + len) };
                this.buf = this.buf.slice(8 + len);
                this.emit('msg', m);
            } else {
                if (this.buf.length < 6) return;
                const len = this.buf.readUInt32BE(0);
                if (this.buf.length < 6 + len) return;
                const m = { type: this.buf.readUInt16BE(4), payload: this.buf.slice(6, 6 + len) };
                this.buf = this.buf.slice(6 + len);
                this.emit('msg', m);
            }
        }
    }
    _exchange(bytes, want, ms) {
        return new Promise((resolve) => {
            const on = (m) => { if (want(m)) { done(m); } };
            const done = (m) => { clearTimeout(t); this.removeListener('msg', on); resolve(m); };
            const t = setTimeout(() => done(null), ms);
            this.on('msg', on);
            try { this.sock.write(bytes); } catch (e) { done(null); }
        });
    }
    /** one request to a unit; resolves with its UDS reply (null: none in time), like Diag.physical */
    physical(target, sid, data, timeoutMs, accept) {
        if (!this.sock || !this.available) return Promise.resolve(null);
        const uds = Buffer.from([sid].concat(data || []));
        return new Promise((resolve) => {
            let t;
            const finish = (v) => { clearTimeout(t); this.removeListener('msg', on); resolve(v); };
            const on = (m) => {
                let from, reply;
                if (this.proto === 'hsfz') {
                    if (m.type !== 0x0001 || m.payload.length < 3) return;
                    from = m.payload[0]; reply = Array.from(m.payload.slice(2));
                } else {
                    if (m.type !== 0x8001 || m.payload.length < 5) return;
                    from = m.payload.readUInt16BE(0); reply = Array.from(m.payload.slice(4));
                }
                if (from !== target) return;
                if (reply[0] === 0x7F && reply[2] === 0x78) {       // response pending: wait longer
                    if (reply[1] !== sid) return;
                    clearTimeout(t); t = setTimeout(() => finish(null), 5000);
                    return;
                }
                if (accept && !accept(reply)) return;
                finish(reply);
            };
            this.on('msg', on);
            t = setTimeout(() => finish(null), timeoutMs || 1000);
            const frame = this.proto === 'hsfz'
                ? this._hsfz(0x0001, Buffer.concat([Buffer.from([HSFZ_TESTER, target]), uds]))
                : this._doip(0x8001, Buffer.concat([Buffer.from([this.tester >> 8, this.tester & 255, 0x00, target]), uds]));
            try { this.sock.write(frame); } catch (e) { finish(null); }
        });
    }
    close() {
        const was = this.available;
        const s = this.sock;
        this.sock = null; this.available = false; this.proto = null; this.buf = Buffer.alloc(0);
        if (s) { try { s.destroy(); } catch (e) { /* gone */ } }
        if (was) this.emit('available', false);
    }
}

module.exports = { DirectDiag, HSFZ_PORT, DOIP_PORT, HSFZ_TESTER, DOIP_TESTERS };
