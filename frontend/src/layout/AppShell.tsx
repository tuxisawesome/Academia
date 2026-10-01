import { useCallback, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate, useSearchParams } from "react-router";
import { LogOut, Menu as MenuIcon, Monitor, Moon, Search, Settings, Sun, Trash2, Users, X } from "lucide-react";
import { logout, updatePrefs } from "../api/actions";
import { useMe, useTree } from "../api/queries";
import type { Prefs } from "../api/types";
import { Wordmark } from "../components/Glyphs";
import { MenuButton, type MenuEntry } from "../components/Menu";
import { useIsNarrow } from "../lib/hooks";
import { isImeKey } from "../lib/keys";
import { filtersFromParams, hasFilters, withFilters } from "../lib/searchFilters";
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
  const urlQuery = onSearchPage ? (params.get("q") ?? "") : "";
  const [value, setValue] = useState(urlQuery);
  // The query the box last navigated to (or showed), to tell its own navigations from Back/Forward.
  const sent = useRef(urlQuery);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!onSearchPage) {
      sent.current = "";
      setValue("");
    } else if (urlQuery !== sent.current) {
      sent.current = urlQuery;
      setValue(urlQuery);
    }
  }, [onSearchPage, urlQuery]);

  // Read when the typing pause ends: the box's own navigation to /search may still be rendering
  // when the timer was set, and that search must then replace, not push, the results page.
  const onSearchPageNow = useRef(onSearchPage);
  useEffect(() => {
    onSearchPageNow.current = onSearchPage;
    // A search still waiting for the typing pause must not fire after the user went to another page.
    if (!onSearchPage) clearTimeout(timer.current);
  }, [onSearchPage, location.pathname]);

  // The tag filters set on the results page apply to a new search there too. Read when the
  // typing pause ends, like onSearchPageNow: a filter may have been chosen meanwhile.
  const filters = onSearchPage ? filtersFromParams(params) : null;
  const filtersNow = useRef(filters);
  useEffect(() => {
    filtersNow.current = filters;
  });

  const go = (q: string, replace: boolean) => {
    clearTimeout(timer.current);
    sent.current = q;
    let query = new URLSearchParams({ q });
    if (scope) query.set("in", scope.id);
    if (filtersNow.current) query = withFilters(query, filtersNow.current);
    navigate(`/search?${query}`, { replace });
  };

  useEffect(() => {
    const q = value.trim();
    if (!q || q === sent.current) return;
    timer.current = setTimeout(() => go(q, onSearchPageNow.current), 300);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const label = scope ? `Search “${scope.name}”` : "Search your library";
  return (
    <form
      className="search-box"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        // With filters set, an empty search lists every page they match.
        if (value.trim() || (filters && hasFilters(filters))) go(value.trim(), onSearchPage);
      }}
    >
      <Search aria-hidden="true" />
      <input
        type="search"
        placeholder={label}
        aria-label={label}
        maxLength={200}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !isImeKey(e.nativeEvent)) {
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
  const openButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);

  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const closeDrawer = useCallback(() => {
    // Give focus back to the hamburger before the drawer becomes inert and drops it.
    if (sidebar.current?.contains(document.activeElement)) openButton.current?.focus();
    setDrawerOpen(false);
  }, []);

  // The open drawer takes focus and closes on Escape (unless a menu or dialog in it handled Escape).
  useEffect(() => {
    if (!narrow || !drawerOpen) return;
    closeButton.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeDrawer();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [narrow, drawerOpen, closeDrawer]);

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
        try {
          await logout();
          navigate("/login", { replace: true });
        } catch (err) {
          toastError(err);
        }
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
          <button ref={openButton} className="icon-btn" aria-label="Open navigation" onClick={() => setDrawerOpen(true)}>
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

      {/* Off-screen while the narrow layout's drawer is closed: keep it out of the Tab order too. */}
      <aside ref={sidebar} className="app-sidebar" aria-label="Library navigation" inert={narrow && !drawerOpen}>
        {narrow && (
          <div className="drawer-head">
            <Wordmark />
            <button ref={closeButton} className="icon-btn" aria-label="Close navigation" onClick={closeDrawer}>
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
      {narrow && drawerOpen && <div className="drawer-scrim" onClick={closeDrawer} />}

      <main className="main" id="main">
        <Outlet />
      </main>
    </div>
  );
}

