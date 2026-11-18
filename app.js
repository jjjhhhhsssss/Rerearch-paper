'use strict';

const MAX_KW = 5;
const KW_COLORS = ['var(--kw0)', 'var(--kw1)', 'var(--kw2)', 'var(--kw3)', 'var(--kw4)'];
const KW_HEX = ['#2456c9', '#b0451f', '#1f7a4d', '#7a3fb0', '#a0326e']; // PDF용 고정색
const SEL_KEY = 'paperSearch.selected.v1';

const $ = id => document.getElementById(id);
const el = {
  form: $('searchForm'), kwBox: $('kwBox'), kwChips: $('kwChips'), kwInput: $('kwInput'),
  srcEpmc: $('srcEpmc'), srcOa: $('srcOa'), yearFrom: $('yearFrom'), size: $('size'), oaOnly: $('oaOnly'),
  searchBtn: $('searchBtn'), scholarLink: $('scholarLink'),
  area: $('resultsArea'), empty: $('emptyState'), filterChips: $('filterChips'), matchSeg: $('matchSeg'),
  titleOnly: $('titleOnly'), sort: $('sort'), status: $('status'), results: $('results'),
  tray: $('tray'), trayToggle: $('trayToggle'), trayCount: $('trayCount'), trayList: $('trayList'),
  clearSel: $('clearSel'), exportPdf: $('exportPdf'),
};

const state = {
  keywords: [],          // 입력 중인 키워드
  searched: [],          // 마지막으로 검색한 키워드
  papers: new Map(),     // key -> paper
  titleIndex: new Map(), // 정규화 제목 -> key
  active: new Set(),     // 필터에서 켜진 키워드
  view: 'merged',
  match: 'any',
  selected: loadSelected(), // key -> snapshot
};

/* ---------- 유틸 ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = s => String(s || '').toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');

function highlight(text, kws) {
  let h = esc(text);
  const list = kws.filter(Boolean).map(k => esc(k)).sort((a, b) => b.length - a.length);
  if (!list.length) return h;
  const re = new RegExp('(' + list.map(reEsc).join('|') + ')', 'gi');
  return h.replace(re, '<mark>$1</mark>');
}

function loadSelected() {
  try {
    const raw = localStorage.getItem(SEL_KEY);
    return new Map(raw ? JSON.parse(raw) : []);
  } catch { return new Map(); }
}
function saveSelected() {
  try { localStorage.setItem(SEL_KEY, JSON.stringify([...state.selected])); } catch { /* 저장 불가 환경 */ }
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ---------- 키워드 입력 ---------- */
function addKeywords(text) {
  const parts = text.split(/[,\n]/).map(s => s.replace(/["]/g, '').trim()).filter(Boolean);
  for (const p of parts) {
    if (state.keywords.length >= MAX_KW) break;
    if (!state.keywords.some(k => k.toLowerCase() === p.toLowerCase())) state.keywords.push(p);
  }
  renderKwChips();
}
function renderKwChips() {
  el.kwChips.innerHTML = state.keywords.map((k, i) =>
    `<span class="chip" style="--c:${KW_COLORS[i]}">${esc(k)}<button type="button" data-i="${i}" aria-label="${esc(k)} 삭제">×</button></span>`
  ).join('');
  el.kwInput.placeholder = state.keywords.length >= MAX_KW ? '최대 5개' : (state.keywords.length ? '키워드 추가' : '예: quality control, defect detection, machine vision');
  updateScholarLink(state.keywords);
}
el.kwChips.addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  state.keywords.splice(+b.dataset.i, 1);
  renderKwChips();
  el.kwInput.focus();
});
el.kwInput.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ',') && el.kwInput.value.trim()) {
    e.preventDefault();
    addKeywords(el.kwInput.value);
    el.kwInput.value = '';
  } else if (e.key === 'Backspace' && !el.kwInput.value && state.keywords.length) {
    state.keywords.pop();
    renderKwChips();
  }
});
el.kwInput.addEventListener('paste', e => {
  const t = (e.clipboardData || window.clipboardData).getData('text');
  if (/[,\n]/.test(t)) { e.preventDefault(); addKeywords(t); }
});
el.kwBox.addEventListener('click', e => { if (e.target === el.kwBox) el.kwInput.focus(); });

function updateScholarLink(kws) {
  const q = kws.map(k => `"${k}"`).join(' OR ');
  el.scholarLink.href = q ? 'https://scholar.google.com/scholar?q=' + encodeURIComponent(q) : 'https://scholar.google.com/';
}

/* ---------- 검색 소스 ---------- */
async function searchEpmc(kw, o) {
  let q = `"${kw}"`;
  if (o.oaOnly) q += ' AND OPEN_ACCESS:y';
  if (o.from) q += ` AND PUB_YEAR:[${o.from} TO 3000]`;
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${o.size}`;
  const data = await fetchJson(url);
  return (data.resultList?.result || []).map(r => {
    const links = [];
    if (r.doi) links.push({ label: 'DOI', url: 'https://doi.org/' + r.doi });
    links.push({ label: 'Europe PMC', url: `https://europepmc.org/article/${r.source}/${r.id}` });
    if (r.pmcid) links.push({ label: 'PMC 전문', url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${r.pmcid}/` });
    return {
      title: Summ.htmlToText(r.title),
      authors: r.authorString || '',
      year: +r.pubYear || null,
      venue: r.journalInfo?.journal?.title || r.bookOrReportDetails?.publisher || '',
      doi: (r.doi || '').toLowerCase(),
      pmcid: r.pmcid || '',
      fulltextAvail: r.isOpenAccess === 'Y' && r.inEPMC === 'Y' && !!r.pmcid,
      isOA: r.isOpenAccess === 'Y',
      cited: r.citedByCount || 0,
      abstractRaw: r.abstractText || '',
      links,
      source: 'Europe PMC',
    };
  });
}

function invertedToText(inv) {
  if (!inv) return '';
  const arr = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) arr[p] = w;
  return arr.join(' ');
}

async function searchOpenAlex(kw, o) {
  const filters = ['has_abstract:true'];
  if (o.from) filters.push(`from_publication_date:${o.from}-01-01`);
  if (o.oaOnly) filters.push('is_oa:true');
  const params = new URLSearchParams({
    search: `"${kw}"`,
    filter: filters.join(','),
    'per-page': String(o.size),
    select: 'id,doi,display_name,publication_year,authorships,primary_location,open_access,ids,cited_by_count,abstract_inverted_index',
  });
  const data = await fetchJson('https://api.openalex.org/works?' + params);
  return (data.results || []).map(w => {
    const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
    const pmcMatch = String(w.ids?.pmcid || '').match(/PMC\d+/i);
    const links = [];
    if (doi) links.push({ label: 'DOI', url: 'https://doi.org/' + doi });
    const land = safeUrl(w.primary_location?.landing_page_url);
    if (land && !land.includes('doi.org')) links.push({ label: '원문 페이지', url: land });
    const oaUrl = safeUrl(w.open_access?.oa_url);
    if (oaUrl && oaUrl !== land) links.push({ label: '무료 원문', url: oaUrl });
    links.push({ label: 'OpenAlex', url: w.id });
    const authors = (w.authorships || []).map(a => a.author?.display_name).filter(Boolean);
    return {
      title: Summ.htmlToText(w.display_name),
      authors: authors.length > 6 ? authors.slice(0, 6).join(', ') + ' 외' : authors.join(', '),
      year: w.publication_year || null,
      venue: w.primary_location?.source?.display_name || '',
      doi,
      pmcid: pmcMatch ? pmcMatch[0].toUpperCase() : '',
      fulltextAvail: !!pmcMatch,
      isOA: !!w.open_access?.is_oa,
      cited: w.cited_by_count || 0,
      abstractRaw: invertedToText(w.abstract_inverted_index),
      links,
      source: 'OpenAlex',
    };
  });
}

/* ---------- 결과 병합 ---------- */
function paperKey(p) { return p.doi ? 'doi:' + p.doi : 't:' + norm(p.title).slice(0, 120); }

function addPaper(raw, kw, rank) {
  if (!raw.title) return;
  // DOI가 달라도(프리프린트·출판본) 제목이 같으면 같은 논문으로 합친다
  const tKey = norm(raw.title).slice(0, 120);
  const key = state.titleIndex.get(tKey) || paperKey(raw);
  state.titleIndex.set(tKey, key);
  let p = state.papers.get(key);
  if (!p) {
    p = { ...raw, key, sources: new Set(), queryHits: new Set(), score: 0, summary: null, summaryPromise: null };
    p.links = [];
    state.papers.set(key, p);
  } else {
    // 비어있는 정보 보충
    for (const f of ['authors', 'venue', 'year', 'doi', 'pmcid']) if (!p[f] && raw[f]) p[f] = raw[f];
    if ((raw.abstractRaw || '').length > (p.abstractRaw || '').length && !/<h4>/i.test(p.abstractRaw || '')) p.abstractRaw = raw.abstractRaw;
    p.fulltextAvail = p.fulltextAvail || raw.fulltextAvail;
    p.isOA = p.isOA || raw.isOA;
    p.cited = Math.max(p.cited, raw.cited);
  }
  for (const l of raw.links) if (!p.links.some(x => x.url === l.url)) p.links.push(l);
  p.sources.add(raw.source);
  p.queryHits.add(kw);
  p.score += 1 / (rank + 5);
}

// 각 키워드가 어디에 포함됐는지 (제목 / 초록 / 색인·본문)
function keywordWhere(p, kw) {
  const k = kw.toLowerCase();
  if ((p.title || '').toLowerCase().includes(k)) return '제목';
  if (!p._abs) p._abs = Summ.htmlToText(p.abstractRaw).toLowerCase();
  if (p._abs.includes(k)) return '초록';
  if (p.queryHits.has(kw)) return '색인·본문';
  return '';
}
function matchedKeywords(p) {
  return state.searched.map((k, i) => ({ k, i, where: keywordWhere(p, k) })).filter(x => x.where);
}

/* ---------- 검색 실행 ---------- */
let searchSeq = 0;
async function runSearch() {
  if (el.kwInput.value.trim()) { addKeywords(el.kwInput.value); el.kwInput.value = ''; }
  const kws = [...state.keywords];
  if (!kws.length) { el.kwInput.focus(); return; }
  const o = {
    size: +el.size.value,
    from: /^\d{4}$/.test(el.yearFrom.value) ? el.yearFrom.value : '',
    oaOnly: el.oaOnly.checked,
  };
  const useEpmc = el.srcEpmc.checked, useOa = el.srcOa.checked;
  if (!useEpmc && !useOa) { setStatus('검색 소스를 하나 이상 골라줘요.'); return; }

  const seq = ++searchSeq;
  state.searched = kws;
  state.papers.clear();
  state.titleIndex.clear();
  state.active = new Set(kws);
  updateScholarLink(kws);
  try { history.replaceState(null, '', '#q=' + encodeURIComponent(kws.join(','))); } catch { /* noop */ }
  el.area.hidden = false;
  el.empty.hidden = true;
  el.results.innerHTML = '';
  el.searchBtn.disabled = true;
  setStatus('검색 중…');

  const jobs = [];
  for (const kw of kws) {
    if (useEpmc) jobs.push(searchEpmc(kw, o).then(list => ({ kw, list }), err => ({ kw, err, src: 'Europe PMC' })));
    if (useOa) jobs.push(searchOpenAlex(kw, o).then(list => ({ kw, list }), err => ({ kw, err, src: 'OpenAlex' })));
  }
  const out = await Promise.all(jobs);
  if (seq !== searchSeq) return;
  const errors = [];
  for (const r of out) {
    if (r.err) { errors.push(`${r.src} "${r.kw}" 실패(${r.err.message})`); continue; }
    r.list.forEach((p, i) => addPaper(p, r.kw, i));
  }
  el.searchBtn.disabled = false;
  state.lastErrors = errors;
  render();
}

function setStatus(html) { el.status.innerHTML = html; }

/* ---------- 렌더링 ---------- */
function filteredPapers(onlyKw) {
  const titleOnly = el.titleOnly.checked;
  const list = [];
  for (const p of state.papers.values()) {
    const m = matchedKeywords(p);
    const consider = titleOnly ? m.filter(x => x.where === '제목') : m;
    const ks = new Set(consider.map(x => x.k));
    let ok;
    if (onlyKw) ok = ks.has(onlyKw);
    else if (state.match === 'all') ok = [...state.active].every(k => ks.has(k)) && state.active.size > 0;
    else ok = [...state.active].some(k => ks.has(k));
    if (ok) list.push({ p, m });
  }
  const s = el.sort.value;
  list.sort((a, b) => {
    if (s === 'year') return (b.p.year || 0) - (a.p.year || 0) || b.p.score - a.p.score;
    if (s === 'cited') return b.p.cited - a.p.cited;
    if (s === 'kwcount') return b.m.length - a.m.length || b.p.score - a.p.score;
    return b.m.length - a.m.length || b.p.score - a.p.score;
  });
  return list;
}

function renderFilters() {
  const counts = state.searched.map(k => {
    let n = 0;
    for (const p of state.papers.values()) {
      const w = keywordWhere(p, k);
      if (w && (!el.titleOnly.checked || w === '제목')) n++;
    }
    return n;
  });
  const allOn = state.active.size === state.searched.length;
  el.filterChips.innerHTML =
    `<button type="button" class="fchip ${allOn ? 'on' : ''}" data-all="1" aria-pressed="${allOn}">전체</button>` +
    state.searched.map((k, i) => {
      const on = state.active.has(k);
      return `<button type="button" class="fchip ${on ? 'on' : ''}" style="--c:${KW_COLORS[i]}" data-k="${esc(k)}" aria-pressed="${on}">${esc(k)}<span class="n">${counts[i]}</span></button>`;
    }).join('');
}

function render() {
  renderFilters();
  el.matchSeg.classList.toggle('disabled', state.view === 'split');
  const errHtml = (state.lastErrors || []).length ? ` <span class="err">· ${esc(state.lastErrors.join(', '))}</span>` : '';
  el.results.innerHTML = '';
  if (!state.active.size) { setStatus('필터에서 키워드를 하나 이상 켜줘요.' + errHtml); return; }

  const frag = document.createDocumentFragment();
  if (state.view === 'split') {
    let total = 0;
    state.searched.forEach((k, i) => {
      if (!state.active.has(k)) return;
      const list = filteredPapers(k);
      total += list.length;
      const h = document.createElement('h2');
      h.className = 'group-h';
      h.style.setProperty('--c', KW_COLORS[i]);
      h.innerHTML = `<span class="dot"></span>${esc(k)} <span class="meta">${list.length}편</span>`;
      frag.appendChild(h);
      list.forEach(x => frag.appendChild(card(x.p, x.m)));
    });
    setStatus(`논문 ${state.papers.size}편 중 키워드별로 나눠서 보는 중 (중복 포함 ${total}건)` + errHtml);
  } else {
    const list = filteredPapers();
    list.forEach(x => frag.appendChild(card(x.p, x.m)));
    setStatus(`${list.length}편 표시 (전체 ${state.papers.size}편)` + errHtml);
  }
  el.results.appendChild(frag);
}

function card(p, m) {
  const div = document.createElement('article');
  div.className = 'card' + (state.selected.has(p.key) ? ' sel' : '');
  div.dataset.key = p.key;
  const kws = state.searched;
  const scholar = 'https://scholar.google.com/scholar?q=' + encodeURIComponent(`"${p.title}"`);
  div.innerHTML = `
    <div class="card-head">
      <div>
        <h3>${highlight(p.title, kws)}</h3>
        <div class="meta">${esc([p.authors, p.venue, p.year].filter(Boolean).join(' · '))}${p.cited ? ` · 피인용 ${p.cited}` : ''}</div>
      </div>
      <label class="pick"><input type="checkbox" class="pick-cb" ${state.selected.has(p.key) ? 'checked' : ''}> PDF에 담기</label>
    </div>
    <div class="tags">
      ${m.map(x => `<span class="tag" style="--c:${KW_COLORS[x.i]}" title="${esc(x.where)}에 포함">${esc(x.k)} <small>· ${esc(x.where)}</small></span>`).join('')}
      ${[...p.sources].map(s => `<span class="tag src">${esc(s)}</span>`).join('')}
      ${p.isOA ? '<span class="tag oa">오픈액세스</span>' : ''}
    </div>
    <div class="links">
      ${p.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}
      <a href="${esc(scholar)}" target="_blank" rel="noopener">Google Scholar ↗</a>
    </div>
    <div class="sum-wrap">${summaryHtml(p)}</div>`;
  if (!p.summary) observer.observe(div);
  return div;
}

function summaryBlock(title, s, kws) {
  const basis = s?.basis ? `<span class="basis">${esc(s.basis)}</span>` : '';
  const body = s?.items?.length
    ? `<ul>${s.items.map(t => `<li>${highlight(t, kws)}</li>`).join('')}</ul>`
    : '<p class="none">추출할 문장을 찾지 못했어요. 원문 링크에서 확인해 줘요.</p>';
  return `<section><h4>${title}${basis}</h4>${body}</section>`;
}
function summaryHtml(p) {
  if (!p.summary) return '<p class="loading">요약 불러오는 중…</p>';
  return `<div class="sum">${summaryBlock('Results 요약', p.summary.results, state.searched)}${summaryBlock('Discussion 요약', p.summary.discussion, state.searched)}</div>`;
}

/* ---------- 요약 (화면에 보일 때 불러옴) ---------- */
const ftQueue = [];
let ftRunning = 0;
const FT_CONCURRENCY = 4;
function queueFetch(fn) {
  return new Promise((resolve, reject) => {
    ftQueue.push({ fn, resolve, reject });
    pump();
  });
}
function pump() {
  while (ftRunning < FT_CONCURRENCY && ftQueue.length) {
    const job = ftQueue.shift();
    ftRunning++;
    job.fn().then(job.resolve, job.reject).finally(() => { ftRunning--; pump(); });
  }
}

function ensureSummary(p) {
  if (p.summary) return Promise.resolve(p.summary);
  if (p.summaryPromise) return p.summaryPromise;
  const kws = state.searched;
  p.summaryPromise = (async () => {
    const abs = Summ.fromAbstract(p.abstractRaw, kws);
    let ft = null;
    if (p.fulltextAvail && p.pmcid) {
      try {
        ft = await queueFetch(async () => {
          const r = await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/${p.pmcid}/fullTextXML`);
          if (!r.ok) return null;
          return Summ.fromFullText(await r.text(), kws);
        });
      } catch { ft = null; }
    }
    const pickBetter = (a, b) => (a && a.items && a.items.length ? a : b);
    p.summary = {
      results: pickBetter(ft?.results, abs.results),
      discussion: pickBetter(ft?.discussion, abs.discussion),
    };
    return p.summary;
  })();
  return p.summaryPromise;
}

const observer = new IntersectionObserver(entries => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    observer.unobserve(en.target);
    const p = state.papers.get(en.target.dataset.key);
    if (!p) continue;
    ensureSummary(p).then(() => refreshCards(p.key));
  }
}, { rootMargin: '300px 0px' });

function refreshCards(key) {
  const p = state.papers.get(key);
  document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"] .sum-wrap`).forEach(w => { w.innerHTML = summaryHtml(p); });
  if (state.selected.has(key)) { state.selected.set(key, snapshot(p)); saveSelected(); }
}

/* ---------- 필터/보기 이벤트 ---------- */
el.filterChips.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.all) {
    state.active = state.active.size === state.searched.length ? new Set() : new Set(state.searched);
  } else {
    const k = b.dataset.k;
    state.active.has(k) ? state.active.delete(k) : state.active.add(k);
  }
  render();
});
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
  render();
}));
document.querySelectorAll('[data-match]').forEach(b => b.addEventListener('click', () => {
  state.match = b.dataset.match;
  document.querySelectorAll('[data-match]').forEach(x => x.classList.toggle('on', x === b));
  render();
}));
el.titleOnly.addEventListener('change', render);
el.sort.addEventListener('change', render);
el.form.addEventListener('submit', e => { e.preventDefault(); runSearch(); });

/* ---------- 선택(PDF에 담기) ---------- */
function snapshot(p) {
  return {
    key: p.key, title: p.title, authors: p.authors, venue: p.venue, year: p.year,
    links: p.links, scholar: 'https://scholar.google.com/scholar?q=' + encodeURIComponent(`"${p.title}"`),
    keywords: matchedKeywords(p).map(x => ({ k: x.k, i: x.i, where: x.where })),
    summary: p.summary,
  };
}

el.results.addEventListener('change', e => {
  if (!e.target.classList.contains('pick-cb')) return;
  const key = e.target.closest('.card').dataset.key;
  const p = state.papers.get(key);
  if (e.target.checked) {
    state.selected.set(key, snapshot(p));
    ensureSummary(p).then(() => { if (state.selected.has(key)) { state.selected.set(key, snapshot(p)); saveSelected(); } });
  } else state.selected.delete(key);
  document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"]`).forEach(c => {
    c.classList.toggle('sel', e.target.checked);
    c.querySelector('.pick-cb').checked = e.target.checked;
  });
  saveSelected();
  renderTray();
});

function renderTray() {
  const n = state.selected.size;
  el.tray.hidden = n === 0;
  el.trayCount.textContent = n;
  if (!n) { el.trayList.hidden = true; el.trayToggle.setAttribute('aria-expanded', 'false'); }
  el.trayList.innerHTML = '<ol>' + [...state.selected.values()].map(s =>
    `<li><span>${esc(s.title)}</span><button type="button" data-rm="${esc(s.key)}" aria-label="빼기">✕</button></li>`).join('') + '</ol>';
}
el.trayToggle.addEventListener('click', () => {
  el.trayList.hidden = !el.trayList.hidden;
  el.trayToggle.setAttribute('aria-expanded', String(!el.trayList.hidden));
});
el.trayList.addEventListener('click', e => {
  const b = e.target.closest('button[data-rm]');
  if (!b) return;
  const key = b.dataset.rm;
  state.selected.delete(key);
  saveSelected();
  document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"]`).forEach(c => { c.classList.remove('sel'); c.querySelector('.pick-cb').checked = false; });
  renderTray();
});
el.clearSel.addEventListener('click', () => {
  if (!confirm('담은 논문을 모두 비울까요?')) return;
  state.selected.clear();
  saveSelected();
  document.querySelectorAll('.card.sel').forEach(c => { c.classList.remove('sel'); c.querySelector('.pick-cb').checked = false; });
  renderTray();
});

/* ---------- PDF 내보내기 ---------- */
function pdfSummary(title, s) {
  const items = s?.items?.length
    ? `<ul style="margin:4px 0 0;padding-left:18px">${s.items.map(t => `<li style="margin-bottom:3px">${esc(t)}</li>`).join('')}</ul>`
    : '<p style="margin:4px 0 0;color:#666">추출된 문장 없음 (원문 확인 필요)</p>';
  return `<div style="margin-top:8px"><b>${title}</b> <span style="color:#777;font-size:10px">${esc(s?.basis || '')}</span>${items}</div>`;
}

function buildPdfHtml(items) {
  const today = new Date();
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const allKws = [...new Set(items.flatMap(s => s.keywords.map(k => k.k)))];
  const head = `
    <div style="border-bottom:2px solid #2456c9;padding-bottom:8px;margin-bottom:14px">
      <div style="font-size:20px;font-weight:700">선행연구 요약 모음</div>
      <div style="color:#555;font-size:11px">작성일 ${d} · 논문 ${items.length}편 · 키워드: ${esc(allKws.join(', '))}</div>
      <div style="color:#777;font-size:10px;margin-top:2px">요약은 본문/초록에서 자동 추출한 문장이며, 인용 전 원문 확인이 필요함.</div>
    </div>`;
  const body = items.map((s, n) => `
    <div class="pdf-item" style="padding:10px 0 12px;border-bottom:1px solid #ddd">
      <div style="font-size:14px;font-weight:700;line-height:1.4">${n + 1}. ${esc(s.title)}</div>
      <div style="color:#555;font-size:10.5px;margin-top:2px">${esc([s.authors, s.venue, s.year].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:4px">${s.keywords.map(k => `<span style="display:inline-block;font-size:10px;color:#fff;background:${KW_HEX[k.i] || '#555'};border-radius:8px;padding:0 6px;margin-right:4px">${esc(k.k)} · ${esc(k.where)}</span>`).join('')}</div>
      <div style="font-size:10px;margin-top:4px;word-break:break-all">${s.links.map(l => `${esc(l.label)}: <a href="${esc(l.url)}" style="color:#2456c9">${esc(l.url)}</a>`).join('<br>')}</div>
      ${pdfSummary('Results 요약', s.summary?.results)}
      ${pdfSummary('Discussion 요약', s.summary?.discussion)}
    </div>`).join('');
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:180mm;color:#111;background:#fff;font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif;font-size:11.5px;line-height:1.55';
  wrap.innerHTML = head + body;
  return wrap;
}

el.exportPdf.addEventListener('click', async () => {
  if (!state.selected.size) return;
  if (typeof html2pdf === 'undefined') { alert('PDF 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인해 줘요.'); return; }
  el.exportPdf.disabled = true;
  const label = el.exportPdf.textContent;
  el.exportPdf.textContent = '요약 정리 중…';
  try {
    // 아직 요약이 없는 항목은 먼저 만든다
    for (const [key, snap] of state.selected) {
      const p = state.papers.get(key);
      if (p && !snap.summary) { await ensureSummary(p); state.selected.set(key, snapshot(p)); }
    }
    saveSelected();
    el.exportPdf.textContent = 'PDF 만드는 중…';
    const node = buildPdfHtml([...state.selected.values()]);
    await html2pdf().set({
      margin: [12, 12, 14, 12],
      filename: `선행연구_요약_${Date.now()}.pdf`,
      image: { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'], avoid: '.pdf-item' },
    }).from(node).save();
  } catch (err) {
    alert('PDF 생성 중 오류: ' + err.message);
  } finally {
    el.exportPdf.disabled = false;
    el.exportPdf.textContent = label;
  }
});

/* ---------- 시작 ---------- */
renderTray();
(() => {
  const m = location.hash.match(/q=([^&]+)/);
  if (m) {
    try { addKeywords(decodeURIComponent(m[1])); } catch { /* noop */ }
    if (state.keywords.length) runSearch();
  } else renderKwChips();
})();
