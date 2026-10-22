"""Builds tests/fixtures/muestra.epub: a small EPUB 3 in Spanish (original text)
with three chapters, a footnote, dialogue and a heading per chapter. Used by the
unit tests, the screenshot script and the end-to-end worker test."""

import argparse
import io
import zipfile
from pathlib import Path

OUT = Path(__file__).parent / "fixtures" / "muestra.epub"

CHAPTERS = [
    ("Uno", "La lluvia", [
        "Llovía sobre Buenos Aires desde el mediodía, una lluvia finita y terca que no terminaba de decidirse. Martina cerró el libro y miró la calle vacía.",
        "—¿Vos también lo escuchaste? —preguntó sin darse vuelta.",
        "—Escuché algo —dijo Tomás desde la cocina—, pero seguro fue el viento.",
        'Ella no contestó. Había contado siete golpes, ni uno más ni uno menos<a epub:type="noteref" href="#n1">1</a>, y el viento no sabe contar.',
    ]),
    ("Dos", "La escalera", [
        "Bajó la escalera de dos en dos. En el tercer piso la luz no andaba, como siempre; en el segundo, la señora Ruiz había dejado la puerta entreabierta.",
        "¿Quién golpea siete veces a las tres de la tarde? Nadie que quiera vender algo, pensó.",
        "Abajo, el portero leía el diario con una paciencia de otro siglo.",
    ]),
    ("Tres", "La puerta", [
        "La puerta de calle estaba cerrada con llave. Del otro lado, sobre la vereda mojada, alguien había dejado un sobre amarillo.",
        "Martina lo levantó con cuidado. No tenía nombre, ni dirección, ni sello. Solamente un número escrito a mano: siete.",
    ]),
]


def chapter(num: str, title: str, paras: list[str], with_note: bool) -> str:
    body = "\n".join(f"<p>{p}</p>" for p in paras)
    note = '<aside epub:type="footnote" id="n1"><p>Siete, como los días de la semana.</p></aside>' if with_note else ""
    return f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="es" xml:lang="es">
<head><title>{title}</title></head>
<body>
<section epub:type="chapter">
<h1>Capítulo {num}: {title}</h1>
{body}
{note}
</section>
</body>
</html>"""


# Extra fictional titles for screenshots (--demo DIR, needs Pillow for covers).
DEMO = [
    ("Siete golpes", "Martina Ortiz", "es", "#5E81AC"),
    ("La casa del puerto", "Julián Ferraro", "es", "#BF616A"),
    ("Mapa de las nubes", "Inés Calvo", "es", "#A3BE8C"),
    ("El último tranvía", "Ramón Etchegaray", "es", "#D08770"),
    ("Notes from the Lighthouse", "Eleanor Hale", "en", "#B48EAD"),
    ("Cartas a Julia", "Pedro Montes", "es", "#EBCB8B"),
]


def cover_png(title: str, author: str, color: str) -> bytes:
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (600, 900), color)
    d = ImageDraw.Draw(img)
    serif = "/usr/share/fonts/gnu-free/FreeSerifBold.otf"
    sans = "/usr/share/fonts/gnu-free/FreeSans.otf"
    big, small = ImageFont.truetype(serif, 64), ImageFont.truetype(sans, 30)
    d.rectangle([40, 40, 560, 860], outline="#ECEFF4", width=4)
    words, lines, cur = title.split(), [], ""
    for w in words:
        if d.textlength((cur + " " + w).strip(), font=big) > 440:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    lines.append(cur)
    y = 300
    for line in lines:
        d.text((300, y), line, font=big, fill="#2E3440" if color in ("#EBCB8B", "#A3BE8C") else "#ECEFF4", anchor="mm")
        y += 80
    d.text((300, 780), author.upper(), font=small, fill="#2E3440" if color in ("#EBCB8B", "#A3BE8C") else "#ECEFF4", anchor="mm")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--demo", help="also write the demo library (with covers) to this folder")
    args = ap.parse_args()
    write(OUT, "Siete golpes", "Atril (muestra)", "es", None)
    if args.demo:
        out = Path(args.demo)
        out.mkdir(parents=True, exist_ok=True)
        for k, (title, author, lang, color) in enumerate(DEMO):
            write(out / f"demo{k}.epub", title, author, lang, cover_png(title, author, color), uid=k + 2)


def write(path: Path, title: str, author: str, lang: str, cover: bytes | None, uid: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>""")
        items = "\n".join(f'<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(1, 4))
        if cover:
            z.writestr("OEBPS/cover.png", cover)
            items += '\n<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>'
        spine = "\n".join(f'<itemref idref="c{i}"/>' for i in range(1, 4))
        z.writestr("OEBPS/content.opf", f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="es">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:7c1c5f3e-0000-4000-8000-{uid:012d}</dc:identifier>
<dc:title>{title}</dc:title>
<dc:creator>{author}</dc:creator>
<dc:language>{lang}</dc:language>
<meta property="dcterms:modified">2026-10-21T00:00:00Z</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
{items}
</manifest>
<spine>{spine}</spine>
</package>""")
        nav = "\n".join(f'<li><a href="c{i}.xhtml">Capítulo {n}: {t}</a></li>' for i, (n, t, _) in enumerate(CHAPTERS, 1))
        z.writestr("OEBPS/nav.xhtml", f"""<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="es">
<head><title>Índice</title></head>
<body><nav epub:type="toc"><ol>{nav}</ol></nav></body></html>""")
        for i, (n, t, paras) in enumerate(CHAPTERS, 1):
            z.writestr(f"OEBPS/c{i}.xhtml", chapter(n, t, paras, i == 1))
    print(path)


if __name__ == "__main__":
    main()
