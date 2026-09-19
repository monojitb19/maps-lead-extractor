(() => {
  if (window.__mapsLeadExtractor) return;
  window.__mapsLeadExtractor = true;

  let running = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (a, b) => sleep(a + Math.random() * (b - a));
  const txt = (el) => (el ? el.textContent.trim() : "");

  const setStatus = (text) => chrome.storage.local.set({ status: { running, text } });

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.action === "ping") reply({ running });
    else if (msg.action === "start") { if (!running) run(); reply({ ok: true }); }
    else if (msg.action === "stop") { running = false; setStatus("Stopping…"); reply({ ok: true }); }
  });

  // ---------- helpers ----------
  function getQuery() {
    const m = location.pathname.match(/\/maps\/search\/([^/@]+)/);
    if (m) return decodeURIComponent(m[1]).replace(/\+/g, " ");
    return document.querySelector("#searchboxinput")?.value || "";
  }

  function placeKey(url, name) {
    const m = (url || "").match(/!1s([^!]+)/);
    return m ? m[1] : (name || url);
  }

  function coords(url) {
    const m = (url || "").match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    return m ? { lat: m[1], lng: m[2] } : {};
  }

  const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

  function endReached(feed) {
    if (feed.querySelector("span.HlvSq")) return true;
    return /end of the list/i.test(feed.lastElementChild?.innerText || "");
  }

  // ---------- step 1: scroll the full results list ----------
  async function scrollAll(feed) {
    let last = 0, stale = 0;
    while (running) {
      feed.scrollTop = feed.scrollHeight;
      await jitter(1200, 2000);
      const count = feed.querySelectorAll("a.hfpxzc").length;
      await setStatus(`Scrolling… ${count} found`);
      if (endReached(feed)) break;
      if (count === last) {
        if (++stale >= 5) break;
        feed.scrollTop -= 400;           // nudge to trigger lazy load
        await sleep(400);
      } else { stale = 0; last = count; }
    }
  }

  // ---------- step 2: data from list card (fallback) ----------
  function cardData(a) {
    const card = a.closest("div.Nv2PK") || a.parentElement;
    return {
      name: a.getAttribute("aria-label") || txt(card?.querySelector(".qBF1Pd")),
      rating: txt(card?.querySelector("span.MW4etd")),
      reviews: txt(card?.querySelector("span.UY7F9")).replace(/\D/g, ""),
      website: card?.querySelector('a[data-value="Website"]')?.href || ""
    };
  }

  // ---------- step 3: data from detail panel ----------
  function itemText(root, sel, prefix) {
    const el = root.querySelector(sel);
    if (!el) return "";
    const inner = txt(el.querySelector(".Io6YTe"));
    if (inner) return inner;
    return (el.getAttribute("aria-label") || "").replace(prefix, "").trim();
  }

  function readDetail() {
    const h1 = document.querySelector("h1.DUwDvf");
    const root = h1?.closest('div[role="main"]') || document;
    const ratingWrap = root.querySelector("div.F7nice");
    const phoneBtn = root.querySelector('button[data-item-id^="phone:tel:"]');
    return {
      name: txt(h1),
      category: txt(root.querySelector("button.DkEaL")),
      rating: txt(ratingWrap?.querySelector('span[aria-hidden="true"]')),
      reviews: (ratingWrap?.querySelector('span[aria-label*="review"]')?.getAttribute("aria-label") || "").replace(/\D/g, ""),
      phone: itemText(root, 'button[data-item-id^="phone:tel:"]', /^Phone:\s*/i) ||
             (phoneBtn?.getAttribute("data-item-id") || "").replace("phone:tel:", ""),
      address: itemText(root, 'button[data-item-id="address"]', /^Address:\s*/i),
      website: root.querySelector('a[data-item-id="authority"]')?.href || "",
      plusCode: itemText(root, 'button[data-item-id="oloc"]', /^Plus code:\s*/i)
    };
  }

  async function waitForDetail(name, prev) {
    if (name && name === prev) await sleep(1800); // same-name chain: give panel time to swap
    const t0 = Date.now();
    const n = (name || "").toLowerCase();
    while (Date.now() - t0 < 6000) {
      const h = txt(document.querySelector("h1.DUwDvf")).toLowerCase();
      if (h && (h === n || (h !== prev.toLowerCase() && n && h.startsWith(n.slice(0, 10))))) {
        await sleep(700); // let phone/address buttons render
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  // ---------- main ----------
  async function run() {
    running = true;
    const feed = document.querySelector('div[role="feed"]');
    if (!feed) {
      running = false;
      await setStatus("No results list found. Search a business type on Maps first.");
      return;
    }
    const query = getQuery();
    await setStatus("Scrolling results…");
    await scrollAll(feed);

    const links = [...feed.querySelectorAll("a.hfpxzc")];
    let added = 0;

    for (let i = 0; i < links.length && running; i++) {
      const a = links[i];
      const url = a.href;
      const key = placeKey(url, a.getAttribute("aria-label"));

      const { leads = [] } = await chrome.storage.local.get("leads");
      if (leads.some((l) => l.key === key)) continue;

      await setStatus(`Extracting ${i + 1}/${links.length}…`);
      const card = cardData(a);
      const prev = txt(document.querySelector("h1.DUwDvf"));
      a.scrollIntoView({ block: "center" });
      a.click();
      const ok = await waitForDetail(card.name, prev);
      const detail = ok ? readDetail() : {};

      const fresh = (await chrome.storage.local.get("leads")).leads || [];
      fresh.push({ ...card, ...nonEmpty(detail), key, mapsUrl: url, query, ...coords(url),
                   extractedAt: new Date().toISOString() });
      await chrome.storage.local.set({ leads: fresh });
      const lead = fresh[fresh.length - 1];
      if (lead.website) chrome.runtime.sendMessage({ action: "enrich", key, website: lead.website }).catch(() => {});
      added++;
      await jitter(700, 1400);
    }

    chrome.runtime.sendMessage({ action: "enrichAll" }).catch(() => {});
    const finished = running;
    running = false;
    await setStatus(`${finished ? "Done" : "Stopped"}. ${added} new leads added.`);
  }
})();
