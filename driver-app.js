const rigTrackerApp = (() => {
  const nav = document.getElementById('driverAppNav');
  const dialog = document.getElementById('driverInstallDialog');
  const teamLinks = document.querySelectorAll('[data-company-team-link],#companyDriverTeamLinks');
  const tabs = new Map([...nav.querySelectorAll('[data-driver-tab]')].map(control => [control.dataset.driverTab, control]));
  const sections = {
    company: {
      driverLoadsPage: 'loads', driverLoadDetailPage: 'loads', companyMessagesPage: 'messages', driverDocumentsPage: 'settlements',
      rigTrackerProfilePage: 'profile', companyDriverClockPage: 'profile', companySafetyPage: 'safety'
    },
    driver: {
      driverLoadsPage: 'loads', driverLoadDetailPage: 'loads', spreadsheetPage: 'settlements', settlementPage: 'settlements',
      dashboardPage: 'dashboard', rigTrackerProfilePage: 'dashboard', taxPage: 'dashboard', perDiemPage: 'dashboard'
    }
  };
  const allowedTabs = {
    company: new Set(['loads', 'messages', 'settlements', 'safety', 'profile']),
    driver: new Set(['loads', 'settlements', 'dashboard'])
  };
  let currentPage;
  let role;
  let verifiedCompanyProfile = false;
  let installPrompt;

  function standalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function launchedAsApp() {
    return standalone() || new URLSearchParams(window.location.search).get('app') === 'driver';
  }

  function pageChanged(page, account) {
    currentPage = page;
    role = account;
    const active = sections[role]?.[page];
    for (const link of teamLinks) link.classList.toggle('hidden', role !== 'company' || !verifiedCompanyProfile);
    if (!active || (role === 'company' && !verifiedCompanyProfile)) {
      nav.classList.add('hidden');
      delete document.body.dataset.driverApp;
      return;
    }
    for (const [tab, control] of tabs) {
      control.hidden = !allowedTabs[role].has(tab);
      if (tab === active) control.setAttribute('aria-current', 'page');
      else control.removeAttribute('aria-current');
    }
    nav.classList.remove('hidden');
    document.body.dataset.driverApp = role;
  }

  function companyReady() {
    verifiedCompanyProfile = true;
    pageChanged(currentPage, role);
  }

  function badge(tab, value, description = '') {
    const control = tabs.get(tab);
    const indicator = control.querySelector('.driver-app-badge');
    indicator.hidden = !value;
    indicator.textContent = value > 99 ? '99+' : value || '';
    const label = control.firstChild.textContent.trim();
    if (value) {
      const descriptionWithCount = typeof value === 'number' ? value + ' ' + description : description;
      control.setAttribute('aria-label', label + ', ' + descriptionWithCount);
    } else {
      control.removeAttribute('aria-label');
    }
  }

  function reset() {
    verifiedCompanyProfile = false;
    pageChanged(null, null);
    for (const tab of ['loads', 'messages', 'settlements']) badge(tab, 0);
  }

  nav.addEventListener('click', event => {
    const control = event.target.closest('[data-driver-tab]');
    const tab = control?.dataset.driverTab;
    if (!allowedTabs[role]?.has(tab) || control.getAttribute('aria-current') === 'page') return;
    if (tab === 'loads') void driverLoadWorkflow.open();
    if (tab === 'messages') void companyMessaging.open();
    if (tab === 'safety') void companySafety.open();
    if (tab === 'settlements') {
      if (role === 'company') void companyDriverTools.openDocuments();
      else showPage('spreadsheetPage');
    }
    if (tab === 'profile') showPage('rigTrackerProfilePage');
    if (tab === 'dashboard') showPage('dashboardPage');
  });

  function installSteps() {
    const agent = navigator.userAgent;
    if (/iPhone|iPad|iPod/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      return 'Open this site in Safari. Tap Share, then Add to Home Screen. Turn on Open as Web App if shown, then tap Add.';
    }
    if (/Android/i.test(agent)) {
      return 'Open this site in Chrome. Tap the three-dot menu, choose Install app or Add to Home screen, and follow the prompt.';
    }
    return 'In Chrome or Edge, look for the install icon in the address bar or the Install option in the browser menu.';
  }

  async function install() {
    if (standalone()) return;
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      try {
        await prompt.prompt();
        return;
      } catch {
        // Use the browser menu if the prompt is unavailable.
      }
    }
    document.getElementById('driverInstallSteps').textContent = installSteps();
    if (!dialog.open) dialog.showModal();
  }

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; });
  document.querySelectorAll('[data-install-app]').forEach(button => button.addEventListener('click', () => void install()));
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(error => console.warn('App installation worker unavailable.', error));
  }

  return { pageChanged, companyReady, badge, reset, launchedAsApp };
})();
