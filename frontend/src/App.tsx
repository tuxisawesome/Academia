import { QueryClientProvider } from "@tanstack/react-query";
import { Tooltip } from "radix-ui";
import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { queryClient, useMe } from "./api/queries";
import { ConnectionGuard, UpdateBanner } from "./components/ConnectionGuard";
import { DialogHost } from "./components/DialogHost";
import { Toaster } from "./components/Toaster";
import { UploadTray } from "./components/UploadTray";
import { UsersAdminPage } from "./features/admin/UsersAdminPage";
import { ChangePasswordPage } from "./features/auth/ChangePasswordPage";
import { LoginPage } from "./features/auth/LoginPage";
import { BookmarkEditorPage } from "./features/bookmark/BookmarkEditorPage";
import { ExplorerPage } from "./features/explorer/ExplorerPage";
import { SearchPage } from "./features/explorer/SearchPage";
import { TrashPage } from "./features/explorer/TrashPage";
import { NotebookPage } from "./features/notebook/NotebookPage";
import { UploadPage } from "./features/notebook/UploadPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { AppShell } from "./layout/AppShell";
import { applyTheme } from "./lib/theme";

const ReaderPage = lazy(() => import("./features/reader/ReaderPage"));

function Splash() {
  return (
    <div className="splash">
      <div className="spinner lg" />
    </div>
  );
}

function RequireAuth({ children, allowPasswordChange = false }: { children: ReactNode; allowPasswordChange?: boolean }) {
  const { data: me, isLoading, isError } = useMe();
  const location = useLocation();
  if (isLoading) return <Splash />;
  if (isError && me === undefined) return <Splash />;
  if (!me) {
    const next = location.pathname + location.search;
    return <Navigate to={`/login${next && next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`} replace />;
  }
  if (me.must_change_password && !allowPasswordChange) return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

function ThemeSync() {
  const { data: me } = useMe();
  const theme = me?.prefs.theme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
  return null;
}

function NotFound() {
  return (
    <div className="center-fill">
      <div className="empty">
        <h3>Not found</h3>
        <p>This page doesn't exist, or the item was moved to the Trash.</p>
        <a href="/">Go to your library</a>
      </div>
    </div>
  );
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    path: "/change-password",
    element: (
      <RequireAuth allowPasswordChange>
        <ChangePasswordPage />
      </RequireAuth>
    ),
  },
  {
    path: "/read/:kind/:id",
    element: (
      <RequireAuth>
        <Suspense fallback={<Splash />}>
          <ReaderPage />
        </Suspense>
      </RequireAuth>
    ),
  },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <ExplorerPage /> },
      { path: "f/:folderId", element: <ExplorerPage /> },
      { path: "trash", element: <TrashPage /> },
      { path: "search", element: <SearchPage /> },
      { path: "n/:id", element: <NotebookPage /> },
      { path: "n/:id/upload", element: <UploadPage /> },
      { path: "b/new", element: <BookmarkEditorPage /> },
      { path: "b/:id/edit", element: <BookmarkEditorPage /> },
      { path: "settings/:section?", element: <SettingsPage /> },
      { path: "admin/users", element: <UsersAdminPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Tooltip.Provider delayDuration={500}>
        <ThemeSync />
        <RouterProvider router={router} />
        <DialogHost />
        <Toaster />
        <UploadTray />
        <UpdateBanner />
        <ConnectionGuard />
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}
