# yad2-scraper

Turns a [yad2.co.il](https://www.yad2.co.il) car search into a single self-contained HTML report: every matching **private-seller** listing, full per-ad detail, images embedded so the file is portable, and suspicious keywords (accident/rental history, etc.) highlighted in bold red so they jump out while skimming.

Drives a real, visible Chrome browser under your own profile/network — [`puppeteer-extra`](https://github.com/berstend/puppeteer-extra) with the [stealth plugin](https://github.com/berstend/puppeteer-extra/tree/master/packages/puppeteer-extra-plugin-stealth), launched against your actual installed Chrome (not a bundled/headless one), with a persistent user profile so it behaves like a returning real browser session rather than a fresh automation profile.

## Why headed + stealth + a real Chrome profile

yad2.co.il fronts a Radware/ShieldSquare bot-mitigation layer that can challenge automated browsers. This isn't something to defeat with cleverer evasion from a datacenter/CI box — the reliable, legitimate path is to run it **locally**, as a **real** browser under **your** normal network and Chrome install, doing exactly what you'd otherwise do by hand: open the search, page through results, open each ad. The stealth plugin and profile persistence are defense-in-depth on top of that, not a replacement for it.

If a bot-challenge page still shows up, the script stops rather than silently scraping the challenge page as data — see `bailIfBlocked` in `scrape.js`. It gives you a 60-second window to clear the challenge by hand (e.g. click through a CAPTCHA) before giving up; if you clear it in time, scraping continues automatically.

## Setup

Requires [Node.js](https://nodejs.org/) and a locally installed Google Chrome.

```
npm install
```

## Configure your search

Edit `config.yaml`:

```yaml
search:
  manufacturer: [15, 17, 19, 21]   # yad2 manufacturer IDs; up to 4 per request (see max_manufacturers_per_request)
  year: "2016--1"                  # 2016 or newer
  price: "40000-55000"
  km: "30000-160000"
  hand: "0-1"                      # 1st hand only
  engineval: "1500--1"             # 1500cc or larger

options:
  exclude_dealers: true            # keep only private-seller ads
  suspicious_keywords: ["תאונה", "השכרה", ...]   # highlighted in bold red if found in the description
  output_file: "yad2_report.html"

  max_manufacturers_per_request: 4   # yad2's own limit per search request
  request_delay_seconds: [2, 5]      # randomized pause between search-result pages/chunks
  inner_page_delay_seconds: [6, 14]  # randomized pause between individual ad page visits
  max_pages_per_search: 20           # safety cap per manufacturer chunk
  max_ad_details: 20                 # fetch full details for only the first N listings found; the rest are
                                      # still included in the report, but with only what's visible on the
                                      # results page (title, price, year/hand, thumbnail) - no extra page visits
  browser_profile_dir: ".pw-test"    # persistent Chrome profile dir, reused across runs
```

Manufacturer IDs are yad2's own internal IDs (e.g. 19 = Toyota, 21 = Hyundai) - find them by starting a manual search on the site and reading the `manufacturer=` query parameter.

## Run

```
npm run scrape
```

This opens a visible Chrome window, walks the configured search(es), filters out dealer/agency listings (detected right on the results page, so their ad pages are never even visited), opens each remaining private listing up to `max_ad_details`, extracts full details, downloads and embeds the first image, and writes the report to `output_file`.

## What ends up in the report

- Responsive card grid: image, price, year, hand/ownership, km, city, engine size/fuel type, full description, direct link back to the original ad.
- **Km color-coding**: average km/year (total km ÷ car age) over 10,000 is marked blue; under 7,000 is marked bold green.
- **First-hand cars** (`יד ראשונה`) are marked bold green.
- Suspicious keywords (config-driven) highlighted in bold red inside the description.
- Listings beyond `max_ad_details` still appear, in a separate section, with whatever the results page itself shows (no extra page visits).

## Notes

- `.pw-test/` (the persistent Chrome profile) and the generated report are gitignored - the profile contains real session/cookie data, and the report contains real scraped listings.
- If the run gets interrupted mid-flight by a closed browser tab, it stops cleanly with whatever it's collected so far rather than grinding through the rest with useless failures.
