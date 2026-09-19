const $ = (id) => document.getElementById(id);
let running = false;

const COLUMNS = [
  ["name", "Name"], ["category", "Category"], ["phone", "Phone"], ["websitePhone", "Website Phone"], ["email", "Email"], ["linkedin", "LinkedIn"], ["facebook", "Facebook"], ["twitter", "X / Twitter"], ["address", "Address"],
  ["website", "Website"], ["rating", "Rating"], ["reviews", "Reviews"], ["plusCode", "Plus Code"],
  ["lat", "Latitude"], ["lng", "Longitude"], ["mapsUrl", "Maps URL"], ["query", "Search Query"],
  ["extractedAt", "Extracted At"]
];

async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
const isMaps = (url) => /^https:\/\/www\.google\.(com|co\.in)\/maps/.test(url || "");

async function render() {
  const { leads = [], status = {}, emails = {}, emailStatus = "" } =
    await chrome.storage.local.get(["leads", "status", "emails", "emailStatus"]);
  const withEmail = leads.filter((l) => emails[l.key]).length;
  $("count").textContent = `Leads: ${leads.length}   Emails: ${withEmail}`;
  $("export").textContent = `Export Leads (${leads.length})`;
  $("export").disabled = !leads.length;
  running = !!status.running;
  $("start").textContent = running ? "Stop Extract" : "Start Auto Extract";
  $("start").classList.toggle("stop", running);
  $("status").textContent = running ? (status.text || "") : (emailStatus || status.text || "");
}

async function send(msg) {
  const tab = await getTab();
  if (!isMaps(tab?.url)) {
    $("status").textContent = "Open Google Maps and run a search first.";
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    // Tab was open before the extension loaded: inject and retry
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return await chrome.tabs.sendMessage(tab.id, msg);
  }
}

function toCSV(rows) {
  const esc = (v) => {
    v = v == null ? "" : String(v);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const header = COLUMNS.map(([, label]) => esc(label)).join(",");
  const body = rows.map((r) => COLUMNS.map(([key]) => esc(r[key])).join(","));
  return "\uFEFF" + [header, ...body].join("\r\n"); // BOM so Excel reads UTF-8 correctly
}

$("start").onclick = async () => {
  await send({ action: running ? "stop" : "start" });
  render();
};

$("export").onclick = async () => {
  const { leads: raw = [], emails = {}, socials = {} } = await chrome.storage.local.get(["leads", "emails", "socials"]);
  if (!raw.length) return;
  const leads = raw.map((l) => ({ ...l, email: emails[l.key] || "", ...(socials[l.key] || {}) }));
  const q = (leads[leads.length - 1].query || "leads").replace(/[^\w]+/g, "_").slice(0, 40);
  const date = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(new Blob([toCSV(leads)], { type: "text/csv;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `maps_${q}_${date}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

$("clear").onclick = async () => {
  if (running) { try { await send({ action: "stop" }); } catch {} }
  chrome.runtime.sendMessage({ action: "clearQueue" }).catch(() => {});
  await chrome.storage.local.set({ leads: [], emails: {}, socials: {}, emailStatus: "", status: { running: false, text: "Cleared." } });
};

async function doSearch() {
  const q = $("q").value.trim();
  if (!q) { $("q").focus(); return; }
  const tab = await getTab();
  if (running) { try { await send({ action: "stop" }); } catch {} }
  await chrome.storage.local.set({ lastQuery: q, status: { running: false, text: "Searching… click Start once results load." } });
  const url = `https://www.google.com/maps/search/${encodeURIComponent(q).replace(/%20/g, "+")}`;
  if (isMaps(tab?.url)) await chrome.tabs.update(tab.id, { url });   // reuse the Maps tab
  else await chrome.tabs.create({ url });                             // don't hijack other pages
}

$("searchBtn").onclick = doSearch;
$("q").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
chrome.storage.local.get("lastQuery").then(({ lastQuery }) => { if (lastQuery) $("q").value = lastQuery; });

chrome.storage.onChanged.addListener(render);

(async () => {
  await render();
  // Fix stale "running" state (e.g. tab was closed mid-run)
  if (running) {
    const tab = await getTab();
    let alive = false;
    try { alive = (await chrome.tabs.sendMessage(tab.id, { action: "ping" }))?.running; } catch {}
    if (!alive) await chrome.storage.local.set({ status: { running: false, text: "" } });
  }
})();
