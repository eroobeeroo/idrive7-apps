'use strict';
/**
 * gateway.js - whether the head unit can reach the car's central gateway directly over the car's own Ethernet, the
 * way tools on the OBD port do (ENET cable / Wi-Fi adapter: requests in milliseconds, against ~300 ms through the
 * head unit's diagnostic transport). Discovery only: the two identification requests the gateway answers to anyone
 * on the network, nothing diagnostic.
 *
 *   DoIP (ISO 13400, G-series): UDP vehicle identification request to port 13400, broadcast:
 *       02 FD 00 01 00 00 00 00        -> vehicle announcement (02 FD 00 04 ...: VIN, logical address)
 *   HSFZ (BMW, F-series and gateways that keep it): UDP identification to port 6811, broadcast:
 *       00 00 00 00 00 11              -> "DIAGADR..BMWMAC..BMWVIN.." text
 *
 * findGateway(log, { timeoutMs }) -> { interfaces: ['eth0 169.254.x.x', ...], found: [{ proto, ip, text }], error }
 */
const dgram = require('dgram');
const os = require('os');

const DOIP_REQ = Buffer.from([0x02, 0xFD, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
const HSFZ_REQ = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x11]);

/** the IPv4 broadcast address of each interface (and the general one) */
function broadcasts() {
    const out = new Set(['255.255.255.255']);
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((n) => (ifs[n] || []).forEach((a) => {
        if (a.family !== 'IPv4' && a.family !== 4) return;
        if (a.internal) return;
        const ip = a.address.split('.').map(Number), m = (a.netmask || '255.255.0.0').split('.').map(Number);
        out.add(ip.map((x, i) => (x & m[i]) | (~m[i] & 255)).join('.'));
    }));
    return Array.from(out);
}
function interfaces() {
    const ifs = os.networkInterfaces(), out = [];
    Object.keys(ifs).forEach((n) => (ifs[n] || []).forEach((a) => { if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(n + ' ' + a.address); }));
    return out;
}
const printable = (b) => b.toString('latin1').replace(/[^\x20-\x7e]+/g, ' ').trim();

function ask(port, msg, timeoutMs, proto, found) {
    return new Promise((resolve) => {
        let sock;
        try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { resolve('socket: ' + e.message); return; }
        const done = (err) => { try { sock.close(); } catch (e) { /* closed */ } resolve(err || null); };
        sock.on('error', (e) => done(proto + ': ' + e.message));
        sock.on('message', (m, rinfo) => {
            if (m.equals(msg)) return;                       // (our own broadcast)
            let text = '';
            if (proto === 'DoIP' && m.length >= 8 + 17 && m[2] === 0x00 && m[3] === 0x04) text = 'VIN ' + m.slice(8, 25).toString('latin1') + ', address ' + m.readUInt16BE(25).toString(16);
            else text = printable(m).slice(0, 80);
            if (!found.some((f) => f.ip === rinfo.address && f.proto === proto)) found.push({ proto, ip: rinfo.address, text });
        });
        sock.bind(0, () => {
            try { sock.setBroadcast(true); } catch (e) { done(proto + ': ' + e.message); return; }
            broadcasts().forEach((b) => sock.send(msg, port, b, () => {}));
            setTimeout(() => done(null), timeoutMs);
        });
    });
}

async function findGateway(log, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 1500;
    const found = [], errors = [];
    for (const [port, msg, proto] of [[13400, DOIP_REQ, 'DoIP'], [6811, HSFZ_REQ, 'HSFZ']]) {
        const e = await ask(port, msg, timeoutMs, proto, found);
        if (e) errors.push(e);
    }
    const r = { interfaces: interfaces(), found, error: errors.join('; ') || null };
    if (log) log.info('light show: gateway search ' + JSON.stringify(r));
    return r;
}

module.exports = { findGateway, DOIP_REQ, HSFZ_REQ };
