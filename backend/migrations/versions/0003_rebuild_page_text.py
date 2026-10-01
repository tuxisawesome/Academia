"""rebuild page text index

Page text is now indexed in a normalised form (see ``search.index_text``), so the index is
emptied and every source's text layer is extracted again by the startup backfill. The tables
are recreated rather than just emptied: databases migrated by an earlier revision 0002 have
``page_texts`` with recognised-handwriting columns and a ``page_text_vocab`` table, and are
brought to the current shape here (the recognised text is not kept).

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-01 12:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS page_texts_au")
    op.execute("DROP TRIGGER IF EXISTS page_texts_ad")
    op.execute("DROP TRIGGER IF EXISTS page_texts_ai")
    op.execute("DROP TABLE IF EXISTS page_text_vocab")
    op.execute("DROP TABLE IF EXISTS page_text_fts")
    op.drop_table("page_texts")
    op.create_table(
        "page_texts",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("source_id", sa.String(length=36), nullable=False),
        sa.Column("idx", sa.Integer(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["source_id"], ["sources.id"], name=op.f("fk_page_texts_source_id_sources"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_page_texts")),
        sa.UniqueConstraint("source_id", "idx", name=op.f("uq_page_texts_source_id_idx")),
    )
    # Full-text index over each page's text layer, kept in sync by triggers.
    op.execute("CREATE VIRTUAL TABLE page_text_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')")
    op.execute(
        """
        CREATE TRIGGER page_texts_ai AFTER INSERT ON page_texts BEGIN
            INSERT INTO page_text_fts(rowid, body) VALUES (new.id, new.body);
        END
        """
    )
    op.execute(
        """
        CREATE TRIGGER page_texts_ad AFTER DELETE ON page_texts BEGIN
            DELETE FROM page_text_fts WHERE rowid = old.id;
        END
        """
    )
    op.execute(
        """
        CREATE TRIGGER page_texts_au AFTER UPDATE OF body ON page_texts BEGIN
            DELETE FROM page_text_fts WHERE rowid = old.id;
            INSERT INTO page_text_fts(rowid, body) VALUES (new.id, new.body);
        END
        """
    )


def downgrade() -> None:
    # The tables keep the shape revision 0002 creates; the extracted text is simply re-read.
    op.execute("DELETE FROM page_texts")
