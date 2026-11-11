/* ============================================================================
 * IotBench - embedded MQTT test broker (aedes)
 *
 * Runs a real MQTT broker on TCP :1883 so an ESP32 can connect HERE and publish
 * its bin data. Captures connected clients + every published message so the
 * /mqtt page can display them (first-level check without a cloud broker).
 *
 * Point the ESP32 at this PC:   mqttBroker = "<PC LAN IP>",  mqttPort = 1883
 * ========================================================================== */

'use strict';
const { Aedes } = require('aedes');
const net = require('net');

const state = { port: 1883, listening: false, error: null };
const messages = [];          // { seq, t, clientId, topic, payload }
let seq = 0;
const MAX = 300;
const clients = {};           // id -> { id, connectedAt, lastSeen, disconnectedAt }
let latest = null;            // last parsed message
let aedes = null;
let server = null;

function ts() { return new Date().toISOString().slice(11, 23); }

/* aedes v1 requires the async factory (new Aedes() is removed). */
async function start(port = 1883) {
  state.port = port;
  aedes = await Aedes.createBroker();

  aedes.on('client', (c) => {
    clients[c.id] = { id: c.id, connectedAt: Date.now(), lastSeen: Date.now(), disconnectedAt: 0 };
    console.log(`[${ts()}] MQTT client connected: ${c.id}`);
  });
  aedes.on('clientDisconnect', (c) => {
    if (clients[c.id]) clients[c.id].disconnectedAt = Date.now();
    console.log(`[${ts()}] MQTT client disconnected: ${c.id}`);
  });
  aedes.on('publish', (packet, client) => {
    if (!client) return;                       // skip broker-internal ($SYS/keepalive)
    const payload = packet.payload ? packet.payload.toString() : '';
    const e = { seq: ++seq, t: ts(), clientId: client.id, topic: packet.topic, payload };
    messages.push(e);
    if (messages.length > MAX) messages.shift();
    if (clients[client.id]) clients[client.id].lastSeen = Date.now();
    let data = null;
    try { data = JSON.parse(payload); } catch (_) { /* non-JSON payload */ }
    latest = { topic: packet.topic, payload, data, clientId: client.id, at: Date.now() };
    console.log(`[${ts()}] MQTT ${client.id} -> ${packet.topic}: ${payload}`);
  });

  server = net.createServer((socket) => aedes.handle(socket));
  server.listen(port, () => {
    state.listening = true; state.error = null;
    console.log(`MQTT broker listening on tcp://0.0.0.0:${port}`);
  });
  server.on('error', (err) => {
    state.listening = false; state.error = err.message;
    console.error(`MQTT broker error: ${err.message}`);
  });

  return server;
}

/* Server-side publish — used by the /furnace test page to push a retained message as if
 * the real production server had sent it (bypasses authorizePublish; that hook only gates
 * client publishes). Logged into the same messages/latest feed the /mqtt page polls, with
 * clientId '(server)' so it's visually distinct from anything the ESP32 itself published. */
function publish(topic, payloadObj, { retain = true, qos = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!aedes) { reject(new Error('broker not started')); return; }
    const payload = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
    const packet = { cmd: 'publish', qos, topic, payload: Buffer.from(payload), retain, dup: false };
    aedes.publish(packet, (err) => {
      if (err) { reject(err); return; }
      const e = { seq: ++seq, t: ts(), clientId: '(server)', topic, payload };
      messages.push(e);
      if (messages.length > MAX) messages.shift();
      let data = null;
      try { data = JSON.parse(payload); } catch (_) { /* non-JSON payload */ }
      latest = { topic, payload, data, clientId: '(server)', at: Date.now() };
      console.log(`[${ts()}] MQTT (server) -> ${topic}: ${payload}${retain ? ' [retained]' : ''}`);
      resolve();
    });
  });
}

function getStatus() { return { ...state }; }
function getClients() { return Object.values(clients); }
function getMessages(since = 0) { return messages.filter((m) => m.seq > since); }
function getLatest() { return latest; }
/* Last message seen on one specific topic (any sender), or null if none yet. */
function getLatestForTopic(topic) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].topic === topic) return messages[i];
  }
  return null;
}

module.exports = { start, publish, getStatus, getClients, getMessages, getLatest, getLatestForTopic };
