// Silently fetches each lead's website (no tabs) and extracts email addresses.
const CONCURRENCY = 4;
const TIMEOUT_MS = 10000;
const MAX_EXTRA_PAGES = 3;

const SKIP_HOSTS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com|indiamart\.com|justdial\.com|tradeindia\.com|wa\.me|whatsapp\.com)$|(^|\.)google\./i;
const JUNK_EMAIL = /(\.(png|jpe?g|gif|webp|svg|css|js)$|example\.|domain\.|yourdomain|email\.com$|sentry|wixpress|@2x|u003e)/i;

const queue = [];
const queued = new Set();
let active = 0;
let writeChain = Promise.resolve();

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.action === "enrich") { enqueue(msg.key, msg.website); reply({ ok: true }); }
  else if (msg.action === "enrichAll") { enrichAll().then(() => reply({ ok: true })); return true; }
  else if (msg.action === "clearQueue") { queue.length = 0; queued.clear(); updateStatus(); reply({ ok: true }); }
});

async function enrichAll() {
  const { leads = [], emails = {}, socials = {} } = await chrome.storage.local.get(["leads", "emails", "socials"]);
  for (const l of leads) {
    const s = socials[l.key];
    if (l.website && (!(l.key in emails) || !s || !("websitePhone" in s))) enqueue(l.key, l.website);
  }
}

function enqueue(key, website) {
  if (!key || !website || queued.has(key)) return;
  queued.add(key);
  queue.push({ key, website });
  pump();
}

function pump() {
  updateStatus();
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    findEmails(job.website)
      .catch(() => ({ emails: [] }))
      .then((res) => saveResult(job.key, res))
      .finally(() => { active--; queued.delete(job.key); pump(); });
  }
}

function updateStatus() {
  const pending = queue.length + active;
  chrome.storage.local.set({ emailStatus: pending ? `Finding emails… ${pending} left` : "" });
}

function saveResult(key, res) {
  writeChain = writeChain.then(async () => {
    const { emails = {}, socials = {} } = await chrome.storage.local.get(["emails", "socials"]);
    emails[key] = (res.emails || []).join("; ");   // "" = checked, none found
    socials[key] = { linkedin: res.linkedin || "", facebook: res.facebook || "",
                     twitter: res.twitter || "", websitePhone: res.websitePhone || "" };
    await chrome.storage.local.set({ emails, socials });
  });
  return writeChain;
}

// ---------- fetching ----------
function cleanUrl(url) {
  try {
    let u = new URL(url);
    if (/google\./.test(u.hostname) && u.searchParams.get("q")) u = new URL(u.searchParams.get("q"));
    return u;
  } catch { return null; }
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, credentials: "omit", redirect: "follow" });
    if (!r.ok) return "";
    if (!/html|text/i.test(r.headers.get("content-type") || "")) return "";
    return (await r.text()).slice(0, 2000000);
  } catch { return ""; }
  finally { clearTimeout(t); }
}

async function findEmails(website) {
  const base = cleanUrl(website);
  if (!base) return { emails: [] };

  // Maps "website" is itself their LinkedIn/Facebook page: exact, keep it
  const direct = { linkedin: normLinkedIn(base.href), facebook: normFacebook(base.href), twitter: normTwitter(base.href) };
  if (direct.linkedin || direct.facebook || direct.twitter) return { emails: [], websitePhone: "", ...direct };
  if (SKIP_HOSTS.test(base.hostname)) return { emails: [] };

  const pages = [await fetchText(base.href)];
  const found = new Set(extractEmails(pages[0]));

  // Go to contact pages if the homepage lacks an email or a phone
  if (!found.size || !extractPhones(pages[0]).length) {
    for (const page of contactPages(pages[0], base)) {
      const h = await fetchText(page);
      pages.push(h);
      extractEmails(h).forEach((e) => found.add(e));
      if (found.size && extractPhones(pages.join("\n")).length) break;
    }
  }

  // Emails on the company's own domain first
  const host = base.hostname.replace(/^www\./, "");
  const emails = [...found].sort((a, b) => (b.endsWith(host) - a.endsWith(host)));
  const all = pages.join("\n");
  return { emails, websitePhone: extractPhones(all).join("; "), ...extractSocials(all, host) };
}

// ---------- social links (only from the company's own site; ambiguous = blank) ----------
const FB_RESERVED = /^(sharer|sharer\.php|share|share\.php|dialog|tr|plugins|login|login\.php|l\.php|policies|policy|help|privacy|legal|business|ads|pages|groups|events|watch|hashtag|photo\.php|photos|story\.php|permalink\.php|home\.php|search|marketplace|gaming|people|connect|recover|settings|v\d+(\.\d+)?|\d{4})$/i;
const PLACEHOLDER = /^(wix|wixcom|squarespace|godaddy|wordpress|facebook|linkedin|shopify|hostinger|elementor|themeforest|envato|yourpage|yourcompany|your-company|username|company|page|example|mysite|webflow|weebly|jimdo|zoho|google)$/i;

function normLinkedIn(raw) {
  const m = (raw || "").match(/linkedin\.com\/company\/([^\/"'\s<>?#&]+)/i);
  if (!m || PLACEHOLDER.test(m[1]) || m[1].length < 2) return "";
  return `https://www.linkedin.com/company/${m[1]}`;
}

function normFacebook(raw) {
  if (!/(facebook|fb)\.com\//i.test(raw || "")) return "";
  let u;
  try { u = new URL(raw.replace(/&amp;/g, "&").replace(/^\/\//, "https://")); } catch { return ""; }
  if (!/(^|\.)(facebook|fb)\.com$/i.test(u.hostname)) return "";
  const seg = u.pathname.split("/").filter(Boolean);
  if (!seg.length) return "";
  if (/^profile\.php$/i.test(seg[0])) {
    const id = u.searchParams.get("id");
    return id && /^\d+$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : "";
  }
  if (/^pages$/i.test(seg[0]) && seg.length >= 3 && /^\d+$/.test(seg[2])) return `https://www.facebook.com/${seg.slice(0, 3).join("/")}`;
  if (FB_RESERVED.test(seg[0]) || PLACEHOLDER.test(seg[0]) || !/^[\w.\-]{3,}$/.test(seg[0])) return "";
  return `https://www.facebook.com/${seg[0]}`;
}

function extractSocials(html, host) {
  const li = new Set(), fb = new Set();
  for (const m of (html || "").matchAll(/(?:https?:)?\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/company\/[^"'\s<>?#]+/gi)) {
    const u = normLinkedIn(m[0]); if (u) li.add(u);
  }
  for (const m of (html || "").matchAll(/(?:https?:)?\/\/(?:[\w-]+\.)?(?:facebook|fb)\.com\/[^"'\s<>#]+/gi)) {
    const u = normFacebook(m[0]); if (u) fb.add(u);
  }
  const tw = new Set();
  for (const m of (html || "").matchAll(/(?:https?:)?\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/[^"'\s<>#]+/gi)) {
    if (/\/status\//i.test(m[0])) continue;               // embedded tweet: could be someone else
    const u = normTwitter(m[0]); if (u) tw.add(u.toLowerCase());
  }
  return { linkedin: pick([...li], host), facebook: pick([...fb], host), twitter: pick([...tw], host) };
}

// One link = the company's. Several = keep only a single one matching the domain name, else blank.
function pick(list, host) {
  if (list.length <= 1) return list[0] || "";
  const brand = host.split(".")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  const slug = (u) => (u.split("/").filter(Boolean).pop().split("=").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const hits = list.filter((u) => {
    const k = slug(u);
    return k && brand && (k.includes(brand.slice(0, 6)) || brand.includes(k.slice(0, 6)));
  });
  return hits.length === 1 ? hits[0] : "";
}

function contactPages(html, base) {
  const pages = new Set();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html)) && pages.size < MAX_EXTRA_PAGES) {
    if (!/contact|about|enquir|inquir|reach/i.test(m[1])) continue;
    try {
      const u = new URL(m[1], base);
      if (u.hostname === base.hostname) pages.add(u.href);
    } catch {}
  }
  for (const p of ["/contact-us", "/contact"]) {
    if (pages.size >= MAX_EXTRA_PAGES) break;
    pages.add(new URL(p, base).href);
  }
  return [...pages];
}

// ---------- parsing ----------
function decodeCf(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function extractEmails(html) {
  if (!html) return [];
  const out = new Set();

  // Cloudflare email protection
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"|email-protection#([0-9a-f]+)/gi)) {
    try { out.add(decodeCf(m[1] || m[2])); } catch {}
  }

  const text = html
    .replace(/&#64;|&#x40;|%40/gi, "@")
    .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@")
    .replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");

  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(m[0]);

  return [...out]
    .map((e) => e.toLowerCase().replace(/^mailto:/, "").replace(/\.+$/, ""))
    .filter((e) => !JUNK_EMAIL.test(e) && e.split("@")[0].length < 40);
}

// ---------- X / Twitter ----------
const TW_RESERVED = /^(share|intent|home|i|search|hashtag|login|signup|privacy|tos|explore|settings|messages|notifications|widgets|twitter|x|twitterapi|about|en|compose|oauth|account|download)$/i;
function normTwitter(raw) {
  let u;
  try { u = new URL((raw || "").replace(/&amp;/g, "&").replace(/^\/\//, "https://")); } catch { return ""; }
  if (!/^(www\.|mobile\.)?(twitter|x)\.com$/i.test(u.hostname)) return "";
  const h = u.pathname.split("/").filter(Boolean)[0] || "";
  if (!/^[A-Za-z0-9_]{2,15}$/.test(h) || TW_RESERVED.test(h) || PLACEHOLDER.test(h)) return "";
  return `https://x.com/${h}`;
}

// ---------- phone numbers on the website ----------
const FAKE_PHONE = /^(\d)\1{9}$|^(1234567890|9876543210|0123456789)$/;
const MOBILE_RE = /(?<![\d+])(?:(?:\+|00)91[\s.-]?|0)?[6-9](?:[\s.-]?\d){9}(?!\d)/g;
const IN_PLUS_RE = /(?:\+|00)91[\s.-]?\(?0?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}(?!\d)/g;
const LANDLINE_RE = /\b(?:tel|telephone|phone|ph|landline|office|contact)\b\.?\s*(?:no\.?)?\s*[:\-]?\s*(\(?0\d{2,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4})(?!\d)/gi;

function normPhone(raw, fromTel) {
  let d = (raw || "").replace(/[^\d+]/g, "");
  const plus = d.startsWith("+") || d.startsWith("00");
  d = d.replace(/\+/g, "").replace(/^00/, "");
  if (plus && !d.startsWith("91")) {                       // foreign number, only trust tel: links
    return fromTel && d.length >= 8 && d.length <= 15 ? `+${d}` : "";
  }
  if (d.startsWith("910") && d.length === 13) d = d.slice(3);
  else if (d.startsWith("91") && d.length === 12) d = d.slice(2);
  else if (d.startsWith("0") && d.length === 11) d = d.slice(1);
  if (d.length === 10 && !d.startsWith("0")) return FAKE_PHONE.test(d) ? "" : `+91 ${d}`;
  if (fromTel && /^1800\d{6,7}$/.test(d)) return d;       // toll-free
  return "";
}

function extractPhones(html) {
  if (!html) return [];
  const out = new Map();                                    // last 10 digits -> formatted (dedupe)
  const add = (raw, tel) => { const p = normPhone(raw, tel); if (p) out.set(p.replace(/\D/g, "").slice(-10), p); };

  // Most reliable first: tel: links and schema.org "telephone"
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    let v = m[1]; try { v = decodeURIComponent(v); } catch {}
    add(v, true);
  }
  for (const m of html.matchAll(/"telephone"\s*:\s*"([^"]+)"/gi)) add(m[1], true);

  const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
                   .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ");
  for (const m of text.matchAll(MOBILE_RE)) add(m[0]);
  for (const m of text.matchAll(IN_PLUS_RE)) add(m[0]);
  for (const m of text.matchAll(LANDLINE_RE)) add(m[1]);
  return [...out.values()].slice(0, 8);
}
