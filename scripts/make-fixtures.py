"""Writes small multi-page PDFs used by the end-to-end tests: page n shows "<label> <n>"."""

import sys
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name


def make(path: Path, label: str, pages: int, size=(595, 842)) -> None:
    pdf = pikepdf.new()
    font = pdf.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/Times-Roman")))
    for i in range(pages):
        pdf.add_blank_page(page_size=size)
        page = pdf.pages[-1]
        page.obj.Resources = Dictionary(Font=Dictionary(F1=font))
        text = f"BT /F1 48 Tf 72 {size[1] - 160} Td ({label} {i + 1}) Tj ET\n"
        text += "0.48 0.18 0.15 rg 72 120 451 4 re f\n"
        page.obj.Contents = pdf.make_stream(text.encode())
    pdf.save(path)


out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
make(out / "Lecture Notes.pdf", "Lecture", 12)
make(out / "Handout.pdf", "Handout", 2)
make(out / "Slides.pdf", "Slide", 4, size=(842, 595))
print(f"fixtures written to {out}")
