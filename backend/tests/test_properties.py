"""Random sequences of page operations must keep positions dense and bookmarks consistent."""

from __future__ import annotations

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from sqlalchemy import select

from academia.db import read_session, write_session
from academia.models import Page, Source, SourcePage, new_id
from academia.services import bookmarks as bms
from academia.services import pages as ps
from academia.services.common import segments
from conftest import add_user

OPS = st.lists(
    st.one_of(
        st.tuples(st.just("insert"), st.integers(0, 2), st.integers(0, 50), st.booleans()),
        st.tuples(st.just("reorder"), st.randoms(use_true_random=False)),
        st.tuples(st.just("delete"), st.randoms(use_true_random=False)),
        st.tuples(st.just("undelete"), st.integers(0, 10)),
        st.tuples(st.just("rotate"), st.randoms(use_true_random=False)),
        st.tuples(st.just("bookmark"), st.randoms(use_true_random=False)),
    ),
    max_size=25,
)


@settings(max_examples=60, deadline=None, suppress_health_check=[HealthCheck.function_scoped_fixture])
@given(ops=OPS)
def test_page_operations_model(data_dir, ops):  # noqa: ANN001
    uid = add_user(f"u{new_id()[:8]}")
    with write_session() as db:
        sources = []
        for n in (1, 2, 3):
            src = Source(owner_id=uid, sha256=new_id(), byte_size=1, page_count=n)
            db.add(src)
            db.flush()
            db.add_all(SourcePage(source_id=src.id, idx=i, width_pt=10, height_pt=10) for i in range(n))
            sources.append(src.id)
        nb = ps.create_notebook(db, uid, None, "N", sources[1])
        nb_id = nb.id
    with write_session() as db:
        initial = ps.live_page_ids(db, nb_id)
        bm = bms.create_bookmark(db, uid, None, "B", nb_id, initial[:1])
        bm_id = bm.id

    # Deleted pages keep their place in the full order until they are restored.
    full: list[str] = list(initial)
    hidden: set[str] = set()
    model: list[str] = list(initial)
    marked: set[str] = {initial[0]}
    deleted: dict[str, list[str]] = {}
    batches: list[str] = []

    for op in ops:
        with write_session() as db:
            kind = op[0]
            if kind == "insert":
                _, src_i, pos, add = op
                at = "end" if not model else ("after" if pos % 3 else "start")
                after = model[pos % len(model)] if model and at == "after" else None
                touched = []
                if add:
                    touched = [bm_id]
                new_ids = ps.insert_source(
                    db, uid, nb_id, None, sources[src_i], at=at, after_page_id=after, add_to_bookmarks=touched
                )
                k = 0 if at == "start" else (full.index(after) + 1 if after else len(full))
                full[k:k] = new_ids
                if add:
                    marked.update(new_ids)
            elif kind == "reorder":
                rnd = op[1]
                perm = list(model)
                rnd.shuffle(perm)
                ps.reorder(db, uid, nb_id, None, perm)
                following: dict[str | None, list[str]] = {}
                prev = None
                for p in full:
                    if p in hidden:
                        following.setdefault(prev, []).append(p)
                    else:
                        prev = p
                full = following.get(None, []) + [q for p in perm for q in [p, *following.get(p, [])]]
            elif kind == "delete" and model:
                rnd = op[1]
                chosen = rnd.sample(model, rnd.randint(1, len(model)))
                batch = ps.delete_pages(db, uid, nb_id, None, chosen)
                deleted[batch] = chosen
                batches.append(batch)
                hidden.update(chosen)
            elif kind == "undelete" and batches:
                batch = batches.pop(op[1] % len(batches))
                ps.undelete(db, uid, nb_id, batch)
                hidden.difference_update(deleted.pop(batch))
            elif kind == "rotate" and model:
                rnd = op[1]
                ps.rotate(db, uid, nb_id, None, rnd.sample(model, 1), 90)
            elif kind == "bookmark" and model:
                rnd = op[1]
                chosen = rnd.sample(model, rnd.randint(0, len(model)))
                bms.set_bookmark_pages(db, uid, bm_id, chosen)
                live = set(model)
                marked = {p for p in marked if p not in live} | set(chosen)
            model = [p for p in full if p not in hidden]

        with read_session() as db:
            rows = db.execute(
                select(Page.id, Page.position)
                .where(Page.notebook_id == nb_id, Page.deleted_at.is_(None))
                .order_by(Page.position)
            ).all()
            assert [r.id for r in rows] == model
            assert [r.position for r in rows] == list(range(len(model)))
            detail = bms.bookmark_detail(db, uid, bm_id)
            expected = segments(sorted(model.index(p) for p in marked if p in model))
            assert detail["segments"] == expected
            nb_detail = ps.notebook_detail(db, uid, nb_id)
            assert nb_detail["page_count"] == len(model)
