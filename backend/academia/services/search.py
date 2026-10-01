"""Library search: item names ("Files") and page text ("Contents").

The search is scoped to a folder and everything below it (or the whole library).
Page text comes from the uploaded PDFs' own text layers. Results report *which pages*
match; the text itself is never returned.
"""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from ..models import BOOKMARK, FOLDER, NOTEBOOK, Node, Page, SourcePage
from .common import chunks, descendant_ids, owned_folder_or_root
from .describe import bookmark_members, describe_nodes, page_json

MAX_RESULTS = 200
MAX_PAGES_PER_RESULT = 60

_word_re = re.compile(r"\w+", re.UNICODE)
_phrase_re = re.compile(r'"([^"]+)"')


def normalize(value: str) -> str:
    """Lowercase without diacritics — the same folding the FTS index applies."""
    decomposed = unicodedata.normalize("NFKD", value or "")
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).casefold()


def parse_query(query: str) -> tuple[list[str], list[list[str]]]:
    """Split a query into loose words and "quoted phrases" (each a list of words)."""
    q = normalize(query)
    phrases = [_word_re.findall(p) for p in _phrase_re.findall(q)]
    phrases = [p for p in phrases if p]
    rest = _phrase_re.sub(" ", q)
    words = list(dict.fromkeys(_word_re.findall(rest)))
    if len(words) > 1:
        # Stray single letters are dropped, but numbers ("lecture 7") narrow the search.
        words = [w for w in words if len(w) > 1 or w.isdigit()] or words
    return words, phrases


def _quote(term: str) -> str:
    return '"' + term.replace('"', '""') + '"'


def _word_clause(word: str) -> str:
    """A word matches itself or, from three letters on, any word it starts."""
    return _quote(word) + ("*" if len(word) >= 3 else "")


def matching_pages(db: Session, user_id: str, query: str) -> set[tuple[str, int]]:
    """(source_id, page index) of the user's pages whose text contains every word and phrase."""
    words, phrases = parse_query(query)
    if not words and not phrases:
        return set()
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


def search(db: Session, user_id: str, query: str, folder_id: str | None = None) -> dict[str, Any]:
    folder = owned_folder_or_root(db, user_id, folder_id)
    q = " ".join((query or "").split())
    scope = {"id": folder.id, "name": folder.name} if folder else None
    if not q:
        return {"query": q, "scope": scope, "files": [], "contents": []}

    nodes = _scope_nodes(db, user_id, folder)
    location = _locations(db, user_id)

    # Files: every query word appears in the name (case- and accent-insensitive).
    name_words = _word_re.findall(normalize(q)) or [normalize(q)]
    file_hits = [n for n in nodes if all(w in normalize(n.name) for w in name_words)]
    file_hits.sort(key=lambda n: (n.kind != FOLDER, normalize(n.name)))
    files = describe_nodes(db, file_hits[:MAX_RESULTS])
    for item in files:
        item["location"] = location(item["parent_id"])

    # Contents: pages whose text matches, grouped by notebook / bookmark in scope.
    matched = matching_pages(db, user_id, q)
    notebooks = [n for n in nodes if n.kind == NOTEBOOK]
    bookmarks = [n for n in nodes if n.kind == BOOKMARK]
    hits: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if matched:
        source_ids = list({sid for sid, _ in matched})
        nb_ids = {n.id for n in notebooks}
        for part in chunks(source_ids):
            rows = db.execute(
                select(Page, SourcePage)
                .outerjoin(SourcePage, (SourcePage.source_id == Page.source_id) & (SourcePage.idx == Page.source_index))
                .where(Page.source_id.in_(part), Page.deleted_at.is_(None))
            ).all()
            for page, sp in rows:
                key = (page.source_id, page.source_index)
                if page.notebook_id in nb_ids and key in matched:
                    number = (page.position or 0) + 1
                    hits[page.notebook_id].append({**page_json(page, sp), "number": number, "open_page": number})
        members = bookmark_members(db, [b.id for b in bookmarks])
        for bm in bookmarks:
            # open_page: the page's place within the bookmark (what the bookmark reader shows).
            for k, (page, sp) in enumerate(members.get(bm.id, []), start=1):
                key = (page.source_id, page.source_index)
                if key in matched:
                    hits[bm.id].append({**page_json(page, sp), "number": (page.position or 0) + 1, "open_page": k})

    by_id = {n.id: n for n in nodes}
    ranked = sorted(
        hits,
        key=lambda nid: (-len(hits[nid]), normalize(by_id[nid].name)),
    )[:MAX_RESULTS]
    contents = describe_nodes(db, [by_id[i] for i in ranked])
    for item in contents:
        pages = sorted(hits[item["id"]], key=lambda m: m["number"])
        item["location"] = location(item["parent_id"])
        item["match_count"] = len(pages)
        item["matches"] = pages[:MAX_PAGES_PER_RESULT]

    return {"query": q, "scope": scope, "files": files, "contents": contents}
