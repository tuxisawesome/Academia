"""CPU-heavy PDF work. These functions run in worker processes (see ``pool.py``).

They receive and return plain data only and never touch the database. pdfium is not
thread-safe, so it must only ever be used from these single-threaded worker processes.
"""

from __future__ import annotations

import os
from typing import Any


class PdfError(Exception):
    """A user-facing problem with a PDF. Picklable, so it crosses the process boundary."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message)
        self.code = code
        self.message = message


def _normalized_rotation(value: Any) -> int:
    try:
        rot = int(value) % 360
    except (TypeError, ValueError):
        return 0
    return (round(rot / 90) * 90) % 360


def ingest(tmp_path: str, dest_path: str) -> dict[str, Any]:
    """Validate an uploaded PDF, repair/decrypt it into ``dest_path`` and report page sizes."""
    import pikepdf

    try:
        pdf = pikepdf.open(tmp_path)
    except pikepdf.PasswordError as exc:
        raise PdfError(
            "encrypted",
            "This PDF is protected with a password. Remove the password and upload it again.",
        ) from exc
    except (pikepdf.PdfError, OSError, ValueError) as exc:
        raise PdfError("invalid", "This file could not be read as a PDF.") from exc

    with pdf:
        count = len(pdf.pages)
        if count == 0:
            raise PdfError("empty", "This PDF has no pages.")
        sizes: list[tuple[float, float]] = []
        for page in pdf.pages:
            try:
                x0, y0, x1, y1 = (float(v) for v in page.cropbox)
                width, height = abs(x1 - x0), abs(y1 - y0)
            except (ValueError, TypeError, pikepdf.PdfError):
                width, height = 612.0, 792.0
            if width < 1 or height < 1:
                width, height = 612.0, 792.0
            rot = _normalized_rotation(page.obj.get("/Rotate", 0))
            if rot != int(page.obj.get("/Rotate", 0) or 0):
                page.obj.Rotate = rot
            if rot in (90, 270):
                width, height = height, width
            sizes.append((round(width, 2), round(height, 2)))
        part = dest_path + ".part"
        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        # Saving without `encryption` drops any owner-password encryption.
        pdf.save(part)
    os.replace(part, dest_path)
    return {"page_count": count, "sizes": sizes}


def render_thumbnails(source_path: str, items: list[tuple[int, int, str]]) -> int:
    """Render ``(page_index, width_px, out_path)`` items to WebP. Returns how many were written."""
    import pypdfium2 as pdfium

    written = 0
    doc = pdfium.PdfDocument(source_path)
    try:
        try:
            doc.init_forms()
        except Exception:  # noqa: BLE001 - forms are optional
            pass
        for idx, width, out_path in items:
            if idx < 0 or idx >= len(doc):
                continue
            page = doc[idx]
            try:
                page_w, page_h = page.get_size()
                scale = width / page_w if page_w > 0 else 1.0
                # Keep extremely tall pages to a sane bitmap size.
                if page_h * scale > width * 6:
                    scale = (width * 6) / page_h
                bitmap = page.render(scale=max(scale, 0.05), may_draw_forms=True)
                image = bitmap.to_pil().convert("RGB")
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                part = out_path + ".part"
                image.save(part, "WEBP", quality=78, method=4)
                os.replace(part, out_path)
                written += 1
            finally:
                page.close()
    finally:
        doc.close()
    return written


def assemble(spec: dict[str, Any], dest_path: str) -> str:
    """Build a PDF from pages of source PDFs.

    ``spec`` keys:
      title: document title
      pages: list of [source_path, page_index, extra_rotation]
      outline: list of {"title", "page", "children": [...]} (0-based page indices), or []
      labels: list of [start_index, first_number] for /PageLabels, or None
    """
    import pikepdf
    from pikepdf import Array, Dictionary, Name, OutlineItem

    out = pikepdf.new()
    opened: dict[str, pikepdf.Pdf] = {}
    try:
        for src_path, idx, _rotation in spec["pages"]:
            src = opened.get(src_path)
            if src is None:
                src = opened[src_path] = pikepdf.open(src_path)
            out.pages.append(src.pages[idx])
        # Rotate only after every page is in place: appending a source page a second time
        # makes a shallow copy of the first copy, which must not carry its rotation yet.
        for page, (_src, _idx, rotation) in zip(out.pages, spec["pages"], strict=True):
            if rotation:
                page.rotate(int(rotation), relative=True)

        outline = spec.get("outline") or []
        if outline:

            def build(item: dict[str, Any]) -> OutlineItem:
                node = OutlineItem(item["title"], int(item["page"]))
                for child in item.get("children") or []:
                    node.children.append(build(child))
                return node

            with out.open_outline() as tree:
                for item in outline:
                    tree.root.append(build(item))
            out.Root.PageMode = Name.UseOutlines

        labels = spec.get("labels")
        if labels:
            nums = Array()
            for start, first_number in labels:
                nums.append(int(start))
                nums.append(Dictionary(S=Name.D, St=int(first_number)))
            out.Root.PageLabels = Dictionary(Nums=nums)

        title = spec.get("title") or ""
        out.docinfo[Name.Title] = title
        out.docinfo[Name.Producer] = "Academia"
        try:
            with out.open_metadata(set_pikepdf_as_editor=False) as meta:
                meta["dc:title"] = title
        except Exception:  # noqa: BLE001 - XMP is best effort
            pass

        os.makedirs(os.path.dirname(dest_path), exist_ok=True)
        part = f"{dest_path}.{os.getpid()}.part"
        out.save(part, linearize=True)
        os.replace(part, dest_path)
    finally:
        for pdf in opened.values():
            pdf.close()
        out.close()
    return dest_path


MAX_PAGE_TEXT = 100_000


def extract_text(source_path: str, indices: list[int]) -> dict[int, str]:
    """Text layer of the given pages (empty for scanned or handwritten pages)."""
    import pypdfium2 as pdfium

    out: dict[int, str] = {}
    doc = pdfium.PdfDocument(source_path)
    try:
        for idx in indices:
            if idx < 0 or idx >= len(doc):
                continue
            page = doc[idx]
            try:
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_range() or ""
                finally:
                    textpage.close()
            except Exception:  # noqa: BLE001 - a broken page just has no text
                text = ""
            finally:
                page.close()
            out[idx] = " ".join(text.split())[:MAX_PAGE_TEXT]
    finally:
        doc.close()
    return out
