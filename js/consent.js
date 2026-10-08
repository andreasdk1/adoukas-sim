// Consent for Google Analytics. Nothing from Google loads until the visitor accepts: before that there is
// no request to Google and no cookie. The choice is kept in localStorage (not a cookie) and can be changed
// at any time from "Cookie settings" in the footer; withdrawing it removes the analytics cookies.
(() => {
  const GA_ID = 'G-EMZ0MM9TYB';
  const KEY = 'consent.analytics';                 // {v: 1, value: 'granted' | 'denied', t: ISO date}
  const privacyHref = (location.pathname.includes('/cases/') ? '../' : '') + 'privacy.html';

  const read = () => { try { const c = JSON.parse(localStorage.getItem(KEY)); return c && c.v === 1 ? c.value : null; } catch (e) { return null; } };
  const save = value => { try { localStorage.setItem(KEY, JSON.stringify({ v: 1, value, t: new Date().toISOString() })); } catch (e) {} };

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  let loaded = false;
  function loadGA() {
    if (loaded) { gtag('consent', 'update', { analytics_storage: 'granted' }); return; }
    loaded = true;
    // Consent Mode v2: analytics only; advertising storage and personalisation stay off
    gtag('consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
    gtag('js', new Date());
    gtag('config', GA_ID);
    const s = document.createElement('script');
    s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }
  function dropGA() {
    if (loaded) gtag('consent', 'update', { analytics_storage: 'denied' });
    // remove the analytics cookies (_ga, _ga_<id>) on this host and the parent domain
    const host = location.hostname, parts = host.split('.');
    const domains = ['', host, '.' + host, parts.length > 2 ? '.' + parts.slice(-2).join('.') : null].filter(d => d !== null);
    document.cookie.split(';').map(c => c.split('=')[0].trim()).filter(n => /^_ga/.test(n)).forEach(n => {
      domains.forEach(d => { document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d ? '; domain=' + d : ''}`; });
    });
  }

  let box = null;
  function banner() {
    if (box) { box.hidden = false; box.querySelector('button').focus(); return; }
    box = document.createElement('div');
    box.className = 'consent'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-label', 'Analytics consent');
    box.innerHTML =
      '<p>This site can use Google Analytics to see which pages are read, but only if you agree. ' +
      'Nothing is tracked unless you accept, and you can change your choice any time under ' +
      `“Cookie settings” at the bottom of the page. <a href="${privacyHref}">Privacy notice</a></p>` +
      '<div class="consent-actions"><button type="button" data-v="denied">Reject</button>' +
      '<button type="button" data-v="granted">Accept</button></div>';
    box.addEventListener('click', e => {
      const v = e.target.closest('button') && e.target.closest('button').dataset.v;
      if (!v) return;
      const before = read();
      save(v); box.hidden = true;
      if (v === 'granted') loadGA(); else if (before === 'granted' || loaded) dropGA();
    });
    document.body.appendChild(box);
  }

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-consent-open]');
    if (a) { e.preventDefault(); banner(); }
  });

  const start = () => { const c = read(); if (c === 'granted') loadGA(); else if (c === null) banner(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
