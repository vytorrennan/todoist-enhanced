import { PrivacyInformation } from '@/components/PrivacyInformation';
import { useState } from 'react';
import { Icon } from '@/components/Icon';
import { WorkspacePreview } from '@/components/WorkspacePreview';
import { Overlay } from '@/components/overlays/Overlay';
import { useT } from '@/hooks/useT';
import { useStore } from '@/store/store';
import { type AccountFailure, type AccountProblem, createAccount, isFailure, signInWithPassword } from '@/api/account';
import type { TranslationKey } from '@/i18n';
import { AUTHOR, GITHUB_URL, VERSION } from '@/app-info';

/**
 * The first screen: signing in to the account on this server, or creating one.
 *
 * The password goes to the server once, to get a session; the session is what
 * the device keeps. Whatever the way in, the session stays on the device and
 * goes nowhere but this server, which is why the privacy note sits right under
 * the form.
 */

const PROBLEM_KEY: Record<AccountProblem, TranslationKey> = {
  'invalid-credentials': 'connect.problem.invalidCredentials',
  'email-taken': 'connect.problem.emailTaken',
  'weak-password': 'connect.problem.weakPassword',
  'invalid-email': 'connect.problem.invalidEmail',
  'too-many-attempts': 'connect.problem.tooManyAttempts',
  'signup-closed': 'connect.problem.signupClosed',
  offline: 'connect.problem.offline',
  server: 'connect.problem.server',
};

export function ConnectView() {
  const { t } = useT();
  const connect = useStore((s) => s.connect);
  const startDemo = useStore((s) => s.startDemo);
  const setLocale = useStore((s) => s.setLocale);
  const locale = useStore((s) => s.prefs.locale);
  const syncError = useStore((s) => s.syncError);

  const [mode, setMode] = useState<'signIn' | 'create'>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AccountFailure | null>(null);
  const [localFailure, setLocalFailure] = useState<AccountProblem | null>(null);
  const [privacyOpen, setPrivacyOpen] = useState(false);

  const shownProblem: AccountProblem | null = localFailure ?? (failure?.problem ?? null);

  async function submit() {
    setFailure(null);
    setLocalFailure(null);
    const address = email.trim();
    if (!address) { setLocalFailure('invalid-email'); return; }
    if (!password) { setLocalFailure('invalid-credentials'); return; }
    setBusy(true);
    const result = mode === 'signIn'
      ? await signInWithPassword(address, password)
      : await createAccount({
        email: address,
        password,
        fullName: fullName.trim(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        lang: locale,
      });
    if (isFailure(result)) {
      setBusy(false);
      setFailure(result);
      return;
    }
    const ok = await connect(result.token);
    setBusy(false);
    if (!ok) setLocalFailure('server');
  }

  const legal = t('connect.legal', { author: AUTHOR }).split(AUTHOR);

  return (
    <div className="signin">
      <div className="signin-lang seg2" role="group" aria-label={t('settings.language')}>
        {(['en', 'fr'] as const).map((value) => (
          <button key={value} aria-pressed={locale === value} onClick={() => setLocale(value)}>
            {value === 'en' ? 'English' : 'Français'}
          </button>
        ))}
      </div>

      {/* What the app is for, on the bubble. Decorative as far as the sign-in
          goes: nothing here needs to be read to connect. */}
      <aside className="signin-bubble">
        <h2>{t('connect.pitch')}</h2>
        <ul className="signin-checks">
          {(['week', 'estimates', 'time', 'review', 'quick', 'matrix'] as const).map((key) => (
            <li key={key}>
              <span className="signin-check"><Icon name="check" size="sm" /></span>
              {t(`connect.feature.${key}` as TranslationKey)}
            </li>
          ))}
        </ul>
        <div className="signin-mock"><WorkspacePreview stage="login" layout="stage" /></div>
      </aside>

      <main className="signin-main">
        <div className="connect-form">
          <h1>{mode === 'signIn' ? t('connect.login') : t('connect.createTitle')}</h1>
          <p className="connect-intro">{t('connect.intro')}</p>

          {(
            <div className="connect-modes seg2" role="group" aria-label={t('connect.modeLabel')}>
              <button type="button" aria-pressed={mode === 'signIn'} onClick={() => { setMode('signIn'); setFailure(null); setLocalFailure(null); }}>
                {t('connect.modeSignIn')}
              </button>
              <button type="button" aria-pressed={mode === 'create'} onClick={() => { setMode('create'); setFailure(null); setLocalFailure(null); }}>
                {t('connect.modeCreate')}
              </button>
            </div>
          )}

          <form
            className="connect-account"
            onSubmit={(event) => { event.preventDefault(); if (!busy) void submit(); }}
          >
            <label>
              <span>{t('connect.email')}</span>
              <input
                type="email"
                name="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {mode === 'create' && (
              <label>
                <span>{t('connect.name')}</span>
                <input
                  type="text"
                  name="name"
                  autoComplete="name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                />
              </label>
            )}
            <label>
              <span>{t('connect.password')}</span>
              <input
                type="password"
                name="password"
                autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {mode === 'create' && <small className="connect-hint">{t('connect.passwordHint')}</small>}

            <button type="submit" className="btn primary lg connect-submit" disabled={busy}>
              {busy
                ? t('connect.working')
                : mode === 'signIn' ? t('connect.submitSignIn') : t('connect.submitCreate')}
            </button>
          </form>

          {syncError === 'storage-signout' && <p className="connect-error" role="alert">{t('sync.signOutStorageFailed')}</p>}
          {syncError === 'invalid' && <p className="connect-error" role="alert">{t('connect.sessionEnded')}</p>}
          {shownProblem && (
            <p className="connect-error" role="alert">
              {t(PROBLEM_KEY[shownProblem])}
              {failure?.retryAfter ? ` ${t('connect.problem.retryIn', { minutes: Math.ceil(failure.retryAfter / 60) })}` : ''}
            </p>
          )}

          <button className="btn soft lg connect-demo" onClick={startDemo} aria-label={t('connect.demoInstead')}>
            {/* The whole sentence needs two lines on a phone; the short one needs one. */}
            <span className="demo-long">{t('connect.demoInstead')}</span>
            <span className="demo-short">{t('connect.demoShort')}</span>
          </button>
        </div>

        {/* A phone has room for one line; the rest is a sheet away (#292). */}
        <p className="connect-privacy-line">
          <Icon name="eye" size="sm" />
          <span><strong>{t('connect.privacyLead').replace(/\.$/, '')}</strong>
            {' · '}<button type="button" onClick={() => setPrivacyOpen(true)}>{t('connect.privacyLink')}</button>
            {' · '}<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">{t('connect.githubShort')}</a></span>
        </p>

        <p className="connect-privacy">
          <Icon name="eye" size="sm" />
          <span><strong>{t('connect.privacyLead')}</strong>{' '}
          {t('connect.privacyBody')} <> {t('connect.privacyAnalytics')}</>{' '}
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size="sm" />
            {t('connect.github')}
          </a>{' '}<button type="button" className="privacy-link" onClick={() => setPrivacyOpen(true)}>{t('connect.privacyLink')}</button></span>
        </p>

        <p className="connect-legal">
          {legal[0]}<strong>{AUTHOR}</strong>{legal[1]}
        </p>

        <footer className="signin-brand">
          <strong className="signin-brand-name">{t('connect.appName')}</strong>
          <small>{t('connect.version', { version: VERSION })}</small>
        </footer>
      </main>

      <Overlay open={privacyOpen} onClose={() => setPrivacyOpen(false)} label={t('connect.privacyLink')} size="sm">
        <div className="sheet-head"><h2>{t('connect.privacyLink')}</h2>
          <button className="iconbtn" aria-label={t('common.close')} onClick={() => setPrivacyOpen(false)}><Icon name="close" /></button>
        </div>
        <div className="sheet-body connect-privacy-sheet">
          <PrivacyInformation />
          <p className="connect-privacy">
            <Icon name="eye" size="sm" />
            <span><strong>{t('connect.privacyLead')}</strong>{' '}{t('connect.privacyBody')} <> {t('connect.privacyAnalytics')}</>{' '}
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">{t('connect.github')}</a></span>
          </p>
          <p className="connect-legal">{legal[0]}<strong>{AUTHOR}</strong>{legal[1]}</p>
          <p className="connect-version">{t('connect.appName')} · {t('connect.version', { version: VERSION })}</p>
        </div>
      </Overlay>
    </div>
  );
}
