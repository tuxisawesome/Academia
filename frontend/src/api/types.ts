export type NodeKind = "folder" | "notebook" | "bookmark";

export type FolderColor =
  | "oxblood"
  | "terracotta"
  | "ochre"
  | "olive"
  | "forest"
  | "teal"
  | "slate"
  | "navy"
  | "plum"
  | "graphite";

export interface Prefs {
  theme: "system" | "light" | "dark";
  view: "grid" | "list";
  sort: { key: SortKey; dir: "asc" | "desc" };
  reader: { layout: "auto" | "single" | "double"; cover_alone: boolean };
}

export type SortKey = "name" | "modified" | "type" | "pages";

export interface User {
  id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
  must_change_password: boolean;
  disabled: boolean;
  created_at: string;
  last_login_at: string | null;
  prefs: Prefs;
}

export interface AdminUser extends Omit<User, "prefs"> {
  storage_bytes: number;
  notebook_count: number;
}

/** A page of a notebook, pointing at page `index` of an uploaded source PDF. */
export interface PageRef {
  id: string;
  source_id: string;
  index: number;
  rotation: number;
  /** Display size in PDF points, after the page's own /Rotate (not our extra rotation). */
  width: number;
  height: number;
}

export interface BookmarkPage extends PageRef {
  /** 1-based page number within the notebook. */
  number: number;
}

export interface LibraryNode {
  id: string;
  kind: NodeKind;
  name: string;
  color: FolderColor | null;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  trashed_at: string | null;
  // folder
  child_count?: number;
  // notebook + bookmark
  page_count?: number;
  cover?: PageRef | null;
  rev?: number;
  // bookmark
  notebook_id?: string | null;
  notebook_name?: string | null;
  available?: boolean;
  segments?: [number, number][];
  label?: string;
  // search / pickers
  location?: string;
  // trash
  item_count?: number;
  original_location?: string;
}

export interface PathEntry {
  id: string;
  name: string;
  kind: NodeKind;
  color: FolderColor | null;
}

export interface FolderListing {
  folder: LibraryNode | null;
  path: PathEntry[];
  items: LibraryNode[];
}

export interface TreeFolder {
  id: string;
  parent_id: string | null;
  name: string;
  color: FolderColor | null;
}

export interface NotebookBookmark {
  id: string;
  name: string;
  parent_id: string | null;
  rev: number;
  page_ids: string[];
  segments: [number, number][];
  label: string;
  first_position: number | null;
}

export interface NotebookDetail extends LibraryNode {
  rev: number;
  page_count: number;
  path: PathEntry[];
  pages: PageRef[];
  bookmarks: NotebookBookmark[];
  deleted_batch?: string;
  inserted_page_ids?: string[];
}

export interface BookmarkDetail extends LibraryNode {
  rev: number;
  path: PathEntry[];
  notebook: { id: string; name: string; rev: number; page_count: number; trashed: boolean };
  available: boolean;
  page_ids: string[];
  pages: BookmarkPage[];
  segments: [number, number][];
  label: string;
}

export interface UploadedSource {
  id: string;
  filename: string;
  page_count: number;
  byte_size: number;
  pages: { index: number; width: number; height: number }[];
}

export interface ExportJob {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  total: number;
  message: string;
  error: string | null;
  params: { embed_bookmarks?: boolean; bookmark_pdfs?: boolean };
  size: number | null;
  created_at: string;
  finished_at: string | null;
  expires_at: string | null;
}

export interface Progress {
  page_id: string | null;
  page_index: number;
  updated_at: string | null;
}

export interface PinnedFolder {
  id: string;
  name: string;
  color: FolderColor | null;
  parent_id: string | null;
  location: string;
}

export interface ContentMatch extends PageRef {
  /** 1-based page number in the notebook. */
  number: number;
  /** Page to open in the reader (for bookmarks: its place within the bookmark). */
  open_page: number;
}

export interface ContentResult extends LibraryNode {
  location: string;
  match_count: number;
  matches: ContentMatch[];
}

export interface SearchResults {
  query: string;
  scope: { id: string; name: string } | null;
  files: LibraryNode[];
  contents: ContentResult[];
}
