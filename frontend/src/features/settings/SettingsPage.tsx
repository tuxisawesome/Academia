import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import { Archive, Download, Info, LogOut, Palette, ScanText, UserRound } from "lucide-react";
import { logout, updatePrefs } from "../../api/actions";
import { api, downloadUrl, errorMessage } from "../../api/client";
import { queryClient, useExports, useMe } from "../../api/queries";
import type { ExportJob, Prefs, User } from "../../api/types";
import { APP_BUILD } from "../../state/connection";
import { formatBytes, formatDate } from "../../lib/format";
import { useDocumentTitle } from "../../lib/hooks";
import { toast, toastError } from "../../state/toasts";
import { PasswordForm } from "../auth/PasswordForm";
import { RecognitionSettings } from "../recognition/RecognitionSettings";

const SECTIONS = [
  { key: "appearance", label: "Appearance", icon: <Palette /> },
  { key: "account", label: "Account", icon: <UserRound /> },
  { key: "recognition", label: "Text recognition", icon: <ScanText /> },
  { key: "export", label: "Export", icon: <Archive /> },
  { key: "about", label: "About", icon: <Info /> },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export function SettingsPage() {
  const { section = "appearance" } = useParams();
  const current = (SECTIONS.find((s) => s.key === section)?.key ?? "appearance") as SectionKey;
  useDocumentTitle("Settings");
  return (
    <div className="page-scroll">
      <div className="page-pad settings">
        <div className="page-header">
          <h1>Settings</h1>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <NavLink key={s.key} to={`/settings/${s.key}`} className={() => `side-link ${current === s.key ? "active" : ""}`}>
                {s.icon} {s.label}
              </NavLink>
            ))}
          </nav>
          <div className="settings-body">
            {current === "appearance" && <AppearanceSettings />}
            {current === "account" && <AccountSettings />}
            {current === "recognition" && <RecognitionSettings />}
            {current === "export" && <ExportSettings />}
            {current === "about" && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="card settings-card">
      <h2>{title}</h2>
      {description && <p className="muted">{description}</p>}
      {children}
    </section>
  );
}

function AppearanceSettings() {
  const { data: me } = useMe();
  // Local copy so the controls respond immediately; the server copy follows.
  const [prefs, setPrefs] = useState<Prefs | null>(me?.prefs ?? null);
  useEffect(() => {
    if (me?.prefs) setPrefs(me.prefs);
  }, [me?.prefs]);
  if (!prefs) return null;
  const set = (patch: Partial<Prefs>) => {
    setPrefs({ ...prefs, ...patch });
    updatePrefs(patch).catch(toastError);
  };
  return (
    <>
      <Section title="Theme" description="Academia follows your device's light or dark setting unless you choose one here.">
        <div className="radio-cards">
          {(["system", "light", "dark"] as const).map((theme) => (
            <label key={theme} className="radio-card">
              <input type="radio" name="theme" checked={prefs.theme === theme} onChange={() => void set({ theme })} />
              {theme === "system" ? "Match device" : theme === "light" ? "Light" : "Dark"}
            </label>
          ))}
        </div>
      </Section>
      <Section title="Library" description="How folders are shown by default.">
        <div className="radio-cards">
          <label className="radio-card">
            <input type="radio" name="view" checked={prefs.view === "grid"} onChange={() => void set({ view: "grid" })} />
            Grid
          </label>
          <label className="radio-card">
            <input type="radio" name="view" checked={prefs.view === "list"} onChange={() => void set({ view: "list" })} />
            List
          </label>
        </div>
      </Section>
      <Section title="Reader" description="Two pages are shown side by side on wide screens; one at a time on phones.">
        <div className="radio-cards">
          {(
            [
              ["auto", "Automatic"],
              ["double", "Always two pages"],
              ["single", "Always one page"],
            ] as const
          ).map(([layout, label]) => (
            <label key={layout} className="radio-card">
              <input
                type="radio"
                name="layout"
                checked={prefs.reader.layout === layout}
                onChange={() => void set({ reader: { ...prefs.reader, layout } })}
              />
              {label}
            </label>
          ))}
        </div>
        <label className="check" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={prefs.reader.cover_alone}
            onChange={(e) => void set({ reader: { ...prefs.reader, cover_alone: e.target.checked } })}
          />
          <span>
            Show the first page on its own
            <small>Like a printed book: the cover, then pages 2–3, 4–5, …</small>
          </span>
        </label>
      </Section>
    </>
  );
}

function AccountSettings() {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(me?.display_name ?? "");
  const [saving, setSaving] = useState(false);
  if (!me) return null;
  return (
    <>
      <Section title="Profile">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSaving(true);
            try {
              const user = await api<User>("/me/profile", { method: "PATCH", json: { display_name: displayName } });
              queryClient.setQueryData(["me"], user);
              toast("Profile saved.");
            } catch (err) {
              toastError(err);
            } finally {
              setSaving(false);
            }
          }}
        >
          <div className="field">
            <label>Username</label>
            <input className="input" value={me.username} disabled />
          </div>
          <div className="field">
            <label htmlFor="display-name">Display name</label>
            <input
              id="display-name"
              className="input"
              value={displayName}
              maxLength={128}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" disabled={saving}>
            Save profile
          </button>
        </form>
      </Section>
      <Section title="Password">
        <div style={{ maxWidth: 420 }}>
          <PasswordForm submitLabel="Change password" />
        </div>
      </Section>
      <Section title="Sessions" description="Sign out everywhere else, for example after using a shared computer.">
        <div className="button-row">
          <button
            className="btn"
            onClick={async () => {
              try {
                await api("/auth/logout-others", { method: "POST" });
                toast("Signed out of all other sessions.");
              } catch (err) {
                toastError(err);
              }
            }}
          >
            Sign out other sessions
          </button>
          <button
            className="btn"
            onClick={async () => {
              await logout();
              navigate("/login", { replace: true });
            }}
          >
            <LogOut /> Sign out
          </button>
        </div>
      </Section>
    </>
  );
}

function jobStatus(job: ExportJob): string {
  if (job.status === "done") return `Ready · ${formatBytes(job.size ?? 0)}`;
  if (job.status === "failed") return job.error ?? "Failed";
  if (job.total) return `${job.progress} of ${job.total} PDFs`;
  return job.message || "Preparing…";
}

function ExportSettings() {
  const { data: jobs } = useExports();
  const [embed, setEmbed] = useState(true);
  const [bookmarkPdfs, setBookmarkPdfs] = useState(false);
  const [starting, setStarting] = useState(false);
  const running = jobs?.find((j) => j.status === "queued" || j.status === "running");

  return (
    <>
      <Section
        title="Export your library"
        description="Download everything as a ZIP file of PDFs, arranged in the same folders as your library."
      >
        <div className="export-options">
          <label className="check">
            <input type="checkbox" checked={embed} onChange={(e) => setEmbed(e.target.checked)} />
            <span>
              Include bookmarks inside the PDFs
              <small>Each notebook PDF gets an outline (PDF bookmarks) pointing at your bookmarked pages.</small>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={bookmarkPdfs} onChange={(e) => setBookmarkPdfs(e.target.checked)} />
            <span>
              Also export each bookmark as its own PDF
              <small>Saved next to the other items in its folder, containing only the bookmarked pages.</small>
            </span>
          </label>
        </div>
        <button
          className="btn btn-primary"
          disabled={!!running || starting}
          onClick={async () => {
            setStarting(true);
            try {
              await api("/exports", { method: "POST", json: { embed_bookmarks: embed, bookmark_pdfs: bookmarkPdfs } });
              await queryClient.invalidateQueries({ queryKey: ["exports"] });
            } catch (err) {
              toast(errorMessage(err), { kind: "error" });
            } finally {
              setStarting(false);
            }
          }}
        >
          <Archive /> {running ? "Export in progress…" : "Start export"}
        </button>
        <p className="field-hint" style={{ marginTop: 10 }}>
          Large libraries can take a few minutes. You can leave this page; finished exports are kept for 24 hours.
        </p>
      </Section>
      {jobs && jobs.length > 0 && (
        <Section title="Recent exports">
          <ul className="export-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <div className="export-info">
                  <strong>{formatDate(job.created_at)}</strong>
                  <span className={`muted ${job.status === "failed" ? "error-text" : ""}`}>{jobStatus(job)}</span>
                  {(job.status === "running" || job.status === "queued") && (
                    <div className={`progress ${job.total ? "" : "indeterminate"}`}>
                      <div style={{ width: job.total ? `${(job.progress / job.total) * 100}%` : "30%" }} />
                    </div>
                  )}
                  <small className="faint">
                    {job.params.embed_bookmarks ? "With bookmarks inside PDFs" : "Without bookmarks inside PDFs"}
                    {job.params.bookmark_pdfs ? " · bookmark PDFs included" : ""}
                  </small>
                </div>
                {job.status === "done" && (
                  <button className="btn" onClick={() => downloadUrl(`/api/exports/${job.id}/download`)}>
                    <Download /> Download
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

function AboutSettings() {
  const { data: health } = useHealth();
  return (
    <Section title="About Academia">
      <dl className="about-list">
        <div>
          <dt>Version</dt>
          <dd>{health?.version ?? "…"}</dd>
        </div>
        <div>
          <dt>Server build</dt>
          <dd className="tabular">{health?.commit ?? "…"}</dd>
        </div>
        <div>
          <dt>App build</dt>
          <dd className="tabular">{APP_BUILD}</dd>
        </div>
      </dl>
      <p className="muted">
        Academia is online-only: it always shows the latest version of your library and never stores your files on
        this device.
      </p>
    </Section>
  );
}

function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api<{ version: string; commit: string; build_id: string }>("/health"),
  });
}
