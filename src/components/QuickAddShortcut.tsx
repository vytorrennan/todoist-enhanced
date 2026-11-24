import { useEffect, useState } from 'react';
import { useT } from '@/hooks/useT';
import { DEFAULT_QUICK_ADD_SHORTCUT, formatShortcut, shortcutFromPress } from '@/domain/shortcut';

/**
 * The Quick Add shortcut, inside the Mac app only.
 *
 * The page is always the newest, the shell around it is not: an app downloaded
 * before this existed has no way to change the shortcut, so it is told so, with
 * the way to get the new one, rather than being shown a button that does nothing.
 */
function QuickAddShortcut() {
  const { t } = useT();
  const bridge = window.enhancedDesktop;
  const supported = Boolean(bridge?.setQuickAddShortcut && bridge.getQuickAddShortcut);
  const [shortcut, setShortcut] = useState(DEFAULT_QUICK_ADD_SHORTCUT);
  const [recording, setRecording] = useState(false);
  /* The modifiers held while choosing, shown in the field itself as they go down. */
  const [held, setHeld] = useState('');
  const [problem, setProblem] = useState<'needsModifier' | 'taken' | null>(null);

  useEffect(() => {
    let live = true;
    bridge?.getQuickAddShortcut?.().then((current) => { if (live && current) setShortcut(current); }).catch(() => { /* the default stays */ });
    return () => { live = false; };
  }, [bridge]);

  const save = async (accelerator: string) => {
    const result = await bridge?.setQuickAddShortcut?.(accelerator);
    if (!result) return;
    setShortcut(result.shortcut);
    setProblem(result.ok ? null : 'taken');
  };

  useEffect(() => {
    if (!recording) return;
    const modifiers = (event: KeyboardEvent) => [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Command']
      .filter((part): part is string => Boolean(part)).join('+');
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') { setRecording(false); setProblem(null); return; }
      setHeld(formatShortcut(modifiers(event)));
      const press = shortcutFromPress(event);
      if (!press.ok) { setProblem(press.reason === 'modifier' ? 'needsModifier' : null); return; }
      setProblem(null);
      setRecording(false);
      void save(press.accelerator);
    };
    const onUp = (event: KeyboardEvent) => setHeld(formatShortcut(modifiers(event)));
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('keyup', onUp, true); setHeld(''); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `save` only reads the bridge.
  }, [recording]);

  return (
    <>
      {/* A settings row like the others: the name and what it does on the left, the control on the right. */}
      <div className="setrow quickshortcut">
        <div>
          <strong>{t('shortcut.title')}</strong>
          <span>{supported ? t('shortcut.about') : t('shortcut.old')}</span>
        </div>
        {supported ? (
          <div className="quickshortcut-control">
            {!recording && shortcut !== DEFAULT_QUICK_ADD_SHORTCUT && (
              <button type="button" className="quickshortcut-reset" onClick={() => { setProblem(null); void save(DEFAULT_QUICK_ADD_SHORTCUT); }}>{t('shortcut.reset')}</button>
            )}
            {/* The field is the control: press it, then press the keys. */}
            <button
              type="button"
              className={`quickshortcut-field${recording ? ' recording' : ''}`}
              aria-label={t('shortcut.title')}
              onClick={() => { setProblem(null); setRecording((on) => !on); }}
              onBlur={() => setRecording(false)}
            >
              {recording ? (held || <span className="quickshortcut-hint">{t('shortcut.press')}</span>) : formatShortcut(shortcut)}
            </button>
          </div>
        ) : null}
      </div>
      {problem && <p className="quickshortcut-problem" role="alert">{t(`shortcut.${problem}`)}</p>}
    </>
  );
}

/** The shortcut editor, in the desktop app only: the desktop app provides the bridge it uses. */
export function DesktopQuickAddShortcut() {
  return document.documentElement.classList.contains('desktop-app') ? <QuickAddShortcut /> : null;
}
