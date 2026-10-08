/*
 * Cars-report car search -> self-contained HTML report, driven live by a real,
 * visible Chrome browser under your own profile/network. Self-contained -
 * no dependency on parse_local.py.
 *
 * Usage:  npm install && npm run scrape
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteerExtra.use(StealthPlugin());

const BASE_URL = "https://www."+"y"+"a"+"d2.co.il"+"/veh"+"icles/cars";
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
  ownership_type: ["owner", "ownership", "ownershipType", "carOwnershipType", "prevOwnershipType"],
  original_owner: ["originalOwner"],
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
  cardClass,
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
  ownershipHistoryHtml,
  description,
  url,
}) => `
<div class="${cardClass}">
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
      <span class="chip${ownershipColorClass(ownershipType)}">${ownershipType}</span>
      ${kmChip}
      <span class="chip">${city}</span>
      <span class="chip">${engineSize}</span>
      <span class="chip">${fuelType}</span>
    </div>
    ${ownershipHistoryHtml}
    <p class="desc">${description}</p>
    <a class="link" href="${url}" target="_blank" rel="noopener">לצפייה במודעה המקורית</a>
  </div>
</div>
`;

const HTML_SHELL = ({ summary, searchParamsHtml, cards, extraSection }) => `<!doctype html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cars-report - דוח רכבים</title>
<style>
  body { font-family: Arial, "Segoe UI", sans-serif; background: #f2f2f5; margin: 0; padding: 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  .summary { color: #555; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
  .card { background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.15); display: flex; flex-direction: column; }
  .card-first-hand { background: #e6f4ea; }
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
  .chip-ownership-lease { color: red; }
  .chip-ownership-company { color: red; }
  .ownership-history { font-size: 0.8rem; margin-top: -2px; }
  .ownership-history-label { color: #666; margin-inline-end: 4px; }
  .desc { font-size: 0.9rem; line-height: 1.4; white-space: pre-wrap; margin: 0; flex: 1; }
  .link { align-self: flex-start; font-size: 0.85rem; color: #1a5cff; text-decoration: none; }
  .link:hover { text-decoration: underline; }
  .extra-section { margin-top: 24px; }
  .extra-section h2 { font-size: 1.05rem; margin: 0 0 8px; }
  .search-params { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
  .search-params .param { background: #fff; border-radius: 999px; padding: 4px 12px; font-size: 0.8rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .search-params .param b { font-weight: 600; }
  @media (max-width: 480px) {
    .grid { grid-template-columns: 1fr; }
    .card img, .no-image { height: 180px; }
  }
</style>
</head>
<body>
<h1>cars-report - דוח רכבים</h1>
${searchParamsHtml}
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

function isFirstHand(hand) {
  if (!hand) return false;
  const text = String(hand).trim();
  return /ראשונה/.test(text) || /\b1\b/.test(text);
}

function formatHandChip(hand) {
  if (!hand) return '<span class="chip">יד -</span>';
  const text = String(hand).trim();
  // The extracted value sometimes already reads "יד ראשונה" (from the DOM
  // fallback) and sometimes is a bare number/word (from JSON) - only prepend
  // the "יד" label when it isn't already part of the text.
  const label = text.includes("יד") ? text : `יד ${text}`;
  const cls = isFirstHand(hand) ? "chip chip-hand-first" : "chip";
  return `<span class="${cls}">${label}</span>`;
}

function ownershipColorClass(text) {
  if (!text) return "";
  if (text.includes("ליסינג")) return " chip-ownership-lease";
  if (text.includes("השכרה") || text.includes("חברה")) return " chip-ownership-company";
  return "";
}

function formatOwnershipHistory(currentOwner, originalOwner) {
  // Always show both lines when both are known, even if identical - cars-report's
  // own "ownership history" drawer does the same (confirmed by clicking it
  // live). Only omit a line when that specific value is genuinely missing
  // (e.g. no "original" owner recorded for a 1st-hand car).
  const entries = [];
  if (currentOwner) entries.push({ label: "בעלות נוכחית", text: currentOwner });
  if (originalOwner) entries.push({ label: "בעלות מקורית", text: originalOwner });
  if (entries.length === 0) return "";
  const chips = entries
    .map(
      (e) =>
        `<span class="chip${ownershipColorClass(e.text)}">${escapeHtml(e.label)}: ${escapeHtml(e.text)}</span>`
    )
    .join(" ");
  return `<div class="ownership-history"><span class="ownership-history-label">היסטוריית בעלויות:</span> ${chips}</div>`;
}

function computeKmPerYear(km, year) {
  const kmNum = km ? parseInt(String(km).replace(/[^\d]/g, ""), 10) : NaN;
  const yearNum = year ? parseInt(String(year).replace(/[^\d]/g, ""), 10) : NaN;
  if (Number.isNaN(kmNum) || Number.isNaN(yearNum)) return null;
  const ageYears = new Date().getFullYear() - yearNum;
  return ageYears > 0 ? kmNum / ageYears : null;
}

// Separate, lower threshold than the km chip's own color-coding - used for
// the card's background highlight, not the chip text color.
function isLowKmPerYear(km, year, threshold) {
  const kmPerYear = computeKmPerYear(km, year);
  return kmPerYear !== null && kmPerYear < threshold;
}

function formatKmChip(km, year) {
  const label = km ? `${withThousands(km)} ק"מ` : `- ק"מ`;
  const kmPerYear = computeKmPerYear(km, year);
  let cls = "chip";
  if (kmPerYear !== null) {
    if (kmPerYear > 10000) cls = "chip chip-km-high";
    else if (kmPerYear < 7000) cls = "chip chip-km-low";
  }
  return `<span class="${cls}">${label}</span>`;
}

function handSortKey(hand) {
  if (!hand) return Number.MAX_SAFE_INTEGER;
  const text = String(hand);
  const numMatch = text.match(/\d+/);
  if (numMatch) return parseInt(numMatch[0], 10);
  const ordinals = { ראשונה: 1, שניה: 2, שלישית: 3, רביעית: 4, חמישית: 5 };
  for (const [word, num] of Object.entries(ordinals)) {
    if (text.includes(word)) return num;
  }
  return Number.MAX_SAFE_INTEGER;
}

function parseCardText(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  let i = 0;
  // Skip leading price-change badge lines (e.g. "ירד ב 4,000 ₪") that sit
  // above the title on the results feed.
  while (i < lines.length && /ירד ב|עלה ב/.test(lines[i])) i++;
  const title = lines[i] || "";
  const yearHandIdx = lines.findIndex((l, idx) => idx > i && l.includes("•"));
  let subtitle = "";
  let year = "";
  let hand = "";
  if (yearHandIdx > i) {
    subtitle = lines.slice(i + 1, yearHandIdx).join(" ");
    const [y, h] = lines[yearHandIdx].split("•").map((s) => s.trim());
    year = y || "";
    hand = h || "";
  } else if (lines[i + 1]) {
    subtitle = lines[i + 1];
  }
  const priceLine = lines.find((l) => l.includes("₪") && !/ירד ב|עלה ב/.test(l));
  const price = priceLine ? priceLine.replace(/[^\d]/g, "") : "";
  return { title, subtitle, year, hand, price };
}

function renderReport(listings, extraItems, outputPath, searchParamsLines, lowKmPerYearThreshold) {
  const cardsHtml = listings.map((item) => {
    const imageHtml = item.image_b64
      ? `<img src="${item.image_b64}" alt="תמונת רכב">`
      : '<div class="no-image">אין תמונה</div>';
    const price = item.price;
    const engine = item.engine_size;
    return CARD_TEMPLATE({
      cardClass:
        isFirstHand(item.hand) || isLowKmPerYear(item.km, item.year, lowKmPerYearThreshold)
          ? "card card-first-hand"
          : "card",
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
      ownershipHistoryHtml: formatOwnershipHistory(item.ownership_type, item.original_owner),
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
      const { title, subtitle, year, hand, price, km } = item;
      const cardClass =
        isFirstHand(hand) || isLowKmPerYear(km, year, lowKmPerYearThreshold) ? "card card-first-hand" : "card";
      return `
<div class="${cardClass}">
  ${imageHtml}
  <div class="card-body">
    <div class="card-head">
      <div>
        <div class="title">${escapeHtml(title)}</div>
        ${subtitle ? `<div class="subtitle">${escapeHtml(subtitle)}</div>` : ""}
      </div>
      <span class="price">${price ? `${withThousands(price)} ₪` : ""}</span>
    </div>
    <div class="card-meta">
      ${year ? `<span class="chip">${escapeHtml(year)}</span>` : ""}
      ${hand ? formatHandChip(hand) : ""}
    </div>
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
  const searchParamsHtml =
    searchParamsLines && searchParamsLines.length > 0
      ? `<div class="search-params">${searchParamsLines
          .map((p) => `<span class="param"><b>${escapeHtml(p.label)}:</b> ${escapeHtml(p.value)}</span>`)
          .join("\n")}</div>`
      : "";

  const html = HTML_SHELL({ summary, searchParamsHtml, cards: cardsHtml.join("\n"), extraSection });

  const fileStamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const ext = path.extname(outputPath) || ".html";
  const dir = path.dirname(outputPath);
  const base = path.basename(outputPath, ext);
  const timestampedPath = path.join(dir, `${base}_${fileStamp}${ext}`);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(timestampedPath, html, "utf-8");
  return timestampedPath;
}

function chunked(seq, size) {
  const out = [];
  for (let i = 0; i < seq.length; i += size) out.push(seq.slice(i, i + size));
  return out;
}

const KM_PER_HAND_KEY_RE = /^km_(\d+)(?:st|nd|rd|th)_hand_per_year$/;

function parseRange(str) {
  const m = /^(-?\d+)-(-?\d+)$/.exec(String(str).trim());
  if (!m) return null;
  return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
}

// Reads all "km_<N>st/nd/rd/th_hand_per_year" keys from search config, e.g.
// km_1st_hand_per_year/km_2nd_hand_per_year - any number of tiers. Each is a
// km-per-year RATE, not an absolute range - see scaleRangesByAge.
function kmPerYearRangesByHand(search) {
  const ranges = {};
  for (const [key, value] of Object.entries(search)) {
    const m = KM_PER_HAND_KEY_RE.exec(key);
    if (!m) continue;
    const range = parseRange(value);
    if (range) ranges[parseInt(m[1], 10)] = range;
  }
  return ranges;
}

// Turns per-year rate ranges into absolute km ranges by multiplying by the
// car age implied by search.year's minimum (e.g. year "2016--1" in 2026 ->
// 10 years old, so a 3000-16000/year rate becomes 30000-160000).
function scaleRangesByAge(perYearRanges, ageYears) {
  const scaled = {};
  for (const [hand, range] of Object.entries(perYearRanges)) {
    scaled[hand] = {
      min: range.min * ageYears,
      max: range.max === -1 ? -1 : range.max * ageYears,
    };
  }
  return scaled;
}

// The actual cars-report request can only carry one km range, so it has to be the
// widest one covering every configured hand-specific tier.
function combinedKmRange(rangesByHand) {
  const ranges = Object.values(rangesByHand);
  if (ranges.length === 0) return null;
  const min = Math.min(...ranges.map((r) => r.min));
  const max = ranges.some((r) => r.max === -1) ? -1 : Math.max(...ranges.map((r) => r.max));
  return { min, max };
}

// Only excludes a listing when BOTH its hand and km are actually known and a
// rule exists for that specific hand tier - otherwise it's kept as-is.
function kmPassesHandRule(km, hand, rangesByHand) {
  const range = rangesByHand[handSortKey(hand)];
  if (!range) return true;
  const kmNum = km != null ? parseInt(String(km).replace(/[^\d]/g, ""), 10) : NaN;
  if (Number.isNaN(kmNum)) return true;
  if (kmNum < range.min) return false;
  if (range.max !== -1 && kmNum > range.max) return false;
  return true;
}

const SEARCH_PARAM_LABELS = {
  manufacturer: "יצרנים",
  year: "שנה",
  price: "מחיר",
  km: 'ק"מ',
  hand: "יד",
  engineval: 'נפח מנוע (סמ"ק)',
};

// Fallback names for the manufacturer IDs configured in config.yaml, used
// only when a run finds zero listings for that manufacturer (so its name is
// never learned from scraped data) - keeps the header from showing a bare ID.
const MANUFACTURER_NAME_FALLBACK = {
  17: "הונדה",
  19: "טויוטה",
  27: "מאזדה",
  36: "סוזוקי",
  35: "סובארו",
  30: "מיצובישי",
  15: "דייהטסו",
  21: "יונדאי",
  32: "ניסאן",
};

// Formats a "min-max" or "min--1" (open-ended) config range string with
// thousands separators, e.g. "40000-55000" -> "40,000-55,000" and
// "1450--1" -> "1,450+". Falls back to the raw string if it doesn't parse.
function formatRangeWithThousands(value) {
  const range = parseRange(value);
  if (!range) return value;
  const minStr = withThousands(range.min);
  return range.max === -1 ? `${minStr}+` : `${minStr}-${withThousands(range.max)}`;
}

// The actual values used to build the cars-report URL, for display at the top of
// the report - manufacturer/year/price/hand/engineval as configured, and km
// as the real combined range sent in the request (not the per-hand rates).
function buildSearchParamsLines(search, kmOverride, manufacturerNames) {
  const lines = [];
  if (search.manufacturer) {
    const list = Array.isArray(search.manufacturer) ? search.manufacturer : [search.manufacturer];
    const withNames = list.map((id) => {
      const name = (manufacturerNames && manufacturerNames.get(id)) || MANUFACTURER_NAME_FALLBACK[id];
      return name ? `${id} [${name}]` : String(id);
    });
    lines.push({ label: SEARCH_PARAM_LABELS.manufacturer, value: withNames.join(", ") });
  }
  if (search.year) lines.push({ label: SEARCH_PARAM_LABELS.year, value: search.year });
  if (search.price) lines.push({ label: SEARCH_PARAM_LABELS.price, value: formatRangeWithThousands(search.price) });
  if (kmOverride) {
    lines.push({
      label: SEARCH_PARAM_LABELS.km,
      value:
        kmOverride.max === -1
          ? `${withThousands(kmOverride.min)}+`
          : `${withThousands(kmOverride.min)}-${withThousands(kmOverride.max)}`,
    });
  }
  if (search.hand) lines.push({ label: SEARCH_PARAM_LABELS.hand, value: search.hand });
  if (search.engineval)
    lines.push({ label: SEARCH_PARAM_LABELS.engineval, value: formatRangeWithThousands(search.engineval) });
  return lines;
}

function buildSearchUrl(search, manufacturerChunk, pageNum, kmOverride) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(search)) {
    if (k === "manufacturer" || KM_PER_HAND_KEY_RE.test(k)) continue;
    params.set(k, String(v));
  }
  if (kmOverride) {
    params.set("km", kmOverride.max === -1 ? `${kmOverride.min}--1` : `${kmOverride.min}-${kmOverride.max}`);
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

async function collectListingUrls(
  page,
  browser,
  search,
  manufacturerChunk,
  maxPages,
  delayRange,
  excludeDealers,
  excludedModels,
  rangesByHand,
  kmOverride,
  manufacturerNames
) {
  const seen = new Map();
  for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
    const url = buildSearchUrl(search, manufacturerChunk, pageNum, kmOverride);
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

      // Walk __NEXT_DATA__ to map each listing's token -> {manufacturer id,
      // adType}. adType ("private" vs. everything else) is the actual,
      // reliable dealer signal - confirmed directly on real ad JSON. This
      // lets us sort by manufacturer and filter dealers correctly even for
      // listings whose ad page we never visit.
      const cardDataByToken = {};
      const tag = document.getElementById("__NEXT_DATA__");
      if (tag && tag.textContent) {
        try {
          const nextData = JSON.parse(tag.textContent);
          const stack = [nextData];
          const seenObjs = new Set();
          while (stack.length) {
            const cur = stack.pop();
            if (!cur || typeof cur !== "object" || seenObjs.has(cur)) continue;
            seenObjs.add(cur);
            if (Array.isArray(cur)) {
              for (const item of cur) {
                if (item && typeof item === "object") stack.push(item);
              }
              continue;
            }
            if (cur.manufacturer && typeof cur.manufacturer === "object" && cur.manufacturer.id) {
              const tokenVal = cur.token || cur.adNumber || cur.adId || cur.id;
              if (tokenVal) {
                cardDataByToken[String(tokenVal)] = {
                  manufacturerId: cur.manufacturer.id,
                  manufacturerName: typeof cur.manufacturer.text === "string" ? cur.manufacturer.text : null,
                  adType: typeof cur.adType === "string" ? cur.adType : null,
                  km: cur.km != null ? cur.km : null,
                  hand: cur.hand && typeof cur.hand === "object" ? cur.hand.text : null,
                };
              }
            }
            for (const v of Object.values(cur)) {
              if (v && typeof v === "object") stack.push(v);
            }
          }
        } catch {
          // ignore - manufacturer sort/dealer filter fall back for this page
        }
      }

      return anchors.map((a) => {
        const container = findCardContainer(a);
        const img = container ? container.querySelector("img") : null;
        const text = container ? container.innerText.trim() : "";
        const tokenMatch = /\/item\/([\w-]+)/.exec(a.href);
        const cardData = tokenMatch ? cardDataByToken[tokenMatch[1]] : null;
        const isDealer =
          cardData && cardData.adType
            ? cardData.adType !== "private"
            : !!(
                container &&
                (container.querySelector("[class*='agencyName']") ||
                  container.querySelector("[data-testid='trade-in-flag']"))
              ) ||
              text.includes("הכירו את הסוכנות") ||
              text.includes("בטרייד");
        const manufacturerId = cardData ? cardData.manufacturerId : null;
        return {
          href: a.href,
          text,
          imageUrl: img ? img.currentSrc || img.src || null : null,
          isDealer,
          manufacturerId,
          manufacturerName: cardData ? cardData.manufacturerName : null,
          km: cardData ? cardData.km : null,
          hand: cardData ? cardData.hand : null,
        };
      });
    });
    let newCount = 0;
    let recommendationSkipped = 0;
    let dealerSkipped = 0;
    let excludedModelSkipped = 0;
    let kmHandSkipped = 0;
    for (const card of cards) {
      const m = ITEM_HREF_RE.exec(card.href);
      if (!m) continue;
      if (manufacturerNames && card.manufacturerId && card.manufacturerName) {
        manufacturerNames.set(card.manufacturerId, card.manufacturerName);
      }
      // Cars-report injects a "recommended for you" carousel into the results page
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
      if (excludedModels && excludedModels.some((m2) => card.text.includes(m2))) {
        excludedModelSkipped++;
        continue;
      }
      if (rangesByHand && !kmPassesHandRule(card.km, card.hand, rangesByHand)) {
        kmHandSkipped++;
        continue;
      }
      const token = m[1];
      if (!seen.has(token)) {
        seen.set(token, {
          url: card.href,
          text: card.text,
          imageUrl: card.imageUrl,
          manufacturerId: card.manufacturerId,
          km: card.km,
          hand: card.hand,
        });
        newCount++;
      }
    }
    if (recommendationSkipped > 0) {
      console.log(`    skipped ${recommendationSkipped} unfiltered "recommended for you" cards`);
    }
    if (kmHandSkipped > 0) {
      console.log(`    skipped ${kmHandSkipped} cards outside their hand-specific km range`);
    }
    if (dealerSkipped > 0) {
      console.log(`    skipped ${dealerSkipped} dealer/agency cards (never visited their pages)`);
    }
    if (excludedModelSkipped > 0) {
      console.log(`    skipped ${excludedModelSkipped} excluded-model cards (never visited their pages)`);
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
        // "adType" ("private" vs. everything else) is the actual, reliable
        // field cars-report uses - confirmed directly on real ad JSON. Everything
        // below is a fallback for the rare case it's missing.
        const adType = nextData ? findInJson(nextData, ["adType"]) : null;
        if (typeof adType === "string") return adType !== "private";
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
      data.original_owner = toScalar(nextData ? findInJson(nextData, CANDIDATE_KEYS.original_owner) : null);
      const manufacturer = toScalar(nextData ? findInJson(nextData, CANDIDATE_KEYS.manufacturer) : null);
      const model = toScalar(nextData ? findInJson(nextData, CANDIDATE_KEYS.model) : null);
      const subModel = toScalar(nextData ? findInJson(nextData, CANDIDATE_KEYS.sub_model) : null);
      const h1 = document.querySelector("h1");
      data.title = [manufacturer, model].filter(Boolean).join(" ") || (h1 ? h1.textContent.trim() : "");
      data.subtitle = subModel || "";
      data.manufacturer_name = manufacturer || null;
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
  const excludedModels = options.excluded_models || [];
  const excludedCities = options.excluded_cities || [];
  const lowKmPerYearThreshold = options.low_km_per_year_threshold || 9000;
  const keywords = options.suspicious_keywords || [];
  const profileDir = options.browser_profile_dir || ".pw-test";
  const maxAdDetails = options.max_ad_details || 20;
  const yearRange = parseRange(search.year);
  const ageYears = yearRange ? new Date().getFullYear() - yearRange.min : 1;
  const perYearRanges = kmPerYearRangesByHand(search);
  const rangesByHand = scaleRangesByAge(perYearRanges, ageYears);
  const kmOverride = combinedKmRange(rangesByHand);
  if (kmOverride) {
    console.log(
      `km/year rates per hand: ${JSON.stringify(perYearRanges)}, car age ${ageYears}y (from search.year) -> ` +
        `absolute ranges ${JSON.stringify(rangesByHand)} -> request uses combined ${kmOverride.min}-${
          kmOverride.max === -1 ? "∞" : kmOverride.max
        }\n`
    );
  }

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
  const manufacturerNames = new Map();
  const chunks = chunked(manufacturerIds, chunkSize);
  for (let c = 0; c < chunks.length; c++) {
    const chunkCards = await collectListingUrls(
      page,
      browser,
      search,
      chunks[c],
      maxPages,
      delayRange,
      excludeDealers,
      excludedModels,
      rangesByHand,
      kmOverride,
      manufacturerNames
    );
    for (const [token, cardInfo] of chunkCards) allUrls.set(token, cardInfo);
    if (c < chunks.length - 1) await randomDelay(delayRange);
  }

  console.log(`\n${allUrls.size} unique listings found across all searches.\n`);

  const cacheDir = path.join(path.dirname(options.output_file || "reports/cars_report.html"), "items");
  fs.mkdirSync(cacheDir, { recursive: true });

  // Beyond the cap, promote any listing that already has a cached ad page -
  // using it costs nothing extra, so there's no reason to leave it in the
  // search-page-only "extra" bucket just because of where it fell in the cap.
  const allEntries = Array.from(allUrls.entries());
  const cappedEntries = allEntries.slice(0, maxAdDetails);
  const beyondCapEntries = allEntries.slice(maxAdDetails);
  const promotedEntries = beyondCapEntries.filter(([token]) =>
    fs.existsSync(path.join(cacheDir, `item_${token}.html`))
  );
  const extraEntries = beyondCapEntries.filter(
    ([token]) => !fs.existsSync(path.join(cacheDir, `item_${token}.html`))
  );
  const urlEntries = cappedEntries.concat(promotedEntries);
  if (promotedEntries.length > 0) {
    console.log(`Promoted ${promotedEntries.length} already-cached listing(s) beyond the cap into full details.`);
  }
  if (extraEntries.length > 0) {
    console.log(
      `Fetching full details for ${urlEntries.length} of ${allUrls.size} (max_ad_details cap` +
        (promotedEntries.length > 0 ? " + cached promotions" : "") +
        `); the remaining ${extraEntries.length} will be listed with search-page details only.\n`
    );
  }

  const byUrl = new Map();
  let dealerCount = 0;
  let kmHandCount = 0;
  let cityCount = 0;
  let failCount = 0;
  let cacheHits = 0;
  let i = 0;
  for (const [token, cardInfo] of urlEntries) {
    const url = cardInfo.url;
    const cachePath = path.join(cacheDir, `item_${token}.html`);
    const isCached = fs.existsSync(cachePath);
    i++;
    console.log(`[${i}/${urlEntries.length}] ${url}${isCached ? " (cached)" : ""}`);
    try {
      if (isCached) {
        // Cached HTML is loaded with JS disabled - we only need the static
        // markup/__NEXT_DATA__ already in it, and running cars-report's hydration
        // scripts against a mismatched page.url() risks a client-side redirect.
        cacheHits++;
        await page.setJavaScriptEnabled(false);
        await page.setContent(fs.readFileSync(cachePath, "utf-8"), { waitUntil: "domcontentloaded" });
      } else {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await bailIfBlocked(page, browser, url);
        fs.writeFileSync(cachePath, await page.content(), "utf-8");
      }
      const ad = await extractAd(page, url);
      ad.manufacturer_id = cardInfo.manufacturerId;
      if (ad.manufacturer_id && ad.manufacturer_name) {
        manufacturerNames.set(ad.manufacturer_id, ad.manufacturer_name);
      }
      if (excludeDealers && ad.is_dealer) {
        dealerCount++;
        console.log("    skipped (dealer/agency listing)");
      } else if (!kmPassesHandRule(ad.km, ad.hand, rangesByHand)) {
        kmHandCount++;
        console.log("    skipped (km out of range for its hand)");
      } else if (ad.city && excludedCities.some((c) => ad.city.includes(c))) {
        cityCount++;
        console.log(`    skipped (excluded city: ${ad.city})`);
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
    } finally {
      if (isCached) await page.setJavaScriptEnabled(true);
    }
    if (!isCached) await randomDelay(innerDelayRange);
  }
  if (cacheHits > 0) {
    console.log(`(${cacheHits} of ${urlEntries.length} loaded from cache in ${cacheDir}, no re-fetch)`);
  }

  if (browser.connected) await browser.close();

  const manufacturerOrder = (search.manufacturer || []).map(String);
  const manufacturerSortKey = (manufacturerId) => {
    if (manufacturerId == null) return Number.MAX_SAFE_INTEGER;
    const idx = manufacturerOrder.indexOf(String(manufacturerId));
    return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
  };
  const byManufacturerThenHand = (a, b) => {
    const m = manufacturerSortKey(a.manufacturer_id) - manufacturerSortKey(b.manufacturer_id);
    if (m !== 0) return m;
    return handSortKey(a.hand) - handSortKey(b.hand);
  };

  const listings = Array.from(byUrl.values());
  for (const ad of listings) {
    ad.image_b64 = await downloadImageB64(ad.image_url);
    ad.description_html = highlightKeywords(normalizeForMatch(ad.description || ""), keywords);
  }
  listings.sort(byManufacturerThenHand);

  const extraItems = [];
  for (const [, cardInfo] of extraEntries) {
    const parsed = parseCardText(cardInfo.text);
    extraItems.push({
      url: cardInfo.url,
      image_b64: await downloadImageB64(cardInfo.imageUrl),
      manufacturer_id: cardInfo.manufacturerId,
      km: cardInfo.km,
      ...parsed,
    });
  }
  extraItems.sort(byManufacturerThenHand);

  const searchParamsLines = buildSearchParamsLines(search, kmOverride, manufacturerNames);
  const writtenPath = renderReport(
    listings,
    extraItems,
    options.output_file,
    searchParamsLines,
    lowKmPerYearThreshold
  );
  console.log(
    `\nDone. ${listings.length} private listings written to ${writtenPath} ` +
      `(${dealerCount} dealer listings excluded, ${kmHandCount} excluded for km/hand mismatch, ` +
      `${cityCount} excluded for city, ${failCount} failed parses, ` +
      `${extraItems.length} additional listings included with search-page details only).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
