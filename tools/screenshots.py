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
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
EPUB = ROOT / "client" / "tests" / "fixtures" / "muestra.epub"
DEVICES = {
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


async def shoot(browser, url: str, out: Path, device: str, scheme: str, variant: str | None, errors: list[str],
                library: Path | None = None, only_library: bool = False) -> None:
    ctx = await browser.new_context(color_scheme=scheme, **DEVICES[device])
    page = await ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"{device}/{scheme}: {e}"))
    page.on("console", lambda m: errors.append(f"{device}/{scheme} console: {m.text}") if m.type == "error" else None)
    q = "?demo" + (f"&variant={variant}" if variant else "")
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
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            for device in args.devices.split(","):
                for scheme in args.schemes.split(","):
                    await shoot(browser, args.url, out, device, scheme, args.variant, errors,
                                Path(args.library) if args.library else None, args.only_library)
        finally:
            await browser.close()
            for e in errors:
                print("ERROR", e)
    print(f"saved to {out}")


if __name__ == "__main__":
    asyncio.run(main())
