from __future__ import annotations

import io
from pathlib import Path
from urllib.parse import unquote

import pikepdf
from PIL import Image

from conftest import make_pdf, new_notebook, page_texts, upload


def outline_of(content: bytes) -> list[tuple[str, int, list[tuple[str, int]]]]:
    pdf = pikepdf.open(io.BytesIO(content))
    pages = {p.objgen: i for i, p in enumerate(pdf.pages)}

    def page_index(item) -> int:  # noqa: ANN001
        dest = item.destination
        if isinstance(dest, int):
            return dest
        return pages[dest[0].objgen]

    out = []
    with pdf.open_outline() as ol:
        for item in ol.root:
            out.append((item.title, page_index(item), [(c.title, page_index(c)) for c in item.children]))
    return out


def test_notebook_download_has_outline(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=8, name="Lecture Notes")
    ids = [p["id"] for p in nb["pages"]]
    client.post("/api/bookmarks", json={"name": "Intro", "notebook_id": nb["id"], "page_ids": ids[0:2]})
    client.post(
        "/api/bookmarks", json={"name": "Proofs", "notebook_id": nb["id"], "page_ids": [ids[3], ids[6], ids[7]]}
    )
    client.post("/api/bookmarks", json={"name": "Empty", "notebook_id": nb["id"], "page_ids": []})

    r = client.get(f"/api/notebooks/{nb['id']}/pdf", params={"variant": "download"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert "attachment" in r.headers["content-disposition"]
    assert "Lecture Notes.pdf" in unquote(r.headers["content-disposition"])
    assert outline_of(r.content) == [
        ("Intro", 0, []),
        ("Proofs", 3, [("Page 4", 3), ("Pages 7–8", 6)]),
    ]
    pdf = pikepdf.open(io.BytesIO(r.content))
    assert pdf.Root.PageMode == pikepdf.Name.UseOutlines
    assert str(pdf.docinfo["/Title"]) == "Lecture Notes"

    # The reader variant has no outline and is served inline.
    r = client.get(f"/api/notebooks/{nb['id']}/pdf")
    assert "inline" in r.headers["content-disposition"]
    assert outline_of(r.content) == []


def test_bookmark_pdf_labels_and_outline(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=10)
    ids = [p["id"] for p in nb["pages"]]
    bm = client.post(
        "/api/bookmarks", json={"name": "Sel", "notebook_id": nb["id"], "page_ids": [ids[2], ids[3], ids[8]]}
    ).json()
    r = client.get(f"/api/bookmarks/{bm['id']}/pdf", params={"variant": "download"})
    assert r.status_code == 200
    assert "Notes - Sel.pdf" in unquote(r.headers["content-disposition"])
    assert page_texts(r.content) == ["p3", "p4", "p9"]
    pdf = pikepdf.open(io.BytesIO(r.content))
    nums = list(pdf.Root.PageLabels.Nums)
    assert int(nums[0]) == 0 and int(nums[1].St) == 3
    assert int(nums[2]) == 2 and int(nums[3].St) == 9
    assert outline_of(r.content) == [("Pages 3–4", 0, []), ("Page 9", 2, [])]


def test_rotation_applied(client, tmp_path: Path):
    src = upload(client, make_pdf(tmp_path / "rot.pdf", pages=2, rotate={1: 90}))
    assert src["pages"][1]["width"] == 400 and src["pages"][1]["height"] == 300
    nb = client.post("/api/notebooks", json={"name": "Rot", "source_id": src["id"]}).json()
    nb = client.get(f"/api/notebooks/{nb['id']}").json()
    ids = [p["id"] for p in nb["pages"]]
    nb = client.post(
        f"/api/notebooks/{nb['id']}/pages/rotate", json={"base_rev": nb["rev"], "page_ids": ids, "delta": 90}
    ).json()
    pdf = pikepdf.open(io.BytesIO(client.get(f"/api/notebooks/{nb['id']}/pdf").content))
    assert [int(p.obj.get("/Rotate", 0)) for p in pdf.pages] == [90, 180]


def test_same_source_page_twice(client, tmp_path: Path):
    path = make_pdf(tmp_path / "dup.pdf", pages=2)
    nb = new_notebook(client, tmp_path, pages=2)
    src = upload(client, path)
    nb = client.post(
        f"/api/notebooks/{nb['id']}/pages/insert", json={"base_rev": nb["rev"], "source_id": src["id"], "at": "end"}
    ).json()
    first = nb["pages"][0]["id"]
    nb = client.post(
        f"/api/notebooks/{nb['id']}/pages/rotate", json={"base_rev": nb["rev"], "page_ids": [first], "delta": 180}
    ).json()
    pdf = pikepdf.open(io.BytesIO(client.get(f"/api/notebooks/{nb['id']}/pdf").content))
    assert len(pdf.pages) == 4
    assert [int(p.obj.get("/Rotate", 0)) for p in pdf.pages] == [180, 0, 0, 0]


def test_range_requests(client, tmp_path: Path):
    nb = new_notebook(client, tmp_path, pages=20)
    url = f"/api/notebooks/{nb['id']}/pdf"
    full = client.get(url)
    assert full.headers.get("accept-ranges") == "bytes"
    r = client.get(url, headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert r.content == full.content[:100]
    assert r.headers["content-range"].startswith("bytes 0-99/")


def test_pdf_cache_is_content_addressed(client, tmp_path: Path, data_dir: Path):
    nb = new_notebook(client, tmp_path, pages=3)
    etag1 = client.get(f"/api/notebooks/{nb['id']}/pdf").headers["etag"]
    etag2 = client.get(f"/api/notebooks/{nb['id']}/pdf").headers["etag"]
    assert etag1 == etag2
    client.patch(f"/api/nodes/{nb['id']}", json={"name": "Renamed"})
    etag3 = client.get(f"/api/notebooks/{nb['id']}/pdf").headers["etag"]
    assert etag3 != etag1
    assert len(list((data_dir / "cache" / "pdf").glob("*.pdf"))) == 2


def test_thumbnails(client, tmp_path: Path):
    src = upload(client, make_pdf(tmp_path / "t.pdf", pages=2, rotate={1: 90}))
    r = client.get(f"/api/thumbs/{src['id']}/0", params={"w": 150})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/webp"
    assert "immutable" in r.headers["cache-control"]
    img = Image.open(io.BytesIO(r.content))
    assert img.size == (200, 267)  # snapped to the 200px size, 300x400 aspect
    rotated = Image.open(io.BytesIO(client.get(f"/api/thumbs/{src['id']}/1", params={"w": 400}).content))
    assert rotated.size == (400, 300)  # the page's own /Rotate applied exactly once
    assert client.get(f"/api/thumbs/{src['id']}/5").status_code == 404
