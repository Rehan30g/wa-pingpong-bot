// Aliran aktivitas untuk dashboard owner (Plan v2 M2c): tugas agen, perubahan
// fitur, kurasi stiker, dan kejadian penting lain. Disimpan di memori (ring
// buffer) dan disiarkan ke pendengar (Server-Sent Events). Tanpa isi pesan pribadi.
const { EventEmitter } = require("node:events");

const LIMIT = 300;
const buffer = [];
const events = new EventEmitter();
events.setMaxListeners(50);
let sequence = 0;

function record(type, data = {}) {
  const entry = { id: ++sequence, at: Date.now(), type, ...data };
  buffer.push(entry);
  if (buffer.length > LIMIT) buffer.splice(0, buffer.length - LIMIT);
  events.emit("entry", entry);
  return entry;
}

function recent(limit = 100, type = null) {
  return buffer.filter((entry) => !type || entry.type === type).slice(-limit).reverse();
}

function subscribe(listener) {
  events.on("entry", listener);
  return () => events.off("entry", listener);
}

function clear() {
  buffer.length = 0;
}

module.exports = { clear, recent, record, subscribe };
