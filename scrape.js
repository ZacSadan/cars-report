/*
 * Yad2 car search -> self-contained HTML report, driven live by a real,
 * visible Chrome browser under your own profile/network. Self-contained -
 * no dependency on parse_local.py.
 *
 * Uses puppeteer-extra with puppeteer-extra-plugin-stealth, launching the
 * actual installed Google Chrome (channel: "chrome", not the bundled
 * Chromium) in headed mode, with a persistent userDataDir (options.
 * browser_profile_dir) so it behaves like a returning real browser session
 * rather than a fresh automation profile. The stealth plugin patches the
 * usual headless/automation fingerprints (navigator.webdriver, plugins,
 * chrome runtime, etc.) as defense-in-depth on top of that.
 *
 * Heads-up from earlier investigation (see PLAN.md): yad2.co.il previously
 * challenged automated browsers here with a Radware/ShieldSquare bot check,
 * even in this exact headed real-Chrome setup. Blocking like that is
 * IP/fingerprint dependent and can change, so this is worth retrying - but
 * if a bot-challenge page shows up (redirected to something like
 * validate.perfdrive.com, or a "Pardon our interruption" / CAPTCHA page),
 * this script stops immediately rather than silently scraping the challenge
 * page as if it were real data.
 *
 * Usage:  npm install && npm run scrape
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteerExtra.use(StealthPlugin());

const BASE_URL = "https://www.yad2.co.il/vehicles/cars";
const ITEM_HREF_RE = /\/item\/([\w-]+)/;
const BLOCK_MARKERS = [
  "perfdrive.com",
  "shieldsquare",
  "pardon our interruption",
  "validate.perfdrive",
  "radware",
];

// Candidate JSON key names per field - first match wins. Next.js props tend
// to keep the underlying API's field names, but we don't know them for
// certain, so each field lists several plausible spellings.
const CANDIDATE_KEYS = {
  year: ["year", "productionYear", "carYear", "yearOfProduction"],
  km: ["km", "kilometers", "mileage", "hand_km", "odometer"],
  hand: ["hand", "handText", "owners", "numOwners", "ownerNumber"],
  ownership_type: ["ownership", "ownershipType", "carOwnershipType", "prevOwnershipType"],
  // "address"/"area" deliberately excluded - they're containers one level
  // above the actual city (address.city.text), and matching them first would
  // short-circuit the search before it reaches the real city value.
  city: ["city", "cityText", "cityName"],
  description: ["description", "text", "remarks", "adText", "metaDataDescription"],
  engine_size: ["engineVolume", "engineval", "cc", "engineCapacity", "engineSize"],
  fuel_type: ["engineType", "fuelType", "engineTypeText", "fuelTypeText"],
  customer_type: ["customerType", "customer_type"],
  merchant_name: ["merchantName", "dealerName", "businessName", "agencyName"],
  price: ["price", "currentPrice"],
  manufacturer: ["manufacturer"],
  model: ["model"],
  sub_model: ["subModel"],
};

const DOM_LABELS = {
  year: ["שנה", "שנת ייצור"],
  km: ["ק\"מ", "קילומטראז'"],
  hand: ["יד"],
  ownership_type: ["בעלות", "סוג בעלות"],
  city: ["עיר", "אזור"],
  engine_size: ["נפח מנוע"],
  fuel_type: ["סוג מנוע", "תיבת הילוכים"],
};

function loadConfig(configPath = "config.yaml") {
  return yaml.load(fs.readFileSync(configPath, "utf-8"));
}

function normalizeForMatch(text) {
  return (text || "").normalize("NFKC");
}

function highlightKeywords(text, keywords) {
  if (!text) return "";
  let escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const kw of keywords) {
    if (!kw) continue;
    const escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(escapedKw, "gi");
    escaped = escaped.replace(pattern, (m) => `<b style="color:red">${m}</b>`);
  }
  return escaped;
}

async function downloadImageB64(imageUrl) {
  // Embed the image so the report stays portable. If the download fails
  // (CDN hiccup, offline), fall back to the remote URL so it still renders
  // for an online viewer.
  if (!imageUrl) return null;
  try {
    const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (resp.ok) {
      const contentType = (resp.headers.get("content-type") || "image/jpeg").split(";")[0];
      const buf = Buffer.from(await resp.arrayBuffer());
      return `data:${contentType};base64,${buf.toString("base64")}`;
    }
  } catch {
    // fall through to remote URL
  }
  return imageUrl;
}

const CARD_TEMPLATE = ({
  imageHtml,
  title,
  subtitle,
  price,
  year,
  handChip,
  ownershipType,
  kmChip,
  city,
  engineSize,
  fuelType,
  description,
  url,
}) => `
<div class="card">
  ${imageHtml}
  <div class="card-body">
    <div class="card-head">
      <div>
        <div class="title">${title}</div>
        ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ""}
      </div>
      <span class="price">${price}</span>
    </div>
    <div class="card-meta">
      <span class="chip">${year}</span>
      ${handChip}
      <span class="chip">${ownershipType}</span>
      ${kmChip}
      <span class="chip">${city}</span>
      <span class="chip">${engineSize}</span>
      <span class="chip">${fuelType}</span>
    </div>
    <p class="desc">${description}</p>
    <a class="link" href="${url}" target="_blank" rel="noopener">לצפייה במודעה המקורית</a>
  </div>
</div>
`;

const HTML_SHELL = ({ summary, cards, extraSection }) => `<!doctype html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>yad2 - דוח רכבים</title>
<style>
  body { font-family: Arial, "Segoe UI", sans-serif; background: #f2f2f5; margin: 0; padding: 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  .summary { color: #555; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .card { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.15); display: flex; flex-direction: column; }
  .card img { width: 100%; height: 200px; object-fit: cover; display: block; background: #ddd; }
  .no-image { width: 100%; height: 200px; display: flex; align-items: center; justify-content: center; color: #999; background: #eee; }
  .card-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; flex: 1; }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .title { font-weight: 600; font-size: 0.95rem; }
  .subtitle { font-size: 0.8rem; color: #666; margin-top: 2px; }
  .price { font-weight: 700; font-size: 1.05rem; white-space: nowrap; }
  .card-meta { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { background: #eef1f7; border-radius: 999px; padding: 3px 10px; font-size: 0.8rem; }
  .chip-km-high { color: #1a5cff; }
  .chip-km-low { color: green; font-weight: 700; }
  .chip-hand-first { color: green; font-weight: 700; }
  .desc { font-size: 0.9rem; line-height: 1.4; white-space: pre-wrap; margin: 0; flex: 1; }
  .link { align-self: flex-start; font-size: 0.85rem; color: #1a5cff; text-decoration: none; }
  .link:hover { text-decoration: underline; }
  .extra-section { margin-top: 24px; }
  .extra-section h2 { font-size: 1.05rem; margin: 0 0 8px; }
  @media (max-width: 480px) {
    .grid { grid-template-columns: 1fr; }
    .card img, .no-image { height: 180px; }
  }
</style>
</head>
<body>
<h1>yad2 - דוח רכבים</h1>
<p class="summary">${summary}</p>
<div class="grid">
${cards}
</div>
${extraSection}
</body>
</html>
`;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function withThousands(numLike) {
  if (numLike === null || numLike === undefined || numLike === "") return numLike;
  const digitsOnly = String(numLike).replace(/[^\d]/g, "");
  if (!digitsOnly) return numLike;
  return digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatHandChip(hand) {
  if (!hand) return '<span class="chip">יד -</span>';
  const text = String(hand).trim();
  // The extracted value sometimes already reads "יד ראשונה" (from the DOM
  // fallback) and sometimes is a bare number/word (from JSON) - only prepend
  // the "יד" label when it isn't already part of the text.
  const label = text.includes("יד") ? text : `יד ${text}`;
  const isFirstHand = /ראשונה/.test(text) || /\b1\b/.test(text);
  const cls = isFirstHand ? "chip chip-hand-first" : "chip";
  return `<span class="${cls}">${label}</span>`;
}

function formatKmChip(km, year) {
  const label = km ? `${withThousands(km)} ק"מ` : `- ק"מ`;
  const kmNum = km ? parseInt(String(km).replace(/[^\d]/g, ""), 10) : NaN;
  const yearNum = year ? parseInt(String(year).replace(/[^\d]/g, ""), 10) : NaN;
  let cls = "chip";
  if (!Number.isNaN(kmNum) && !Number.isNaN(yearNum)) {
    const ageYears = new Date().getFullYear() - yearNum;
    if (ageYears > 0) {
      const kmPerYear = kmNum / ageYears;
      if (kmPerYear > 10000) cls = "chip chip-km-high";
      else if (kmPerYear < 7000) cls = "chip chip-km-low";
    }
  }
  return `<span class="${cls}">${label}</span>`;
}

function renderReport(listings, extraItems, outputPath) {
  const cardsHtml = listings.map((item) => {
    const imageHtml = item.image_b64
      ? `<img src="${item.image_b64}" alt="תמונת רכב">`
      : '<div class="no-image">אין תמונה</div>';
    const price = item.price;
    const engine = item.engine_size;
    return CARD_TEMPLATE({
      imageHtml,
      title: item.title || "",
      subtitle: item.subtitle || "",
      price: price ? `${withThousands(price)} ₪` : "",
      year: item.year || "-",
      handChip: formatHandChip(item.hand),
      ownershipType: item.ownership_type || "-",
      kmChip: formatKmChip(item.km, item.year),
      city: item.city || "-",
      engineSize: engine ? `${withThousands(engine)} סמ"ק` : "-",
      fuelType: item.fuel_type || "-",
      description: item.description_html,
      url: item.url,
    });
  });
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate()
  ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
  let summary = `${listings.length} מודעות פרטיות · נוצר ב-${stamp}`;
  let extraSection = "";
  if (extraItems && extraItems.length > 0) {
    summary += ` · ${extraItems.length} מודעות נוספות (פרטים מעמוד התוצאות בלבד, לא נבדקו לעומק)`;
    const extraCards = extraItems.map((item) => {
      const imageHtml = item.image_b64
        ? `<img src="${item.image_b64}" alt="תמונת רכב">`
        : '<div class="no-image">אין תמונה</div>';
      const textHtml = escapeHtml(item.text || "").replace(/\n/g, "<br>");
      return `
<div class="card">
  ${imageHtml}
  <div class="card-body">
    <p class="desc">${textHtml}</p>
    <a class="link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">לצפייה במודעה המקורית</a>
  </div>
</div>`;
    });
    extraSection = `<div class="extra-section">
<h2>מודעות נוספות (מעבר למכסת הבדיקה המפורטת) - פרטים מעמוד התוצאות בלבד</h2>
<div class="grid">
${extraCards.join("\n")}
</div>
</div>`;
  }
  const html = HTML_SHELL({ summary, cards: cardsHtml.join("\n"), extraSection });
  fs.writeFileSync(outputPath, html, "utf-8");
}

function chunked(seq, size) {
  const out = [];
  for (let i = 0; i < seq.length; i += size) out.push(seq.slice(i, i + size));
  return out;
}

function buildSearchUrl(search, manufacturerChunk, pageNum) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (k === "manufacturer") continue;
    params.set(k, String(v));
  }
  params.set("page", String(pageNum));
  // Keep manufacturer IDs joined with a literal "," (URLSearchParams would
  // percent-encode it to %2C) to match the known-good URL format exactly.
  return `${BASE_URL}?${params.toString()}&manufacturer=${manufacturerChunk.join(",")}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay([min, max]) {
  return delay((min + Math.random() * (max - min)) * 1000);
}

async function looksBlocked(page) {
  const title = ((await page.title()) || "").toLowerCase();
  const content = (await page.content()).slice(0, 4000);
  const haystack = (page.url() + " " + title + " " + content).toLowerCase();
  return BLOCK_MARKERS.some((marker) => haystack.includes(marker));
}

async function bailIfBlocked(page, browser, targetUrl) {
  if (await looksBlocked(page)) {
    console.log(`\n!! Bot-challenge page detected at ${page.url()}`);
    console.log("   Leaving the window open for 60s in case you want to clear it by hand...");
    await delay(60000);

    if (!(await looksBlocked(page))) {
      console.log("   Challenge cleared - reloading the target page...");
      if (targetUrl) {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      }
      if (!(await looksBlocked(page))) {
        console.log("   Continuing.");
        return;
      }
    }

    console.log("   Still blocked. Stopping rather than scraping garbage - see scrape.js docstring.");
    if (browser) await browser.close();
    process.exit(1);
  }
}

async function collectListingUrls(page, browser, search, manufacturerChunk, maxPages, delayRange, excludeDealers) {
  const seen = new Map();
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const url = buildSearchUrl(search, manufacturerChunk, pageNum);
    console.log(`  [chunk ${manufacturerChunk}] page ${pageNum}: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await bailIfBlocked(page, browser, url);

    // Scroll to trigger lazy-loaded cards.
    let prevHeight = 0;
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 4000));
      await delay(400);
      const height = await page.evaluate(() => document.body.scrollHeight);
      if (height === prevHeight) break;
      prevHeight = height;
    }

    const cards = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href*='item/']"));
      // Find the smallest ancestor that still contains exactly this one
      // item-link - climbing further would start pulling in a sibling
      // card's markup (and its dealer badge/promo text) too.
      const findCardContainer = (a) => {
        let container = a;
        let node = a.parentElement;
        let depth = 0;
        while (node && depth < 12) {
          if (node.querySelectorAll("a[href*='item/']").length > 1) break;
          container = node;
          node = node.parentElement;
          depth++;
        }
        return container;
      };
      return anchors.map((a) => {
        const container = findCardContainer(a);
        const img = container ? container.querySelector("img") : null;
        const text = container ? container.innerText.trim() : "";
        const isDealer =
          !!(
            container &&
            (container.querySelector("[class*='agencyName']") ||
              container.querySelector("[data-testid='trade-in-flag']"))
          ) ||
          text.includes("הכירו את הסוכנות") ||
          text.includes("בטרייד");
        return {
          href: a.href,
          text,
          imageUrl: img ? img.currentSrc || img.src || null : null,
          isDealer,
        };
      });
    });
    let newCount = 0;
    let recommendationSkipped = 0;
    let dealerSkipped = 0;
    for (const card of cards) {
      const m = ITEM_HREF_RE.exec(card.href);
      if (!m) continue;
      // Yad2 injects a "recommended for you" carousel into the results page
      // that ignores the search filters entirely - only keep cards that came
      // from the actual filtered feed.
      let componentType;
      try {
        componentType = new URL(card.href).searchParams.get("component-type");
      } catch {
        componentType = null;
      }
      if (componentType === "recommendation") {
        recommendationSkipped++;
        continue;
      }
      if (excludeDealers && card.isDealer) {
        dealerSkipped++;
        continue;
      }
      const token = m[1];
      if (!seen.has(token)) {
        seen.set(token, { url: card.href, text: card.text, imageUrl: card.imageUrl });
        newCount++;
      }
    }
    if (recommendationSkipped > 0) {
      console.log(`    skipped ${recommendationSkipped} unfiltered "recommended for you" cards`);
    }
    if (dealerSkipped > 0) {
      console.log(`    skipped ${dealerSkipped} dealer/agency cards (never visited their pages)`);
    }

    if (newCount === 0) {
      console.log(`    no new listings on page ${pageNum}, stopping this chunk`);
      break;
    }

    await randomDelay(delayRange);
  }
  return seen;
}

// Runs entirely inside the page - mirrors extract_in_browser.js's approach of
// reading __NEXT_DATA__ / the live DOM directly rather than re-parsing HTML
// text back in Node.
async function extractAd(page, fallbackUrl) {
  return page.evaluate(
    (CANDIDATE_KEYS, DOM_LABELS, fallbackUrl) => {
      function findInJson(obj, keys) {
        const dq = [obj];
        while (dq.length) {
          const cur = dq.shift();
          if (cur && typeof cur === "object" && !Array.isArray(cur)) {
            for (const k of Object.keys(cur)) {
              const v = cur[k];
              const empty =
                v === null ||
                v === undefined ||
                v === "" ||
                (Array.isArray(v) && v.length === 0) ||
                (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
              if (keys.includes(k) && !empty) return v;
            }
            for (const v of Object.values(cur)) {
              if (v && typeof v === "object") dq.push(v);
            }
          } else if (Array.isArray(cur)) {
            for (const item of cur) {
              if (item && typeof item === "object") dq.push(item);
            }
          }
        }
        return null;
      }

      function domLabelValue(label) {
        // Real field values (city/fuel type/ownership etc.) are short. Promo
        // widgets (insurance quotes, "similar cars" banners, ...) that
        // happen to sit next to a matching label in the DOM are not - reject
        // those instead of accepting the first sibling text found.
        const isPlausible = (text) =>
          text && text.length <= 40 && !text.includes("?") && !text.includes("₪");

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent && node.textContent.includes(label)) {
            const parent = node.parentElement;
            if (!parent) continue;
            const candidates = [];
            if (parent.nextElementSibling) candidates.push(parent.nextElementSibling);
            const grandparent = parent.parentElement;
            if (grandparent && grandparent.nextElementSibling) {
              candidates.push(grandparent.nextElementSibling);
            }
            for (const c of candidates) {
              const text = (c.textContent || "").trim();
              if (isPlausible(text)) return text;
            }
          }
        }
        return null;
      }

      function toScalar(value) {
        if (value === null || value === undefined) return null;
        if (typeof value !== "object") return value;
        if (Array.isArray(value)) {
          for (const item of value) {
            const s = toScalar(item);
            if (s !== null && s !== undefined && s !== "") return s;
          }
          return null;
        }
        // Some categorical fields (ownership/city/fuel type) come back as
        // {id, text} objects rather than a plain string - pull the label out
        // instead of letting it stringify to "[object Object]".
        for (const key of ["text", "label", "name", "value", "he", "title"]) {
          if (typeof value[key] === "string" && value[key]) return value[key];
        }
        return null;
      }

      function extractField(nextData, field) {
        let value = toScalar(nextData ? findInJson(nextData, CANDIDATE_KEYS[field]) : null);
        if (value !== null && value !== undefined && value !== "") return value;
        for (const label of DOM_LABELS[field] || []) {
          value = domLabelValue(label);
          if (value) return value;
        }
        return null;
      }

      function extractDescription(nextData) {
        const description = toScalar(nextData ? findInJson(nextData, CANDIDATE_KEYS.description) : null);
        if (description) return description;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent && node.textContent.includes("תיאור")) {
            const parent = node.parentElement;
            if (!parent) continue;
            const nxt = parent.nextElementSibling;
            if (nxt) {
              const text = (nxt.textContent || "").trim();
              if (text) return text;
            }
          }
        }
        return "";
      }

      function isDealerListing(nextData) {
        if (document.querySelector("[class*='agencyName']")) return true;
        if (document.querySelector("[data-testid='trade-in-flag']")) return true;
        const customerType = nextData ? findInJson(nextData, CANDIDATE_KEYS.customer_type) : null;
        if (customerType !== null && customerType !== undefined) {
          const n = Number(customerType);
          if (!Number.isNaN(n)) return n !== 1;
        }
        const merchantName = nextData ? findInJson(nextData, CANDIDATE_KEYS.merchant_name) : null;
        if (merchantName) return true;
        if (document.querySelector("a[href*='/agency/'], a[href*='/dealer/']")) return true;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.textContent && node.textContent.includes("בטרייד")) return true;
        }
        return false;
      }

      function extractUrl() {
        const canonical = document.querySelector("link[rel='canonical']");
        if (canonical && canonical.getAttribute("href")) return canonical.getAttribute("href");
        const og = document.querySelector("meta[property='og:url']");
        if (og && og.getAttribute("content")) return og.getAttribute("content");
        return fallbackUrl;
      }

      function findFirstImageUrl(nextData) {
        const IMAGE_URL_RE = /https?:\/\/[^\s"\\]+?\.(?:jpg|jpeg|png|webp)/i;
        const texts = [];
        if (nextData) {
          try {
            texts.push(JSON.stringify(nextData));
          } catch {
            // ignore
          }
        }
        texts.push(document.documentElement.outerHTML);
        for (const text of texts) {
          const m = IMAGE_URL_RE.exec(text);
          if (m) return m[0];
        }
        return null;
      }

      let nextData = null;
      const tag = document.getElementById("__NEXT_DATA__");
      if (tag && tag.textContent) {
        try {
          nextData = JSON.parse(tag.textContent);
        } catch {
          nextData = null;
        }
      }

      const data = { url: extractUrl() };
      for (const field of ["year", "km", "hand", "ownership_type", "city", "engine_size", "fuel_type"]) {
        data[field] = extractField(nextData, field);
      }
      data.price = nextData ? findInJson(nextData, CANDIDATE_KEYS.price) : null;
      const manufacturer = toScalar(nextData ? findInJson(nextData, CANDIDATE_KEYS.manufacturer) : null);
      const model = toScalar(nextData ? findInJson(nextData, CANDIDATE_KEYS.model) : null);
      const subModel = toScalar(nextData ? findInJson(nextData, CANDIDATE_KEYS.sub_model) : null);
      const h1 = document.querySelector("h1");
      data.title = [manufacturer, model].filter(Boolean).join(" ") || (h1 ? h1.textContent.trim() : "");
      data.subtitle = subModel || "";
      data.description = extractDescription(nextData);
      data.image_url = findFirstImageUrl(nextData);
      data.is_dealer = isDealerListing(nextData);
      return data;
    },
    CANDIDATE_KEYS,
    DOM_LABELS,
    fallbackUrl
  );
}

async function main() {
  const config = loadConfig();
  const search = config.search;
  const options = config.options;

  const manufacturerIds = search.manufacturer;
  const chunkSize = options.max_manufacturers_per_request || 4;
  const delayRange = options.request_delay_seconds || [2, 5];
  const innerDelayRange = options.inner_page_delay_seconds || [6, 14];
  const maxPages = options.max_pages_per_search || 20;
  const excludeDealers = options.exclude_dealers;
  const keywords = options.suspicious_keywords || [];
  const profileDir = options.browser_profile_dir || ".pw-test";
  const maxAdDetails = options.max_ad_details || 20;

  const browser = await puppeteerExtra.launch({
    channel: "chrome",
    headless: false,
    userDataDir: path.resolve(profileDir),
    defaultViewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());

  const allUrls = new Map();
  const chunks = chunked(manufacturerIds, chunkSize);
  for (let c = 0; c < chunks.length; c++) {
    const chunkCards = await collectListingUrls(page, browser, search, chunks[c], maxPages, delayRange, excludeDealers);
    for (const [token, cardInfo] of chunkCards) allUrls.set(token, cardInfo);
    if (c < chunks.length - 1) await randomDelay(delayRange);
  }

  console.log(`\n${allUrls.size} unique listings found across all searches.\n`);

  const allEntries = Array.from(allUrls.entries());
  const urlEntries = allEntries.slice(0, maxAdDetails);
  const extraEntries = allEntries.slice(maxAdDetails);
  if (extraEntries.length > 0) {
    console.log(
      `Fetching full details for the first ${urlEntries.length} of ${allUrls.size} (max_ad_details cap); ` +
        `the remaining ${extraEntries.length} will be listed with search-page details only.\n`
    );
  }

  const byUrl = new Map();
  let dealerCount = 0;
  let failCount = 0;
  let i = 0;
  for (const [, cardInfo] of urlEntries) {
    const url = cardInfo.url;
    i++;
    console.log(`[${i}/${urlEntries.length}] ${url}`);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await bailIfBlocked(page, browser, url);
      const ad = await extractAd(page, url);
      if (excludeDealers && ad.is_dealer) {
        dealerCount++;
        console.log("    skipped (dealer/agency listing)");
      } else {
        byUrl.set(ad.url, ad);
      }
    } catch (e) {
      failCount++;
      console.log(`    FAILED: ${e.message || e}`);
      if (page.isClosed() || /detached Frame|Target closed|Session closed/.test(e.message || "")) {
        console.log("    Browser/tab appears to have been closed - stopping here instead of retrying the rest.");
        break;
      }
    }
    await randomDelay(innerDelayRange);
  }

  if (browser.connected) await browser.close();

  const listings = Array.from(byUrl.values());
  for (const ad of listings) {
    ad.image_b64 = await downloadImageB64(ad.image_url);
    ad.description_html = highlightKeywords(normalizeForMatch(ad.description || ""), keywords);
  }

  const extraItems = [];
  for (const [, cardInfo] of extraEntries) {
    extraItems.push({
      url: cardInfo.url,
      text: cardInfo.text,
      image_b64: await downloadImageB64(cardInfo.imageUrl),
    });
  }

  renderReport(listings, extraItems, options.output_file);
  console.log(
    `\nDone. ${listings.length} private listings written to ${options.output_file} ` +
      `(${dealerCount} dealer listings excluded, ${failCount} failed parses, ` +
      `${extraItems.length} additional listings included with search-page details only).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
