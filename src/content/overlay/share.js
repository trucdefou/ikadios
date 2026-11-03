// Row selection and sharing for overlay tables (Military, Transport): a checkbox
// per row, a select-all box, and a bar that sends the selected rows to Discord
// (manual sends) or opens WhatsApp with the same text. Selections live in memory
// by row key, so they survive re-renders.
(function (root) {
  'use strict';

  const IkaDios = root.IkaDios;
  const { el } = IkaDios.util;

  const selections = new Map(); // by scope: Map of rowKey to selected (boolean)
  const MAX_FIELDS = 25;

  function isSelected(scope, key) {
    const map = selections.get(scope);
    // New rows start selected
    return map?.has(key) ? map.get(key) : true;
  }

  function setSelected(scope, key, on) {
    if (!selections.has(scope)) selections.set(scope, new Map());
    selections.get(scope).set(key, on);
  }

  // Checkbox cell for a row
  function rowCheck(scope, key) {
    return el('td', { class: 'sel' }, el('input', {
      type: 'checkbox',
      checked: isSelected(scope, key) ? true : null,
      onchange: (e) => setSelected(scope, key, e.target.checked),
    }));
  }

  // Header checkbox that toggles every row of the table it sits in
  function headCheck(scope, keys) {
    return el('th', { class: 'sel' }, el('input', {
      type: 'checkbox',
      checked: keys.every((k) => isSelected(scope, k)) ? true : null,
      onchange: (e) => {
        const on = e.target.checked;
        for (const k of keys) setSelected(scope, k, on);
        const table = e.target.closest('table');
        for (const box of table.querySelectorAll('td.sel input')) box.checked = on;
      },
    }));
  }

  // "29/10/26 21:23 (in 2h 15m)": absolute arrival plus the time left right now
  function arrivalText(ms, i18n) {
    if (!ms) return '-';
    const left = (ms - Date.now()) / 1000;
    const rel = left > 0 ? i18n.t('arrivalIn', { time: i18n.formatDuration(left) }) : i18n.t('done');
    return `${i18n.formatTime(ms)} (${rel})`;
  }

  // Arrival cell for tables: fixed date/time and a live countdown
  function arrivalCell(ms, i18n, countdown) {
    if (!ms) return el('td', { text: '-' });
    return el('td', { class: 'nowrap' }, [i18n.formatTime(ms), ' (', countdown(ms), ')']);
  }

  // `build()` returns (or resolves to) { title, fields: [{name, value}], reports?:
  // [{title, text, links?: [{label, url}]}], links?: [{label, url}] }: one embed field per
  // selected row, long texts (battle reports) as their own messages, and import
  // links (src/shared/intel-link.js) so other IkaDios users can open the items.
  // WhatsApp gets the same content as text.
  function shareBar({ i18n, scopeLabel, build }) {
    const { t } = i18n;
    const status = el('span', { class: 'hint' });
    const hasContent = (c) => c && ((c.fields || []).length || (c.reports || []).length);
    const prepare = async () => {
      status.textContent = t('sharePreparing');
      try {
        return await build();
      } catch (err) {
        status.textContent = t('discordFailedReason', { reason: String(err?.message || err) });
        return null;
      }
    };
    const discord = el('button', {
      class: 'refresh',
      text: t('sendToDiscord'),
      onclick: async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
          const content = await prepare();
          if (!content) return;
          if (!hasContent(content)) {
            status.textContent = t('shareNothingSelected');
            return;
          }
          const res = await chrome.runtime.sendMessage({
            type: 'ikadios:discordShare',
            share: { title: content.title, fields: (content.fields || []).slice(0, MAX_FIELDS), reports: content.reports || [], links: content.links || [] },
          });
          status.textContent = IkaDios.discordResultText(res, i18n);
        } catch (err) {
          status.textContent = t('discordFailedReason', { reason: String(err?.message || err) });
        } finally {
          button.disabled = false;
        }
      },
    });
    const whatsapp = el('button', {
      class: 'refresh whatsapp',
      text: t('shareWhatsApp'),
      onclick: async () => {
        // Opened right away so the browser keeps the click as its trigger; the
        // text is filled in when it is ready
        const win = window.open('about:blank', '_blank');
        const content = await prepare();
        if (!content || !hasContent(content)) {
          win?.close();
          if (content) status.textContent = t('shareNothingSelected');
          return;
        }
        const text = [
          `*${content.title}*`,
          ...(content.fields || []).map((f) => `*${f.name}*\n${f.value}`),
          ...(content.reports || []).map((r) => {
            const links = Array.isArray(r.links) ? r.links : r.link ? [{ url: r.link, label: r.linkLabel }] : [];
            return [`*${r.title}*\n${'```'}${r.text}${'```'}`, ...links.map((l) => `${l.label || ''}: ${l.url}`)].join('\n');
          }),
          ...(content.links || []).map((l) => `${l.label}: ${l.url}`),
        ].join('\n\n');
        const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
        if (win) {
          win.opener = null;
          win.location.href = url;
        } else window.open(url, '_blank', 'noopener');
        status.textContent = t('shareWhatsAppOpened');
      },
    });
    // Alliance bot channel (options): shown only when the bot is configured
    const alliance = el('button', {
      class: 'refresh',
      text: t('shareAlliance'),
      title: t('shareAllianceHint'),
      hidden: IkaDios.allianceAuto?.ready() ? null : true,
      onclick: async (e) => {
        const button = e.currentTarget;
        button.disabled = true;
        try {
          const content = await prepare();
          if (!content) return;
          if (!hasContent(content)) {
            status.textContent = t('shareNothingSelected');
            return;
          }
          const res = await IkaDios.allianceAuto.send({ title: content.title, fields: (content.fields || []).slice(0, MAX_FIELDS), reports: content.reports || [], links: content.links || [] });
          status.textContent = res?.ok ? t('shareAllianceSent') : t('discordFailedReason', { reason: res?.error || '?' });
        } finally {
          button.disabled = false;
        }
      },
    });
    const off = IkaDios.allianceAuto?.onChange((on) => {
      if (!alliance.isConnected) return off?.();
      alliance.hidden = !on;
    });
    return el('div', { class: 'map-toolbar share-bar' }, [el('strong', { text: scopeLabel }), discord, alliance, whatsapp, status]);
  }

  IkaDios.share = { isSelected, setSelected, rowCheck, headCheck, arrivalText, arrivalCell, shareBar };
})(typeof self !== 'undefined' ? self : window);
