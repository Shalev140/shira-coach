import { Component, useEffect, useState, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { UiProvider, useUi } from './components/ui';
import { initDatabase } from './db/repo';
import { autoSnapshotIfDue, requestPersistence, writeFolderBackup } from './db/backup';
import { useSettings } from './db/hooks';
import { isStandalone, localFlag, setLocalFlag } from './components/install';
import { Home } from './pages/Home';
import { Clients } from './pages/Clients';
import { ClientEdit } from './pages/ClientEdit';
import { ClientDetail } from './pages/ClientDetail';
import { Programs } from './pages/Programs';
import { ProgramEditor } from './pages/ProgramEditor';
import { WorkoutStart } from './pages/WorkoutStart';
import { ActiveWorkout } from './pages/ActiveWorkout';
import { SessionSummaryPage } from './pages/SessionSummary';
import { Progress } from './pages/Progress';
import { Insights } from './pages/Insights';
import { Library } from './pages/Library';
import { SettingsPage } from './pages/Settings';
import { BackupPage } from './pages/Backup';

const THEME_COLOR = { light: '#F4F3EF', dark: '#0E0F13' };

function Theme() {
  const s = useSettings();
  useEffect(() => {
    const root = document.documentElement;
    if (s.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', s.theme);
    // "by device": each meta keeps its own color for its media query, so the status bar follows the OS
    // when it switches later; a chosen theme sets both
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
      const dark = s.theme === 'system' ? (m.getAttribute('media') ?? '').includes('dark') : s.theme === 'dark';
      m.setAttribute('content', dark ? THEME_COLOR.dark : THEME_COLOR.light);
    });
  }, [s.theme]);
  return null;
}

/** Registers the offline service worker (production only) and offers updates. */
function Updates() {
  const { toast } = useUi();
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    // reload only for an update the trainer accepted — a first visit (the worker claiming an
    // uncontrolled page) or any other controller change must never reload mid-use
    let accepted = false;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !accepted) return;
      reloading = true;
      // let an open workout save its last edit before the page goes away
      window.dispatchEvent(new Event('shira:flush'));
      setTimeout(() => window.location.reload(), 400);
    });
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // offered again on every return to the app while a new version waits — an installed iPhone app has
      // no reload and is only resumed, so a missed toast would otherwise not come back until iOS kills it
      let shown: ServiceWorker | null = null;
      let shownAt = 0;
      const offer = (w: ServiceWorker) => {
        if (w === shown && Date.now() - shownAt < 60000) return;
        shown = w;
        shownAt = Date.now();
        toast('גרסה חדשה של האפליקציה מוכנה', {
          tone: 'info',
          ms: 60000,
          action: {
            label: 'עדכון',
            run: () => {
              accepted = true;
              w.postMessage('SKIP_WAITING');
            },
          },
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      const check = () =>
        reg
          .update()
          .catch(() => {})
          .finally(() => reg.waiting && navigator.serviceWorker.controller && offer(reg.waiting));
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
      // the installed app keeps its own copy for offline use — say once when it is complete
      if (isStandalone() && !localFlag('offline-ready'))
        void navigator.serviceWorker.ready
          .then(() => caches.match('./'))
          .then((hit) => {
            if (!hit) return;
            setLocalFlag('offline-ready');
            toast('האפליקציה מוכנה לעבודה גם בלי אינטרנט', { tone: 'ok' });
          })
          .catch(() => {});
    });
  }, [toast]);
  return null;
}

function Boot({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    initDatabase().then(
      () => {
        setReady(true);
        // background safety copies — a failure here (e.g. storage almost full) must
        // never lock the app behind the "cannot open the database" screen
        void (async () => {
          await requestPersistence();
          await autoSnapshotIfDue();
          await writeFolderBackup(false);
        })().catch((e) => console.warn('startup backup failed', e));
      },
      (e) => {
        console.error(e);
        setError(String(e?.message ?? e));
      },
    );
  }, []);
  if (error)
    return (
      <div className="page page-narrow" style={{ paddingTop: 60 }}>
        <div className="card card-lg stack">
          <h2>לא ניתן לפתוח את מסד הנתונים</h2>
          <p className="muted">
            ייתכן שהדפדפן במצב גלישה פרטית או שהאחסון חסום. הנתונים שלך לא נמחקו. נסי לפתוח בחלון רגיל או בדפדפן אחר.
          </p>
          <code className="small muted ltr">{error}</code>
        </div>
      </div>
    );
  if (!ready) return <div style={{ minHeight: '100dvh', background: 'var(--bg)' }} />;
  return <>{children}</>;
}

/** Last line of defence: a render error shows a recovery screen instead of a blank app. */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error('render error', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page page-narrow" style={{ paddingTop: 60 }}>
        <div className="card card-lg stack">
          <h2>משהו השתבש בתצוגה</h2>
          <p className="muted">הנתונים שמורים במכשיר ולא נפגעו. אפשר לחזור למסך הבית או לרענן.</p>
          <div className="row row-wrap">
            <button
              className="btn btn-primary"
              onClick={() => {
                window.location.hash = '#/';
                this.setState({ error: null });
              }}
            >
              למסך הבית
            </button>
            <button className="btn" onClick={() => window.location.reload()}>
              רענון
            </button>
          </div>
          <code className="small muted ltr">{String(this.state.error.message ?? this.state.error)}</code>
        </div>
      </div>
    );
  }
}

export function App() {
  return (
    <UiProvider>
      <Theme />
      <Updates />
      <Boot>
        <ErrorBoundary>
        <HashRouter>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Home />} />
              <Route path="clients" element={<Clients />} />
              <Route path="clients/new" element={<ClientEdit />} />
              <Route path="clients/:id" element={<ClientDetail />} />
              <Route path="clients/:id/edit" element={<ClientEdit />} />
              <Route path="programs" element={<Programs />} />
              <Route path="programs/:id" element={<ProgramEditor />} />
              <Route path="workout" element={<WorkoutStart />} />
              <Route path="session/:id" element={<ActiveWorkout />} />
              <Route path="session/:id/summary" element={<SessionSummaryPage mode="summary" />} />
              <Route path="session/:id/view" element={<SessionSummaryPage mode="view" />} />
              <Route path="progress" element={<Progress />} />
              <Route path="insights" element={<Insights />} />
              <Route path="library" element={<Library />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="backup" element={<BackupPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </HashRouter>
        </ErrorBoundary>
      </Boot>
    </UiProvider>
  );
}
