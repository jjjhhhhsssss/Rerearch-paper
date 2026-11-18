// 추출 요약: 본문 섹션 또는 초록에서 핵심 문장을 골라낸다 (LLM 없음).
'use strict';

const Summ = (() => {
  const RESULT_CUES = /\b(significant(ly)?|increas\w*|decreas\w*|higher|lower|greater|fewer|associated|correlat\w*|show(ed|n|s)?|found|observ\w*|reduc\w*|improv\w*|compared|accuracy|precision|recall|outperform\w*|achiev\w*|odds ratio|hazard ratio|95% ?CI|mean|median)\b|p\s*[<=>≤]\s*0?\.\d|\d+(\.\d+)?\s*%/i;
  const DISC_CUES = /\b(suggest\w*|indicat\w*|implicat\w*|conclu\w*|demonstrat\w*|support\w*|consistent with|in contrast|limitation\w*|future (research|studies|work)|may|might|could|should|important(ly)?|highlight\w*|therefore|overall|taken together|in summary)\b/i;
  const NUM = /\d/;

  function htmlToText(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function sentences(text) {
    if (!text) return [];
    return text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+(?=[A-Z(\[“"])/)
      .map(s => s.trim())
      .filter(s => s.length >= 40 && s.length <= 500);
  }

  function kwHits(s, kws) {
    const low = s.toLowerCase();
    let n = 0;
    for (const k of kws) if (low.includes(k.toLowerCase())) n++;
    return n;
  }

  // kind: 'results' | 'discussion'
  function pick(text, kind, kws, n = 3, opts = {}) {
    const sents = sentences(text);
    if (!sents.length) return [];
    const cue = kind === 'results' ? RESULT_CUES : DISC_CUES;
    const scored = sents.map((s, i) => {
      let sc = 0;
      sc += kwHits(s, kws) * 3;
      if (cue.test(s)) sc += 2;
      if (kind === 'results' && NUM.test(s)) sc += 1;
      if (kind === 'discussion' && /\b(we|our|this study|these findings|these results)\b/i.test(s)) sc += 1;
      if (opts.skipFirst && i === 0) sc -= 3;
      if (opts.preferEnd) sc += (i / sents.length) * 1.5;
      if (opts.preferStart) sc += (1 - i / sents.length) * 1.5;
      if (/^(table|figure|fig\.)\s*\d/i.test(s)) sc -= 5;
      return { s, i, sc };
    });
    return scored
      .sort((a, b) => b.sc - a.sc || a.i - b.i)
      .slice(0, n)
      .filter(x => x.sc > 0 || sents.length <= n)
      .sort((a, b) => a.i - b.i)
      .map(x => x.s);
  }

  // 구조화 초록 (Background/Methods/Results/Conclusions) 분리
  function structuredAbstract(raw) {
    if (!raw) return {};
    let t = String(raw).replace(/<h4>\s*([^<]+?)\s*<\/h4>/gi, ' §§$1§§ ');
    t = htmlToText(t);
    t = t.replace(/\b(BACKGROUND|INTRODUCTION|PURPOSE|AIMS?|OBJECTIVES?|METHODS?|MATERIALS AND METHODS|DESIGN|RESULTS?|FINDINGS|CONCLUSIONS?|DISCUSSION|INTERPRETATION|SIGNIFICANCE)\s*:/g, ' §§$1§§ ');
    const parts = t.split('§§');
    if (parts.length < 3) return {};
    const out = {};
    for (let i = 1; i < parts.length - 1; i += 2) {
      const label = parts[i].toLowerCase();
      const body = (parts[i + 1] || '').trim();
      if (/result|finding/.test(label)) out.results = (out.results ? out.results + ' ' : '') + body;
      else if (/conclu|discuss|interpret|significance/.test(label)) out.discussion = (out.discussion ? out.discussion + ' ' : '') + body;
    }
    return out;
  }

  function fromAbstract(raw, kws) {
    const st = structuredAbstract(raw);
    const plain = htmlToText(raw);
    // 구조화되지 않은 초록: 뒤쪽 약 1/3은 결론(Discussion) 후보, 그 앞(첫 문장 제외)은 결과(Results) 후보
    const all = sentences(plain);
    const nDis = all.length >= 3 ? Math.max(1, Math.ceil(all.length * 0.35)) : (all.length ? 1 : 0);
    const disPart = all.slice(all.length - nDis);
    let resPart = all.slice(all.length > 3 ? 1 : 0, all.length - nDis);
    if (!resPart.length) resPart = all.slice(0, all.length - nDis);

    const res = st.results
      ? { items: pick(st.results, 'results', kws, 3), basis: '초록 Results' }
      : { items: pick(resPart.join(' '), 'results', kws, 2), basis: '초록 기반 추출' };
    if (!res.items.length && resPart.length) res.items = resPart.slice(-2);
    let dis;
    if (st.discussion) {
      dis = { items: pick(st.discussion, 'discussion', kws, 3), basis: '초록 Conclusions' };
    } else {
      let items = pick(disPart.join(' '), 'discussion', kws, 2, { preferEnd: true });
      if (!items.length && disPart.length) items = [disPart[disPart.length - 1]];
      dis = { items, basis: '초록 기반 추출' };
    }
    return { results: res, discussion: dis };
  }

  // Europe PMC JATS XML 본문에서 Results / Discussion 섹션 텍스트 추출
  function sectionsFromJats(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) return {};
    const body = doc.getElementsByTagName('body')[0];
    if (!body) return {};
    body.querySelectorAll('table-wrap, fig, disp-formula, supplementary-material, xref, ext-link[ext-link-type="uri"]').forEach(n => n.remove());
    const out = { results: '', discussion: '' };
    const secs = Array.from(body.children).filter(n => n.nodeName === 'sec');
    for (const sec of secs) {
      const type = (sec.getAttribute('sec-type') || '').toLowerCase();
      const titleEl = Array.from(sec.children).find(c => c.nodeName === 'title');
      const title = (titleEl ? titleEl.textContent : '').toLowerCase();
      const label = type + ' ' + title;
      const text = Array.from(sec.getElementsByTagName('p')).map(p => p.textContent).join(' ').replace(/\s+/g, ' ').replace(/[\[(]\s*[,;–\-\s]*[\])]/g, '');
      const isRes = /result|finding/.test(label);
      const isDis = /discussion|conclu/.test(label);
      if (isRes) out.results += ' ' + text;
      if (isDis) out.discussion += ' ' + text;
      if (isRes && isDis) out.combined = true;
    }
    out.results = out.results.trim();
    out.discussion = out.discussion.trim();
    return out;
  }

  function fromFullText(xmlText, kws) {
    const s = sectionsFromJats(xmlText);
    if (!s.results && !s.discussion) return null;
    return {
      results: s.results ? { items: pick(s.results, 'results', kws, 3, { preferStart: true }), basis: '본문 Results 섹션' } : null,
      discussion: s.discussion ? { items: pick(s.discussion, 'discussion', kws, 3, { preferStart: !s.combined, preferEnd: s.combined }), basis: '본문 Discussion 섹션' } : null,
    };
  }

  return { htmlToText, fromAbstract, fromFullText, pick, structuredAbstract };
})();
