'use strict';

const MAX_KW = 5;
const KW_COLORS = ['var(--kw0)', 'var(--kw1)', 'var(--kw2)', 'var(--kw3)', 'var(--kw4)'];
const KW_HEX = ['#2456c9', '#b0451f', '#1f7a4d', '#7a3fb0', '#a0326e']; // PDF용 고정색
const SEL_KEY = 'paperSearch.selected.v1';

const $ = id => document.getElementById(id);
const el = {
  form: $('searchForm'), kwBox: $('kwBox'), kwChips: $('kwChips'), kwInput: $('kwInput'),
  fieldChips: $('fieldChips'), srcList: $('srcList'), srcSummary: $('srcSummary'), yearFrom: $('yearFrom'), yearTo: $('yearTo'), size: $('size'), oaOnly: $('oaOnly'),
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 응답이 없는 요청이 대기열을 막지 않도록 20초 뒤 끊는다
const fetchT = (url, ms = 20000) => fetch(url, AbortSignal.timeout ? { signal: AbortSignal.timeout(ms) } : undefined);
// 429(요청 과다)·5xx는 잠시 기다렸다가 최대 2번 다시 시도
async function fetchOk(url) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetchT(url);
    if (r.ok) return r;
    if ((r.status === 429 || r.status >= 500) && attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
    if (r.status === 429 || r.status === 402) {
      const e = new Error('무료 사용 한도 초과');
      e.limit = true; // 한도 초과 표시 → 팝업 띄우고 해당 DB 검색 중단
      throw e;
    }
    throw new Error(`HTTP ${r.status}`);
  }
}
const fetchJson = async url => (await fetchOk(url)).json();
const fetchText = async url => (await fetchOk(url)).text();

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
// 각 검색 함수는 (키워드, 옵션, 이어받을 위치)를 받아 결과 배열을 돌려준다.
// 배열에 total(그 소스의 전체 검색 건수)과 next(다음 묶음을 받을 위치, 없으면 null)를 붙인다.
const MAX_OFFSET = 10000; // 대부분의 API가 1만 건 이후로는 넘겨 보기를 막는다
function paged(list, total, next) {
  list.total = +total || 0;
  list.next = next ?? null;
  return list;
}
const nextOffset = (offset, got, total, cap = MAX_OFFSET) => {
  const n = offset + got;
  return got > 0 && n < total && n < cap ? n : null;
};

async function searchEpmc(kw, o, cur) {
  let q = `"${kw}"` + (o.extraQ || '');
  if (o.oaOnly) q += ' AND OPEN_ACCESS:y';
  if (o.from || o.to) q += ` AND PUB_YEAR:[${o.from || 1800} TO ${o.to || 3000}]`;
  const mark = cur || '*';
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${o.size}&cursorMark=${encodeURIComponent(mark)}`;
  const data = await fetchJson(url);
  const results = data.resultList?.result || [];
  const next = results.length && data.nextCursorMark && data.nextCursorMark !== mark ? data.nextCursorMark : null;
  return paged(results.map(r => {
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
      fulltextAvail: r.inEPMC === 'Y' && !!r.pmcid,
      isOA: r.isOpenAccess === 'Y',
      cited: r.citedByCount || 0,
      abstractRaw: r.abstractText || '',
      links,
      source: o.label || 'Europe PMC',
    };
  }), data.hitCount, next);
}

function invertedToText(inv) {
  if (!inv) return '';
  const arr = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) arr[p] = w;
  return arr.join(' ');
}

async function searchOpenAlex(kw, o, cur) {
  const offset = cur || 0;
  const filters = ['has_abstract:true', ...(o.extraFilter ? [o.extraFilter] : [])];
  if (o.from) filters.push(`from_publication_date:${o.from}-01-01`);
  if (o.to) filters.push(`to_publication_date:${o.to}-12-31`);
  if (o.oaOnly) filters.push('is_oa:true');
  const params = new URLSearchParams({
    search: `"${kw}"`,
    filter: filters.join(','),
    'per-page': String(o.size),
    page: String(Math.floor(offset / o.size) + 1),
    select: 'id,doi,display_name,publication_year,authorships,primary_location,open_access,ids,cited_by_count,abstract_inverted_index',
  });
  const data = await fetchJson('https://api.openalex.org/works?' + params);
  const results = data.results || [];
  return paged(results.map(w => {
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
      source: o.label || 'OpenAlex',
    };
  }), data.meta?.count, nextOffset(offset, results.length, data.meta?.count));
}

/* ---------- 서울대 학술DB 중 공개 API가 있는 DB ---------- */
const yearSpan = o => [o.from || 1800, o.to || 3000];
const doiLink = doi => (doi ? [{ label: 'DOI', url: 'https://doi.org/' + doi }] : []);
const cleanDoi = d => String(d || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().toLowerCase();

// PubMed (NCBI E-utilities): 검색(esearch) → 서지·초록(efetch XML)
async function searchPubMed(kw, o, cur) {
  const offset = cur || 0;
  const E = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
  let term = `"${kw}"`;
  if (o.from || o.to) { const [a, b] = yearSpan(o); term += ` AND ${a}:${b}[dp]`; }
  if (o.oaOnly) term += ' AND free full text[sb]';
  const s = await fetchJson(`${E}/esearch.fcgi?db=pubmed&retmode=json&retmax=${o.size}&retstart=${offset}&term=${encodeURIComponent(term)}`);
  const ids = s.esearchresult?.idlist || [];
  const total = +s.esearchresult?.count || 0;
  if (!ids.length) return paged([], total, null);
  await sleep(400); // 키 없이 초당 3회 제한
  const xml = new DOMParser().parseFromString(await fetchText(`${E}/efetch.fcgi?db=pubmed&retmode=xml&id=${ids.join(',')}`), 'text/xml');
  const txt = (n, sel) => n.querySelector(sel)?.textContent.trim() || '';
  return paged([...xml.querySelectorAll('PubmedArticle')].map(a => {
    const pmid = txt(a, 'MedlineCitation > PMID');
    const doi = cleanDoi(txt(a, 'ArticleIdList > ArticleId[IdType="doi"]'));
    const pmc = txt(a, 'ArticleIdList > ArticleId[IdType="pmc"]');
    // 구조화 초록 라벨을 <h4>로 바꿔 두면 summarize.js가 Results/Conclusions를 나눠 읽는다
    const abs = [...a.querySelectorAll('Abstract > AbstractText')].map(t => {
      const label = t.getAttribute('Label');
      return (label ? `<h4>${esc(label)}</h4>` : '') + esc(t.textContent);
    }).join(' ');
    const authors = [...a.querySelectorAll('AuthorList > Author')].map(au => [txt(au, 'LastName'), txt(au, 'Initials')].filter(Boolean).join(' ') || txt(au, 'CollectiveName')).filter(Boolean);
    // 온라인 선공개일(ArticleDate)과 인쇄본 발행일 중 이른 연도 (PubMed 연도 필터와 같은 기준)
    const yrs = [txt(a, 'Article > ArticleDate Year'), txt(a, 'JournalIssue PubDate Year') || (txt(a, 'JournalIssue PubDate MedlineDate').match(/\d{4}/) || [''])[0]].map(Number).filter(Boolean);
    const yr = yrs.length ? Math.min(...yrs) : '';
    const links = [...doiLink(doi), { label: 'PubMed', url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` }];
    if (pmc) links.push({ label: 'PMC 전문', url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmc}/` });
    return {
      title: txt(a, 'ArticleTitle'), authors: authors.length > 6 ? authors.slice(0, 6).join(', ') + ' 외' : authors.join(', '),
      year: +yr || null, venue: txt(a, 'Journal > Title'), doi, pmcid: pmc, fulltextAvail: !!pmc, isOA: !!pmc,
      cited: 0, abstractRaw: abs, links, source: 'PubMed',
    };
  }), total, nextOffset(offset, ids.length, total, 9999));
}

// PLOS (Solr 검색 API)
async function searchPlos(kw, o, cur) {
  const offset = cur || 0;
  const p = new URLSearchParams({
    q: `everything:"${kw}"`, rows: String(o.size), start: String(offset), wt: 'json',
    fl: 'id,title_display,author_display,abstract,publication_date,journal,counter_total_all',
  });
  p.append('fq', 'doc_type:full');
  if (o.from || o.to) { const [a, b] = yearSpan(o); p.append('fq', `publication_date:[${a}-01-01T00:00:00Z TO ${b}-12-31T23:59:59Z]`); }
  const d = await fetchJson('https://api.plos.org/search?' + p);
  const docs = d.response?.docs || [];
  return paged(docs.map(x => {
    const doi = cleanDoi(x.id);
    const authors = x.author_display || [];
    return {
      title: Summ.htmlToText(x.title_display), authors: authors.length > 6 ? authors.slice(0, 6).join(', ') + ' 외' : authors.join(', '),
      year: +(x.publication_date || '').slice(0, 4) || null, venue: x.journal || 'PLOS', doi, pmcid: '', fulltextAvail: false, isOA: true,
      cited: 0, abstractRaw: (x.abstract || []).join(' '), links: [...doiLink(doi), { label: 'PLOS', url: `https://journals.plos.org/plosone/article?id=${doi}` }],
      source: 'PLOS',
    };
  }), d.response?.numFound, nextOffset(offset, docs.length, d.response?.numFound));
}

// DOAJ (오픈액세스 저널 논문 검색 API)
async function searchDoaj(kw, o, cur) {
  const offset = cur || 0;
  let q = `"${kw}"`;
  if (o.from || o.to) { const [a, b] = yearSpan(o); q += ` AND bibjson.year:[${a} TO ${b}]`; }
  const d = await fetchJson(`https://doaj.org/api/search/articles/${encodeURIComponent(q)}?pageSize=${o.size}&page=${Math.floor(offset / o.size) + 1}`);
  const results = d.results || [];
  return paged(results.map(r => {
    const b = r.bibjson || {};
    const doi = cleanDoi((b.identifier || []).find(i => i.type === 'doi')?.id);
    const ft = safeUrl((b.link || []).find(l => l.type === 'fulltext')?.url);
    const authors = (b.author || []).map(a => a.name).filter(Boolean);
    const links = [...doiLink(doi)];
    if (ft) links.push({ label: '무료 원문', url: ft });
    links.push({ label: 'DOAJ', url: `https://doaj.org/article/${r.id}` });
    return {
      title: Summ.htmlToText(b.title), authors: authors.length > 6 ? authors.slice(0, 6).join(', ') + ' 외' : authors.join(', '),
      year: +b.year || null, venue: b.journal?.title || '', doi, pmcid: '', fulltextAvail: false, isOA: true,
      cited: 0, abstractRaw: b.abstract || '', links, source: 'DOAJ',
    };
  }), d.total, nextOffset(offset, results.length, d.total, 1000)); // DOAJ는 1,000건까지만 넘겨 볼 수 있음
}

// ERIC (미국 교육부 교육학 문헌 API)
async function searchEric(kw, o, cur) {
  const offset = cur || 0;
  let q = `"${kw}"`;
  if (o.from || o.to) { const [a, b] = yearSpan(o); q += ` AND publicationdateyear:[${a} TO ${b}]`; }
  if (o.oaOnly) q += ' AND e_fulltextauth:T';
  const p = new URLSearchParams({ search: q, format: 'json', rows: String(o.size), start: String(offset), fields: 'id,title,author,description,publicationdateyear,source,e_fulltextauth' });
  const d = await fetchJson('https://api.ies.ed.gov/eric/?' + p);
  const docs = d.response?.docs || [];
  return paged(docs.map(x => {
    const authors = x.author || [];
    const links = [{ label: 'ERIC', url: `https://eric.ed.gov/?id=${x.id}` }];
    const hasFt = String(x.e_fulltextauth) === '1' || x.e_fulltextauth === 'T' || x.e_fulltextauth === true;
    if (hasFt) links.push({ label: '무료 원문(PDF)', url: `https://files.eric.ed.gov/fulltext/${x.id}.pdf` });
    return {
      title: Summ.htmlToText(x.title), authors: authors.length > 6 ? authors.slice(0, 6).join(', ') + ' 외' : authors.join(', '),
      year: +x.publicationdateyear || null, venue: x.source || '', doi: '', pmcid: '', fulltextAvail: false, isOA: hasFt,
      cited: 0, abstractRaw: Summ.htmlToText(x.description), links, source: 'ERIC',
    };
  }), d.response?.numFound, nextOffset(offset, docs.length, d.response?.numFound));
}

// CiNii Research (일본 학술정보 OpenSearch)
async function searchCinii(kw, o, cur) {
  const offset = cur || 0;
  const p = new URLSearchParams({ q: `"${kw}"`, format: 'json', count: String(o.size), start: String(offset + 1) });
  if (o.from) p.set('from', o.from);
  if (o.to) p.set('until', o.to);
  const d = await fetchJson('https://cir.nii.ac.jp/opensearch/articles?' + p);
  const asText = v => (Array.isArray(v) ? v.map(asText).join(' ') : (v && typeof v === 'object' ? (v['@value'] || '') : String(v || '')));
  const items = d.items || [];
  const total = d['opensearch:totalResults'];
  return paged(items.filter(it => it.title).map(it => {
    const ids = [].concat(it['dc:identifier'] || []);
    const doi = cleanDoi(ids.find(i => /doi/i.test(i['@type'] || ''))?.['@value']);
    const authors = [].concat(it['dc:creator'] || []).map(asText).filter(Boolean);
    return {
      title: Summ.htmlToText(asText(it.title)), authors: authors.length > 6 ? authors.slice(0, 6).join(', ') + ' 외' : authors.join(', '),
      year: +(asText(it['prism:publicationDate']).match(/\d{4}/) || [''])[0] || null, venue: asText(it['prism:publicationName']),
      doi, pmcid: '', fulltextAvail: false, isOA: false, cited: 0, abstractRaw: Summ.htmlToText(asText(it.description)),
      links: [...doiLink(doi), { label: 'CiNii', url: safeUrl(it.link?.['@id'] || it['@id']) }].filter(l => l.url),
      source: 'CiNii',
    };
  }), total, nextOffset(offset, items.length, total));
}

// AGRICOLA (미국 농업도서관 농학 문헌) — Europe PMC에 수록된 AGRICOLA 레코드만 검색
const searchAgricola = (kw, o, cur) => searchEpmc(kw, { ...o, extraQ: ' AND SRC:AGR', label: 'AGRICOLA' }, cur);
// OpenAlex 농학 — 주제 분야가 'Agricultural and Biological Sciences'(field 11)인 문헌만
const searchOpenAlexAgri = (kw, o, cur) => searchOpenAlex(kw, { ...o, extraFilter: 'primary_topic.field.id:11', label: 'OpenAlex 농학' }, cur);

const shortAuthors = a => (a.length > 6 ? a.slice(0, 6).join(', ') + ' 외' : a.join(', '));

// Crossref (전 분야 DOI 메타데이터, 일부 초록 포함)
async function searchCrossref(kw, o, cur) {
  const offset = cur || 0;
  const f = ['type:journal-article', 'type:proceedings-article', 'type:posted-content'];
  if (o.from) f.push(`from-pub-date:${o.from}`);
  if (o.to) f.push(`until-pub-date:${o.to}`);
  const p = new URLSearchParams({
    query: kw, rows: String(o.size), offset: String(offset), filter: f.join(','),
    select: 'DOI,title,abstract,author,container-title,issued,is-referenced-by-count,URL,link',
  });
  const d = await fetchJson('https://api.crossref.org/works?' + p);
  const items = d.message?.items || [];
  const total = d.message?.['total-results'];
  return paged(items.filter(x => x.title?.[0]).map(x => {
    const doi = cleanDoi(x.DOI);
    const authors = (x.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean);
    return {
      title: Summ.htmlToText(x.title[0]), authors: shortAuthors(authors),
      year: x.issued?.['date-parts']?.[0]?.[0] || null, venue: (x['container-title'] || [])[0] || '',
      doi, pmcid: '', fulltextAvail: false, isOA: false, cited: x['is-referenced-by-count'] || 0,
      abstractRaw: Summ.htmlToText(x.abstract || '').replace(/^abstract\s*/i, ''),
      links: [...doiLink(doi), { label: 'Crossref', url: `https://search.crossref.org/?q=${encodeURIComponent(doi)}` }],
      source: 'Crossref',
    };
  }), total, nextOffset(offset, items.length, total));
}

// HAL (프랑스 국가 오픈 아카이브, INRAE 등 농학 연구기관 논문 다수)
async function searchHal(kw, o, cur) {
  const offset = cur || 0;
  const p = new URLSearchParams({
    q: `"${kw}"`, rows: String(o.size), start: String(offset), wt: 'json',
    fl: 'title_s,abstract_s,authFullName_s,producedDateY_i,doiId_s,uri_s,journalTitle_s,fileMain_s',
  });
  if (o.from || o.to) { const [a, b] = yearSpan(o); p.append('fq', `producedDateY_i:[${a} TO ${b}]`); }
  if (o.oaOnly) p.append('fq', 'submitType_s:file');
  const d = await fetchJson('https://api.archives-ouvertes.fr/search/?' + p);
  const docs = d.response?.docs || [];
  return paged(docs.map(x => {
    const doi = cleanDoi(x.doiId_s);
    const pdf = safeUrl(x.fileMain_s);
    const links = [...doiLink(doi), { label: 'HAL', url: safeUrl(x.uri_s) }].filter(l => l.url);
    if (pdf) links.push({ label: '무료 원문(PDF)', url: pdf });
    return {
      title: Summ.htmlToText((x.title_s || [])[0]), authors: shortAuthors(x.authFullName_s || []),
      year: x.producedDateY_i || null, venue: x.journalTitle_s || '', doi, pmcid: '', fulltextAvail: false, isOA: !!pdf,
      cited: 0, abstractRaw: Summ.htmlToText((x.abstract_s || [])[0] || ''), links, source: 'HAL',
    };
  }), d.response?.numFound, nextOffset(offset, docs.length, d.response?.numFound));
}

// Zenodo (CERN 운영 오픈 저장소, 논문·보고서만 검색)
async function searchZenodo(kw, o, cur) {
  const offset = cur || 0;
  const size = Math.min(o.size, 25); // 로그인 없이 한 번에 25건까지
  let q = `"${kw}"`;
  if (o.from || o.to) { const [a, b] = yearSpan(o); q += ` AND publication_date:[${a}-01-01 TO ${b}-12-31]`; }
  if (o.oaOnly) q += ' AND access_right:open';
  const p = new URLSearchParams({ q, size: String(size), page: String(Math.floor(offset / size) + 1), type: 'publication' });
  const d = await fetchJson('https://zenodo.org/api/records?' + p);
  const hits = d.hits?.hits || [];
  const total = d.hits?.total;
  return paged(hits.map(h => {
    const m = h.metadata || {};
    const doi = cleanDoi(h.doi || m.doi);
    return {
      title: Summ.htmlToText(m.title), authors: shortAuthors((m.creators || []).map(c => c.name).filter(Boolean)),
      year: +(m.publication_date || '').slice(0, 4) || null, venue: m.journal?.title || 'Zenodo', doi, pmcid: '',
      fulltextAvail: false, isOA: m.access_right === 'open', cited: 0, abstractRaw: Summ.htmlToText(m.description || ''),
      links: [...doiLink(doi), { label: 'Zenodo', url: safeUrl(h.links?.self_html || `https://zenodo.org/records/${h.id}`) }],
      source: 'Zenodo',
    };
  }), total, nextOffset(offset, hits.length, total));
}

// INSPIRE-HEP (고에너지·입자물리 문헌)
async function searchInspire(kw, o, cur) {
  const offset = cur || 0;
  let q = `"${kw}"`;
  if (o.from || o.to) { const [a, b] = yearSpan(o); q += ` and date ${a}->${b}`; }
  const p = new URLSearchParams({
    q, size: String(o.size), page: String(Math.floor(offset / o.size) + 1), sort: 'mostrecent',
    fields: 'titles,abstracts,authors.full_name,dois,publication_info,control_number,earliest_date,arxiv_eprints,citation_count',
  });
  const d = await fetchJson('https://inspirehep.net/api/literature?' + p);
  const hits = d.hits?.hits || [];
  const total = d.hits?.total;
  return paged(hits.map(h => {
    const m = h.metadata || {};
    const doi = cleanDoi(m.dois?.[0]?.value);
    const ax = m.arxiv_eprints?.[0]?.value;
    const links = [...doiLink(doi), { label: 'INSPIRE', url: `https://inspirehep.net/literature/${m.control_number}` }];
    if (ax) links.push({ label: 'arXiv 원문', url: `https://arxiv.org/abs/${ax}` });
    return {
      title: Summ.htmlToText(m.titles?.[0]?.title), authors: shortAuthors((m.authors || []).map(a => a.full_name).filter(Boolean)),
      year: +(m.earliest_date || '').slice(0, 4) || null, venue: m.publication_info?.[0]?.journal_title || '', doi, pmcid: '',
      fulltextAvail: false, isOA: !!ax, cited: m.citation_count || 0, abstractRaw: Summ.htmlToText(m.abstracts?.[0]?.value || ''),
      links, source: 'INSPIRE',
    };
  }), total, nextOffset(offset, hits.length, total));
}

// 분야 목록: 서울대 학술DB 주제 분류 16개('일반'은 '전 분야'로) + 일본 학술자료
const ALL_FIELDS = ['인문학', '사회과학', '경영학', '법학', '교육학', '예술', '자연과학', '공학', '생명과학', '농생명과학', '의학', '약학', '간호학', '치의학', '수의학'];
const FIELD_ORDER = ['전 분야', ...ALL_FIELDS, '일본 학술자료'];

// 검색 소스 목록. fields = 그 DB에서 찾을 수 있는 분야 (DB 수록 범위 기준)
const SOURCES = [
  { id: 'epmc', name: 'Europe PMC', fn: searchEpmc, note: '생의학 논문, 오픈액세스 본문 제공 (AGRICOLA 농학 문헌 포함)',
    fields: ['생명과학', '의학', '약학', '간호학', '치의학', '수의학', '농생명과학'] },
  { id: 'openalex', name: 'OpenAlex', fn: searchOpenAlex, note: '전 분야 학술 문헌 색인', fields: ['전 분야', ...ALL_FIELDS] },
  { id: 'pubmed', name: 'PubMed', fn: searchPubMed, note: '의학 분야 대표 서지 DB', fields: ['의학', '약학', '간호학', '치의학', '수의학', '생명과학'] },
  { id: 'plos', name: 'PLOS', fn: searchPlos, note: '오픈액세스 과학 저널 (PLOS ONE 등)', fields: ['생명과학', '의학', '자연과학', '공학', '사회과학', '농생명과학'] },
  { id: 'doaj', name: 'DOAJ', fn: searchDoaj, note: '전 분야 오픈액세스 저널', fields: ['전 분야', ...ALL_FIELDS] },
  { id: 'eric', name: 'ERIC', fn: searchEric, note: '교육학 저널·보고서 (미국 교육부)', fields: ['교육학', '사회과학'] },
  { id: 'cinii', name: 'CiNii', fn: searchCinii, note: '일본 학술 논문·학위논문 (일본어 검색 가능)',
    fields: ['전 분야', ...ALL_FIELDS.filter(f => f !== '간호학'), '일본 학술자료'] },
  { id: 'agricola', name: 'AGRICOLA', fn: searchAgricola, note: '미국 농업도서관 농학·식품·축산 문헌 (Europe PMC 경유)',
    fields: ['농생명과학', '생명과학', '수의학'] },
  { id: 'oaagri', name: 'OpenAlex 농학', fn: searchOpenAlexAgri, note: 'OpenAlex 중 농학·생물학(Agricultural and Biological Sciences) 분야만',
    fields: ['농생명과학', '생명과학'] },
  { id: 'crossref', name: 'Crossref', fn: searchCrossref, note: '전 분야 DOI 등록 논문 (일부 초록 포함, 키워드 일치는 느슨함)',
    fields: ['전 분야', ...ALL_FIELDS] },
  { id: 'hal', name: 'HAL', fn: searchHal, note: '프랑스 국가 오픈 아카이브 (INRAE 등 농학 연구기관 논문 다수)',
    fields: ['전 분야', ...ALL_FIELDS] },
  { id: 'zenodo', name: 'Zenodo', fn: searchZenodo, note: 'CERN 운영 오픈 저장소의 논문·보고서',
    fields: ['전 분야', '자연과학', '공학', '생명과학', '농생명과학', '사회과학', '인문학'] },
  { id: 'inspire', name: 'INSPIRE', fn: searchInspire, note: '물리학(고에너지·입자물리) 문헌',
    fields: ['자연과학', '공학'] },
];

// 분야 버튼을 누르면 그 분야를 다루는 DB만 체크한다. '전 분야'는 모든 DB.
const sourcesForField = f => SOURCES.filter(s => f === '전 분야' || s.fields.includes(f)).map(s => s.id);

function renderSources(selectedIds, field) {
  const sel = new Set(selectedIds || sourcesForField('전 분야'));
  el.srcList.innerHTML = SOURCES.map(s => `
    <label class="src">
      <input type="checkbox" value="${s.id}" ${sel.has(s.id) ? 'checked' : ''}>
      <span><span class="src-name">${esc(s.name)}</span>
        <span class="src-note">${esc(s.note)}</span>
        <span class="src-tags">${s.fields.map(f => `<span>${esc(f)}</span>`).join('')}</span>
      </span>
    </label>`).join('');
  el.fieldChips.innerHTML = FIELD_ORDER.map(f => `<button type="button" data-field="${esc(f)}" aria-pressed="false">${esc(f)}</button>`).join('');
  markField(selectedIds ? fieldOf([...sel]) : '전 분야');
  updateSrcSummary();
}
const selectedSources = () => [...el.srcList.querySelectorAll('input:checked')].map(i => i.value);
// 지금 체크된 DB 조합이 어떤 분야 버튼과 정확히 같은지 (없으면 null)
function fieldOf(ids) {
  const key = [...ids].sort().join(',');
  return FIELD_ORDER.find(f => sourcesForField(f).sort().join(',') === key) || null;
}
function markField(f) {
  el.fieldChips.querySelectorAll('button').forEach(b => {
    const on = b.dataset.field === f;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}
function updateSrcSummary() {
  const ids = selectedSources();
  const names = SOURCES.filter(s => ids.includes(s.id)).map(s => s.name);
  el.srcSummary.textContent = `검색할 DB ${names.length}/${SOURCES.length}개` + (names.length ? ` · ${names.join(', ')}` : ' · 하나 이상 골라줘요');
}
el.srcList.addEventListener('change', () => { markField(fieldOf(selectedSources())); updateSrcSummary(); });
el.fieldChips.addEventListener('click', e => {
  const f = e.target.closest('button[data-field]')?.dataset.field;
  if (!f) return;
  const ids = sourcesForField(f);
  el.srcList.querySelectorAll('input').forEach(i => { i.checked = ids.includes(i.value); });
  markField(f);
  updateSrcSummary();
});

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
  // 링크는 종류(DOI, OpenAlex 등)마다 처음 것 하나만 둔다 — 같은 제목의 다른 기록이 합쳐져도 링크가 늘어나지 않게
  for (const l of raw.links) if (!p.links.some(x => x.url === l.url || x.label === l.label)) p.links.push(l);
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
  let from = /^\d{4}$/.test(el.yearFrom.value) ? +el.yearFrom.value : '';
  let to = /^\d{4}$/.test(el.yearTo.value) ? +el.yearTo.value : '';
  if (from && to && from > to) { [from, to] = [to, from]; el.yearFrom.value = from; el.yearTo.value = to; }
  const o = { size: +el.size.value, from, to, oaOnly: el.oaOnly.checked };
  const srcIds = selectedSources();
  if (!srcIds.length) { el.area.hidden = false; setStatus('검색 소스를 하나 이상 골라줘요.'); return; }

  const seq = ++searchSeq;
  state.searched = kws;
  state.papers.clear();
  state.titleIndex.clear();
  state.doiLookup = null;
  resetPages();
  state.active = new Set(kws);
  updateScholarLink(kws);
  const yr = from || to ? `&y=${from}-${to}` : '';
  try { history.replaceState(null, '', '#q=' + encodeURIComponent(kws.join(',')) + yr + '&s=' + srcIds.join(',')); } catch { /* noop */ }
  el.area.hidden = false;
  el.empty.hidden = true;
  el.results.innerHTML = '';
  el.searchBtn.disabled = true;
  setStatus('검색 중…');

  // 소스×키워드마다 "피드"를 만들어 두고, 처음 한 묶음을 받는다. 나머지는 페이지를 넘길 때 이어서 받는다.
  state.searchOpts = o;
  state.feeds = [];
  limitHit.clear();
  limitShown.clear();
  for (const s of SOURCES.filter(x => srcIds.includes(x.id))) {
    for (const kw of kws) state.feeds.push({ s, kw, cur: undefined, loaded: 0, total: 0, done: false, fails: 0, err: '' });
  }
  await fetchBatch(seq);
  if (seq !== searchSeq) return;
  el.searchBtn.disabled = false;
  render();
}

// 아직 끝나지 않은 피드에서 다음 묶음을 받는다.
// 소스끼리는 동시에, 한 소스 안에서는 요청 한도 때문에 키워드를 순서대로 보낸다.
async function fetchBatch(seq) {
  const o = state.searchOpts;
  const groups = {};
  state.feeds.filter(f => !f.done).forEach(f => (groups[f.s.id] = groups[f.s.id] || []).push(f));
  await Promise.all(Object.values(groups).map(async feeds => {
    for (const f of feeds) {
      try {
        const list = await f.s.fn(f.kw, o, f.cur);
        if (seq !== searchSeq) return;
        list.forEach((p, i) => addPaper(p, f.kw, f.loaded + i));
        f.loaded += list.length;
        if (list.total) f.total = list.total;
        f.cur = list.next;
        f.done = list.next == null;
        f.err = '';
      } catch (err) {
        f.err = err.message;
        if (err.limit) { f.done = true; limitHit.add(f.s.name); } // 한도 초과면 즉시 그 DB 중단
        else if (++f.fails >= 2) f.done = true; // 두 번 실패하면 그 피드는 그만 받는다
      }
    }
  }));
  if (seq !== searchSeq) return;
  state.lastErrors = state.feeds.filter(f => f.err).map(f => `${f.s.name} "${f.kw}" 실패(${f.err})`);
  showLimitPopup();
  // 새로 들어온 논문만 DOI로 PMC 본문 조회 (앞선 조회와 이어서)
  const prev = state.doiLookup;
  const fresh = [...state.papers.values()].filter(p => !p.doiChecked);
  fresh.forEach(p => { p.doiChecked = true; });
  state.doiLookup = Promise.all([prev, lookupPmcByDoi(fresh)]);
}

// 무료 사용 한도 초과 팝업. 이 사이트는 결제 수단·API 키가 없어서 한도를 넘어도 요금이 생기지 않고,
// 해당 DB가 요청을 거절할 뿐이다. 거절되면 그 DB 검색을 멈추고 안내한다.
const limitHit = new Set();
const limitShown = new Set();
function showLimitPopup() {
  const fresh = [...limitHit].filter(n => !limitShown.has(n));
  if (!fresh.length) return;
  fresh.forEach(n => limitShown.add(n));
  const dlg = document.getElementById('limitDialog');
  dlg.querySelector('.limit-dbs').textContent = [...limitHit].join(', ');
  if (dlg.showModal) dlg.showModal(); else alert('사이트 사용 한도 초과: ' + [...limitHit].join(', '));
}

const hasMore = () => !!state.feeds?.some(f => !f.done);
let loadingMore = false;
async function loadMore() {
  if (loadingMore || !hasMore()) return;
  loadingMore = true;
  const seq = searchSeq;
  setStatus('다음 결과 불러오는 중…');
  try { await fetchBatch(seq); } finally { loadingMore = false; }
  if (seq === searchSeq) render();
}

// 상태줄용: DB가 알려준 전체 검색 건수 (키워드·DB 사이 중복 포함)
function totalsHtml() {
  if (!state.feeds?.length) return '';
  const sum = state.feeds.reduce((a, f) => a + (f.total || 0), 0);
  const bySrc = {};
  state.feeds.forEach(f => { bySrc[f.s.name] = (bySrc[f.s.name] || 0) + (f.total || 0); });
  const tip = Object.entries(bySrc).map(([k, v]) => `${k} ${v.toLocaleString()}건`).join(', ');
  return ` · <span title="${esc(tip)}">DB 전체 검색 결과 약 ${sum.toLocaleString()}건${hasMore() ? ', 마지막 쪽에서 다음을 누르면 이어서 불러옴' : ''}</span>`;
}

// PMC 번호가 없는 논문(주로 OpenAlex)을 DOI로 Europe PMC에서 25개씩 묶어 조회 → 본문을 쓸 수 있으면 표시
async function lookupPmcByDoi(papers) {
  const need = papers.filter(p => !p.pmcid && p.doi && /^10\.\S+$/.test(p.doi));
  for (let i = 0; i < need.length; i += 25) {
    const chunk = need.slice(i, i + 25);
    const q = chunk.map(p => `DOI:"${p.doi.replace(/"/g, '')}"`).join(' OR ');
    try {
      const d = await fetchJson(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&resultType=lite&pageSize=100`);
      for (const hit of d.resultList?.result || []) {
        if (!hit.pmcid || !hit.doi) continue;
        const p = chunk.find(x => x.doi === hit.doi.toLowerCase());
        if (!p || p.pmcid) continue;
        p.pmcid = hit.pmcid;
        p.fulltextAvail = hit.inEPMC === 'Y';
        const url = `https://www.ncbi.nlm.nih.gov/pmc/articles/${hit.pmcid}/`;
        if (!p.links.some(l => l.url === url)) p.links.push({ label: 'PMC 전문', url });
      }
    } catch { /* 조회 실패 시 초록만 사용 */ }
  }
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
      h.id = 'grp-' + i;
      h.style.setProperty('--c', KW_COLORS[i]);
      h.innerHTML = `<span class="dot"></span>${esc(k)} <span class="meta">${list.length}편</span>`;
      frag.appendChild(h);
      appendPage(frag, list, 'kw:' + k, h.id); // 키워드 묶음마다 따로 페이지를 넘긴다
    });
    setStatus(`불러온 논문 ${state.papers.size}편 중 키워드별로 나눠서 보는 중 (중복 포함 ${total}건)` + totalsHtml() + errHtml);
  } else {
    const list = filteredPapers();
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    setStatus(`${list.length}편 표시 (불러온 ${state.papers.size}편${pages > 1 ? ` · ${pages}쪽` : ''})` + totalsHtml() + errHtml);
    appendPage(frag, list, 'merged', 'resultsArea');
  }
  el.results.appendChild(frag);
}

/* ---------- 페이지 나누기 (한 쪽에 30편) ---------- */
const PAGE_SIZE = 30;
state.pages = {};
function appendPage(frag, list, key, anchorId) {
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(state.pages[key] || 0, pages - 1);
  state.pages[key] = page;
  if (pages > 1) frag.appendChild(pager(key, page, pages, list.length, anchorId));
  list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).forEach(x => frag.appendChild(card(x.p, x.m)));
  if (pages > 1) frag.appendChild(pager(key, page, pages, list.length, anchorId));
}
function pager(key, page, pages, total, anchorId) {
  const nav = document.createElement('nav');
  nav.className = 'pager';
  nav.setAttribute('aria-label', '페이지');
  // 검색 사이트처럼 쪽 번호를 10개 단위로 보여 준다 (1~10, 11~20 …)
  const start = Math.floor(page / 10) * 10;
  const end = Math.min(pages, start + 10);
  let html = page > 0 ? `<button type="button" class="pg-nav" data-pg="${page - 1}">이전</button>` : '';
  for (let n = start; n < end; n++) {
    html += `<button type="button" data-pg="${n}" class="${n === page ? 'on' : ''}" ${n === page ? 'aria-current="page"' : `aria-label="${n + 1}쪽"`}>${n + 1}</button>`;
  }
  // 마지막 쪽이어도 DB에 남은 결과가 있으면 "다음"으로 이어서 불러온다
  if (page < pages - 1 || hasMore()) html += `<button type="button" class="pg-nav" data-pg="${page + 1}">다음</button>`;
  nav.dataset.count = total;
  nav.title = `${page * PAGE_SIZE + 1}–${Math.min(total, (page + 1) * PAGE_SIZE)} / ${total}편`;
  nav.innerHTML = html;
  nav.dataset.key = key;
  nav.dataset.anchor = anchorId;
  return nav;
}
el.results.addEventListener('click', async e => {
  const b = e.target.closest('.pager button[data-pg]');
  if (!b || b.disabled || b.classList.contains('on')) return;
  const nav = b.closest('.pager');
  const target = +b.dataset.pg;
  const anchor = nav.dataset.anchor;
  // 아직 안 받은 쪽이면 DB에서 다음 묶음을 받아 온다
  if (target * PAGE_SIZE >= +nav.dataset.count && hasMore()) {
    b.disabled = true;
    b.textContent = '불러오는 중…';
    await loadMore();
  }
  state.pages[nav.dataset.key] = target;
  render();
  document.getElementById(anchor === 'resultsArea' ? 'results' : anchor)?.scrollIntoView({ block: 'start' });
});
function resetPages() { state.pages = {}; }

// 같은 종류(label)의 링크는 하나만 남긴다 (예전에 저장된 선택 목록에도 적용)
const uniqueLinks = links => (links || []).filter((l, i, a) => a.findIndex(x => x.label === l.label) === i);

function linksHtml(p) {
  const scholar = 'https://scholar.google.com/scholar?q=' + encodeURIComponent(`"${p.title}"`);
  return uniqueLinks(p.links).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('') +
    `<a href="${esc(scholar)}" target="_blank" rel="noopener">Google Scholar ↗</a>`;
}

function card(p, m) {
  const div = document.createElement('article');
  div.className = 'card' + (state.selected.has(p.key) ? ' sel' : '');
  div.dataset.key = p.key;
  const kws = state.searched;
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
      ${p.summary?.ft === 'ok' ? '<span class="tag ft">본문 요약</span>' : ''}
    </div>
    <div class="links">${linksHtml(p)}</div>
    <div class="sum-wrap">${summaryHtml(p)}</div>`;
  if (!p.summary) observer.observe(div);
  return div;
}

// 요약 구조: { results: { ft, abs }, discussion: { ft, abs }, ft: 'ok'|'nosection'|'none' }
// ft = 본문 기반 추출, abs = 초록 기반 추출. 예전 형식(저장된 선택 목록)도 읽을 수 있게 변환한다.
function normSection(s) {
  if (!s) return { ft: null, abs: null };
  if ('items' in s) return /^본문/.test(s.basis || '') ? { ft: s, abs: null } : { ft: null, abs: s };
  return s;
}
function normSummary(sum) {
  if (!sum) return null;
  return { results: normSection(sum.results), discussion: normSection(sum.discussion), ft: sum.ft || 'none' };
}

const FT_NOTE = { none: '본문 미공개 · 초록만 사용', nosection: '본문에 해당 섹션 없음', loading: '본문 불러오는 중…' };

function subList(label, s, kws) {
  if (!s) return '';
  const body = s.items?.length
    ? `<ul>${s.items.map(t => `<li>${highlight(t, kws)}</li>`).join('')}</ul>`
    : '<p class="none">추출할 문장을 찾지 못했어요.</p>';
  return `<div class="sub"><div class="sub-h">${label}<span class="basis">${esc(s.basis || '')}</span></div>${body}</div>`;
}
function summaryBlock(title, sec, ftState, kws) {
  const note = !sec.ft ? `<p class="ft-note">${esc(FT_NOTE[ftState] || FT_NOTE.none)}</p>` : '';
  return `<section><h4>${title}</h4>${subList('본문 기반', sec.ft, kws)}${note}${subList('초록 기반', sec.abs, kws)}</section>`;
}
function summaryHtml(p) {
  if (!p.summary) return '<p class="loading">요약 불러오는 중…</p>';
  const s = normSummary(p.summary);
  return `<div class="sum">${summaryBlock('Results 요약', s.results, s.ft, state.searched)}${summaryBlock('Discussion 요약', s.discussion, s.ft, state.searched)}</div>`;
}

/* ---------- 요약 (화면에 보일 때 불러옴) ---------- */
const ftQueue = [];
let ftRunning = 0;
const FT_CONCURRENCY = 6;
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
  if (p.summaryPromise) return p.summaryPromise;
  if (p.summary) return Promise.resolve(p.summary);
  const kws = state.searched;
  p.summaryPromise = (async () => {
    const abs = Summ.fromAbstract(p.abstractRaw, kws);
    // DOI로 PMC 본문을 찾는 일괄 조회가 끝날 때까지 기다린다
    if (state.doiLookup) await state.doiLookup;
    let ft = null;
    let ftState = 'none';
    if (p.fulltextAvail && p.pmcid) {
      // 본문을 기다리는 동안 초록 요약부터 보여 준다
      p.summary = {
        results: { ft: null, abs: abs.results },
        discussion: { ft: null, abs: abs.discussion },
        ft: 'loading',
      };
      refreshCards(p.key);
      try {
        ft = await queueFetch(async () => {
          // Europe PMC 본문 서버는 한 건에 10~20초 걸릴 때가 있어 넉넉히 기다린다
          const r = await fetchT(`https://www.ebi.ac.uk/europepmc/webservices/rest/${p.pmcid}/fullTextXML`, 40000);
          if (!r.ok) return null;
          const xml = await r.text();
          return Summ.fromFullText(xml, kws) || { results: null, discussion: null, nosection: true };
        });
      } catch { ft = null; }
      if (ft) ftState = ft.nosection ? 'nosection' : 'ok';
    }
    p.summary = {
      results: { ft: ft?.results || null, abs: abs.results },
      discussion: { ft: ft?.discussion || null, abs: abs.discussion },
      ft: ftState,
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
  document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"]`).forEach(c => {
    c.querySelector('.sum-wrap').innerHTML = summaryHtml(p);
    c.querySelector('.links').innerHTML = linksHtml(p);
    if (p.summary?.ft === 'ok' && !c.querySelector('.tag.ft')) c.querySelector('.tags').insertAdjacentHTML('beforeend', '<span class="tag ft">본문 요약</span>');
  });
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
  resetPages();
  render();
});
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
  resetPages();
  render();
}));
document.querySelectorAll('[data-match]').forEach(b => b.addEventListener('click', () => {
  state.match = b.dataset.match;
  document.querySelectorAll('[data-match]').forEach(x => x.classList.toggle('on', x === b));
  resetPages();
  render();
}));
el.titleOnly.addEventListener('change', () => { resetPages(); render(); });
el.sort.addEventListener('change', () => { resetPages(); render(); });
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
// 논문 전체를 긴 이미지 한 장으로 만들면 브라우저 캔버스 한계 때문에 잘린다.
// 그래서 블록(머리말, 논문 1편)마다 따로 그리고, 문장(.a) 경계에서만 페이지를 넘긴다.
const PDF = { margin: 12, bottom: 14, pageW: 210, pageH: 297 };

function pdfSubList(label, s) {
  if (!s) return '';
  const items = s.items?.length
    ? `<ul style="margin:2px 0 0;padding-left:18px">${s.items.map(t => `<li class="a" style="margin-bottom:3px">${esc(t)}</li>`).join('')}</ul>`
    : '<p class="a" style="margin:2px 0 0;color:#666">추출된 문장 없음 (원문 확인 필요)</p>';
  return `<div style="margin-top:3px"><div class="a" style="font-size:10.5px;color:#2456c9;font-weight:600">${label} <span style="color:#777;font-weight:400">${esc(s.basis || '')}</span></div>${items}</div>`;
}
function pdfSummary(title, sec, ftState) {
  const note = !sec.ft ? `<div class="a" style="font-size:10px;color:#777;margin-top:2px">${esc(FT_NOTE[ftState] || FT_NOTE.none)}</div>` : '';
  return `<div style="margin-top:8px"><div class="a"><b>${title}</b></div>${pdfSubList('본문 기반', sec.ft)}${note}${pdfSubList('초록 기반', sec.abs)}</div>`;
}

function pdfParts(sum) {
  const s = normSummary(sum) || { results: { ft: null, abs: null }, discussion: { ft: null, abs: null }, ft: 'none' };
  return pdfSummary('Results 요약', s.results, s.ft) + pdfSummary('Discussion 요약', s.discussion, s.ft);
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
      <div class="a" style="font-size:14px;font-weight:700;line-height:1.4">${n + 1}. ${esc(s.title)}</div>
      <div class="a" style="color:#555;font-size:10.5px;margin-top:2px">${esc([s.authors, s.venue, s.year].filter(Boolean).join(' · '))}</div>
      <div class="a" style="margin-top:4px">${s.keywords.map(k => `<span style="display:inline-block;font-size:10px;color:#fff;background:${KW_HEX[k.i] || '#555'};border-radius:8px;padding:0 6px;margin-right:4px">${esc(k.k)} · ${esc(k.where)}</span>`).join('')}</div>
      <div style="font-size:10px;margin-top:4px;word-break:break-all">${uniqueLinks(s.links).map(l => `<div class="a">${esc(l.label)}: <a href="${esc(l.url)}" style="color:#2456c9">${esc(l.url)}</a></div>`).join('')}</div>
      ${pdfParts(s.summary)}
    </div>`).join('');
  const wrap = document.createElement('div');
  wrap.style.cssText = `position:absolute;left:0;top:${window.scrollY}px;z-index:-1;width:${PDF.pageW - PDF.margin * 2}mm;color:#111;background:#fff;font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif;font-size:11.5px;line-height:1.55`;
  wrap.innerHTML = head.replace('<div style=', '<div class="a" style=') + body;
  return wrap;
}

function sliceCanvas(canvas, fromPx, toPx) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = Math.max(1, toPx - fromPx);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, fromPx, canvas.width, c.height, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}

// stats(선택): 점검용. 블록별 원래 높이와 PDF에 실제로 들어간 높이, 페이지 밖으로 넘친 횟수를 기록한다.
async function renderPdf(items, onProgress, stats) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const contentW = PDF.pageW - PDF.margin * 2;
  const pageBottom = PDF.pageH - PDF.bottom;
  const root = buildPdfHtml(items);
  document.body.appendChild(root);
  try {
    let y = PDF.margin;
    const blocks = [...root.children];
    for (let bi = 0; bi < blocks.length; bi++) {
      onProgress?.(bi + 1, blocks.length);
      const blk = blocks[bi];
      const box = blk.getBoundingClientRect();
      const H = box.height;
      const mmPerPx = contentW / box.width;
      // 잘라도 되는 위치 = 각 문장·줄 블록의 아래쪽
      const breaks = [...new Set([...blk.querySelectorAll('.a')].map(e => e.getBoundingClientRect().bottom - box.top).concat([H]))].sort((a, b) => a - b);
      const links = [...blk.querySelectorAll('a[href]')].map(a => {
        const r = a.getBoundingClientRect();
        return { url: a.href, x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
      });
      const canvas = await html2canvas(blk, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true });
      const k = canvas.height / H; // CSS px -> 캔버스 px
      const rec = { H, placed: 0, blankCanvas: !canvas.width || !canvas.height };
      stats?.blocks.push(rec);

      let start = 0;
      while (start < H - 0.5) {
        const availPx = (pageBottom - y) / mmPerPx;
        let end;
        if (H - start <= availPx) end = H;
        else {
          const fit = breaks.filter(b => b > start + 1 && b <= start + availPx);
          if (fit.length) end = fit[fit.length - 1];
          else if (y > PDF.margin + 0.5) { pdf.addPage(); y = PDF.margin; continue; } // 다음 페이지에서 다시 시도
          else end = start + availPx; // 한 줄이 한 페이지보다 큰 경우만 강제로 자름
        }
        const hMm = (end - start) * mmPerPx;
        rec.placed += end - start;
        if (stats && y + hMm > pageBottom + 0.5) stats.overflow++;
        pdf.addImage(sliceCanvas(canvas, Math.round(start * k), Math.round(end * k)), 'JPEG', PDF.margin, y, contentW, hMm);
        for (const l of links) {
          if (l.y >= start - 1 && l.y + l.h <= end + 1) {
            pdf.link(PDF.margin + l.x * mmPerPx, y + (l.y - start) * mmPerPx, l.w * mmPerPx, l.h * mmPerPx, { url: l.url });
          }
        }
        y += hMm;
        start = end;
        if (start < H - 0.5) { pdf.addPage(); y = PDF.margin; }
      }
      y += 2;
    }
    const n = pdf.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      pdf.setPage(i);
      pdf.setFontSize(9);
      pdf.setTextColor(150);
      pdf.text(`${i} / ${n}`, PDF.pageW / 2, PDF.pageH - 6, { align: 'center' });
    }
    return pdf;
  } finally {
    root.remove();
  }
}

el.exportPdf.addEventListener('click', async () => {
  if (!state.selected.size) return;
  if (typeof html2canvas === 'undefined' || !window.jspdf) { alert('PDF 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인해 줘요.'); return; }
  el.exportPdf.disabled = true;
  const label = el.exportPdf.textContent;
  el.exportPdf.textContent = '요약 정리 중…';
  try {
    // 아직 요약이 없는 항목은 먼저 만든다
    for (const [key, snap] of state.selected) {
      const p = state.papers.get(key);
      if (p && (!snap.summary || snap.summary.ft === 'loading')) { await ensureSummary(p); state.selected.set(key, snapshot(p)); }
    }
    saveSelected();
    const pdf = await renderPdf([...state.selected.values()], (i, n) => {
      el.exportPdf.textContent = `PDF 만드는 중… (${i}/${n})`;
    });
    pdf.save(`선행연구_요약_${Date.now()}.pdf`);
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
  const y = location.hash.match(/[#&]y=(\d{4})?-(\d{4})?/);
  if (y) { el.yearFrom.value = y[1] || ''; el.yearTo.value = y[2] || ''; }
  // 검색 소스: 링크에 s=가 있으면 그대로, 없으면 기본값 '전 분야'(모든 DB)
  const sm = location.hash.match(/[#&]s=([a-z,]+)/);
  renderSources(sm ? sm[1].split(',') : null);
  if (m) {
    try { addKeywords(decodeURIComponent(m[1])); } catch { /* noop */ }
    if (state.keywords.length) runSearch();
  } else renderKwChips();
})();
