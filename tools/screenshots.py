"""Render the real app in headless Chromium and save screenshots.

Design changes are proposed as screenshots before they are built (see
CLAUDE.md). This drives the app in ?demo mode (local only, no account),
imports client/tests/fixtures/muestra.epub and captures the main screens.

    python tools/screenshots.py OUT_DIR [--url http://localhost:5173] [--variant NAME]

Needs Playwright (not a project dependency: install it in a throwaway venv,
see CLAUDE.md "Screenshots") and a running `npm run dev` in client/.
"""

import argparse
import asyncio
import os
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
AS_PHONE = False
EPUB = ROOT / "client" / "tests" / "fixtures" / "muestra.epub"
DEVICES = {
    "phone-narrow": {"viewport": {"width": 360, "height": 780}, "device_scale_factor": 3, "is_mobile": True, "has_touch": True},
    "phone": {"viewport": {"width": 400, "height": 860}, "device_scale_factor": 2.5, "is_mobile": True, "has_touch": True},
    "tablet": {"viewport": {"width": 1280, "height": 800}, "device_scale_factor": 2, "is_mobile": True, "has_touch": True},
}


SEED = """async ([progress]) => {
  const db = window.__atril.db
  const books = await db.all('books')
  const now = Date.now()
  for (const [k, b] of books.entries()) {
    const p = progress[k % progress.length]
    if (p === null) continue
    b.status = p >= 1 ? 'finished' : 'reading'
    await db.put('books', b)
    if (p < 1) await db.put('positions', { book_id: b.id, cfi: 'epubcfi(/6/2)', section: 0, sentence: 0, fraction: p,
      device: 'x', updated_at: new Date(now - k * 3600e3).toISOString() })
  }
}"""


SEED_AUDIO = """async () => {
  const db = window.__atril.db
  const books = (await db.all('books')).sort((a, b) => a.title.localeCompare(b.title))
  const t0 = Date.now()
  const plan = [  // [state, status, scope, chapters ready, on device]
    ['generating', 'active', 'all', 1, 1], ['waiting', 'active', 'next', 0, 0], ['ready', 'active', 'all', 3, 2],
    ['ready', 'active', 'chapter', 1, 1], ['waiting', 'paused', 'all', 1, 0],
  ]
  const started = new Date(t0 - 3600e3).toISOString()
  for (const [k, [state, status, scope, ready, dev]] of plan.entries()) {
    const b = books[k]; if (!b) break
    if (b.status === 'finished') { b.status = 'reading'; await db.put('books', b) }
    const voice = k === 3 ? 'kokoro:ef_dora' : 'chatterbox-latam:ar_elena'
    await db.put('narrations', { book_id: b.id, voice, status, scope, state, start_section: 0, priority_section: null,
      current_section: state === 'generating' ? ready : null, error: null, started_at: started, stopped_at: null,
      requested_at: new Date(t0 - (10 - k) * 60e3).toISOString(), updated_at: new Date(t0).toISOString() })
    for (let s = 0; s < ready; s++)
      await db.put('chapters', { book_id: b.id, voice, section: s, audio_path: 'x', duration: 1500, bytes: 13.8e6 + s * 9e5,
        created_at: new Date(t0).toISOString(), cached: s < dev })
    if (k === 0) window.__atrilWs = { heartbeat: new Date(t0).toISOString(), voices: [], audio_bytes: null, notice: null,
      current: { book_id: b.id, section: 1, voice, title: b.title, label: 'Capítulo 2', done: 1, total: 3, until: t0 / 1000 + 2400 } }
  }
}"""


async def shoot(browser, url: str, out: Path, device: str, scheme: str, variant: str | None, errors: list[str],
                library: Path | None = None, only_library: bool = False, audios: bool = False) -> None:
    ctx = await browser.new_context(color_scheme=scheme, **DEVICES[device])
    page = await ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"{device}/{scheme}: {e}"))
    page.on("console", lambda m: errors.append(f"{device}/{scheme} console: {m.text}") if m.type == "error" else None)
    q = "?demo" + (f"&variant={variant}" if variant else "") + ("&as=phone" if AS_PHONE else "")
    await page.goto(f"{url}/{q}#/")
    await page.wait_for_selector(".fab")
    files = sorted(str(f) for f in library.glob("*.epub")) if library else [str(EPUB)]
    await page.set_input_files("input[type=file]", files)
    for _ in range(240):  # imports run one after another
        if await page.evaluate("window.__atril.db.all('books').then(b => b.length)") >= len(files):
            break
        await page.wait_for_timeout(250)
    if library:
        await page.evaluate(SEED, [[0.37, 0.72, None, 1, None, 0.08]])
        await page.reload()
        await page.wait_for_selector(".bookc, .brow")
    await page.wait_for_timeout(1500)
    tag = f"{device}-{scheme}" + (f"-{variant}" if variant else "")
    await page.screenshot(path=out / f"{tag}-library.png")
    if only_library:
        await ctx.close()
        return
    if audios:
        await page.evaluate(SEED_AUDIO)
        await page.goto(f"{url}/{q}#/audios")
        await page.wait_for_selector(".meter", timeout=20000)
        await page.evaluate(SEED_AUDIO)  # the reload above dropped the fake worker status
        await page.wait_for_timeout(1500)
        await page.screenshot(path=out / f"{tag}-audios.png")
        if await page.query_selector(".audios .hd .btn.primary"):
            await page.click(".audios .hd .btn.primary")  # "Generar ahora" → pick a book → the sheet
            await page.wait_for_timeout(500)
            await page.screenshot(path=out / f"{tag}-pick-book.png")
            await page.click(".dialog .choice")
            await page.wait_for_timeout(1200)
            await page.screenshot(path=out / f"{tag}-generate.png")
        await ctx.close()
        return
    await page.click(".bookc, .brow")
    await page.wait_for_selector("foliate-view", timeout=20000)
    await page.wait_for_timeout(1500)
    await page.screenshot(path=out / f"{tag}-reader.png")
    await page.mouse.click(DEVICES[device]["viewport"]["width"] / 2, DEVICES[device]["viewport"]["height"] / 2)
    await page.wait_for_timeout(500)
    await page.screenshot(path=out / f"{tag}-reader-chrome.png")
    await page.click("button[aria-label='Lectura']")
    await page.wait_for_timeout(400)
    await page.screenshot(path=out / f"{tag}-reading-settings.png")
    await ctx.close()


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--url", default="http://localhost:5173")
    ap.add_argument("--variant")
    ap.add_argument("--devices", default="phone,tablet")
    ap.add_argument("--schemes", default="light,dark")
    ap.add_argument("--library", help="folder of EPUBs to import instead of the sample (seeds some progress)")
    ap.add_argument("--only-library", action="store_true")
    ap.add_argument("--audios", action="store_true", help="seed narrations and capture the Audios screen")
    ap.add_argument("--as-phone", action="store_true", help="the phone app (no audio management)")
    args = ap.parse_args()
    global AS_PHONE
    AS_PHONE = args.as_phone
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    async with async_playwright() as p:
        # CHROMIUM: a browser already on the machine (e.g. /opt/pw-browsers/chromium).
        browser = await p.chromium.launch(executable_path=os.environ.get("CHROMIUM") or None)
        try:
            for device in args.devices.split(","):
                for scheme in args.schemes.split(","):
                    await shoot(browser, args.url, out, device, scheme, args.variant, errors,
                                Path(args.library) if args.library else None, args.only_library, args.audios)
        finally:
            await browser.close()
            for e in errors:
                print("ERROR", e)
    print(f"saved to {out}")


if __name__ == "__main__":
    asyncio.run(main())
