import { QueryCache, QueryClient, useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./client";
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
      if (error instanceof ApiError) {
        if (error.status === 401) queryClient.setQueryData(["me"], null);
        if (error.code === "password_change_required") void queryClient.invalidateQueries({ queryKey: ["me"] });
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

export function useNotebook(id: string | null | undefined) {
  return useQuery({
    queryKey: ["notebook", id],
    queryFn: () => api<NotebookDetail>(`/notebooks/${id}`),
    enabled: !!id,
  });
}

export function useBookmark(id: string | null | undefined) {
  return useQuery({
    queryKey: ["bookmark", id],
    queryFn: () => api<BookmarkDetail>(`/bookmarks/${id}`),
    enabled: !!id,
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
