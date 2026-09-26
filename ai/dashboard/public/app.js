// Dashboard owner Grad (tanpa framework). Semua teks dari server di-escape
// sebelum masuk DOM, karena isinya bisa berasal dari chat (label stiker, memori).
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const subjects = new Map();
const chatName = (id) => subjects.get(id) || (String(id).endsWith("@g.us") ? `grup …${String(id).slice(-9, -5)}` : `DM ${String(id).replace(/@.*/, "")}`);
const time = (at) => new Date(at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
const dateTime = (at) => (at ? new Date(at).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");
const onOff = (value) => (value === true ? "aktif" : value === false ? "mati" : value);
const money = (value) => `$${Number(value || 0).toFixed(3)}`;

async function api(path, body) {
  const response = await fetch(path, body === undefined
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3000);
}

async function act(button, work, done) {
  if (button) button.disabled = true;
  try {
    const result = await work();
    if (done) toast(typeof done === "function" ? done(result) : done);
    return result;
  } catch (error) {
    toast(`Gagal: ${error.message}`);
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

// ---------- tab ----------
const loaders = {};
let currentTab = "overview";
$("#tabs").addEventListener("click", (event) => {
  const tab = event.target.dataset?.tab;
  if (!tab) return;
  currentTab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${tab}`));
  loaders[tab]?.();
});

// ---------- ringkasan ----------
function activityText(entry) {
  switch (entry.type) {
    case "task": {
      const tools = Object.entries(entry.tools || {}).map(([k, v]) => `${k}×${v}`).join(", ") || "tanpa tool";
      return `Tugas di ${chatName(entry.chat)} · ${entry.status} · ${tools} · ${(entry.durationMs / 1000).toFixed(1)} s · ${money(entry.cost)}`;
    }
    case "sticker_sent": return `Stiker "${entry.label}" dikirim ke ${chatName(entry.chat)}`;
    case "feature": return `Fitur ${entry.feature} ${entry.scope === "global" ? "global" : `di ${chatName(entry.scope)}`}: ${onOff(entry.from)} → ${onOff(entry.to)} (${entry.role || "?"})`;
    case "curation": return `Kurasi: ${entry.considered} dinilai, ${entry.kept} disimpan, ${entry.skipped} skip, ${entry.removed} dibuang`;
    case "review": return `Review: ${entry.reviewed} ditinjau, ${entry.removed} dibuang, ${entry.revised} direvisi`;
    case "setting": return `Pengaturan ${entry.key}: ${entry.from} → ${entry.to}`;
    case "agent": return `Agen: ${"enabled" in entry ? (entry.enabled ? "on" : "off") : `emergency pause ${entry.emergencyPaused ? "on" : "off"}`}`;
    case "proactive": return entry.mode === "muted" ? `Diminta diam di ${chatName(entry.chat)}` : `Masuk sendiri (${entry.mode === "help" ? "bantuan" : "nimbrung"}) di ${chatName(entry.chat)}`;
    case "background": return `Tugas latar ${entry.id} ${entry.state === "start" ? `mulai: ${entry.goal}` : entry.state}${entry.cost ? ` · ${money(entry.cost)}` : ""}`;
    case "dm_relay": return `Kirim ke DM peminta (${entry.texts} teks, ${entry.media} media)`;
    case "memory": return `Memori ${chatName(entry.chat)}: ${entry.mode}`;
    case "job": return `Job ${entry.id}: ${entry.action}`;
    default: return entry.type;
  }
}

loaders.overview = async () => {
  const o = await api("/api/overview");
  const conn = $("#conn");
  conn.textContent = o.connected ? "terhubung ke WhatsApp" : "tidak terhubung";
  conn.className = `pill ${o.connected ? "ok" : "bad"}`;
  $("#agent-enabled").checked = o.agent.enabled;
  $("#agent-paused").checked = o.agent.emergencyPaused;
  const used = o.usage.cost;
  const ratio = o.budget.dailyUsd ? Math.min(1, used / o.budget.dailyUsd) : 0;
  const uptime = o.uptimeMs == null ? "-" : `${Math.floor(o.uptimeMs / 3_600_000)} j ${Math.floor((o.uptimeMs % 3_600_000) / 60_000)} m`;
  $("#tiles").innerHTML = [
    ["Tugas hari ini", o.usage.tasks, `${o.usage.steps} langkah · ${o.usage.tokens.toLocaleString("id-ID")} token`],
    ["Biaya hari ini", money(used), `dari budget ${money(o.budget.dailyUsd)}`, ratio],
    ["Web", o.usage.searches, `pencarian · ${o.usage.fetches} baca link`],
    ["Voice note didengar", o.usage.audio, "hari ini"],
    ["Stiker", o.stickers?.collection ?? "-", `di koleksi · ${o.stickers?.candidates ?? 0} kandidat`],
    ["Grup aktif", o.groups, `${o.memory.people} orang dikenal · uptime ${uptime}`],
  ].map(([label, value, sub, bar]) => `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div>${bar === undefined ? "" : `<div class="bar ${bar > 0.85 ? "hot" : ""}"><span data-width="${Math.round(bar * 100)}"></span></div>`}</div>`).join("");
  // CSP melarang atribut style inline; lebar bar diset lewat CSSOM.
  document.querySelectorAll("#tiles [data-width]").forEach((el) => { el.style.width = `${el.dataset.width}%`; });
  $("#models").innerHTML = [["Keputusan", o.models.jev], ["Balasan & tools", o.models.chat], ["Telinga (audio)", o.models.audio], ["Akun bot", o.botUser || "-"], ["Job menunggu", o.agent.jobs], ["Jam tenang", o.agent.quiet ? "ya" : "tidak"]]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const { entries } = await api("/api/activity?limit=10");
  $("#overview-feed").innerHTML = entries.map((e) => `<li><time>${time(e.at)}</time><span>${esc(activityText(e))}</span></li>`).join("") || `<li class="muted">Belum ada aktivitas sejak bot start.</li>`;
};

$("#agent-enabled").addEventListener("change", (e) => act(null, () => api("/api/agent", { enabled: e.target.checked }), e.target.checked ? "Agen dinyalakan" : "Agen dimatikan (reminder tetap jalan)"));
$("#agent-paused").addEventListener("change", (e) => act(null, () => api("/api/agent", { emergencyPaused: e.target.checked }), e.target.checked ? "Emergency pause aktif" : "Emergency pause dilepas"));

// ---------- grup & fitur ----------
loaders.groups = async () => {
  const data = await api("/api/groups");
  for (const g of data.groups) subjects.set(g.id, g.subject);
  $("#global-locks").innerHTML = data.global.map((f) => `<label class="chip switch danger"><span>${esc(f.name)}</span><input type="checkbox" data-lock="${esc(f.name)}" ${f.locked ? "checked" : ""}><span>${f.locked ? "🔒" : "🔓"}</span></label>`).join("");
  $("#group-cards").innerHTML = data.groups.map((g) => `
    <div class="card"><h3>${esc(g.subject)}</h3><div class="features">
      ${g.features.map((f) => `<div class="feature"><div><span class="name">${esc(f.name)}</span>${f.locked ? '<span class="badge lock">dikunci owner</span>' : ""}<div class="desc">${esc(f.label)}</div></div>
        <label class="switch"><input type="checkbox" data-group="${esc(g.id)}" data-feature="${esc(f.name)}" ${f.enabled ? "checked" : ""} ${f.locked ? "disabled" : ""}></label></div>`).join("")}
    </div></div>`).join("") || `<div class="card muted">Belum ada grup yang diizinkan (/allow di grup).</div>`;
  $("#feature-log").innerHTML = `<tr><th>Waktu</th><th>Lingkup</th><th>Fitur</th><th>Perubahan</th><th>Oleh</th></tr>` + (data.log.map((l) => `<tr><td>${dateTime(l.at)}</td><td>${esc(l.scope === "global" ? "global" : chatName(l.scope))}</td><td>${esc(l.feature)}</td><td>${esc(onOff(l.from))} → ${esc(onOff(l.to))}</td><td>${esc(l.role || "-")}${l.by ? ` · ${esc(l.by)}` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Belum ada perubahan.</td></tr>`);
};

$("#group-cards").addEventListener("change", (event) => {
  const input = event.target;
  if (!input.dataset.feature) return;
  act(null, () => api("/api/groups/feature", { groupId: input.dataset.group, feature: input.dataset.feature, enabled: input.checked }), `Fitur ${input.dataset.feature} ${input.checked ? "aktif" : "mati"}`).then(() => loaders.groups());
});
$("#global-locks").addEventListener("change", (event) => {
  const input = event.target;
  if (!input.dataset.lock) return;
  act(null, () => api("/api/features/global", { feature: input.dataset.lock, locked: input.checked }), `${input.dataset.lock} ${input.checked ? "dikunci" : "dibuka"}`).then(() => loaders.groups());
});

// ---------- aktivitas live ----------
function activityRow(entry, fresh = false) {
  return `<tr class="${fresh ? "new" : ""}" data-type="${esc(entry.type)}"><td>${time(entry.at)}</td><td>${esc(entry.type)}</td><td>${esc(activityText(entry))}</td></tr>`;
}
function applyActivityFilter() {
  const filter = $("#activity-filter").value;
  document.querySelectorAll("#activity-table tr[data-type]").forEach((row) => { row.hidden = Boolean(filter) && row.dataset.type !== filter; });
}
loaders.activity = async () => {
  const { entries } = await api("/api/activity?limit=200");
  $("#activity-table").innerHTML = `<tr><th>Jam</th><th>Jenis</th><th>Detail</th></tr>` + entries.map((e) => activityRow(e)).join("");
  applyActivityFilter();
};
$("#activity-filter").addEventListener("change", applyActivityFilter);

function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = (message) => {
    const entry = JSON.parse(message.data);
    const table = $("#activity-table");
    const header = table.querySelector("tr");
    if (header) header.insertAdjacentHTML("afterend", activityRow(entry, true));
    applyActivityFilter();
    if (currentTab === "overview") loaders.overview();
  };
  source.onerror = () => {
    $("#conn").textContent = "dashboard terputus, menyambung ulang…";
    $("#conn").className = "pill bad";
  };
}

// ---------- stiker ----------
const KIND = { keep: "simpan", skip: "skip", remove: "buang", revise: "revisi" };
loaders.stickers = async () => {
  const data = await api("/api/stickers");
  const s = data.stats;
  $("#sticker-stats").textContent = `${s.collection} di koleksi · ${s.candidates} kandidat menunggu · ${s.skipped} di-skip · pemakaian manusia 24 jam: ${s.usesLast24h} · kurasi terakhir: ${dateTime(data.lastCurationAt)} · review terakhir: ${dateTime(data.lastReviewAt)}`;
  $("#sticker-grid").innerHTML = data.collection.map((st) => `
    <div class="sticker">
      <img src="/api/stickers/image?sha=${esc(st.sha)}" alt="${esc(st.label)}" loading="lazy">
      <div class="label">${esc(st.label)}${st.scope === "local" ? '<span class="badge local">lokal</span>' : ""}</div>
      <div class="meta">${esc(st.moods.join(", "))} · ${esc(st.plannedFrequency)} · dipakai ${st.botUseCount}×</div>
      <div class="meta">${esc(st.whenToUse)}</div>
      <button class="danger small" data-remove="${esc(st.sha)}" data-label="${esc(st.label)}">Buang</button>
    </div>`).join("") || `<p class="muted">Koleksi masih kosong. Kirim stiker di grup, lalu klik "Kurasi sekarang".</p>`;
  $("#sticker-decisions").innerHTML = `<tr><th>Waktu</th><th>Stiker</th><th>Keputusan</th><th>Sumber</th><th>Alasan</th></tr>` + (data.decisions.map((d) => `<tr><td>${dateTime(d.at)}</td><td>${esc(d.id)}${d.label ? ` "${esc(d.label)}"` : ""}</td><td>${esc(KIND[d.kind] || d.kind)}</td><td>${esc(d.source)}</td><td>${esc(d.reason)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">Belum ada keputusan.</td></tr>`);
};
$("#sticker-grid").addEventListener("click", (event) => {
  const sha = event.target.dataset?.remove;
  if (!sha || !confirm(`Buang stiker "${event.target.dataset.label}" dari koleksi?`)) return;
  act(event.target, () => api("/api/stickers/remove", { sha }), "Stiker dibuang").then(() => loaders.stickers());
});
$("#btn-curate").addEventListener("click", (e) => act(e.target, () => api("/api/stickers/curate", {}), (r) => `Kurasi: ${r.considered} dinilai, ${r.kept.length} disimpan, ${r.skipped.length} skip`).then(() => loaders.stickers()));
$("#btn-review").addEventListener("click", (e) => act(e.target, () => api("/api/stickers/review", {}), (r) => `Review: ${r.removed.length} dibuang, ${r.revised.length} direvisi`).then(() => loaders.stickers()));

// ---------- memori ----------
loaders.memory = async () => {
  const data = await api("/api/memory");
  for (const g of data.groups) subjects.set(g.id, g.subject);
  $("#memory-groups").innerHTML = data.groups.map((g) => `
    <div class="card">
      <div class="row"><h3>${esc(g.subject)}</h3><div class="actions">
        <button class="ghost small" data-clear="${esc(g.id)}" data-mode="clear">Clear</button>
        <button class="danger small" data-clear="${esc(g.id)}" data-mode="reset">Reset</button>
      </div></div>
      <p class="muted">${g.active} pesan aktif · compact terakhir ${esc(g.updatedAt || "belum pernah")}</p>
      <details><summary>Memori GLM</summary><pre class="memory">${esc(g.glm)}</pre></details>
      <details><summary>Konteks Jev</summary><pre class="memory">${esc(g.jev)}</pre></details>
    </div>`).join("") || `<div class="card muted">Belum ada grup.</div>`;
  $("#people").innerHTML = `<tr><th>Nama</th><th>Nomor</th><th>Terakhir terlihat</th><th>Profil</th></tr>` + (data.people.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.phone)}</td><td>${esc(p.lastSeen || "-")}</td><td>${esc(p.profile || p.relation || "-")}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Belum ada.</td></tr>`);
};
$("#memory-groups").addEventListener("click", (event) => {
  const groupId = event.target.dataset?.clear;
  if (!groupId) return;
  const mode = event.target.dataset.mode;
  const message = mode === "reset" ? "Reset menghapus riwayat aktif DAN seluruh memori grup ini. Lanjut?" : "Bersihkan riwayat aktif (memori compact tetap)?";
  if (!confirm(message)) return;
  act(event.target, () => api("/api/memory/clear", { groupId, mode }), mode === "reset" ? "Memori grup direset" : "Riwayat aktif dibersihkan").then(() => loaders.memory());
});

// ---------- jadwal ----------
loaders.jobs = async () => {
  const { jobs } = await api("/api/jobs");
  $("#jobs").innerHTML = `<tr><th>Jatuh tempo</th><th>Jenis</th><th>Tujuan</th><th>Isi</th><th>Percobaan</th><th></th></tr>` + (jobs.map((j) => `<tr><td>${dateTime(j.fire_at)}</td><td>${esc(j.type)}</td><td>${esc(j.payload?.phone || j.payload?.chatId || "-")}</td><td>${esc(j.payload?.text || j.payload?.reason || "")}</td><td class="num">${j.attempts || 0}</td><td><button class="danger small" data-cancel="${esc(j.id)}">Batalkan</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Tidak ada job aktif.</td></tr>`);
};
$("#jobs").addEventListener("click", (event) => {
  const id = event.target.dataset?.cancel;
  if (!id || !confirm("Batalkan job ini?")) return;
  act(event.target, () => api("/api/jobs/cancel", { id }), "Job dibatalkan").then(() => loaders.jobs());
});

// ---------- pengaturan ----------
loaders.settings = async () => {
  const { settings } = await api("/api/settings");
  const groups = [...new Set(settings.map((s) => s.group))];
  $("#settings").innerHTML = groups.map((group) => `<div class="card"><h3>${esc(group)}</h3>${settings.filter((s) => s.group === group).map((s) => `
    <div class="setting"><div><div>${esc(s.label)}</div><div class="muted"><code>${esc(s.key)}</code>${s.overridden ? ' <span class="overridden">diubah dari dashboard</span>' : ""}</div></div>
    ${s.type === "enum"
      ? `<select data-setting="${esc(s.key)}">${s.options.map((o) => `<option ${o === s.value ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`
      : `<input type="number" data-setting="${esc(s.key)}" value="${esc(s.value)}" min="${s.min}" max="${s.max}" step="${s.type === "integer" ? 1 : "any"}">`}
    </div>`).join("")}</div>`).join("");
};
$("#settings").addEventListener("change", (event) => {
  const key = event.target.dataset?.setting;
  if (!key) return;
  const value = event.target.tagName === "SELECT" ? event.target.value : Number(event.target.value);
  act(null, () => api("/api/settings", { key, value }), `${key} disimpan`).then(() => loaders.settings());
});

// ---------- mulai ----------
(async () => {
  try {
    const data = await api("/api/groups");
    for (const g of data.groups) subjects.set(g.id, g.subject);
  } catch {}
  loaders.overview();
  loaders.activity();
  connectEvents();
  setInterval(() => { if (currentTab === "overview") loaders.overview(); }, 30_000);
})();
