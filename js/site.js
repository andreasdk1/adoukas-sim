// Nav state (transparent over hero, solid after), active link, mobile menu,
// and reveal-on-scroll.
(function () {
  document.documentElement.classList.add('js');

  const nav = document.getElementById('nav');
  const hero = document.querySelector('.hero, .case-hero');
  const toggle = nav.querySelector('.nav-toggle');
  const links = [...nav.querySelectorAll('.nav-links a')];
  const sections = links
    .map(a => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);

  function onScroll() {
    const y = window.scrollY;
    const overHero = hero && y < hero.offsetHeight - nav.offsetHeight;
    nav.classList.toggle('on-dark', overHero);
    nav.classList.toggle('scrolled', !overHero);

    const atBottom = y + window.innerHeight >= document.documentElement.scrollHeight - 4;
    let current = null;
    for (const s of sections) if (y >= s.offsetTop - nav.offsetHeight - 40) current = s.id;
    if (atBottom) current = null;
    links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + current));
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (toggle) toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open);
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  });
  links.forEach(a => a.addEventListener('click', () => {
    nav.classList.remove('open');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }));

  const items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        // Stagger siblings that enter together
        const sibs = [...e.target.parentElement.children].filter(c => c.classList.contains('reveal'));
        e.target.style.transitionDelay = (sibs.indexOf(e.target) % 3) * 90 + 'ms';
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    items.forEach(el => io.observe(el));
  } else {
    items.forEach(el => el.classList.add('in'));
  }
})();
