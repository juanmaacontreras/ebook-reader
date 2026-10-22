"""Builds tests/fixtures/muestra.epub: a small EPUB 3 in Spanish (original text)
with three chapters, a footnote, dialogue and a heading per chapter. Used by the
unit tests, the screenshot script and the end-to-end worker test."""

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


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w") as z:
        z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>""")
        items = "\n".join(f'<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(1, 4))
        spine = "\n".join(f'<itemref idref="c{i}"/>' for i in range(1, 4))
        z.writestr("OEBPS/content.opf", f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="es">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:7c1c5f3e-0000-4000-8000-000000000001</dc:identifier>
<dc:title>Siete golpes</dc:title>
<dc:creator>Atril (muestra)</dc:creator>
<dc:language>es-AR</dc:language>
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
    print(OUT)


if __name__ == "__main__":
    main()
