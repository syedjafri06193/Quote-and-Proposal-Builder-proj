/* Quote builder UI. */
const B = { catalog: null, accounts: [], quotes: [], current: null, tab: 'trace', draft: null, route: 'quotes' };

async function boot() {
  await initUserSwitcher(() => refreshAll());
  [B.catalog, B.accounts] = await Promise.all([api('GET', '/api/catalog'), api('GET', '/api/accounts')]);
  document.getElementById('new-quote').onclick = () => newQuote();
  window.addEventListener('hashchange', route);
  await refreshAll();
}

async function refreshAll() {
  await loadList();
  await refreshInboxCount();
  await route();
}

async function refreshInboxCount() {
  const items = await api('GET', '/api/inbox');
  const el = document.getElementById('inbox-count');
  el.hidden = items.length === 0;
  el.textContent = items.length;
}

async function route() {
  const h = location.hash || '#/quotes';
  document.getElementById('nav-quotes').classList.toggle('on', h.startsWith('#/quotes') || h.startsWith('#/q/'));
  document.getElementById('nav-inbox').classList.toggle('on', h.startsWith('#/inbox'));
  if (h.startsWith('#/inbox')) return renderInbox();
  const m = /^#\/q\/([^/]+)/.exec(h);
  if (m) return openQuote(m[1]);
  if (h === '#/new') return;
  document.getElementById('detail').innerHTML = '<div class="empty">Select a quote or create a new one.</div>';
}

async function loadList() {
  B.quotes = await api('GET', '/api/quotes');
  const cur = B.current?.quote?.id;
  document.getElementById('quote-list').innerHTML =
    B.quotes
      .map(
        (q) => `<a class="qitem ${q.id === cur ? 'on' : ''}" href="#/q/${q.id}">
      <div class="row1"><b>Q-${q.number}</b><span class="badge ${q.state}">${q.state.replace('_', ' ')}</span></div>
      <div class="row1"><span class="acct">${esc(q.accountName)}${q.nonStandard ? ' · <span class="badge ns">non-std</span>' : ''}</span><span class="money">${esc(q.total)}</span></div>
    </a>`,
      )
      .join('') || '<div class="empty">No quotes yet.</div>';
}

// ───────────────────────── editing ─────────────────────────

function blankConfig() {
  const a = B.accounts[0];
  const today = new Date().toISOString().slice(0, 10);
  return {
    quoteType: 'standard',
    accountId: a.id,
    channel: 'direct',
    promoCodes: [],
    asOf: today,
    startDate: today,
    termMonths: 12,
    paymentTerms: { netDays: 30, method: 'ACH' },
    legalTermsVersion: 'std-2026.1',
    autoRenew: true,
    noticePeriodDays: 30,
    lines: [{ lineId: 'L1', productId: 'plat', quantity: '50' }],
    cover: { title: 'Proposal', intro: '', preparedFor: a.signer.name },
  };
}

function newQuote() {
  location.hash = '#/new';
  B.current = null;
  B.draft = blankConfig();
  loadList();
  renderEditor(true);
}

function products() {
  return B.catalog.priceBook.entries.filter((p) => p.active);
}

function renderEditor(isNew) {
  const d = B.draft;
  const ns = d.quoteType === 'non-standard';
  const acctOpts = B.accounts.map((a) => `<option value="${a.id}" ${a.id === d.accountId ? 'selected' : ''}>${esc(a.name)} (${a.segment})</option>`).join('');
  const prodOpts = (sel) => products().map((p) => `<option value="${p.productId}" ${p.productId === sel ? 'selected' : ''}>${esc(p.name)} · ${p.sku}</option>`).join('');
  const lines = d.lines
    .map(
      (l, i) => `<tr>
      <td>${
        ns
          ? `<input data-l="${i}" data-k="description" placeholder="Describe the item" value="${esc(l.description ?? '')}">`
          : `<select data-l="${i}" data-k="productId">${prodOpts(l.productId)}</select>`
      }</td>
      <td style="width:120px"><input data-l="${i}" data-k="quantity" inputmode="numeric" value="${esc(l.quantity)}"></td>
      ${
        ns
          ? `<td style="width:150px"><input data-l="${i}" data-k="manualUnitPrice" placeholder="unit price" value="${esc(l.manualUnitPrice ?? '')}"></td>
             <td style="width:130px"><select data-l="${i}" data-k="chargeType"><option value="one-time" ${l.chargeType !== 'recurring' ? 'selected' : ''}>one-time</option><option value="recurring" ${l.chargeType === 'recurring' ? 'selected' : ''}>recurring /yr</option></select></td>`
          : `<td style="width:110px"><input data-l="${i}" data-k="termMonths" inputmode="numeric" placeholder="quote term" value="${esc(l.termMonths ?? '')}"></td>
             <td style="width:120px"><input data-l="${i}" data-k="manualDiscountPct" inputmode="decimal" placeholder="0" value="${l.manualDiscountBp ? l.manualDiscountBp / 100 : ''}"></td>`
      }
      <td style="width:40px"><button class="btn small bad" data-rm="${i}" title="Remove line">✕</button></td>
    </tr>`,
    )
    .join('');
  const el = document.getElementById('detail');
  el.innerHTML = `
    <div class="titlebar"><h1>${isNew ? 'New quote' : `Edit Q-${B.current.quote.number}`}</h1>${ns ? '<span class="badge ns">non-standard</span>' : ''}</div>
    <div class="sub">${isNew ? 'Priced by the engine the moment you save. Saving an existing quote creates a new version; nothing is ever overwritten.' : 'Saving creates version ' + (B.current.version.version + 1) + '. Cover-letter-only edits keep existing approvals.'}</div>
    <div class="panel">
      <div class="grid">
        <label class="f">Account<select id="f-account" ${isNew ? '' : 'disabled'}>${acctOpts}</select></label>
        <label class="f">Channel<select id="f-channel">${['direct', 'partner-gold', 'partner-silver'].map((c) => `<option ${c === d.channel ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="f">Promo codes<input id="f-promo" value="${esc(d.promoCodes.join(', '))}" placeholder="e.g. Q4-2026"></label>
        <label class="f">Pricing date<input id="f-asof" type="date" value="${d.asOf}"></label>
        <label class="f">Start date<input id="f-start" type="date" value="${d.startDate}"></label>
        <label class="f">Term (months)<input id="f-term" inputmode="numeric" value="${d.termMonths}"></label>
        <label class="f">Payment (net days)<input id="f-net" inputmode="numeric" value="${d.paymentTerms.netDays}"></label>
        <label class="f">Legal terms<input id="f-legal" value="${esc(d.legalTermsVersion)}"></label>
        <label class="f">Order discount %<input id="f-orderdisc" inputmode="decimal" value="${d.orderManualDiscountBp ? d.orderManualDiscountBp / 100 : ''}" placeholder="0"></label>
        <label class="f">Auto-renew<select id="f-renew"><option value="1" ${d.autoRenew ? 'selected' : ''}>Yes</option><option value="0" ${!d.autoRenew ? 'selected' : ''}>No</option></select></label>
      </div>
      ${
        isNew
          ? `<label style="display:block;margin-top:12px"><input type="checkbox" id="f-ns" ${ns ? 'checked' : ''}> Non-standard deal <span class="muted">— for deals the pricing model can't express. Manual prices, always routed to the top approval tier, flagged permanently.</span></label>`
          : ''
      }
      ${ns ? `<label class="f" style="margin-top:10px">Why can't the standard model express this deal?<textarea id="f-nsreason">${esc(d.nonStandardReason ?? '')}</textarea></label>` : ''}
      <h3>Line items</h3>
      <table class="lines"><thead><tr><th>${ns ? 'Description' : 'Product'}</th><th>Qty</th>${ns ? '<th>Unit price</th><th>Charge</th>' : '<th>Term (mo)</th><th>Rep discount %</th>'}<th></th></tr></thead><tbody>${lines}</tbody></table>
      <button class="btn small" id="add-line" style="margin-top:8px">+ Add line</button>
      <h3>Cover letter <span style="text-transform:none;letter-spacing:0">(cosmetic — not part of the approval fingerprint)</span></h3>
      <div class="grid">
        <label class="f">Title<input id="f-title" value="${esc(d.cover.title)}"></label>
        <label class="f">Prepared for<input id="f-prepared" value="${esc(d.cover.preparedFor)}"></label>
        <label class="f wide">Intro<textarea id="f-intro">${esc(d.cover.intro)}</textarea></label>
      </div>
      <div class="actions">
        <button class="btn primary" id="save">${isNew ? 'Create & price' : 'Save new version'}</button>
        ${isNew ? '' : '<button class="btn" id="cancel">Cancel</button>'}
      </div>
    </div>`;

  const read = () => {
    const v = (id) => document.getElementById(id)?.value;
    d.accountId = v('f-account');
    d.channel = v('f-channel');
    d.promoCodes = v('f-promo').split(',').map((s) => s.trim()).filter(Boolean);
    d.asOf = v('f-asof');
    d.startDate = v('f-start');
    d.termMonths = Number(v('f-term'));
    d.paymentTerms = { ...d.paymentTerms, netDays: Number(v('f-net')) };
    d.legalTermsVersion = v('f-legal');
    d.autoRenew = v('f-renew') === '1';
    const od = v('f-orderdisc');
    if (od) d.orderManualDiscountBp = Math.round(Number(od) * 100);
    else delete d.orderManualDiscountBp;
    d.cover = { title: v('f-title'), intro: v('f-intro'), preparedFor: v('f-prepared') };
    if (document.getElementById('f-nsreason')) d.nonStandardReason = v('f-nsreason');
    el.querySelectorAll('[data-l]').forEach((inp) => {
      const l = d.lines[Number(inp.dataset.l)];
      const k = inp.dataset.k;
      const val = inp.value.trim();
      if (k === 'termMonths') val ? (l.termMonths = Number(val)) : delete l.termMonths;
      else if (k === 'manualDiscountPct') val && Number(val) > 0 ? (l.manualDiscountBp = Math.round(Number(val) * 100)) : delete l.manualDiscountBp;
      else if (k === 'manualUnitPrice') val ? (l.manualUnitPrice = val) : delete l.manualUnitPrice;
      else l[k] = val;
    });
  };
  el.querySelector('#add-line').onclick = () => {
    read();
    const n = Math.max(0, ...d.lines.map((l) => Number(String(l.lineId).replace(/\D/g, '')) || 0)) + 1;
    d.lines.push(ns ? { lineId: `L${n}`, productId: `custom-${n}`, quantity: '1', description: '', manualUnitPrice: '', chargeType: 'one-time' } : { lineId: `L${n}`, productId: products()[0].productId, quantity: '1' });
    renderEditor(isNew);
  };
  el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => {
    read();
    d.lines.splice(Number(b.dataset.rm), 1);
    renderEditor(isNew);
  }));
  const nsBox = el.querySelector('#f-ns');
  if (nsBox)
    nsBox.onchange = () => {
      read();
      d.quoteType = nsBox.checked ? 'non-standard' : 'standard';
      d.lines = nsBox.checked ? [{ lineId: 'L1', productId: 'custom-1', quantity: '1', description: '', manualUnitPrice: '', chargeType: 'one-time' }] : [{ lineId: 'L1', productId: 'plat', quantity: '50' }];
      renderEditor(isNew);
    };
  const acctSel = el.querySelector('#f-account');
  acctSel.onchange = () => {
    read();
    d.cover.preparedFor = B.accounts.find((a) => a.id === acctSel.value)?.signer.name ?? '';
    renderEditor(isNew);
  };
  el.querySelector('#save').onclick = () =>
    run(async () => {
      read();
      const view = isNew ? await api('POST', '/api/quotes', d) : await api('PATCH', `/api/quotes/${B.current.quote.id}`, d);
      location.hash = `#/q/${view.quote.id}`;
      await loadList();
      await openQuote(view.quote.id, true);
    }, isNew ? 'Quote created and priced' : 'New version saved');
  const cancel = el.querySelector('#cancel');
  if (cancel) cancel.onclick = () => openQuote(B.current.quote.id, true);
}

// ───────────────────────── viewing ─────────────────────────

async function openQuote(id, force = false, version) {
  if (!force && B.current?.quote?.id === id && version === undefined && document.querySelector('[data-quote-view]')) return;
  B.current = await api('GET', `/api/quotes/${id}${version ? `?version=${version}` : ''}`);
  await loadList();
  renderQuote();
}

function renderQuote() {
  const c = B.current;
  const q = c.quote;
  const p = c.priced;
  const latest = Math.max(...c.versions);
  const isLatest = c.version.version === latest;
  const st = q.state;
  const can = {
    edit: isLatest && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'].includes(st),
    submit: isLatest && st === 'DRAFT',
    recall: ['PENDING_APPROVAL', 'APPROVED', 'SENT', 'VIEWED'].includes(st),
    send: isLatest && st === 'APPROVED',
    reprice: isLatest && ['DRAFT', 'REJECTED', 'APPROVED', 'PENDING_APPROVAL'].includes(st),
  };
  const warnings = p.warnings.length ? `<div class="notice warn"><b>Floor / ceiling adjustments.</b> ${p.warnings.map(esc).join('<br>')}</div>` : '';
  const fpStale = c.approvals.plan && !c.approvals.fingerprintCurrent;
  const acct = B.accounts.find((a) => a.id === q.accountId);
  document.getElementById('detail').innerHTML = `
    <div data-quote-view class="titlebar">
      <h1>Q-${q.number}</h1><span class="badge ${st}">${st.replace('_', ' ')}</span>
      ${q.nonStandard ? '<span class="badge ns">non-standard</span>' : ''}
      <span class="muted">·</span>
      <select id="ver">${c.versions.map((v) => `<option value="${v}" ${v === c.version.version ? 'selected' : ''}>v${v}${v === latest ? ' (latest)' : ''}</option>`).join('')}</select>
    </div>
    <div class="sub">${esc(acct?.name ?? q.accountId)} · owner ${esc(userName(q.ownerId))} · priced ${when(c.version.pricedAt)} under rule set <b>v${p.ruleSetVersion}</b>, price book v${p.priceBookVersion} · fingerprint <code>${c.version.approvalFingerprint.slice(0, 12)}</code></div>
    ${!isLatest ? '<div class="notice info">You are viewing a historical version. It shows exactly what was priced then — reading never re-prices.</div>' : ''}
    ${fpStale && ['DRAFT', 'REJECTED'].includes(st) ? '<div class="notice bad">Material terms changed since this quote was submitted. Existing approvals no longer apply to these numbers; resubmit for approval.</div>' : ''}
    ${warnings}
    <div class="totals">
      <div class="stat"><div class="k">List</div><div class="v">${money(p.listTotal)}</div></div>
      <div class="stat"><div class="k">Discount</div><div class="v">${pct(p.totalDiscountBasisPoints)}</div></div>
      <div class="stat"><div class="k">Order discount</div><div class="v">${money(p.orderDiscount)}</div></div>
      <div class="stat hero"><div class="k">Total (excl. tax)</div><div class="v">${money(p.total)}</div></div>
    </div>
    <div class="actions">
      <button class="btn" id="a-edit" ${can.edit ? '' : 'disabled'}>Edit…</button>
      <button class="btn" id="a-reprice" ${can.reprice ? '' : 'disabled'} title="Re-price under the current rule set as a new version">Reprice</button>
      <button class="btn primary" id="a-submit" ${can.submit ? '' : 'disabled'}>Submit for approval</button>
      <button class="btn good" id="a-send" ${can.send ? '' : 'disabled'}>Send for signature</button>
      <button class="btn" id="a-recall" ${can.recall ? '' : 'disabled'}>Recall</button>
      <button class="btn" id="a-clone">Clone</button>
      <a class="btn" href="/api/quotes/${q.id}/document.pdf?version=${c.version.version}" target="_blank">Proposal PDF ↗</a>
    </div>
    <div class="tabs">${['trace:Price trace', 'lines:Lines', 'approvals:Approvals', 'document:Document', 'signature:Signature', 'contract:Contract', 'events:Audit log']
      .map((t) => {
        const [k, l] = t.split(':');
        return `<button data-tab="${k}" class="${B.tab === k ? 'on' : ''}">${l}</button>`;
      })
      .join('')}</div>
    <div id="tab"></div>`;

  const $ = (id) => document.getElementById(id);
  $('ver').onchange = (e) => openQuote(q.id, true, Number(e.target.value));
  $('a-edit').onclick = () => {
    B.draft = structuredClone(c.version.config);
    renderEditor(false);
  };
  $('a-reprice').onclick = () => run(async () => {
    await api('POST', `/api/quotes/${q.id}/reprice`);
    await openQuote(q.id, true);
  }, 'Repriced as a new version');
  $('a-submit').onclick = () => {
    const note = prompt('Note for approvers (why this deal needs what it asks for):', '') ?? null;
    if (note === null) return;
    run(async () => {
      await api('POST', `/api/quotes/${q.id}/submit`, { note });
      B.tab = 'approvals';
      await openQuote(q.id, true);
      await refreshInboxCount();
    }, 'Submitted');
  };
  $('a-send').onclick = () => run(async () => {
    await api('POST', `/api/quotes/${q.id}/send`);
    B.tab = 'signature';
    await openQuote(q.id, true);
  }, 'Sent for signature');
  $('a-recall').onclick = () => run(async () => {
    await api('POST', `/api/quotes/${q.id}/recall`, { reason: 'recalled by rep' });
    await openQuote(q.id, true);
  }, 'Recalled to draft');
  $('a-clone').onclick = () => run(async () => {
    const v = await api('POST', `/api/quotes/${q.id}/clone`);
    location.hash = `#/q/${v.quote.id}`;
  }, 'Cloned into a new draft');
  document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
    B.tab = b.dataset.tab;
    renderQuote();
  }));
  renderTab();
}

function renderTab() {
  const el = document.getElementById('tab');
  const c = B.current;
  const p = c.priced;
  switch (B.tab) {
    case 'trace':
      return (el.innerHTML = traceHtml(p));
    case 'lines':
      return (el.innerHTML = `<div class="panel"><table><thead><tr><th>Line</th><th>Item</th><th class="r">Qty</th><th class="r">Term</th><th class="r">List</th><th class="r">Unit (eff.)</th><th class="r">Disc.</th><th class="r">Net</th><th>Billing</th></tr></thead><tbody>${p.lines
        .map(
          (l) => `<tr><td>${esc(l.lineId)}</td><td><b>${esc(l.name)}</b><div class="muted" style="font-size:12px">${esc(l.sku)}${l.appliedRuleIds.length ? ' · rules: ' + l.appliedRuleIds.map(esc).join(', ') : ''}</div></td>
            <td class="r num">${l.quantity}</td><td class="r num">${l.chargeType === 'recurring' ? l.termMonths + ' mo' : '—'}</td>
            <td class="r money">${money(l.listExtended)}</td><td class="r money">${money(l.unitPrice)}${l.chargeType === 'recurring' ? '/yr' : ''}</td>
            <td class="r num">${pct(l.totalDiscountBasisPoints)}${l.floorClamped ? ' <span class="badge pending">floor</span>' : ''}</td><td class="r money"><b>${money(l.net)}</b></td>
            <td>${l.billingFrequency} · ${l.recognitionMethod}</td></tr>`,
        )
        .join('')}</tbody></table><p class="muted" style="margin:10px 0 0">Tax: ${p.tax.status} to the tax provider — never computed here.</p></div>`);
    case 'approvals':
      return renderApprovals(el);
    case 'document':
      return (el.innerHTML = `<p class="muted">Deterministic PDF: generating this version again produces byte-identical output. Signature fields are placed by anchor text.</p>
        ${c.documents.length ? `<table style="margin-bottom:12px"><thead><tr><th>Version</th><th>Template</th><th>SHA-256</th><th>Content ref</th><th>Generated</th></tr></thead><tbody>${c.documents.map((d) => `<tr><td>v${d.quoteVersion}</td><td>v${d.templateVersion}</td><td><code>${d.sha256.slice(0, 16)}…</code></td><td><code>${d.contentHash.slice(0, 16)}…</code></td><td>${when(d.generatedAt)}</td></tr>`).join('')}</tbody></table>` : ''}
        <iframe class="pdf" src="/api/quotes/${c.quote.id}/document.pdf?version=${c.version.version}"></iframe>`);
    case 'signature':
      return renderSignature(el);
    case 'contract':
      if (!c.hasContract) return (el.innerHTML = '<div class="empty">The structured contract is emitted when the signed document is verified.</div>');
      return api('GET', `/api/quotes/${c.quote.id}/contract`).then((k) => {
        el.innerHTML = `<div class="notice good">Executed contract <b>${esc(k.contractId)}</b> published as <code>contract.executed</code>. Billing ingests this, not the PDF. <a href="/api/quotes/${c.quote.id}/signed.pdf" target="_blank">Signed PDF ↗</a></div><pre class="json">${esc(JSON.stringify(k, null, 2))}</pre>`;
      });
    case 'events':
      return api('GET', `/api/quotes/${c.quote.id}/events`).then((evs) => {
        el.innerHTML = `<div class="row" style="justify-content:space-between"><p class="muted">Append-only. The quote's state is the fold of this log.</p><a class="btn small" href="/api/quotes/${c.quote.id}/audit" target="_blank">Audit export (JSON) ↗</a></div>
          <ul class="timeline">${evs
            .slice()
            .reverse()
            .map((e) => `<li><span class="t">${when(e.occurredAt)}</span><span><b>${esc(e.type)}</b>${e.quoteVersion ? ` <span class="muted">v${e.quoteVersion}</span>` : ''}</span><span>${esc(userName(e.actor))} <span class="muted">${esc(summarizePayload(e.payload))}</span></span></li>`)
            .join('')}</ul>`;
      });
  }
}

function summarizePayload(p) {
  const bits = [];
  for (const [k, v] of Object.entries(p || {})) {
    if (v === null || v === '' || typeof v === 'object') continue;
    bits.push(`${k}=${v}`);
  }
  return bits.join(' · ');
}

function traceHtml(p) {
  const lineBlocks = p.lines
    .map((l) => {
      const entries = p.trace.filter((t) => t.lineId === l.lineId);
      const list = Number(entries.find((t) => t.stage === 'base-price')?.after?.amount ?? 1) || 1;
      const rows = entries
        .map((t) => {
          const skip = t.inputs && t.inputs.applied === false;
          const d = t.delta ? Number(t.delta.amount) : 0;
          const a = t.after ? Number(t.after.amount) : null;
          const cls = t.stage === 'floors' && t.inputs.floorClamped ? 'floor' : '';
          const label = t.ruleName || { 'base-price': 'List price', floors: 'Floor check', rounding: 'Rounding', 'order-level': 'Order discount' }[t.stage] || t.stage;
          return `<div class="wf-row ${skip ? 'skip' : ''} ${cls}">
            <div class="lbl">${esc(label)}</div>
            <div class="expl">${t.ruleId ? `<code>${esc(t.ruleId)}</code> ` : ''}${esc(t.explanation)}</div>
            <div class="d ${d < 0 ? 'neg' : d > 0 && t.stage !== 'base-price' ? 'pos' : ''}">${t.delta && !skip ? money(t.delta) : ''}</div>
            <div class="a">${a !== null && !skip ? money(t.after) : ''}${a !== null && !skip ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, (a / list) * 100))}%"></i></div>` : ''}</div>
          </div>`;
        })
        .join('');
      return `<div class="wf panel"><div class="lh"><div><b>${esc(l.name)}</b> <span class="muted">× ${l.quantity}${l.chargeType === 'recurring' ? ` · ${l.termMonths} months` : ''}</span></div>${l.floorClamped ? '<span class="badge pending">clamped to floor</span>' : ''}</div>
        ${rows}
        <div class="wf-row net"><div class="lbl">Net</div><div class="expl">${pct(l.totalDiscountBasisPoints)} off list · effective ${money(l.unitPrice)}${l.chargeType === 'recurring' ? '/unit/yr' : '/unit'}</div><div></div><div class="a">${money(l.net)}</div></div>
      </div>`;
    })
    .join('');
  const order = p.trace.filter((t) => !t.lineId && t.stage !== 'configure');
  const cfg = p.trace.find((t) => t.stage === 'configure');
  return `<p class="muted">${esc(cfg?.explanation ?? '')}. Every number below is replayable: the same inputs and rule set produce the same trace, forever.</p>${lineBlocks}
    <div class="panel"><div class="lh" style="margin-bottom:6px"><b>Order level</b></div>${order
      .map((t) => `<div class="wf-row"><div class="lbl">${esc(t.ruleName || t.stage)}</div><div class="expl">${esc(t.explanation)}</div><div class="d ${t.delta && Number(t.delta.amount) < 0 ? 'neg' : ''}">${t.delta ? money(t.delta) : ''}</div><div class="a">${t.after ? money(t.after) : ''}</div></div>`)
      .join('')}</div>`;
}

function renderApprovals(el) {
  const a = B.current.approvals;
  const q = B.current.quote;
  if (!a.plan) {
    el.innerHTML = `<div class="empty">Not submitted yet. When submitted, the required approvers are resolved from rule set v${B.current.priced.ruleSetVersion} and the plan is stored with the quote.</div>`;
    return;
  }
  const plan = a.plan;
  el.innerHTML = `
    <div class="notice info"><b>Context for approvers:</b> ${esc(plan.plan.summary)}${plan.repNote ? `<br><b>Rep's note:</b> ${esc(plan.repNote)}` : ''}</div>
    ${!a.fingerprintCurrent ? '<div class="notice bad">This plan was approved against different numbers (fingerprint mismatch). It cannot be used to send.</div>' : ''}
    <p class="muted">Submitted ${when(plan.submittedAt)} by ${esc(userName(plan.submittedBy))} for v${plan.quoteVersion}. Stages run in sequence; approvals within a stage run in parallel. Each decision records the fingerprint <code>${plan.plan.fingerprint.slice(0, 12)}</code> it approved.</p>
    ${
      a.stages.length === 0
        ? '<div class="notice good">No approval required by policy — auto-approved.</div>'
        : a.stages
            .map(
              (st) => `<div class="stage"><div class="sh"><b>Stage ${st.index + 1}</b><span class="badge ${st.status}">${st.status}</span>${st.slots.length > 1 ? '<span class="muted">parallel</span>' : ''}</div>
          ${st.slots
            .map((s) => {
              const eligible = [...s.eligibleUserIds, ...s.escalatedTo];
              const canAct = st.status === 'active' && s.status === 'pending' && q.state === 'PENDING_APPROVAL' && S.user !== q.ownerId;
              return `<div class="slot"><div><b>${esc(s.ruleName)}</b> <span class="badge ${s.status}">${s.status}</span>
                  <div class="who">${esc(s.reason)}</div>
                  <div class="who">Approver: ${esc(s.label)} — ${eligible.map((u) => esc(userName(u))).join(', ')}${s.escalatedTo.length ? ` <span class="badge pending">escalated</span>` : ''}</div>
                  ${s.decidedBy ? `<div class="who">Decided by ${esc(userName(s.decidedBy))}${s.onBehalfOf ? ` on behalf of ${esc(userName(s.onBehalfOf))} (delegation)` : ''}${s.conditions ? ` — condition: <b>${esc(s.conditions)}</b>` : ''}</div>` : ''}
                </div>
                <div class="decide">${
                  canAct
                    ? `<input placeholder="comment / conditions" data-c="${s.slotId}"><button class="btn small good" data-d="approved" data-s="${s.slotId}">Approve</button><button class="btn small" data-d="conditional" data-s="${s.slotId}">Approve with conditions</button><button class="btn small bad" data-d="rejected" data-s="${s.slotId}">Reject</button>`
                    : ''
                }</div></div>`;
            })
            .join('')}</div>`,
            )
            .join('')
    }
    <div class="row" style="margin-top:12px"><button class="btn small" id="run-esc">Run escalation check</button><span class="muted">Escalates slots waiting longer than the policy's business hours to the approver's manager.</span></div>`;
  el.querySelectorAll('[data-d]').forEach(
    (b) =>
      (b.onclick = () => {
        const txt = el.querySelector(`[data-c="${b.dataset.s}"]`).value;
        const body = { decision: b.dataset.d };
        if (b.dataset.d === 'conditional') body.conditions = txt;
        else if (txt) body.comment = txt;
        run(async () => {
          await api('POST', `/api/quotes/${q.id}/approvals/${b.dataset.s}`, body);
          await openQuote(q.id, true);
          await refreshInboxCount();
        }, 'Decision recorded');
      }),
  );
  el.querySelector('#run-esc').onclick = () => run(async () => {
    const r = await api('POST', '/api/escalations/run');
    toast(r.length ? `Escalated ${r.length} slot(s)` : 'Nothing due for escalation');
    await openQuote(q.id, true);
  });
}

async function renderSignature(el) {
  const c = B.current;
  const fake = await api('GET', '/api/esign/fake/envelopes').catch(() => null);
  const envs = c.envelopes;
  el.innerHTML = `
    ${envs.length === 0 ? '<div class="empty">Not sent yet. Sending checks the approval fingerprint, generates the PDF, and creates one envelope per (quote, version, document hash) — retries never double-send.</div>' : ''}
    ${envs
      .map(
        (e) => `<div class="stage"><div class="sh"><b>${esc(e.id)}</b><span class="badge ${e.state}">${e.state}</span><span class="muted">${esc(e.provider)} ${esc(e.providerId ?? '')} · v${e.quoteVersion}</span></div>
        <div class="who muted">Idempotency key <code>${e.idempotencyKey.slice(0, 16)}…</code> · recipients: ${e.recipients.map((r) => `${esc(r.name)} (${esc(r.status)})`).join(', ')}${e.declineReason ? ` · declined: ${esc(e.declineReason)}` : ''}</div>
        ${
          fake && e.providerId && !['completed', 'declined', 'voided', 'expired', 'mismatch'].includes(e.state)
            ? `<div class="decide" style="margin-top:8px"><span class="muted">Simulate the signer:</span>
              ${['view', 'sign', 'decline', 'expire', 'tamper'].map((a) => `<button class="btn small ${a === 'sign' ? 'good' : a === 'decline' || a === 'tamper' ? 'bad' : ''}" data-fa="${a}" data-pid="${e.providerId}">${a}</button>`).join('')}</div>`
            : ''
        }
      </div>`,
      )
      .join('')}
    ${
      fake
        ? `<div class="panel" style="margin-top:12px"><div class="row"><label class="row" style="gap:6px"><input type="checkbox" id="drop" ${fake.dropWebhooks ? 'checked' : ''}> Drop webhooks (simulate an outage)</label>
        <span class="muted">${fake.dropped} dropped</span>
        <button class="btn small" id="reconcile">Run reconciliation poll</button>
        <button class="btn small" id="redeliver">Redeliver dropped</button></div>
        <p class="muted" style="margin:8px 0 0">Webhooks are the fast path; the poller (every 15 minutes on the server) is the safety net. Drift found by the poller is logged — a rising rate means the webhook endpoint is broken.</p></div>`
        : ''
    }`;
  el.querySelectorAll('[data-fa]').forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          const body = b.dataset.fa === 'decline' ? { reason: prompt('Decline reason', 'Pricing too high') || 'Declined' } : {};
          await api('POST', `/api/esign/fake/${b.dataset.pid}/${b.dataset.fa}`, body);
          await openQuote(c.quote.id, true);
        }, `Signer: ${b.dataset.fa}`)),
  );
  const drop = el.querySelector('#drop');
  if (drop) drop.onchange = () => run(async () => api('POST', '/api/esign/fake/drop', { drop: drop.checked }), drop.checked ? 'Webhooks will be dropped' : 'Webhooks restored');
  const rec = el.querySelector('#reconcile');
  if (rec)
    rec.onclick = () =>
      run(async () => {
        const r = await api('POST', '/api/esign/reconcile?olderThanMinutes=0');
        toast(r.drifted.length ? `Drift fixed: ${r.drifted.map((d) => `${d.envelopeId} ${d.local}→${d.remote}`).join(', ')}` : `Checked ${r.checked} envelope(s): in sync`);
        await openQuote(c.quote.id, true);
      });
  const red = el.querySelector('#redeliver');
  if (red)
    red.onclick = () =>
      run(async () => {
        await api('POST', '/api/esign/fake/redeliver');
        await openQuote(c.quote.id, true);
      }, 'Redelivered');
}

// ───────────────────────── inbox ─────────────────────────

async function renderInbox() {
  const items = await api('GET', '/api/inbox');
  const el = document.getElementById('detail');
  el.innerHTML = `<div class="titlebar"><h1>Approvals for ${esc(userName(S.user))}</h1></div>
    <div class="sub">Requests you can act on now, including those delegated to you or escalated to you.</div>
    ${
      items.length
        ? items
            .map(
              (i) => `<div class="stage"><div class="sh"><a href="#/q/${i.quoteId}"><b>Q-${i.number}</b></a><span>${esc(i.account)}</span><span class="money">${esc(i.total)}</span>${i.viaDelegation ? `<span class="badge conditional">for ${esc(userName(i.viaDelegation))}</span>` : ''}</div>
          <div><b>${esc(i.label)}</b> — ${esc(i.reason)}</div><div class="muted">${esc(i.summary)}</div>${i.repNote ? `<div class="muted">Rep: “${esc(i.repNote)}”</div>` : ''}
          <div class="decide" style="margin-top:8px"><button class="btn small good" data-q="${i.quoteId}" data-s="${i.slotId}" data-d="approved">Approve</button><a class="btn small" href="#/q/${i.quoteId}">Open quote</a></div></div>`,
            )
            .join('')
        : '<div class="empty">Nothing waiting on you.</div>'
    }
    <h3>Delegate while away</h3>
    <div class="panel row"><select id="dl-to">${S.users.filter((u) => u.id !== S.user).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>
      <label class="row">until <input type="date" id="dl-until" value="${new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)}"></label>
      <input id="dl-reason" placeholder="reason (e.g. vacation)"><button class="btn small" id="dl-go">Delegate</button></div>`;
  el.querySelectorAll('[data-d]').forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await api('POST', `/api/quotes/${b.dataset.q}/approvals/${b.dataset.s}`, { decision: 'approved' });
          await renderInbox();
          await refreshInboxCount();
          await loadList();
        }, 'Approved')),
  );
  el.querySelector('#dl-go').onclick = () =>
    run(
      () => api('POST', '/api/delegations', { toUserId: el.querySelector('#dl-to').value, until: el.querySelector('#dl-until').value + 'T23:59:59Z', reason: el.querySelector('#dl-reason').value }),
      'Delegation recorded',
    );
}

boot();
