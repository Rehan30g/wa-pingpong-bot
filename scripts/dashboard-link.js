// Cetak link dashboard owner (berisi token). Di VPS jalankan ini, lalu buka link
// lewat SSH tunnel: ssh -N -L 7777:127.0.0.1:7777 -p <port-ssh> ubuntu@<vps>
require("dotenv").config({ quiet: true });
const { dashboardConfig, loadOrCreateToken } = require("../ai/dashboard/server");

const cfg = dashboardConfig();
const token = loadOrCreateToken(cfg.tokenFile);
const host = ["0.0.0.0", "::"].includes(cfg.host) ? "127.0.0.1" : cfg.host;
console.log(`http://${host}:${cfg.port}/?t=${token}`);
if (["127.0.0.1", "localhost"].includes(host)) {
  console.log(`Dari komputer lain (mis. VPS): ssh -N -L ${cfg.port}:127.0.0.1:${cfg.port} <user>@<server>, lalu buka link di atas.`);
}
