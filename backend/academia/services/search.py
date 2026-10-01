"""Library search: item names ("Files") and page text ("Contents").

The search is scoped to a folder and everything below it (or the whole library).
Page text comes from the uploaded PDFs' own text layers. Results report *which pages*
match; the text itself is never returned.
"""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from collections.abc import Iterable, Sequence
from datetime import date
from typing import Any

from sqlalchemy import exists, select, text
from sqlalchemy.orm import Session

from ..models import BOOKMARK, FOLDER, NOTEBOOK, Bookmark, Node, Page, PageClass, SourcePage
from .common import chunks, descendant_ids, owned_class_ids, owned_folder_or_root
from .describe import bookmark_members, describe_nodes, page_class_ids, page_json

MAX_RESULTS = 200
MAX_PAGES_PER_RESULT = 60

_word_re = re.compile(r"\w+", re.UNICODE)
_phrase_re = re.compile(r'"([^"]+)"')


# Scripts written without spaces between words (Han, Hiragana, Katakana, Thai): each of
# their characters is indexed as a word of its own, so a word inside a run is found as the
# phrase of its characters.
_unspaced_re = re.compile("([\u0e00-\u0e7f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0003134f])")


def normalize(value: str) -> str:
    """Lowercase without diacritics, for matching names."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).casefold()


def _spaced(value: str) -> str:
    return _unspaced_re.sub(r" \1 ", value)


def index_text(value: str) -> str:
    """The form in which page text is indexed (query words get the same treatment).

    Compatibility characters are unified (ligatures, full-width letters, superscripts) and
    unspaced scripts are split into characters; the FTS tokenizer then folds case and Latin
    diacritics the same way for the text and for the query.
    """
    return _spaced(unicodedata.normalize("NFKC", value or ""))


def _words(value: str) -> list[str]:
    """Runs of word characters; combining marks (e.g. Thai vowel signs) stay in their word."""
    words: list[str] = []
    word = ""
    for ch in value:
        if ch.isalnum() or ch == "_" or unicodedata.category(ch).startswith("M"):
            word += ch
        elif word:
            words.append(word)
            word = ""
    if word:
        words.append(word)
    return words


def parse_query(query: str) -> tuple[list[str], list[list[str]]]:
    """Split a query into loose words and "quoted phrases" (each a list of words)."""
    q = unicodedata.normalize("NFKC", query or "")
    phrases = [_words(p) for p in _phrase_re.findall(q)]
    phrases = [p for p in phrases if p]
    rest = _phrase_re.sub(" ", q)
    words = list(dict.fromkeys(_words(rest)))
    if len(words) > 1:
        # Stray single letters are dropped, but numbers ("lecture 7") and characters of
        # unspaced scripts narrow the search.
        words = [w for w in words if len(w) > 1 or w.isdigit() or _unspaced_re.match(w)] or words
    return words, phrases


def _quote(term: str) -> str:
    return '"' + _spaced(term).replace('"', '""') + '"'


def _word_clause(word: str) -> str:
    """A word matches itself or, from three letters on, any word it starts."""
    return _quote(word) + ("*" if len(word) >= 3 else "")


def matching_pages(db: Session, user_id: str, query: str) -> set[tuple[str, int]]:
    """(source_id, page index) of the user's pages whose text contains every word and phrase."""
    words, phrases = parse_query(query)
    if not words and not phrases:
        return set()
    # Quoted terms go through the index's own tokenizer, which folds case and Latin diacritics.
    expr = " AND ".join([_word_clause(w) for w in words] + [_quote(" ".join(p)) for p in phrases])
    rows = db.execute(
        text(
            """
            SELECT pt.source_id, pt.idx
            FROM page_text_fts
            JOIN page_texts pt ON pt.id = page_text_fts.rowid
            JOIN sources s ON s.id = pt.source_id
            WHERE page_text_fts MATCH :expr AND s.owner_id = :uid
            """
        ),
        {"expr": expr, "uid": user_id},
    ).all()
    return {(r[0], r[1]) for r in rows}


def _scope_nodes(db: Session, user_id: str, folder: Node | None) -> list[Node]:
    if folder is None:
        return list(db.scalars(select(Node).where(Node.owner_id == user_id, Node.trashed_at.is_(None))))
    ids = [i for i in descendant_ids(db, [folder.id], live_only=True) if i != folder.id]
    nodes: list[Node] = []
    for part in chunks(ids):
        nodes.extend(db.scalars(select(Node).where(Node.id.in_(part), Node.trashed_at.is_(None))))
    return nodes


def _locations(db: Session, user_id: str):  # noqa: ANN202
    folders = {
        r.id: (r.name, r.parent_id)
        for r in db.execute(
            select(Node.id, Node.name, Node.parent_id).where(
                Node.owner_id == user_id, Node.kind == FOLDER, Node.trashed_at.is_(None)
            )
        )
    }

    def location(parent_id: str | None) -> str:
        parts: list[str] = []
        seen: set[str] = set()
        while parent_id and parent_id in folders and parent_id not in seen:
            seen.add(parent_id)
            name, parent_id = folders[parent_id]
            parts.append(name)
        return " / ".join(reversed(parts))

    return location


def tagged_pages(
    db: Session, user_id: str, class_ids: Sequence[str], date_from: date | None, date_to: date | None
) -> dict[str, str]:
    """Live pages (of notebooks outside the Trash) with any of the classes and a date in the
    range, mapped to their notebook. A page without a date never matches a date filter."""
    stmt = (
        select(Page.id, Page.notebook_id)
        .join(Node, Node.id == Page.notebook_id)
        .where(Node.owner_id == user_id, Node.trashed_at.is_(None), Page.deleted_at.is_(None))
    )
    if class_ids:
        stmt = stmt.where(exists().where(PageClass.page_id == Page.id, PageClass.class_id.in_(class_ids)))
    if date_from is not None:
        stmt = stmt.where(Page.tag_date >= date_from)
    if date_to is not None:
        stmt = stmt.where(Page.tag_date <= date_to)
    return {r.id: r.notebook_id for r in db.execute(stmt)}


def _live_pages(db: Session, column: Any, values: Iterable[str]) -> list[tuple[Page, SourcePage | None]]:
    out: list[tuple[Page, SourcePage | None]] = []
    for part in chunks(list(values)):
        rows = db.execute(
            select(Page, SourcePage)
            .outerjoin(SourcePage, (SourcePage.source_id == Page.source_id) & (SourcePage.idx == Page.source_index))
            .where(column.in_(part), Page.deleted_at.is_(None))
        ).all()
        out.extend((page, sp) for page, sp in rows)
    return out


def search(
    db: Session,
    user_id: str,
    query: str,
    folder_id: str | None = None,
    class_ids: Sequence[str] = (),
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict[str, Any]:
    """With tag filters (classes, a date range) only pages that match them count, and an
    empty query lists all of them."""
    folder = owned_folder_or_root(db, user_id, folder_id)
    classes = owned_class_ids(db, user_id, class_ids)
    q = " ".join((query or "").split())
    scope = {"id": folder.id, "name": folder.name} if folder else None
    filtered = bool(classes) or date_from is not None or date_to is not None
    filters = {
        "classes": classes,
        "from": date_from.isoformat() if date_from else None,
        "to": date_to.isoformat() if date_to else None,
    }
    if not q and not filtered:
        return {"query": q, "scope": scope, "filters": filters, "files": [], "contents": []}

    nodes = _scope_nodes(db, user_id, folder)
    location = _locations(db, user_id)
    matched = matching_pages(db, user_id, q) if q else set()
    tagged = tagged_pages(db, user_id, classes, date_from, date_to) if filtered else {}

    def is_hit(page: Page) -> bool:
        if q and (page.source_id, page.source_index) not in matched:
            return False
        return not filtered or page.id in tagged

    notebooks = [n for n in nodes if n.kind == NOTEBOOK]
    bookmarks = [n for n in nodes if n.kind == BOOKMARK]
    members: dict[str, list[tuple[Page, SourcePage | None]]] = {}
    if matched or tagged:
        # Bookmarks of a notebook in the Trash show nothing: their pages are only in the Trash.
        live_bm: set[str] = set()
        for part in chunks([b.id for b in bookmarks]):
            live_bm.update(
                db.scalars(
                    select(Bookmark.node_id)
                    .join(Node, Node.id == Bookmark.notebook_id)
                    .where(Bookmark.node_id.in_(part), Node.trashed_at.is_(None))
                )
            )
        members = bookmark_members(db, list(live_bm))

    # Files: every query word appears in the name (case- and accent-insensitive). With tag
    # filters, only notebooks and bookmarks that have a matching page.
    file_hits = list(nodes)
    if q:
        name_words = _word_re.findall(normalize(q)) or [normalize(q)]
        file_hits = [n for n in file_hits if all(w in normalize(n.name) for w in name_words)]
    if filtered:
        tagged_notebooks = set(tagged.values())
        file_hits = [
            n
            for n in file_hits
            if (n.kind == NOTEBOOK and n.id in tagged_notebooks)
            or (n.kind == BOOKMARK and any(p.id in tagged for p, _ in members.get(n.id, [])))
        ]
    file_hits.sort(key=lambda n: (n.kind != FOLDER, normalize(n.name)))
    files = describe_nodes(db, file_hits[:MAX_RESULTS])
    for item in files:
        item["location"] = location(item["parent_id"])

    # Contents: matching pages, grouped by notebook / bookmark in scope, each with the page
    # to open (for bookmarks its place within the bookmark: what the bookmark reader shows).
    hits: dict[str, list[tuple[Page, SourcePage | None, int]]] = defaultdict(list)
    nb_ids = {n.id for n in notebooks}
    candidates = _live_pages(db, Page.source_id, {sid for sid, _ in matched}) if q else _live_pages(db, Page.id, tagged)
    for page, sp in candidates:
        if page.notebook_id in nb_ids and is_hit(page):
            hits[page.notebook_id].append((page, sp, (page.position or 0) + 1))
    for bm in bookmarks:
        for k, (page, sp) in enumerate(members.get(bm.id, []), start=1):
            if is_hit(page):
                hits[bm.id].append((page, sp, k))

    by_id = {n.id: n for n in nodes}
    ranked = sorted(
        hits,
        key=lambda nid: (-len(hits[nid]), normalize(by_id[nid].name)),
    )[:MAX_RESULTS]
    shown = {nid: sorted(hits[nid], key=lambda h: h[0].position or 0)[:MAX_PAGES_PER_RESULT] for nid in ranked}
    class_ids_of = page_class_ids(db, [page.id for pages in shown.values() for page, _, _ in pages])
    contents = describe_nodes(db, [by_id[i] for i in ranked])
    for item in contents:
        item["location"] = location(item["parent_id"])
        item["match_count"] = len(hits[item["id"]])
        item["matches"] = [
            {**page_json(page, sp, class_ids_of), "number": (page.position or 0) + 1, "open_page": open_page}
            for page, sp, open_page in shown[item["id"]]
        ]

    return {"query": q, "scope": scope, "filters": filters, "files": files, "contents": contents}
