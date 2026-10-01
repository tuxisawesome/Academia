import { QueryCache, QueryClient, useQuery, type Query } from "@tanstack/react-query";
import { api, ApiError, setSessionEndedHandler } from "./client";
import type {
  AdminUser,
  BookmarkDetail,
  ExportJob,
  FolderListing,
  LibraryNode,
  NotebookDetail,
  PinnedFolder,
  Progress,
  SearchResults,
  TreeFolder,
  User,
} from "./types";

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      // A 401 is handled for every request in api() (see setSessionEndedHandler below).
      if (error instanceof ApiError && error.code === "password_change_required") {
        void queryClient.invalidateQueries({ queryKey: ["me"] });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => {
        if (error instanceof ApiError && (error.status === 0 || error.status >= 500)) return count < 2;
        return false;
      },
    },
  },
});

// Any request that finds the session gone signs the tab out (RequireAuth then shows the sign-in page).
setSessionEndedHandler(() => queryClient.setQueryData(["me"], null));

const sessionEndListeners = new Set<() => void>();

/** Runs `listener` whenever the signed-in user's session ends in this tab (see below). */
export function onSessionEnd(listener: () => void): void {
  sessionEndListeners.add(listener);
}

let signedInAs: string | null = null;
let lastEndedSession: string | null = null;

/** The id of the user whose session most recently ended in this tab, if any. */
export function endedSessionUser(): string | null {
  return lastEndedSession;
}

// Everything cached belongs to the signed-in user. When ["me"] changes to nobody (sign-out, or a
// session the server ended) or to someone else, drop it all so the next user never sees it. The
// ["me"] query itself is kept: long-lived observers such as ThemeSync stay attached to it.
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== "updated" || event.action.type !== "success" || event.query.queryKey[0] !== "me") return;
  const id = (event.query.state.data as User | null | undefined)?.id ?? null;
  if (id === signedInAs) return;
  const previous = signedInAs;
  signedInAs = id;
  if (previous === null) return;
  lastEndedSession = previous;
  const others = { predicate: (query: Query) => query.queryKey[0] !== "me" };
  // Signed out: the signed-in pages unmount, so their queries can go. Another user signed in
  // elsewhere: reset the queries still on screen, which refetches them.
  if (id === null) queryClient.removeQueries(others);
  else void queryClient.resetQueries(others);
  queryClient.getMutationCache().clear();
  for (const listener of sessionEndListeners) listener();
});

export const LIBRARY_KEYS = ["nodes", "tree", "trash", "search", "notebooks", "node", "bookmark", "notebook", "pins"];

export function invalidateLibrary(): Promise<void> {
  return Promise.all(LIBRARY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] }))).then(
    () => undefined,
  );
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api<User>("/auth/me");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useFolder(parentId: string | null) {
  return useQuery({
    queryKey: ["nodes", parentId ?? "root"],
    queryFn: () => api<FolderListing>("/nodes", { query: { parent: parentId } }),
  });
}

export function useTree() {
  return useQuery({ queryKey: ["tree"], queryFn: () => api<TreeFolder[]>("/tree") });
}

export function useNode(id: string | null | undefined) {
  return useQuery({
    queryKey: ["node", id],
    queryFn: () => api<LibraryNode & { path: FolderListing["path"] }>(`/nodes/${id}`),
    enabled: !!id,
  });
}

/** `staleTime: 0` makes a page refetch the data whenever it opens, even if a cached copy is recent. */
interface DetailOptions {
  staleTime?: number;
}

export function useNotebook(id: string | null | undefined, options: DetailOptions = {}) {
  return useQuery({
    queryKey: ["notebook", id],
    queryFn: () => api<NotebookDetail>(`/notebooks/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useBookmark(id: string | null | undefined, options: DetailOptions = {}) {
  return useQuery({
    queryKey: ["bookmark", id],
    queryFn: () => api<BookmarkDetail>(`/bookmarks/${id}`),
    enabled: !!id,
    ...options,
  });
}

export function useAllNotebooks(enabled = true) {
  return useQuery({ queryKey: ["notebooks"], queryFn: () => api<LibraryNode[]>("/notebooks"), enabled });
}

export function useTrash() {
  return useQuery({ queryKey: ["trash"], queryFn: () => api<LibraryNode[]>("/trash") });
}

export function useSearch(q: string, folderId: string | null) {
  return useQuery({
    queryKey: ["search", q, folderId ?? "root"],
    queryFn: () => api<SearchResults>("/search", { query: { q, in: folderId } }),
    enabled: q.trim().length > 0,
    placeholderData: (previous) => previous,
  });
}

export function usePins() {
  return useQuery({ queryKey: ["pins"], queryFn: () => api<PinnedFolder[]>("/pins"), staleTime: 60_000 });
}

export function useProgress(nodeId: string | undefined) {
  return useQuery({
    queryKey: ["progress", nodeId],
    queryFn: () => api<Progress>(`/progress/${nodeId}`),
    enabled: !!nodeId,
    staleTime: 0,
    // The reader opens at the first value it sees: never one cached from an earlier visit.
    gcTime: 0,
  });
}

export function useExports() {
  return useQuery({
    queryKey: ["exports"],
    queryFn: () => api<ExportJob[]>("/exports"),
    refetchInterval: (query) => {
      const jobs = query.state.data;
      return jobs?.some((j) => j.status === "queued" || j.status === "running") ? 1000 : false;
    },
  });
}

export function useAdminUsers() {
  return useQuery({ queryKey: ["admin", "users"], queryFn: () => api<AdminUser[]>("/admin/users") });
}
