const payrollTaxUpdates = (() => {
  'use strict';

  const dialog = document.getElementById('payrollTaxUpdatesDialog');
  const status = document.getElementById('payrollTaxUpdatesStatus');
  const releases = document.getElementById('payrollTaxUpdatesReleases');
  const sources = document.getElementById('payrollTaxUpdatesSources');
  const date = new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeZone:'UTC'});
  const reportUrl = 'https://raw.githubusercontent.com/ttservice2020-cloud/Rigtracker/payroll-tax-monitor/payroll-tax-source-status.json';
  const buttons = new Map();
  let session;

  function node(tag,text) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    return element;
  }

  async function request(fleet, release) {
    const {data,error} = await supabaseClient.rpc('payroll_tax_rule_updates',{
      target_fleet:fleet, accept_release:release || null
    });
    if (error) throw error;
    return data;
  }

  function renderBadge(button, updates) {
    const count = updates.releases.filter(release => !release.accepted_at).length;
    button.textContent = count ? 'Tax Rule Updates (' + count + ')' : 'Tax Rule Updates';
  }

  function buttonFor(fleet, existing) {
    const button = existing || node('button');
    button.type = 'button';
    button.classList.add('outline');
    button.textContent = 'Tax Rule Updates';
    button.hidden = !fleet;
    button.onclick = () => open(fleet);
    if (!fleet) return button;
    const user = currentUser;
    const requestForButton = {fleet};
    buttons.set(button,requestForButton);
    for (const [candidate] of buttons) {
      if (candidate !== button && !candidate.isConnected) buttons.delete(candidate);
    }
    void request(fleet).then(updates => {
      if (user === currentUser && buttons.get(button) === requestForButton) renderBadge(button,updates);
    }).catch(() => {});
    return button;
  }

  function active(current) {
    return current === session && current.user === currentUser && dialog.open;
  }

  function render(current, updates) {
    status.textContent = '';
    if (!updates.releases.length) {
      releases.replaceChildren(node('p','No rule updates have been published.'));
      return;
    }
    releases.replaceChildren(...updates.releases.map(release => {
      const section = node('section');
      section.className = 'payroll-tax-group';
      const changes = node('ul');
      changes.append(...release.changes.map(change => node('li',change)));
      const released = date.format(new Date(release.released_on + 'T00:00:00Z'));
      section.append(node('h3',release.title),node('p','Tax year ' + release.tax_year + ' · Released ' + released),changes);
      if (release.accepted_at) {
        section.append(node('p','Accepted ' + date.format(new Date(release.accepted_at))));
      } else if (updates.can_accept) {
        const accept = node('button','Accept Update');
        accept.className = 'primary-btn';
        accept.type = 'button';
        accept.addEventListener('click',async () => {
          if (!active(current) || accept.disabled) return;
          accept.disabled = true;
          status.textContent = 'Recording acceptance…';
          try {
            const result = await request(current.fleet,release.key);
            if (!active(current)) return;
            for (const [button,registration] of buttons) {
              if (registration.fleet !== current.fleet || !button.isConnected) continue;
              buttons.set(button,{fleet:current.fleet});
              renderBadge(button,result);
            }
            render(current,result);
            status.textContent = 'Update accepted for this fleet.';
          } catch (error) {
            if (active(current)) status.textContent = error.message || 'Could not accept the update.';
          } finally {
            accept.disabled = false;
          }
        });
        section.append(accept);
      } else {
        section.append(node('p','Awaiting acceptance by a Fleet Admin or Official.'));
      }
      return section;
    }));
  }

  async function loadSourceCheck(current) {
    sources.replaceChildren(node('h3','Government source checks'),node('p','Loading the latest check…'));
    try {
      const response = await fetch(reportUrl,{cache:'no-cache',credentials:'omit',referrerPolicy:'no-referrer',signal:current.controller.signal});
      if (!response.ok) throw new Error('Source check unavailable');
      const report = await response.json();
      const checked = new Date(report.checked_at);
      if (!active(current)) return;
      if (!Number.isFinite(checked.valueOf()) || !Array.isArray(report.needs_review)) throw new Error('Invalid source check');
      const lastCheck = node('p','Last checked ' + date.format(checked) + '. Scheduled checks run Monday and Thursday.');
      const entries = report.needs_review.slice(0,150).filter(entry => entry && ['changed','unavailable'].includes(entry.status)
        && typeof entry.name === 'string' && typeof entry.url === 'string' && /^https:\/\/[^\s]+$/.test(entry.url));
      sources.replaceChildren(node('h3','Government source checks'),lastCheck);
      if (!entries.length) {
        sources.append(node('p','All checked sources match the reviewed publications.'));
        return;
      }
      const list = node('ul');
      for (const entry of entries) {
        const row = node('li');
        const link = node('a',entry.name);
        link.href = entry.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        row.append(link,entry.status === 'changed' ? ' · Source changed' : ' · Source unavailable');
        list.append(row);
      }
      sources.append(node('p','Changed sources need verification before a new tax rule can be published.'),list);
    } catch {
      if (!active(current)) return;
      sources.replaceChildren(node('h3','Government source checks'),
        node('p','The latest scheduled source check is unavailable. Checks run Monday and Thursday.'));
    }
  }

  async function open(fleet) {
    if (!fleet || !currentUser || dialog.open) return;
    session = {fleet,user:currentUser,controller:new AbortController()};
    const current = session;
    status.textContent = 'Loading fleet tax rule updates…';
    releases.replaceChildren();
    dialog.showModal();
    void loadSourceCheck(current);
    try {
      const updates = await request(fleet);
      if (active(current)) render(current,updates);
    } catch (error) {
      if (active(current)) status.textContent = error.message || 'Could not load tax rule updates.';
    }
  }

  function clearSession() {
    session?.controller.abort();
    session = undefined;
    releases.replaceChildren();
    sources.replaceChildren();
    status.textContent = '';
  }

  function reset() {
    clearSession();
    buttons.clear();
    if (dialog.open) dialog.close();
  }

  dialog.addEventListener('close',clearSession);
  return { buttonFor, reset };
})();
