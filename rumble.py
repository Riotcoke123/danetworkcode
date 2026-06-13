import os
import asyncio
import logging
from flask import Flask, jsonify
from dotenv import load_dotenv
from patchright.async_api import async_playwright

load_dotenv()
app = Flask(__name__)
logging.basicConfig(level=logging.INFO)

# ─── Config ───────────────────────────────────────────────────────────────────

# How many Rumble pages to scrape simultaneously.
# Each slot = 1 browser context + up to 2 pages (channel list → stream page).
# 6 is safe on a 3-core VPS; raise to 8–10 on beefier hardware.
CONCURRENCY = int(os.getenv("RUMBLE_CONCURRENCY", 6))

# Per-page navigation timeout (ms)
NAV_TIMEOUT = int(os.getenv("RUMBLE_NAV_TIMEOUT", 25_000))

# How long to wait for JS to hydrate after domcontentloaded (ms)
HYDRATE_WAIT = int(os.getenv("RUMBLE_HYDRATE_WAIT", 2_500))

# ─── Selectors ────────────────────────────────────────────────────────────────

CHANNEL_SELECTORS = {
    "live_indicator": "body > main > section > ol > div:nth-child(1) > div.thumbnail__thumb.thumbnail__thumb--live > div > div.videostream__badge.videostream__status.videostream__status--live",
    "profile_photo":  "body > main > div > div.channel-header--content > div > div > div.channel-header--thumb > img",
    "display_name":   "body > main > div > div.channel-header--content > div > div > div.channel-header--title > div > h1",
    "stream_title":   "body > main > section > ol > div:nth-child(1) > div.videostream__footer.videostream__footer--live > a > h3",
    "stream_link":    "body > main > section > ol > div:nth-child(1) > div.videostream__footer.videostream__footer--live > a",
    "vod_link":       "body > main > section > ol > div:nth-child(1) > div.thumbnail__thumb > a",
    "last_broadcast": "body > main > section > ol > div:nth-child(1) > div.videostream__footer > address > div.videostream__data > span.videostream__data--item.videostream__date > time",
}

USER_SELECTORS = {
    "live_indicator": "body > main > section > ol > div > div.thumbnail__thumb.thumbnail__thumb--live > div > div.videostream__badge.videostream__status.videostream__status--live",
    "profile_photo":  "body > main > div.channel-header--container > div.channel-header--content > div > div > div.channel-header--thumb > img",
    "display_name":   "body > main > div.channel-header--container > div.channel-header--content > div > div > div.channel-header--title > div > h1",
    "stream_title":   "body > main > section > ol > div > div.videostream__footer.videostream__footer--live > a > h3",
    "stream_link":    "body > main > section > ol > div > div.videostream__footer.videostream__footer--live > a",
    "vod_link":       "body > main > section > ol > div:nth-child(1) > div.thumbnail__thumb > a",
    "last_broadcast": "body > main > section > ol > div:nth-child(1) > div.videostream__footer > address > div.videostream__data > span.videostream__data--item.videostream__date > time",
}

VIEWER_COUNT_SELECTOR = (
    "body > main > article > div.main-and-sidebar > div > div.media-container > "
    "div.media-info > div.video-header-container > div:nth-child(1) > div > div > "
    "div > div > div.live-video-view-count-status-count.tabular-nums"
)

# ─── Async Helpers ────────────────────────────────────────────────────────────

async def new_page(browser):
    context = await browser.new_context(
        viewport={"width": 1920, "height": 1080},
        locale="en-US",
        timezone_id="America/New_York",
    )
    return await context.new_page()


async def get_text(page, selector):
    el = page.locator(selector)
    if await el.count() > 0:
        return (await el.first.inner_text()).strip() or None
    return None


async def get_attr(page, selector, attr):
    el = page.locator(selector)
    if await el.count() > 0:
        return await el.first.get_attribute(attr) or None
    return None


def build_url(href):
    if not href:
        return None
    return f"https://rumble.com{href}" if href.startswith("/") else href


# ─── Core Scraper (async, one target) ─────────────────────────────────────────

async def scrape_one(semaphore, browser, identifier, is_channel):
    async with semaphore:
        page = await new_page(browser)
        sel  = CHANNEL_SELECTORS if is_channel else USER_SELECTORS
        base = "c" if is_channel else "user"
        url  = f"https://rumble.com/{base}/{identifier}/livestreams"

        data = {
            "identifier":     identifier,
            "type":           "channel" if is_channel else "user",
            "url":            url,
            "status":         "offline",
            "profile_photo":  None,
            "display_name":   None,
            "stream_title":   None,
            "stream_url":     None,
            "viewer_count":   None,
            "vod_url":        None,
            "last_broadcast": None,
        }

        try:
            logging.info(f"→ {identifier}")
            await page.goto(url, timeout=NAV_TIMEOUT, wait_until="domcontentloaded")
            await page.wait_for_timeout(HYDRATE_WAIT)

            data["profile_photo"] = await get_attr(page, sel["profile_photo"], "src")
            data["display_name"]  = await get_text(page, sel["display_name"])

            is_live = await page.locator(sel["live_indicator"]).count() > 0

            if is_live:
                data["status"]       = "online"
                data["stream_title"] = await get_text(page, sel["stream_title"])
                href                 = await get_attr(page, sel["stream_link"], "href")
                data["stream_url"]   = build_url(href)
                logging.info(f"✓ {identifier} LIVE — {data['stream_title']}")

                if data["stream_url"]:
                    try:
                        await page.goto(data["stream_url"], timeout=NAV_TIMEOUT,
                                        wait_until="domcontentloaded")
                        await page.wait_for_timeout(HYDRATE_WAIT)
                        await page.wait_for_selector(VIEWER_COUNT_SELECTOR, timeout=8_000)
                        data["viewer_count"] = await get_text(page, VIEWER_COUNT_SELECTOR)
                    except Exception as e:
                        logging.warning(f"Viewer count failed for {identifier}: {e}")
            else:
                data["status"] = "offline"
                href = await get_attr(page, sel["vod_link"], "href")
                data["vod_url"] = build_url(href)
                data["last_broadcast"] = (
                    await get_attr(page, sel["last_broadcast"], "datetime")
                    or await get_text(page, sel["last_broadcast"])
                )
                logging.info(f"✓ {identifier} offline")

        except Exception as e:
            logging.error(f"✗ {identifier}: {e}")
        finally:
            await page.close()

        return data


# ─── Async Orchestrator ───────────────────────────────────────────────────────

async def run_scrape(channels, users):
    semaphore = asyncio.Semaphore(CONCURRENCY)
    results   = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        try:
            tasks = (
                [scrape_one(semaphore, browser, c, True)  for c in channels] +
                [scrape_one(semaphore, browser, u, False) for u in users]
            )
            results = await asyncio.gather(*tasks, return_exceptions=False)
        finally:
            await browser.close()

    return list(results)


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route("/healthz", methods=["GET"])
def healthz():
    return jsonify({"ok": True}), 200


@app.route("/scrape", methods=["GET"])
def trigger_scrape():
    channels = [c.strip() for c in os.getenv("RUMBLE_CHANNELS", "").split(",") if c.strip()]
    users    = [u.strip() for u in os.getenv("RUMBLE_USERS",    "").split(",") if u.strip()]

    results = asyncio.run(run_scrape(channels, users))
    return jsonify({"success": True, "results": results})


@app.route("/debug/<path:identifier>", methods=["GET"])
def debug_page(identifier):
    """Dumps raw rendered HTML. Hit /debug/roseannebarr to inspect selectors."""
    is_channel = identifier not in [
        u.strip() for u in os.getenv("RUMBLE_USERS", "").split(",")
    ]
    base_type = "c" if is_channel else "user"
    url = f"https://rumble.com/{base_type}/{identifier}/livestreams"

    async def _fetch():
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                locale="en-US",
                timezone_id="America/New_York",
            )
            page = await context.new_page()
            await page.goto(url, timeout=NAV_TIMEOUT, wait_until="domcontentloaded")
            await page.wait_for_timeout(HYDRATE_WAIT)
            html = await page.content()
            await browser.close()
            return html

    html = asyncio.run(_fetch())
    return html, 200, {"Content-Type": "text/html"}


# ─── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app.run(host="0.0.0.0", debug=True, use_reloader=False, port=5000)