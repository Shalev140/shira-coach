import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  BookOpen,
  ClipboardList,
  DatabaseBackup,
  Dumbbell,
  House,
  Lightbulb,
  Play,
  Settings as SettingsIcon,
  TrendingUp,
  Users,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useActiveSessions, useClients, useRecommendations } from '../db/hooks';
import { useOnline } from './ui';

declare const __APP_VERSION__: string;

export function BrandMark({ size = 38 }: { size?: number }) {
  return (
    <div className="brand-mark" style={{ width: size, height: size }}>
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect x="3" y="12" width="4.2" height="9" rx="2.1" fill="#fff" opacity="0.55" />
        <rect x="9.9" y="7.5" width="4.2" height="13.5" rx="2.1" fill="#fff" opacity="0.8" />
        <rect x="16.8" y="3" width="4.2" height="18" rx="2.1" fill="#C6F25A" />
      </svg>
    </div>
  );
}

export function Shell() {
  const active = useActiveSessions();
  const recs = useRecommendations();
  const clients = useClients();
  const online = useOnline();
  const nav = useNavigate();
  const loc = useLocation();
  // counted like the Insights list it links to: archived clients' recommendations are not shown there
  const activeClients = new Set((clients ?? []).map((c) => c.id));
  const pending = (recs ?? []).filter((r) => r.status === 'pending' && activeClients.has(r.clientId)).length;
  const live = (active ?? []).length > 0;
  const inWorkout = loc.pathname.startsWith('/session/') && !loc.pathname.endsWith('/summary') && !loc.pathname.endsWith('/view');

  const goWorkout = () => {
    if (active && active.length === 1) nav(`/session/${active[0].id}`);
    else nav('/workout');
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">Shira Coach</div>
            <div className="brand-sub">ניהול ומעקב אימונים</div>
          </div>
        </div>
        <button className={`btn btn-block side-cta ${live ? 'btn-lime' : 'btn-dark'}`} onClick={goWorkout}>
          {live ? <Zap /> : <Play />}
          {live ? 'חזרה לאימון הפעיל' : 'התחלת אימון'}
        </button>
        <NavLink to="/" end className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
          <House /> בית
        </NavLink>
        <NavLink to="/clients" className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
          <Users /> מתאמנים
        </NavLink>
        <NavLink to="/programs" className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
          <ClipboardList /> תוכניות
        </NavLink>
        <NavLink to="/progress" className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
          <TrendingUp /> התקדמות
        </NavLink>
        <NavLink to="/insights" className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
          <Lightbulb /> תובנות
          {pending > 0 && <span className="count">{pending}</span>}
        </NavLink>
        <NavLink to="/library" className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
          <BookOpen /> ספריית תרגילים
        </NavLink>
        <div style={{ height: 10 }} />
        <NavLink to="/backup" className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
          <DatabaseBackup /> גיבוי ושחזור
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}>
          <SettingsIcon /> הגדרות
        </NavLink>
        <div className="side-foot">
          {!online && (
            <div className="offline-pill" style={{ marginBottom: 8 }}>
              <WifiOff /> מצב לא מקוון — הכול נשמר במכשיר
            </div>
          )}
          <div>גרסה {typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''}</div>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>

      {!inWorkout && (
        <nav className="bottomnav" aria-label="ניווט ראשי">
          <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <House />
            בית
          </NavLink>
          <NavLink to="/clients" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <Users />
            מתאמנים
          </NavLink>
          <button className={`nav-fab ${live ? 'live' : ''}`} onClick={goWorkout} aria-label={live ? 'אימון פעיל' : 'התחלת אימון'}>
            {live ? <Zap /> : <Dumbbell />}
            <span className="nav-fab-label">{live ? 'אימון פעיל' : 'אימון'}</span>
          </button>
          <NavLink to="/programs" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <ClipboardList />
            תוכניות
          </NavLink>
          <NavLink to="/insights" className={({ isActive }) => `nav-item ${isActive || loc.pathname.startsWith('/progress') ? 'active' : ''}`}>
            <Lightbulb />
            תובנות
            {pending > 0 && <span className="dot">{pending > 9 ? '9+' : pending}</span>}
          </NavLink>
        </nav>
      )}
    </div>
  );
}
