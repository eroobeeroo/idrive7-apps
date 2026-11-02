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

const net = require('net');
const fs = require('fs');

/** The head unit's neighbours on its in-car networks: the ARP table (units it has talked to), each interface's
 *  routes and gateways, and the other addresses its own networks hold that answered ARP. -> [{ ip, dev, from }] */
function neighbours() {
    const out = [], seen = new Set();
    const add = (ip, dev, from) => { if (!ip || ip === '0.0.0.0' || seen.has(ip)) return; seen.add(ip); out.push({ ip, dev, from }); };
    try {
        fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1).forEach((l) => {
            const f = l.trim().split(/\s+/);
            if (f.length >= 6 && f[2] !== '0x0') add(f[0], f[5], 'arp');
        });
    } catch (e) { /* not readable */ }
    try {
        fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).forEach((l) => {
            const f = l.trim().split(/\s+/);
            if (f.length < 3) return;
            const gw = parseInt(f[2], 16);
            if (gw) add([gw & 255, (gw >> 8) & 255, (gw >> 16) & 255, gw >>> 24].join('.'), f[0], 'route');
        });
    } catch (e) { /* not readable */ }
    return out;
}
/** the routes, for the page: 'dev dest/bits via gw' */
function routes() {
    const ip = (h) => { const n = parseInt(h, 16); return [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24].join('.'); };
    const bits = (h) => { let n = parseInt(h, 16) >>> 0, c = 0; while (n) { c += n & 1; n >>>= 1; } return c; };
    try {
        return fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 8)
            .map((f) => f[0] + ' ' + ip(f[1]) + '/' + bits(f[7]) + (parseInt(f[2], 16) ? ' via ' + ip(f[2]) : ''));
    } catch (e) { return []; }
}
/** whether a TCP port accepts a connection (closed again at once, nothing sent) */
function tcpOpen(ip, port, ms) {
    return new Promise((resolve) => {
        const s = net.connect({ host: ip, port });
        const done = (r) => { clearTimeout(t); s.destroy(); resolve(r); };
        const t = setTimeout(() => done('timeout'), ms);
        s.on('connect', () => done('open'));
        s.on('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : e.code || 'error'));
    });
}
/** the DoIP identification asked of one address (not broadcast) */
function doipUnicast(ip, ms) {
    return new Promise((resolve) => {
        let sock;
        try { sock = dgram.createSocket('udp4'); } catch (e) { resolve(null); return; }
        const done = (r) => { clearTimeout(t); try { sock.close(); } catch (e) { /* closed */ } resolve(r); };
        const t = setTimeout(() => done(null), ms);
        sock.on('error', () => done(null));
        sock.on('message', (m) => done(m.length >= 25 && m[2] === 0x00 && m[3] === 0x04 ? 'VIN ' + m.slice(8, 25).toString('latin1') + ', address ' + m.readUInt16BE(25).toString(16) : printable(m).slice(0, 60)));
        sock.send(DOIP_REQ, 13400, ip, () => {});
    });
}
const PORTS = [13400, 6801, 6811];
/**
 * The thorough search: every neighbour (neighbours()) and, on each of the head unit's networks, the usual unit
 * addresses (.1, .16 and the ones around its own), asked for DoIP identification and tried on the diagnostic TCP
 * ports (connect, then close: nothing sent). -> { routes, tried, open: [{ ip, port }], answered: [{ ip, text }] }
 */
async function searchGateway(log, opts) {
    opts = opts || {};
    const list = neighbours();
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((n) => (ifs[n] || []).forEach((a) => {
        if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) return;
        const p = a.address.split('.').map(Number);
        const mine = p[3];
        [1, 2, 10, 16, 17, 32, 64, 100, 128, 254].concat([-2, -1, 1, 2].map((d) => mine + d)).forEach((h) => {
            if (h > 0 && h < 255 && h !== mine) { const ip = p.slice(0, 3).concat(h).join('.'); if (!list.some((x) => x.ip === ip)) list.push({ ip, dev: n, from: 'guess' }); }
        });
    }));
    const max = opts.max || 80;
    const tried = list.slice(0, max), open = [], answered = [];
    // a few at a time
    for (let i = 0; i < tried.length; i += 8) {
        await Promise.all(tried.slice(i, i + 8).map(async (x) => {
            const id = await doipUnicast(x.ip, 400);
            if (id) answered.push({ ip: x.ip, text: id });
            for (const port of PORTS) { const r = await tcpOpen(x.ip, port, 400); if (r === 'open') open.push({ ip: x.ip, port }); }
        }));
    }
    const r = { routes: routes(), neighbours: list.filter((x) => x.from !== 'guess').map((x) => x.ip + ' ' + x.dev), tried: tried.length, open, answered };
    if (log) log.info('light show: gateway search (thorough) ' + JSON.stringify(r));
    return r;
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

/**
 * The head unit's Wi-Fi client network (wlan0 - the one it joins a phone's hotspot or a router with; not the
 * CarPlay bridge), every address of its /24 tried on the diagnostic ports: a gateway behind an ENET cable in a
 * travel router gets an address there by DHCP. -> [{ ip, port }]
 */
async function scanWifi(opts) {
    opts = opts || {};
    const ifs = os.networkInterfaces(), out = [];
    const nets = [];
    Object.keys(ifs).forEach((n) => { if (/^wlan\d+$/.test(n)) (ifs[n] || []).forEach((a) => { if ((a.family === 'IPv4' || a.family === 4) && !a.internal) nets.push(a.address); }); });
    for (const me of nets) {
        const p = me.split('.').map(Number), ips = [];
        for (let h = 1; h < 255; h++) if (h !== p[3]) ips.push(p.slice(0, 3).concat(h).join('.'));
        for (let i = 0; i < ips.length; i += 32) {
            await Promise.all(ips.slice(i, i + 32).map(async (ip) => {
                for (const port of [6801, 13400]) if (await tcpOpen(ip, port, opts.ms || 300) === 'open') out.push({ ip, port });
            }));
        }
    }
    return { nets, open: out };
}

module.exports = { findGateway, searchGateway, scanWifi, neighbours, tcpOpen, DOIP_REQ, HSFZ_REQ };
