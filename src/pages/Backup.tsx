import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  FolderSync,
  HardDrive,
  History,
  Link2Off,
  RotateCcw,
  Share2,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { db } from '../db/db';
import {
  TABLE_LABELS,
  canShareFiles,
  createSnapshot,
  downloadBackup,
  downloadBlob,
  exportCsv,
  folderBackupSupported,
  forgetBackupFolder,
  importBackup,
  listSnapshots,
  parseBackupFile,
  pickBackupFolder,
  readFolderLatest,
  requestPersistence,
  restoreSnapshot,
  shareBackup,
  snapshotPayload,
  storageInfo,
  writeFolderBackup,
  type FolderResult,
  type Validation,
} from '../db/backup';
import { useMeta, useSettings } from '../db/hooks';
import { fmtDateTime, plural, relativeTime } from '../domain/util';
import { Seg, TopBar, useUi } from '../components/ui';
import { isIOS } from '../components/install';

export function BackupPage() {
  const { toast, confirm } = useUi();
  const settings = useSettings();
  const folder = useLiveQuery(async () => ((await db.meta.get('backupDir'))?.value as FileSystemDirectoryHandle | undefined) ?? null, []);
  const lastFolder = useMeta<number>('lastFolderBackupAt');
  const snapshots = useLiveQuery(() => listSnapshots(), []);
  const counts = useLiveQuery(async () => ({
    clients: (await db.clients.toArray()).filter((c) => !c.deletedAt).length,
    sessions: (await db.sessions.toArray()).filter((s) => !s.deletedAt && s.status === 'completed').length,
    programs: (await db.programs.toArray()).filter((p) => !p.deletedAt).length,
  }), []);
  const [storage, setStorage] = useState<{ persisted: boolean; usage: number; quota: number } | null>(null);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [busy, setBusy] = useState(false);
  const [allSnapshots, setAllSnapshots] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement>(null);
  const share = canShareFiles();
  const ios = isIOS();
  const folderOk = folderBackupSupported();

  useEffect(() => {
    void storageInfo().then(setStorage);
  }, []);

  const backupNow = async () => {
    setBusy(true);
    try {
      if (share) {
        const r = await shareBackup();
        if (r === 'shared') toast('קובץ הגיבוי נשלח');
        else if (r === 'unsupported') {
          await downloadBackup();
          toast('קובץ הגיבוי הורד');
        }
      } else {
        await downloadBackup();
        toast('קובץ הגיבוי הורד לתיקיית ההורדות');
      }
    } catch (e) {
      toast(`הגיבוי נכשל: ${String(e)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (f?: File | null) => {
    if (!f) return;
    setValidation(await parseBackupFile(f));
    if (fileRef.current) fileRef.current.value = '';
  };

  const doImport = async () => {
    if (!validation?.payload) return;
    if (mode === 'replace') {
      const ok = await confirm({
        title: 'שחזור מלא מהקובץ?',
        body: 'כל הנתונים במכשיר יוחלפו בתוכן הקובץ. לפני כן נשמר גיבוי אוטומטי של המצב הנוכחי, כך שאפשר לחזור אחורה.',
        confirmLabel: 'שחזור',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await importBackup(validation.payload, mode);
      toast(
        mode === 'merge'
          ? `מוזג: ${plural(r.added, 'רשומה חדשה אחת', 'רשומות חדשות')}, ${plural(r.updated, 'רשומה אחת עודכנה', 'עודכנו')}` +
              // two active programs for one client after a merge: the older one was archived (with a version)
              (r.archivedPrograms ? ` · ${plural(r.archivedPrograms, 'תוכנית כפולה אחת הועברה לארכיון', 'תוכניות כפולות הועברו לארכיון')}` : '')
          : 'השחזור הושלם',
        { ms: 7000 },
      );
      setValidation(null);
    } catch (e) {
      toast(`השחזור נכשל: ${String(e)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const folderToast = (r: FolderResult, okText: string) =>
    toast(
      r === 'ok'
        ? okText
        : r === 'empty'
          ? 'אין עדיין נתונים לגבות — הקבצים שבתיקייה לא נדרסו'
          : r === 'needs-permission'
            ? 'צריך לאשר גישה לתיקייה'
            : 'הכתיבה לתיקייה נכשלה',
      { tone: r === 'ok' ? 'ok' : r === 'empty' ? 'info' : 'error' },
    );

  const folderAction = async () => {
    try {
      if (!folder) {
        const { name, result } = await pickBackupFolder();
        // nothing on this device yet (new computer / cleared browser) — offer the folder's latest backup instead
        const latest = result === 'empty' ? await readFolderLatest() : null;
        if (latest?.ok) {
          setValidation(latest);
          restoreRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          toast(`נמצא גיבוי בתיקייה "${name}" — אפשר לשחזר ממנו כאן`, { tone: 'info' });
        } else folderToast(result, `הגיבוי האוטומטי מוגדר לתיקייה "${name}"`);
      } else folderToast(await writeFolderBackup(true), 'נשמר גיבוי בתיקייה');
    } catch (e) {
      if ((e as DOMException)?.name !== 'AbortError') toast(`לא ניתן לבחור תיקייה: ${String(e)}`, { tone: 'error' });
    }
  };

  const last = useMeta<number>('lastExternalBackupAt') ?? null;
  const overdue = !last || Date.now() - last > settings.backupReminderDays * 86400000;

  return (
    <>
      <TopBar title="גיבוי ושחזור" back={true} />
      <div className="page page-narrow stack-lg">
        <section className={`card card-lg stack backup-status ${overdue ? 'overdue' : 'ok'}`}>
          <div className="row">
            <div className={`status-icon ${overdue ? 'tone-warn' : 'tone-success'}`}>{overdue ? <Clock /> : <ShieldCheck />}</div>
            <div className="grow">
              <h2>{overdue ? 'כדאי לגבות עכשיו' : 'הנתונים מגובים'}</h2>
              <div className="small muted">
                גיבוי אחרון מחוץ למכשיר: <b>{relativeTime(last)}</b>
                {counts && ` · ${plural(counts.clients, "מתאמן/ת אחד/ת", "מתאמנים")} · ${plural(counts.sessions, "אימון אחד", "אימונים")} · ${plural(counts.programs, "תוכנית אחת", "תוכניות")}`}
              </div>
            </div>
          </div>
          <button className="btn btn-primary btn-lg btn-block" onClick={backupNow} disabled={busy}>
            {share ? <Share2 /> : <Download />}
            {share ? (ios ? 'גיבוי עכשיו — שמירה בקבצים / דרייב / וואטסאפ' : 'גיבוי עכשיו — שליחה לדרייב / וואטסאפ / מייל') : 'גיבוי עכשיו — הורדת קובץ'}
          </button>
          {/* not on iPhone: a download there can end without saving anything, so it can't count as a backup —
              "שמירה בקבצים" in the share sheet does the same and is confirmed */}
          {share && !ios && (
            <button className="btn btn-block" onClick={() => downloadBackup().then(() => toast('הקובץ הורד'))}>
              <Download /> הורדת קובץ למכשיר
            </button>
          )}
          <p className="tiny muted">
            הקובץ מכיל את כל הנתונים (מתאמנים, תוכניות וגרסאות, אימונים, מדדים, הערות, המלצות והגדרות) ונבדק בשחזור עם חתימת שלמות.
          </p>
        </section>

        <section className="card card-lg stack">
          <div className="card-title">
            <FolderSync /> גיבוי אוטומטי לתיקייה במחשב
          </div>
          {folderOk ? (
            <>
              <p className="small muted">
                בוחרים פעם אחת תיקייה (מומלץ: תיקייה בתוך OneDrive / Google Drive) — והאפליקציה שומרת בה קובץ גיבוי יומי בכל פתיחה ובסוף כל אימון. נשמרים 30 הימים האחרונים.
              </p>
              {folder ? (
                <div className="banner tone-success small">
                  <CheckCircle2 />
                  <div className="grow">
                    תיקייה: <b>{folder.name}</b> · גיבוי אחרון: {relativeTime(lastFolder ?? null)}
                  </div>
                </div>
              ) : null}
              <div className="row row-wrap">
                <button className="btn" onClick={folderAction}>
                  <FolderSync /> {folder ? 'גיבוי לתיקייה עכשיו' : 'בחירת תיקייה'}
                </button>
                {folder && (
                  <button
                    className="btn btn-ghost"
                    onClick={async () => {
                      await forgetBackupFolder();
                      toast('התיקייה נותקה');
                    }}
                  >
                    <Link2Off /> ניתוק
                  </button>
                )}
              </div>
              <p className="tiny muted">אחרי הפעלה מחדש של הדפדפן ייתכן שיתבקש אישור גישה מחדש בלחיצה אחת.</p>
            </>
          ) : (
            <p className="small muted">זמין בדפדפן Chrome / Edge במחשב. בטלפון משתמשים בכפתור ״גיבוי עכשיו״ לשליחת הקובץ לדרייב או לוואטסאפ.</p>
          )}
        </section>

        <section ref={restoreRef} className="card card-lg stack">
          <div className="card-title">
            <Upload /> שחזור / ייבוא מקובץ גיבוי
          </div>
          <p className="small muted">מעבר לטלפון חדש, שחזור אחרי תקלה, או העברת נתונים בין מחשב לטלפון.</p>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Upload /> בחירת קובץ גיבוי
          </button>
          {validation && (
            <div className={`banner ${validation.ok ? 'tone-info' : 'tone-danger'}`}>
              <div className="grow stack-sm small">
                {validation.ok ? (
                  <>
                    <b>הקובץ תקין.</b>
                    {validation.payload?.exportedAt && <div>נוצר: {fmtDateTime(new Date(validation.payload.exportedAt).getTime())}</div>}
                    <div className="row row-wrap" style={{ gap: 6 }}>
                      {Object.entries(validation.counts)
                        .filter(([k, v]) => k !== 'settings' && v > 0)
                        .map(([k, v]) => (
                          <span key={k} className="badge">
                            {TABLE_LABELS[k as keyof typeof TABLE_LABELS]}: {v}
                          </span>
                        ))}
                    </div>
                    {validation.warnings.map((w) => (
                      <div key={w} className="muted">{w}</div>
                    ))}
                    <Seg
                      value={mode}
                      onChange={setMode}
                      options={[
                        { value: 'merge', label: 'מיזוג (מומלץ)' },
                        { value: 'replace', label: 'החלפה מלאה' },
                      ]}
                    />
                    <div className="muted">
                      {mode === 'merge'
                        ? 'מיזוג: מוסיף רשומות חסרות ומעדכן רק רשומות שבקובץ חדשות יותר. שום דבר לא נמחק.'
                        : 'החלפה: הנתונים במכשיר יהיו בדיוק כמו בקובץ. נשמר גיבוי אוטומטי לפני.'}
                    </div>
                    <div className="row">
                      <button className="btn btn-primary btn-sm" onClick={doImport} disabled={busy}>
                        {mode === 'merge' ? 'מיזוג הנתונים' : 'שחזור מלא'}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setValidation(null)}>
                        ביטול
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <b>לא ניתן לשחזר מהקובץ:</b>
                    {validation.errors.map((e) => (
                      <div key={e}>{e}</div>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="card card-lg stack">
          <div className="row between">
            <div className="card-title">
              <History /> גיבויים אוטומטיים בתוך האפליקציה
            </div>
            <button
              className="btn btn-sm"
              onClick={async () => {
                await createSnapshot('גיבוי ידני', 'manual');
                toast('נשמרה נקודת שחזור');
              }}
            >
              שמירה עכשיו
            </button>
          </div>
          <p className="small muted">
            נקודת שחזור נשמרת אוטומטית פעם ביום, לפני כל שחזור/ייבוא ולפני מחיקת מתאמן/ת או אימון. מגן מטעויות — אבל נמצא באותו מכשיר, לכן חשוב גם גיבוי חיצוני.
          </p>
          <div className="list">
            {(snapshots ?? []).slice(0, allSnapshots ? undefined : 12).map((s) => (
              <div key={s.id} className="list-item" style={{ padding: '10px 0' }}>
                <div className="grow">
                  <div className="small strong">{s.reason}</div>
                  <div className="tiny muted">
                    {fmtDateTime(s.createdAt)} · {plural(s.counts.clients ?? 0, 'מתאמן/ת אחד/ת', 'מתאמנים')} · {plural(s.counts.sessions ?? 0, 'אימון אחד', 'אימונים')} · {Math.max(1, Math.round(s.size / 1024))}KB
                  </div>
                </div>
                <button
                  className="icon-btn"
                  aria-label="הורדת נקודת השחזור כקובץ"
                  title="הורדה כקובץ גיבוי"
                  onClick={async () => {
                    const payload = await snapshotPayload(s.id);
                    downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `shira-coach-snapshot-${new Date(s.createdAt).toISOString().slice(0, 10)}.json`);
                  }}
                >
                  <Download size={18} />
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={async () => {
                    const ok = await confirm({
                      title: 'לחזור לנקודה הזו?',
                      body: `הנתונים יחזרו למצב של ${fmtDateTime(s.createdAt)}. המצב הנוכחי יישמר קודם כנקודת שחזור.`,
                      confirmLabel: 'שחזור',
                      danger: true,
                    });
                    if (!ok) return;
                    await restoreSnapshot(s.id);
                    toast('הנתונים שוחזרו');
                  }}
                >
                  <RotateCcw /> שחזור
                </button>
              </div>
            ))}
            {snapshots && snapshots.length === 0 && <div className="small muted">עדיין אין נקודות שחזור — הראשונה תיווצר אוטומטית כשיהיו נתונים.</div>}
          </div>
          {!allSnapshots && snapshots && snapshots.length > 12 && (
            <button className="btn btn-ghost btn-sm" onClick={() => setAllSnapshots(true)}>
              הצגת כל {snapshots.length} נקודות השחזור
            </button>
          )}
        </section>

        <section className="card card-lg stack">
          <div className="card-title">
            <FileSpreadsheet /> ייצוא לאקסל
          </div>
          <p className="small muted">קבצי CSV שנפתחים באקסל / Google Sheets — קריאים גם בלי האפליקציה.</p>
          <div className="row row-wrap">
            <button className="btn btn-sm" onClick={() => exportCsv('sets')}>
              <FileSpreadsheet /> יומן סטים
            </button>
            <button className="btn btn-sm" onClick={() => exportCsv('clients')}>
              <FileSpreadsheet /> מתאמנים
            </button>
            <button className="btn btn-sm" onClick={() => exportCsv('measurements')}>
              <FileSpreadsheet /> מדידות
            </button>
          </div>
        </section>

        <section className="card card-lg stack">
          <div className="card-title">
            <HardDrive /> אחסון במכשיר
          </div>
          {storage && (
            <div className="small">
              {storage.persisted ? (
                <span className="badge tone-success">
                  <ShieldCheck /> אחסון קבוע — הדפדפן לא ימחק את הנתונים
                </span>
              ) : (
                <span className="badge tone-warn">אחסון רגיל</span>
              )}
              <div className="muted" style={{ marginTop: 6 }}>
                בשימוש: {(storage.usage / 1024 / 1024).toFixed(1)}MB
                {storage.quota ? ` מתוך ${(storage.quota / 1024 / 1024 / 1024).toFixed(1)}GB זמינים` : ''}
              </div>
            </div>
          )}
          {storage && !storage.persisted && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                const ok = await requestPersistence();
                setStorage(await storageInfo());
                toast(ok ? 'האחסון הוגדר כקבוע' : 'הדפדפן לא אישר — מומלץ להתקין את האפליקציה למסך הבית', { tone: ok ? 'ok' : 'info' });
              }}
            >
              בקשת אחסון קבוע
            </button>
          )}
          {ios ? (
            <p className="tiny muted">
              באייפון: לעבוד רק מהאפליקציה שבמסך הבית (שיתוף ← ״הוספה למסך הבית״). הנתונים שלה נפרדים מספארי, ומחיקת האייקון ממסך הבית מוחקת את כל הנתונים — לפני מחיקה או החלפת טלפון חובה לגבות לקובץ.
            </p>
          ) : (
            <p className="tiny muted">
              מומלץ להתקין את האפליקציה למסך הבית (״הוספה למסך הבית״ בתפריט הדפדפן) — כך היא נפתחת כמו אפליקציה, עובדת בלי אינטרנט והנתונים מוגנים יותר.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
