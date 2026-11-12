import { useEffect } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useI18n } from './i18n';
import { BrandMark, IconEnvelope, IconGlobe, IconHome, IconLedger, IconWallet } from './components/Icons';
import { Landing } from './pages/Landing';
import { Send } from './pages/Send';
import { Claim } from './pages/Claim';
import { Me } from './pages/Me';
import { Ledger } from './pages/Ledger';

function NotFound() {
  const { t } = useI18n();
  return (
    <div className="stack center" style={{ paddingTop: 40 }}>
      <h1 className="page-title">404</h1>
      <Link className="btn btn-primary" to="/">
        {t('nav.home')}
      </Link>
    </div>
  );
}

export function App() {
  const { t, toggle, lang } = useI18n();
  const { pathname } = useLocation();
  const wide = pathname === '/' || pathname === '/ledger';

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  useEffect(() => {
    const base = lang === 'en' ? 'Hongbao · red packets on Mezo' : '紅包 Hongbao · Mezo 上的紅包';
    document.title = base;
  }, [lang]);

  const nav = [
    { to: '/', label: t('nav.home'), icon: IconHome, end: true },
    { to: '/send', label: t('nav.send'), icon: IconEnvelope, end: false },
    { to: '/me', label: t('nav.me'), icon: IconWallet, end: false },
    { to: '/ledger', label: t('nav.ledger'), icon: IconLedger, end: false },
  ];

  return (
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <Link to="/" className="brand" aria-label="Hongbao">
            <BrandMark className="brand-mark" />
            <span className="brand-word">
              <span className="brand-zh">紅包</span>
              <span className="brand-en">Hongbao</span>
            </span>
          </Link>
          <nav className="header-nav" aria-label="Main">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="header-spacer" />
          <button type="button" className="lang-btn" onClick={toggle} aria-label={t('lang.label')}>
            <IconGlobe width={16} height={16} />
            {t('lang.switch')}
          </button>
        </div>
      </header>

      <main className={`main ${wide ? 'wide' : ''}`}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/send" element={<Send />} />
          <Route path="/c/:chainId/:id" element={<Claim />} />
          <Route path="/me" element={<Me />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      <footer className="footer">
        <div className="footer-inner">
          <span>{t('footer.line')}</span>
          <Link to="/ledger">{t('footer.ledger')}</Link>
        </div>
      </footer>

      <nav className="bottom-nav" aria-label="Main">
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            <n.icon />
            {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
