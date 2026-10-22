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


async def shoot(browser, url: str, out: Path, device: str, scheme: str, variant: str | None, errors: list[str]) -> None:
    ctx = await browser.new_context(color_scheme=scheme, **DEVICES[device])
    page = await ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"{device}/{scheme}: {e}"))
    page.on("console", lambda m: errors.append(f"{device}/{scheme} console: {m.text}") if m.type == "error" else None)
    q = "?demo" + (f"&variant={variant}" if variant else "")
    await page.goto(f"{url}/{q}#/")
    await page.wait_for_selector(".fab")
    await page.set_input_files("input[type=file]", str(EPUB))
    await page.wait_for_selector(".bookc", timeout=20000)
    await page.wait_for_timeout(600)
    tag = f"{device}-{scheme}" + (f"-{variant}" if variant else "")
    await page.screenshot(path=out / f"{tag}-library.png")
    await page.click(".bookc")
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
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    errors: list[str] = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        try:
            for device in args.devices.split(","):
                for scheme in args.schemes.split(","):
                    await shoot(browser, args.url, out, device, scheme, args.variant, errors)
        finally:
            await browser.close()
            for e in errors:
                print("ERROR", e)
    print(f"saved to {out}")


if __name__ == "__main__":
    asyncio.run(main())
