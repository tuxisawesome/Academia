import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate, useSearchParams } from "react-router";
import { LogOut, Menu as MenuIcon, Monitor, Moon, Search, Settings, Sun, Trash2, Users, X } from "lucide-react";
import { logout, updatePrefs } from "../api/actions";
import { useMe, useTree } from "../api/queries";
import type { Prefs } from "../api/types";
import { Wordmark } from "../components/Glyphs";
import { MenuButton, type MenuEntry } from "../components/Menu";
import { useIsNarrow } from "../lib/hooks";
import { toastError } from "../state/toasts";
import { FolderTree } from "./FolderTree";
import { PinnedFolders } from "./PinnedFolders";

/** The folder the search box applies to: the open folder, or the scope of the current search. */
function useSearchScope(): { id: string; name: string } | null {
  const folderMatch = useMatch("/f/:folderId");
  const location = useLocation();
  const [params] = useSearchParams();
  const { data: folders } = useTree();
  const id = folderMatch?.params.folderId ?? (location.pathname === "/search" ? params.get("in") : null);
  if (!id) return null;
  const folder = folders?.find((f) => f.id === id);
  return { id, name: folder?.name ?? "this folder" };
}

function SearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const scope = useSearchScope();
  const onSearchPage = location.pathname === "/search";
  const [value, setValue] = useState(onSearchPage ? (params.get("q") ?? "") : "");

  useEffect(() => {
    if (!onSearchPage) setValue("");
  }, [onSearchPage]);

  const go = (q: string, replace: boolean) => {
    const query = new URLSearchParams({ q });
    if (scope) query.set("in", scope.id);
    navigate(`/search?${query}`, { replace });
  };

  useEffect(() => {
    if (!value.trim()) return;
    const t = setTimeout(() => go(value.trim(), onSearchPage), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const label = scope ? `Search “${scope.name}”` : "Search your library";
  return (
    <form
      className="search-box"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) go(value.trim(), onSearchPage);
      }}
    >
      <Search aria-hidden="true" />
      <input
        type="search"
        placeholder={label}
        aria-label={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setValue("");
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </form>
  );
}

const THEME_ICON = { system: <Monitor />, light: <Sun />, dark: <Moon /> };

export function AppShell() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const narrow = useIsNarrow();
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  if (!me) return null;
  const theme = me.prefs.theme;
  const setTheme = (t: Prefs["theme"]) => updatePrefs({ theme: t }).catch(toastError);

  const themeEntries: MenuEntry[] = [
    { type: "label", label: "Appearance" },
    { label: "System", checked: theme === "system", onSelect: () => setTheme("system") },
    { label: "Light", checked: theme === "light", onSelect: () => setTheme("light") },
    { label: "Dark", checked: theme === "dark", onSelect: () => setTheme("dark") },
  ];

  const userEntries: MenuEntry[] = [
    { type: "label", label: me.display_name || me.username },
    { label: "Settings", icon: <Settings />, onSelect: () => navigate("/settings") },
    ...(me.is_admin ? [{ label: "Manage users", icon: <Users />, onSelect: () => navigate("/admin/users") }] : []),
    { type: "sep" },
    {
      label: "Sign out",
      icon: <LogOut />,
      onSelect: async () => {
        await logout();
        navigate("/login", { replace: true });
      },
    },
  ];

  const initials = (me.display_name || me.username)
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={`shell ${drawerOpen ? "drawer-open" : ""}`}>
      <header className="topbar">
        {narrow && (
          <button className="icon-btn" aria-label="Open navigation" onClick={() => setDrawerOpen(true)}>
            <MenuIcon />
          </button>
        )}
        <Link to="/" className="brand" aria-label="Academia — library">
          <Wordmark />
        </Link>
        <SearchBox />
        <div className="topbar-actions">
          <MenuButton entries={themeEntries} label="Theme">
            {THEME_ICON[theme]}
          </MenuButton>
          <MenuButton entries={userEntries} label="Account" className="avatar-btn">
            <span className="avatar" aria-hidden="true">
              {initials}
            </span>
          </MenuButton>
        </div>
      </header>

      <aside className="app-sidebar" aria-label="Library navigation">
        {narrow && (
          <div className="drawer-head">
            <Wordmark />
            <button className="icon-btn" aria-label="Close navigation" onClick={() => setDrawerOpen(false)}>
              <X />
            </button>
          </div>
        )}
        <nav className="sidebar-scroll">
          <PinnedFolders />
          <FolderTree />
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/trash" className="side-link">
            <Trash2 /> Trash
          </NavLink>
          <NavLink to="/settings" className="side-link">
            <Settings /> Settings
          </NavLink>
          {me.is_admin && (
            <NavLink to="/admin/users" className="side-link">
              <Users /> Users
            </NavLink>
          )}
        </div>
      </aside>
      {narrow && drawerOpen && <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} />}

      <main className="main" id="main">
        <Outlet />
      </main>
    </div>
  );
}

