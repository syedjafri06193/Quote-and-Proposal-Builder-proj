/* Rule authoring, simulation, approval, diff; governance health. */
const A = { versions: [], drafts: [] };

async function boot() {
  await initUserSwitcher(() => route());
  document.getElementById('new-draft').onclick = () =>
    run(async () => {
      const title = prompt('What is this change?', 'Adjust discount thresholds');
      if (!title) return;
      const d = await api('POST', '/api/rules/drafts', { title });
      location.hash = `#/draft/${d.id}`;
    }, 'Draft created from the current rule set');
  window.addEventListener('hashchange', route);
  await route();
}

async function loadSide() {
  [A.versions, A.drafts] = await Promise.all([api('GET', '/api/rules'), api('GET', '/api/rules/drafts')]);
  const h = location.hash;
  document.getElementById('versions').innerHTML = A.versions
    .slice()
    .reverse()
    .map(
      (v) => `<a class="qitem ${h === `#/v/${v.version}` ? 'on' : ''}" href="#/v/${v.version}"><div class="row1"><b>v${v.version}</b>${v.current ? '<span class="badge APPROVED">in force</span>' : ''}</div>
      <div class="acct">${esc(v.notes)}</div><div class="acct">effective ${when(v.effectiveFrom)} · approved by ${esc(userName(v.approvedBy))}</div></a>`,
    )
    .join('');
  document.getElementById('drafts').innerHTML =
    A.drafts
      .map(
        (d) => `<a class="qitem ${h === `#/draft/${d.id}` ? 'on' : ''}" href="#/draft/${d.id}"><div class="row1"><b>${esc(d.title)}</b><span class="badge ${d.state}">${d.state.replace('_', ' ')}</span></div>
      <div class="acct">by ${esc(userName(d.author))} · based on v${d.basedOnVersion}</div></a>`,
      )
      .join('') || '<div class="empty" style="padding:14px">No drafts.</div>';
}

async function route() {
  await loadSide();
  const h = location.hash;
  let m;
  if ((m = /^#\/v\/(\d+)/.exec(h))) return showVersion(Number(m[1]));
  if ((m = /^#\/draft\/(.+)/.exec(h))) return showDraft(m[1]);
  if (h === '#/health') return showHealth();
  const cur = A.versions.find((v) => v.current);
  if (cur) location.hash = `#/v/${cur.version}`;
}

function diffHtml(entries) {
  if (!entries.length) return '<p class="muted">No differences.</p>';
  return `<table><thead><tr><th>Path</th><th>Change</th><th>Before</th><th>After</th></tr></thead><tbody>${entries
    .map((e) => `<tr><td><code>${esc(e.path)}</code></td><td><span class="badge ${e.kind === 'removed' ? 'rejected' : e.kind === 'added' ? 'approved' : 'pending'}">${e.kind}</span></td><td><code>${esc(JSON.stringify(e.before) ?? '')}</code></td><td><code>${esc(JSON.stringify(e.after) ?? '')}</code></td></tr>`)
    .join('')}</tbody></table>`;
}

async function showVersion(v) {
  const rs = await api('GET', `/api/rules/${v}`);
  const meta = A.versions.find((x) => x.version === v);
  const prev = A.versions.find((x) => x.version === v - 1);
  const diff = prev ? await api('GET', `/api/rules/diff?a=${v - 1}&b=${v}`) : [];
  document.getElementById('detail').innerHTML = `
    <div class="titlebar"><h1>Rule set v${v}</h1>${meta.current ? '<span class="badge APPROVED">in force</span>' : ''}<span class="badge">immutable</span></div>
    <div class="sub">Published ${when(meta.publishedAt)} by ${esc(userName(meta.publishedBy))}, approved by ${esc(userName(meta.approvedBy))} · effective ${when(meta.effectiveFrom)} · hash <code>${meta.contentHash.slice(0, 16)}</code></div>
    <div class="grid" style="margin-bottom:12px">
      <div class="stat"><div class="k">Stacking</div><div class="v" style="font-size:15px">${rs.stacking.mode}</div></div>
      <div class="stat"><div class="k">Rounding</div><div class="v" style="font-size:15px">${rs.rounding.mode} @ ${rs.rounding.point}</div></div>
      <div class="stat"><div class="k">Stacking ceiling</div><div class="v" style="font-size:15px">${pct(rs.stacking.maxTotalBasisPoints)}</div></div>
      <div class="stat"><div class="k">Default floor</div><div class="v" style="font-size:15px">max ${pct(rs.floors.defaultMaxDiscountBp)} off</div></div>
    </div>
    <h3>Discount rules (applied in priority order)</h3>
    <div class="panel"><table><thead><tr><th>Priority</th><th>Rule</th><th>Effect</th><th>Stacks</th><th>When</th></tr></thead><tbody>${rs.discountRules
      .slice()
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((r) => `<tr><td class="num">${r.priority}</td><td><b>${esc(r.name)}</b><div class="muted"><code>${esc(r.id)}</code></div></td><td>${r.effect.type === 'percent' ? pct(r.effect.basisPoints) + ' off' : esc(r.effect.type + ' ' + r.effect.perUnit)}</td><td>${r.stackable ? 'yes' : 'no'}${r.stackGroup ? ` · group ${esc(r.stackGroup)}` : ''}</td><td class="muted" style="font-size:12.5px">${esc(describe(r.condition))}</td></tr>`)
      .join('')}</tbody></table></div>
    <h3>Approval rules</h3>
    <div class="panel"><table><thead><tr><th>Order</th><th>Rule</th><th>Approvers</th><th>When</th></tr></thead><tbody>${rs.approvalRules
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((r) => `<tr><td class="num">${r.order}</td><td><b>${esc(r.name)}</b><div class="muted">${esc(r.reason)}</div></td><td>${r.approvers.map((a) => esc(a.type === 'role' ? a.role : a.type === 'user' ? a.userId : `manager of ${a.userId}`)).join(r.mode === 'parallel' ? ' ∥ ' : ' → ')}</td><td class="muted" style="font-size:12.5px">${esc(describe(r.condition))}</td></tr>`)
      .join('')}</tbody></table>
      <p class="muted">Non-standard deals always require: ${rs.nonStandardApprovers.map((a) => esc(a.role ?? a.userId)).join(' → ')}. Escalation after ${rs.escalation.afterBusinessHours} business hours.</p></div>
    ${prev ? `<h3>Changes from v${v - 1}</h3><div class="panel">${diffHtml(diff)}</div>` : ''}
    <h3>Definition</h3><pre class="json">${esc(JSON.stringify(rs, null, 2))}</pre>`;
}

function describe(c) {
  switch (c.op) {
    case 'true':
      return 'always';
    case 'and':
      return c.terms.map(describe).join(' AND ');
    case 'or':
      return '(' + c.terms.map(describe).join(' OR ') + ')';
    case 'not':
      return `NOT (${describe(c.term)})`;
    case 'contains':
      return `${c.field} contains ${JSON.stringify(c.value)}`;
    case 'in':
      return `${c.field} in ${JSON.stringify(c.values)}`;
    default:
      return `${c.field} ${{ eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' }[c.op]} ${JSON.stringify(c.value)}`;
  }
}

async function showDraft(id) {
  const d = await api('GET', `/api/rules/drafts/${id}`);
  const editable = d.state === 'DRAFT' || d.state === 'SIMULATED' || d.state === 'REJECTED';
  const sim = d.simulation;
  document.getElementById('detail').innerHTML = `
    <div class="titlebar"><h1>${esc(d.title)}</h1><span class="badge ${d.state}">${d.state.replace('_', ' ')}</span></div>
    <div class="sub">Author ${esc(userName(d.author))} · based on v${d.basedOnVersion} · effective ${d.effectiveFrom === 'on-publish' ? 'when approved' : when(d.effectiveFrom)} · lifecycle: DRAFT → SIMULATED → PENDING APPROVAL → PUBLISHED</div>
    ${d.validation.errors.length ? `<div class="notice bad"><b>${d.validation.errors.length} validation error(s)</b> — must be fixed before simulation.<ul>${d.validation.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : '<div class="notice good">Validates: all conditions reference known fields with correct types.</div>'}
    ${d.validation.warnings.length ? `<div class="notice warn"><ul style="margin:0">${d.validation.warnings.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    ${sim ? simHtml(sim, d) : '<div class="notice info">Simulation is mandatory before approval: the draft is re-priced against recent quotes to measure revenue and approval-load impact.</div>'}
    <div class="actions">
      <button class="btn" id="simulate" ${editable ? '' : 'disabled'}>Simulate against recent quotes</button>
      <button class="btn primary" id="submit" ${d.state === 'SIMULATED' ? '' : 'disabled'}>Submit for approval</button>
      <button class="btn good" id="approve" ${d.state === 'PENDING_APPROVAL' ? '' : 'disabled'}>Approve &amp; publish</button>
      <button class="btn bad" id="reject" ${d.state === 'PENDING_APPROVAL' ? '' : 'disabled'}>Reject</button>
      ${d.publishedVersion ? `<a class="btn" href="#/v/${d.publishedVersion}">Published as v${d.publishedVersion} →</a>` : ''}
    </div>
    <h3>Changes from v${d.basedOnVersion}</h3><div class="panel">${diffHtml(d.diff)}</div>
    <h3>Definition ${editable ? '(edit and save — any edit invalidates the simulation)' : ''}</h3>
    <div class="grid" style="margin-bottom:8px"><label class="f">Effective from<input id="eff" value="${esc(d.effectiveFrom)}" ${editable ? '' : 'disabled'} placeholder="on-publish or ISO timestamp"></label></div>
    <textarea class="code" id="def" ${editable ? '' : 'readonly'}>${esc(JSON.stringify(d.definition, null, 2))}</textarea>
    <div class="actions"><button class="btn" id="save" ${editable ? '' : 'disabled'}>Save draft</button></div>
    <h3>History</h3><ul class="timeline">${d.history.map((h) => `<li><span class="t">${when(h.at)}</span><span><b>${esc(h.action)}</b></span><span>${esc(userName(h.actor))} <span class="muted">${esc(h.note ?? '')}</span></span></li>`).join('')}</ul>`;
  const $ = (x) => document.getElementById(x);
  $('save').onclick = () =>
    run(async () => {
      let def;
      try {
        def = JSON.parse($('def').value);
      } catch (e) {
        throw new Error('Definition is not valid JSON: ' + e.message);
      }
      await api('PATCH', `/api/rules/drafts/${id}`, { definition: def, effectiveFrom: $('eff').value.trim() || 'on-publish' });
      await route();
    }, 'Draft saved');
  $('simulate').onclick = () => run(async () => { await api('POST', `/api/rules/drafts/${id}/simulate`, { sampleSize: 200 }); await route(); }, 'Simulation complete');
  $('submit').onclick = () => run(async () => { await api('POST', `/api/rules/drafts/${id}/submit`, { note: prompt('Note for the pricing owner', '') ?? '' }); await route(); }, 'Submitted to the pricing owner');
  $('approve').onclick = () => run(async () => { await api('POST', `/api/rules/drafts/${id}/approve`, {}); await route(); }, 'Published');
  $('reject').onclick = () => run(async () => { await api('POST', `/api/rules/drafts/${id}/reject`, { note: prompt('Reason', '') ?? '' }); await route(); }, 'Rejected');
}

function simHtml(s, d) {
  const stale = d.simulatedHash !== d.contentHash;
  return `<div class="panel" style="margin:12px 0">
    <div class="row" style="justify-content:space-between"><b style="font-size:16px">${esc(s.headline)}</b>${stale ? '<span class="badge rejected">stale</span>' : ''}</div>
    <div class="totals">
      <div class="stat"><div class="k">Before</div><div class="v">${esc(s.totalBefore)}</div></div>
      <div class="stat"><div class="k">After</div><div class="v">${esc(s.totalAfter)}</div></div>
      <div class="stat hero"><div class="k">Revenue delta</div><div class="v">${esc(s.totalDelta)}</div></div>
      <div class="stat"><div class="k">Approval load</div><div class="v" style="font-size:15px">+${s.newlyRequiresApproval} / −${s.noLongerRequiresApproval}</div></div>
    </div>
    <details style="margin-top:10px"><summary>${s.sampleSize} quote(s): ${s.increased} up, ${s.decreased} down, ${s.unchanged} unchanged${s.errors ? `, ${s.errors} fail to price` : ''}</summary>
      <table><thead><tr><th>Quote</th><th class="r">Before</th><th class="r">After</th><th class="r">Delta</th><th class="r">Approval stages</th></tr></thead><tbody>${s.rows
        .map((r) => `<tr><td>Q-${r.quoteNumber} v${r.version}</td><td class="r money">${esc(r.before)}</td><td class="r money">${esc(r.after)}</td><td class="r money">${esc(r.delta)}</td><td class="r">${r.approvalStagesBefore} → ${r.approvalStagesAfter}${r.newlyRequiresApproval ? ' <span class="badge pending">more</span>' : ''}${r.error ? ` <span class="badge rejected">${esc(r.error)}</span>` : ''}</td></tr>`)
        .join('')}</tbody></table></details></div>`;
}

async function showHealth() {
  const [replay, cons, ns, flags, outbox] = await Promise.all([
    api('GET', '/api/admin/replay'),
    api('GET', '/api/admin/consistency'),
    api('GET', '/api/reports/non-standard'),
    api('GET', '/api/admin/flags'),
    api('GET', '/api/outbox'),
  ]);
  document.getElementById('detail').innerHTML = `
    <div class="titlebar"><h1>Governance health</h1></div>
    <div class="sub">The checks that make historical quotes trustworthy.</div>
    <div class="totals">
      <div class="stat ${replay.failures.length ? '' : 'hero'}"><div class="k">Replay</div><div class="v" style="font-size:15px">${replay.total - replay.failures.length}/${replay.total} reproduce</div></div>
      <div class="stat"><div class="k">State ⇔ event log</div><div class="v" style="font-size:15px">${cons.mismatches.length ? cons.mismatches.length + ' mismatch' : 'consistent'}</div></div>
      <div class="stat"><div class="k">Non-standard rate</div><div class="v" style="font-size:15px">${pct(ns.rateBp)} (${ns.nonStandard}/${ns.total})</div></div>
      <div class="stat"><div class="k">Review flags</div><div class="v" style="font-size:15px">${flags.length}</div></div>
    </div>
    ${replay.failures.length ? `<div class="notice bad">${replay.failures.map((f) => esc(`${f.quoteId} v${f.version}: ${f.error}`)).join('<br>')}</div>` : ''}
    <h3>Non-standard deals</h3><p class="muted">A rising rate in one area is a feature request for the rule model, with evidence attached.</p>
    <div class="panel">${ns.deals.length ? `<table><thead><tr><th>Quote</th><th>Reason</th><th>State</th><th class="r">Total</th></tr></thead><tbody>${ns.deals.map((d) => `<tr><td><a href="/#/q/${d.quoteId}">Q-${d.number}</a></td><td>${esc(d.reason)}</td><td><span class="badge ${d.state}">${d.state}</span></td><td class="r money">${esc(d.total)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">None.</p>'}
      <table style="margin-top:10px"><thead><tr><th>Month</th><th class="r">Quotes</th><th class="r">Non-standard</th></tr></thead><tbody>${ns.byMonth.map((m) => `<tr><td>${m.month}</td><td class="r">${m.total}</td><td class="r">${m.nonStandard}</td></tr>`).join('')}</tbody></table></div>
    <h3>Review flags</h3><div class="panel">${flags.length ? flags.map((f) => `<div><span class="badge rejected">${esc(f.kind)}</span> ${esc(f.ref)} — ${esc(f.message)} <span class="muted">${when(f.at)}</span></div>`).join('') : '<p class="muted">None.</p>'}</div>
    <h3>Outbox (downstream events)</h3><div class="panel">${outbox.length ? `<table><thead><tr><th>#</th><th>Topic</th><th>Idempotency key</th><th>Published</th></tr></thead><tbody>${outbox.map((o) => `<tr><td>${o.id}</td><td><code>${esc(o.topic)}</code></td><td><code>${esc(o.idempotencyKey)}</code></td><td>${when(o.publishedAt)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nothing published yet.</p>'}</div>`;
}

boot();
