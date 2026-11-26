/*! ion-tools.js — 어떤 HTML 수업자료에도 붙는 노트 / 메모 / 구문 / 단어 도구
 * 사용: <script src=".../ion-tools.js" data-doc="2025-고1-3월-18번"
 *        data-supabase-url="https://xxxx.supabase.co" data-supabase-key="anon 공개키"></script>
 * 저장: 로컬 먼저(localStorage) → Supabase 표 1개(ion_items)에 동기화. 오프라인에서도 동작.
 */
(function () {
  'use strict';
  if (window.IonTools) return;

  /* ───────── 설정 ───────── */
  var S = document.currentScript || document.querySelector('script[src*="ion-tools"]');
  var ds = (S && S.dataset) || {};
  function autoDoc() {
    var p = decodeURIComponent((location.pathname.split('/').pop() || 'index')).replace(/\.html?$/i, '').replace(/\s*\(\d+\)$/, '');
    return p || document.title || 'doc';
  }
  var CFG = {
    wordsUrl: ds.wordsUrl || (S && S.src ? new URL('ion-words.json', S.src).href : ''),
    doc: ds.doc || autoDoc(),
    url: (ds.supabaseUrl || '').replace(/\/+$/, ''),
    key: ds.supabaseKey || '',
    table: ds.table || 'ion_items',
    createUser: ds.createUser !== 'false',
    tabs: (ds.tabs || 'note,memo,phrase,word').split(',').map(function (s) { return s.trim(); }),
    ns: ds.ns || 'ion:v1',
    bridge: (ds.bridge || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean)
  };
  var REMOTE = !!(CFG.url && CFG.key);

  /* ───────── 유틸 ───────── */
  var LS = window.localStorage;
  function jget(k, d) { try { var v = LS.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function jset(k, v) { try { LS.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function nowISO() { return new Date().toISOString(); }
  function uid() { return Math.random().toString(36).slice(2, 8) + Date.now().toString(36); }
  function hash(s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      var v = attrs[k];
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ───────── 로컬 저장소 (항목 = doc + kind + key) ───────── */
  var K_ITEMS = CFG.ns + ':items', K_DIRTY = CFG.ns + ':dirty', K_PULL = CFG.ns + ':pull', K_SESS = CFG.ns + ':sess', K_PREF = CFG.ns + ':pref';
  var items = jget(K_ITEMS, {}), dirty = jget(K_DIRTY, {}), pref = jget(K_PREF, {});
  var listeners = [];
  function iid(doc, kind, k) { return doc + '\u0001' + kind + '\u0001' + k; }
  var saveLocal = debounce(function () { jset(K_ITEMS, items); jset(K_DIRTY, dirty); }, 120);
  function flushLocal() { jset(K_ITEMS, items); jset(K_DIRTY, dirty); }
  function emit(ev) { listeners.forEach(function (f) { try { f(ev); } catch (e) { } }); }

  var Store = {
    get: function (doc, kind, k) { var it = items[iid(doc, kind, k)]; return it && !it.del ? it.body : null; },
    put: function (doc, kind, k, body) {
      var id = iid(doc, kind, k);
      items[id] = { doc: doc, kind: kind, k: k, body: body, ts: nowISO(), del: false };
      dirty[id] = items[id].ts; saveLocal(); schedulePush(); emit({ type: 'change', kind: kind });
    },
    remove: function (doc, kind, k) {
      var id = iid(doc, kind, k);
      items[id] = { doc: doc, kind: kind, k: k, body: null, ts: nowISO(), del: true };
      dirty[id] = items[id].ts; saveLocal(); schedulePush(); emit({ type: 'change', kind: kind });
    },
    list: function (kind, doc) {
      var out = [];
      for (var id in items) {
        var it = items[id];
        if (it.del || it.kind !== kind) continue;
        if (doc != null && it.doc !== doc) continue;
        out.push(it);
      }
      return out;
    }
  };

  /* ───────── Supabase 연결 (SDK 없이 REST) ───────── */
  var sess = jget(K_SESS, null);
  var state = { s: REMOTE ? (sess ? 'idle' : 'out') : 'local', msg: '', at: null };
  function setState(s, msg) { state.s = s; state.msg = msg || ''; if (s === 'ok') state.at = nowISO(); emit({ type: 'state' }); }

  function http(method, path, body, extra) {
    var headers = { apikey: CFG.key, 'Content-Type': 'application/json' };
    headers.Authorization = 'Bearer ' + ((extra && extra.anon) ? CFG.key : (sess ? sess.at : CFG.key));
    if (extra && extra.headers) for (var k in extra.headers) headers[k] = extra.headers[k];
    return fetch(CFG.url + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { }
        if (!r.ok) { var e = new Error((j && (j.msg || j.message || j.error_description || j.error)) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function saveSess(j) {
    sess = { at: j.access_token, rt: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, uid: j.user && j.user.id, email: j.user && j.user.email };
    jset(K_SESS, sess);
  }
  function refresh() {
    if (!sess || !sess.rt) return Promise.reject(new Error('로그인이 필요합니다'));
    return http('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token: sess.rt }, { anon: true }).then(saveSess);
  }
  function authed(method, path, body, extra) {
    var pre = (sess && sess.exp - Date.now() < 60000) ? refresh() : Promise.resolve();
    return pre.then(function () { return http(method, path, body, extra); }).catch(function (e) {
      if (e.status === 401 && sess && sess.rt && !(extra && extra._retried)) {
        return refresh().then(function () { return authed(method, path, body, Object.assign({}, extra, { _retried: true })); });
      }
      throw e;
    });
  }
  var Auth = {
    sendCode: function (email) { return http('POST', '/auth/v1/otp', { email: email, create_user: CFG.createUser }, { anon: true }); },
    verify: function (email, code) {
      return http('POST', '/auth/v1/verify', { type: 'email', email: email, token: String(code).trim() }, { anon: true }).then(function (j) {
        saveSess(j); setState('idle'); return Sync.run();
      });
    },
    password: function (email, pw) {
      return http('POST', '/auth/v1/token?grant_type=password', { email: email, password: pw }, { anon: true }).then(function (j) { saveSess(j); setState('idle'); return Sync.run(); });
    },
    logout: function () { sess = null; LS.removeItem(K_SESS); setState(REMOTE ? 'out' : 'local'); },
    email: function () { return sess && sess.email; }
  };

  var pushTimer = null, running = false, again = false;
  function schedulePush() { if (!REMOTE || !sess) return; clearTimeout(pushTimer); pushTimer = setTimeout(function () { Sync.run(); }, 1500); }

  var Sync = {
    run: function () {
      if (!REMOTE || !sess) return Promise.resolve();
      if (!navigator.onLine) { setState('offline'); return Promise.resolve(); }
      if (running) { again = true; return Promise.resolve(); }
      running = true; setState('busy');
      return Sync.push().then(Sync.pull).then(function () { setState('ok'); }).catch(function (e) {
        if (e.status === 401 || e.status === 400 && /refresh|token/i.test(e.message)) { sess = null; LS.removeItem(K_SESS); setState('out', '다시 로그인해 주세요'); }
        else setState('err', e.message);
      }).then(function () { running = false; flushLocal(); if (again) { again = false; return Sync.run(); } });
    },
    push: function () {
      var ids = Object.keys(dirty);
      if (!ids.length) return Promise.resolve();
      var rows = ids.map(function (id) {
        var it = items[id];
        return { user_id: sess.uid, doc: it.doc, kind: it.kind, k: it.k, body: it.body, deleted: !!it.del, updated_at: it.ts };
      });
      var chunks = [], i;
      for (i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
      var path = '/rest/v1/' + CFG.table + '?on_conflict=user_id,doc,kind,k';
      var sentTs = {}; ids.forEach(function (id) { sentTs[id] = dirty[id]; });
      return chunks.reduce(function (p, c) {
        return p.then(function () { return authed('POST', path, c, { headers: { Prefer: 'resolution=merge-duplicates,return=minimal' } }); });
      }, Promise.resolve()).then(function () {
        ids.forEach(function (id) { if (dirty[id] === sentTs[id]) delete dirty[id]; });
      });
    },
    pull: function () {
      var cursor = jget(K_PULL, '1970-01-01T00:00:00Z'), changed = false;
      function page() {
        var q = '/rest/v1/' + CFG.table + '?select=doc,kind,k,body,deleted,updated_at,synced_at&synced_at=gt.' + encodeURIComponent(cursor) + '&order=synced_at.asc&limit=500';
        return authed('GET', q).then(function (rows) {
          rows = rows || [];
          rows.forEach(function (r) {
            var id = iid(r.doc, r.kind, r.k), loc = items[id];
            if (loc && dirty[id] && Date.parse(loc.ts) > Date.parse(r.updated_at)) { /* 내 변경이 더 최신 → 유지 */ }
            else if (!loc || Date.parse(loc.ts) <= Date.parse(r.updated_at)) {
              items[id] = { doc: r.doc, kind: r.kind, k: r.k, body: r.body, ts: r.updated_at, del: !!r.deleted };
              delete dirty[id]; changed = true;
            }
            if (r.synced_at > cursor) cursor = r.synced_at;
          });
          if (rows.length >= 500) return page();
        });
      }
      return page().then(function () { jset(K_PULL, cursor); flushLocal(); if (changed) emit({ type: 'change', kind: '*' }); });
    }
  };

  /* ───────── 기존 앱 연결: localStorage 키를 그대로 서버와 동기화 (data-bridge="ion_") ───────── */
  var applying = false, kvPending = 0, lsSet = Storage.prototype.setItem, lsRm = Storage.prototype.removeItem;
  function bmatch(k) { return typeof k === 'string' && k.indexOf(CFG.ns) !== 0 && CFG.bridge.some(function (p) { return k.indexOf(p) === 0; }); }
  if (CFG.bridge.length) {
    Storage.prototype.setItem = function (k, v) { lsSet.call(this, k, v); if (this === LS && !applying && bmatch(k)) Store.put('*', 'kv', k, { v: String(v) }); };
    Storage.prototype.removeItem = function (k) { lsRm.call(this, k); if (this === LS && !applying && bmatch(k)) Store.remove('*', 'kv', k); };
  }
  function bridgeScan() {            // 이미 이 기기에 있던 값을 처음 한 번 서버 대기열에 올림
    if (!CFG.bridge.length) return;
    for (var i = 0; i < LS.length; i++) {
      var k = LS.key(i); if (!bmatch(k)) continue;
      if (items[iid('*', 'kv', k)] === undefined) Store.put('*', 'kv', k, { v: LS.getItem(k) });
    }
  }
  function bridgeApply() {           // 다른 기기에서 받은 값을 localStorage에 반영
    if (!CFG.bridge.length) return 0;
    var n = 0; applying = true;
    try {
      Store.list('kv', '*').forEach(function (it) { if (LS.getItem(it.k) !== it.body.v) { lsSet.call(LS, it.k, it.body.v); n++; } });
      for (var id in items) { var it = items[id]; if (it.kind === 'kv' && it.del && LS.getItem(it.k) !== null) { lsRm.call(LS, it.k); n++; } }
    } finally { applying = false; }
    return n;
  }

  /* ───────── 본문 텍스트 위치 찾기 (구문 하이라이트·이동) ───────── */
  var host, root, ui = {};
  function textIndex() {
    var nodes = [], full = '';
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p || p.closest('script,style,noscript,textarea,#ion-tools-host')) return NodeFilter.FILTER_REJECT;
        return n.nodeValue ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var n; while ((n = w.nextNode())) { nodes.push({ n: n, s: full.length }); full += n.nodeValue; }
    return { nodes: nodes, full: full };
  }
  function rangeAt(idx, a, b) {
    var ns = idx.nodes, sN, sO, eN, eO;
    for (var i = 0; i < ns.length; i++) {
      var s = ns[i].s, e = s + ns[i].n.nodeValue.length;
      if (!sN && a < e) { sN = ns[i].n; sO = a - s; }
      if (b <= e) { eN = ns[i].n; eO = b - s; break; }
    }
    if (!sN || !eN) return null;
    var r = document.createRange(); try { r.setStart(sN, Math.max(0, sO)); r.setEnd(eN, Math.max(0, eO)); } catch (e) { return null; } return r;
  }
  function findRanges(text, ctx, all) {
    var idx = textIndex(), out = [], from = 0, p;
    if (!text) return out;
    while ((p = idx.full.indexOf(text, from)) >= 0) {
      var r = rangeAt(idx, p, p + text.length); if (r) out.push({ r: r, p: p });
      from = p + text.length; if (!all && out.length > 30) break;
    }
    if (!all && out.length > 1 && ctx) {
      var best = out.filter(function (o) { return idx.full.slice(Math.max(0, o.p - 60), o.p + text.length + 60).indexOf(ctx) >= 0; });
      if (best.length) return [best[0].r];
    }
    return out.map(function (o) { return o.r; });
  }
  var hlOK = !!(window.CSS && CSS.highlights && window.Highlight);
  var paintHL = debounce(function () {
    if (!hlOK) return;
    var rs = [];
    Store.list('phrase').forEach(function (it) { var f = findRanges(it.body.text, it.body.ctx); if (f[0]) rs.push(f[0]); });
    CSS.highlights.set('ion-phrase', new Highlight(...rs));
  }, 250);
  function jumpTo(text, ctx) {
    var f = findRanges(text, ctx); if (!f[0]) return false;
    var el = f[0].startContainer.parentElement; if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (hlOK) { CSS.highlights.set('ion-flash', new Highlight(f[0])); setTimeout(function () { CSS.highlights.delete('ion-flash'); }, 1800); }
    return true;
  }

  /* ───────── 스티커 메모 (요소 기준 상대 위치로 저장) ───────── */
  var COLORS = ['#fff3a3', '#ffd6e0', '#cfeeff', '#d9f5c8'];
  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body && el !== document.documentElement) {
      if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var tag = el.tagName.toLowerCase(), i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(tag + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return parts.join('>');
  }
  function anchorFor(clientX, clientY) {
    host.style.pointerEvents = 'none';
    var el = document.elementFromPoint(clientX, clientY);
    host.style.pointerEvents = '';
    var px = clientX + scrollX, py = clientY + scrollY;
    if (!el || el === document.documentElement || el === document.body) return { sel: '', fx: 0, fy: 0, px: px, py: py };
    var r = el.getBoundingClientRect();
    return { sel: cssPath(el), fx: r.width ? (clientX - r.left) / r.width : 0, fy: r.height ? (clientY - r.top) / r.height : 0, px: px, py: py };
  }
  function posOf(a) {
    var el = null; if (a.sel) { try { el = document.querySelector(a.sel); } catch (e) { } }
    if (el) { var r = el.getBoundingClientRect(); if (r.width || r.height) return { x: r.left + scrollX + a.fx * r.width, y: r.top + scrollY + a.fy * r.height }; }
    return { x: a.px, y: a.py };
  }
  var stickyEls = {}, placing = false;
  function renderStickies() {
    var list = Store.list('memo', CFG.doc), seen = {};
    list.forEach(function (it) {
      seen[it.k] = 1;
      var el = stickyEls[it.k];
      if (!el) { el = stickyEls[it.k] = makeSticky(it.k); ui.layer.appendChild(el); }
      var b = it.body, p = posOf(b);
      el.style.left = Math.max(0, p.x) + 'px'; el.style.top = Math.max(0, p.y) + 'px';
      el.style.background = b.c || COLORS[0];
      el.style.display = pref.hideMemo ? 'none' : '';
      var ta = el.querySelector('textarea');
      if (root.activeElement !== ta && ta.value !== b.t) ta.value = b.t || '';
    });
    for (var k in stickyEls) if (!seen[k]) { stickyEls[k].remove(); delete stickyEls[k]; }
  }
  var relayout = (function () { var q = false; return function () { if (q) return; q = true; requestAnimationFrame(function () { q = false; renderStickies(); }); }; })();

  function makeSticky(k) {
    var ta = h('textarea', { placeholder: '메모…', rows: 3 });
    var save = debounce(function () { var b = Store.get(CFG.doc, 'memo', k); if (b && b.t !== ta.value) { b = Object.assign({}, b, { t: ta.value }); Store.put(CFG.doc, 'memo', k, b); } }, 500);
    ta.addEventListener('input', save);
    var bar = h('div', { class: 'sbar' }, [
      h('span', { class: 'sdots' }, COLORS.map(function (c) {
        return h('i', { style: 'background:' + c, onclick: function () { var b = Store.get(CFG.doc, 'memo', k); if (b) Store.put(CFG.doc, 'memo', k, Object.assign({}, b, { c: c })); } });
      })),
      h('b', { class: 'sx', title: '삭제', text: '×', onclick: function () { if (!ta.value || confirm('이 메모를 지울까요?')) Store.remove(CFG.doc, 'memo', k); } })
    ]);
    var el = h('div', { class: 'stk', 'data-k': k }, [bar, ta]);
    var drag = null;
    bar.addEventListener('pointerdown', function (e) {
      if (e.target.closest('i,b')) return;
      var r = el.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.setPointerCapture(e.pointerId); e.preventDefault();
    });
    bar.addEventListener('pointermove', function (e) {
      if (!drag) return; el.style.left = (e.clientX - drag.dx + scrollX) + 'px'; el.style.top = (e.clientY - drag.dy + scrollY) + 'px';
    });
    bar.addEventListener('pointerup', function (e) {
      if (!drag) return; drag = null;
      var b = Store.get(CFG.doc, 'memo', k); if (!b) return;
      var r = el.getBoundingClientRect(), a = anchorFor(r.left + 6, r.top + 6);
      Store.put(CFG.doc, 'memo', k, Object.assign({}, b, a));
    });
    return el;
  }
  function addMemoAt(cx, cy) {
    var a = anchorFor(cx, cy), k = uid();
    Store.put(CFG.doc, 'memo', k, Object.assign({ t: '', c: COLORS[pref.ci % COLORS.length || 0] }, a));
    pref.ci = ((pref.ci || 0) + 1) % COLORS.length; jset(K_PREF, pref);
    renderStickies();
    var ta = stickyEls[k] && stickyEls[k].querySelector('textarea'); if (ta) ta.focus();
  }
  function setPlacing(on) {
    placing = on; document.documentElement.classList.toggle('ion-placing', on);
    if (ui.addMemoBtn) ui.addMemoBtn.textContent = on ? '붙일 위치를 클릭하세요 (Esc 취소)' : '+ 메모 붙이기';
    if (on) closePanel();
  }
  document.addEventListener('click', function (e) {
    if (!placing) return;
    if (e.target.closest && e.target.closest('#ion-tools-host')) return;
    e.preventDefault(); e.stopPropagation(); setPlacing(false); addMemoAt(e.clientX, e.clientY);
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && placing) setPlacing(false); });

  /* ───────── 패널 UI ───────── */
  var CSS_TEXT = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif}',
    '.dock{position:fixed;right:16px;bottom:16px;z-index:2147483000;width:46px;height:46px;border-radius:50%;background:#1f3a5f;color:#fff;font-size:13px;font-weight:700;border:0;cursor:pointer;box-shadow:0 2px 10px #0004;display:flex;align-items:center;justify-content:center}',
    '.dock .dt{position:absolute;right:2px;top:2px;width:11px;height:11px;border-radius:50%;border:2px solid #fff;background:#9aa3b0}',
    '.dt.ok{background:#2fb26a}.dt.busy{background:#e0a21b}.dt.err,.dt.out{background:#d9534f}.dt.local{background:#9aa3b0}.dt.offline{background:#888}',
    '.drawer{position:fixed;top:0;right:0;bottom:0;width:min(380px,100vw);z-index:2147483001;background:#fff;box-shadow:-4px 0 24px #0003;display:none;flex-direction:column;color:#1d2330;font-size:14px}',
    '.drawer.on{display:flex}',
    '.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e6e9ee}.hd b{flex:1;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.x{border:0;background:none;font-size:22px;cursor:pointer;color:#6b7480;line-height:1}',
    '.tabs{display:flex;border-bottom:1px solid #e6e9ee}.tabs button{flex:1;padding:9px 0;border:0;background:none;font-size:13px;cursor:pointer;color:#6b7480;border-bottom:2px solid transparent}.tabs button.on{color:#2f5bff;border-color:#2f5bff;font-weight:700}',
    '.body{flex:1;overflow:auto;padding:12px}',
    'textarea,input{width:100%;border:1px solid #d3d8df;border-radius:8px;padding:8px 10px;font-size:14px;color:#1d2330;background:#fff;outline:0}textarea:focus,input:focus{border-color:#2f5bff}',
    '.note{height:calc(100vh - 150px);resize:none;line-height:1.6}',
    '.btn{white-space:nowrap;border:1px solid #cdd5e0;background:#fff;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;color:#1d2330}.btn.pri{background:#1f3a5f;color:#fff;border-color:#1f3a5f}.btn.sm{padding:3px 8px;font-size:12px}',
    '.row{display:flex;gap:6px;align-items:center;margin-bottom:8px}',
    '.card{border:1px solid #e3e6ea;border-radius:10px;padding:9px 11px;margin-bottom:8px;background:#fafbfc}',
    '.card .t{font-size:14px;line-height:1.5;cursor:pointer}.card .m{font-size:11.5px;color:#8a93a1;margin-top:3px;display:flex;gap:8px;align-items:center}.card textarea{margin-top:6px;font-size:13px;min-height:44px}',
    '.card .m .sp{flex:1}.link{color:#2f5bff;cursor:pointer}.del{color:#b3bac6;cursor:pointer;border:0;background:none;font-size:15px}.del:hover{color:#d9534f}',
    '.empty{color:#9aa3b0;text-align:center;padding:30px 0;font-size:13px}',
    '.hint{font-size:12px;color:#8a93a1;margin:6px 0}',
    '.wd{display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid #eef0f3}.wd .en{font-family:Georgia,serif;font-weight:700;font-size:15px;min-width:90px;cursor:pointer}.wd input{border:0;padding:3px 4px;border-bottom:1px dashed #d3d8df;border-radius:0;flex:1;font-size:13px}.star{cursor:pointer;color:#c4cad4;font-size:16px;border:0;background:none}.star.on{color:#f0a60c}',
    '.sel{position:fixed;z-index:2147483002;display:none;background:#1f3a5f;border-radius:8px;padding:4px;box-shadow:0 2px 10px #0005;gap:2px}.sel.on{display:flex}.sel button{border:0;background:none;color:#fff;font-size:12.5px;padding:5px 9px;border-radius:6px;cursor:pointer}.sel button:hover{background:#ffffff26}',
    '.layer{position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147482990}',
    '.stk{position:absolute;width:190px;border-radius:4px;box-shadow:0 3px 10px #0003;display:flex;flex-direction:column}.stk .sbar{display:flex;align-items:center;justify-content:space-between;padding:3px 6px;cursor:move;background:#0000000d;touch-action:none}',
    '.sdots{display:flex;gap:4px}.sdots i{width:11px;height:11px;border-radius:50%;border:1px solid #0003;cursor:pointer}.sx{cursor:pointer;color:#6b7480;font-size:16px;line-height:1}',
    '.stk textarea{border:0;background:transparent;border-radius:0 0 4px 4px;min-height:70px;resize:vertical;font-size:13px;color:#222}',
    '.toast{position:fixed;left:16px;bottom:16px;z-index:2147483003;background:#1f3a5f;color:#fff;border-radius:10px;padding:9px 12px;font-size:13px;display:none;gap:10px;align-items:center;box-shadow:0 2px 10px #0005}.toast.on{display:flex}.toast button{border:0;border-radius:6px;padding:4px 10px;cursor:pointer}',
    '.stat{font-size:13px;line-height:1.7}.stat .pill{display:inline-block;padding:1px 9px;border-radius:10px;font-size:12px;background:#eef2ff;color:#2443c9}',
    '.fchips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px}.fc{padding:4px 10px;border:1px solid #d3d8df;border-radius:999px;background:#fff;font-size:12.5px;cursor:pointer;color:#445}.fc.on{background:#1f3a5f;color:#fff;border-color:#1f3a5f}.fc small{opacity:.65;margin-left:5px}.fc.add{border-style:dashed;color:#2f5bff}',
    '.fm{background:#f4f6fb;border-radius:8px;padding:6px 10px;margin-bottom:10px}.fm b{font-size:13px}.sp{flex:1}',
    'select.mv{width:auto;max-width:105px;border:1px solid #d3d8df;border-radius:7px;padding:3px 4px;font-size:12px;background:#fff;color:#445}.wd select.mv{max-width:78px}',
    '.card .sn{color:#7a8294;font-size:12.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gh{font-size:12.5px;font-weight:700;color:#5f6f8f;margin:12px 2px 6px}',
    '.note2{height:calc(100vh - 240px)}',
    '.seg{display:flex;background:#eef1f6;border-radius:9px;padding:3px;margin-bottom:10px}.seg button{flex:1;border:0;background:none;padding:6px 0;border-radius:7px;font-size:13px;cursor:pointer;color:#6b7480}.seg button.on{background:#fff;color:#1f3a5f;font-weight:700;box-shadow:0 1px 3px #0002}',
    '.dr{border-bottom:1px solid #eef0f3}.dh{display:flex;align-items:center;gap:8px;padding:8px 2px;cursor:pointer}.dh .en{font-family:Georgia,serif;font-weight:700;font-size:15px;min-width:84px}.dh .dk{flex:1;font-size:13px;color:#445}.dr .ch{padding:0 2px 6px;margin-top:-2px}.c.more{background:#e3e8f2}.dr .ex{font-family:Georgia,serif;font-size:13.5px;line-height:1.55;padding:6px 8px;margin:0 0 6px;background:#f6f8fb;border-radius:8px}.dr .ex .xs{font-family:system-ui,sans-serif;font-size:11px;color:#8a94a8;margin-top:2px}.hl{background:#fde58a;font-weight:700}',
    '.c{display:inline-block;font-size:11px;background:#eef2f8;color:#5f6f8f;border-radius:999px;padding:1px 8px;margin:0 4px 4px 0}',
    '.tip{position:fixed;z-index:2147483002;display:none;width:260px;background:#fff;border:1px solid #d3d8df;border-radius:12px;padding:10px 12px;box-shadow:0 6px 22px #0003;font-size:13px;color:#1d2330}.tip.on{display:block}.tip .w{font-weight:700;font-size:16px;font-family:Georgia,serif;cursor:pointer}.tip .w small{font-weight:400;font-size:11px;color:#8a94a8;font-family:system-ui}.tip .k{margin:2px 0 6px;font-size:14px}.tip .tb{display:flex;gap:6px;margin-top:6px}',
    '.msg{position:fixed;left:50%;bottom:70px;transform:translateX(-50%);z-index:2147483003;background:#1f3a5f;color:#fff;font-size:13px;padding:7px 14px;border-radius:999px;display:none}.msg.on{display:block}',
    '@media print{.dock,.drawer,.sel,.layer{display:none!important}}'
  ].join('');

  var pushed = null, W = 380, lastF = 1;
  /* 브라우저 확대/축소와 상관없이 패널·버튼 크기를 일정하게 */
  function zf() {
    try { var t = window.top, z = t.outerWidth / t.innerWidth; if (!(z > 0.25 && z < 6)) return 1; z = Math.round(z * 100) / 100; return Math.abs(z - 1) < 0.04 ? 1 : 1 / z; } catch (e) { return 1; }
  }
  function applyZoom() { var f = zf(); [ui.drawer, ui.dock].forEach(function (el) { if (el) el.style.zoom = f === 1 ? '' : String(f); }); return f; }
  /* 전체화면 요소 찾기 — 같은 출처 iframe 안쪽까지 따라 들어감 */
  function fsCtx() {
    var d = document, el = d.fullscreenElement || d.webkitFullscreenElement || null, n = 0;
    while (el && el.tagName === 'IFRAME' && n++ < 4) {
      var cd; try { cd = el.contentDocument; } catch (e) { cd = null; }
      var ie = cd && (cd.fullscreenElement || cd.webkitFullscreenElement);
      if (!ie) break; d = cd; el = ie;
    }
    return { doc: d, el: el };
  }
  function pushPage(on) {
    if (pushed) {                                   // 이전 상태 복원
      pushed.fx.forEach(function (x) { x.el.style.right = x.r; });
      var pd = pushed.doc.documentElement;
      pd.style.marginRight = pushed.m; pd.style.overflowX = pushed.o; pd.style.transition = pushed.t;
      if (pushed.f) pushed.f.style.width = pushed.fw;
      pushed = null;
    }
    var c = fsCtx(), d = c.doc, de = d.documentElement, win = d.defaultView || window, Wp = Math.round(W * applyZoom()); lastF = zf();
    if (on && win.innerWidth >= 760) {
      var fe = c.el && c.el !== de && c.el !== d.body ? c.el : null;
      pushed = { doc: d, m: de.style.marginRight, o: de.style.overflowX, t: de.style.transition, f: fe, fw: fe ? fe.style.width : '', fx: [] };
      Array.prototype.forEach.call(d.querySelectorAll('body > *, body > * > *'), function (el) {
        if (el === host || host.contains(el) || !el.getBoundingClientRect) return;
        var cs = win.getComputedStyle(el); if (cs.position !== 'fixed' || cs.display === 'none') return;
        var rc = el.getBoundingClientRect(); if (rc.width < win.innerWidth * 0.9 || rc.left > 2 || rc.right < win.innerWidth - 2) return;
        pushed.fx.push({ el: el, r: el.style.right }); el.style.right = Wp + 'px';
      });
      if (fe) fe.style.width = 'calc(100% - ' + Wp + 'px)';
      else { de.style.transition = 'margin-right .15s'; de.style.marginRight = Wp + 'px'; de.style.overflowX = 'auto'; }
    }
    setTimeout(function () { window.dispatchEvent(new Event('resize')); try { win.dispatchEvent(new Event('resize')); } catch (e) { } }, 180);
  }
  /* 전체화면: 전체화면이 된 문서 안으로 도구를 옮겨야 보임 */
  function onFS() {
    var c = fsCtx(), tgt = c.el && c.el !== c.doc.documentElement && c.el !== c.doc.body ? c.el : c.doc.body;
    if (host.parentNode !== tgt) { try { tgt.appendChild(host); } catch (e) { } }
    if (ui.drawer.classList.contains('on')) pushPage(true);
  }
  window.addEventListener('resize', function () { var f = zf(); if (f !== lastF) { lastF = f; applyZoom(); if (ui.drawer && ui.drawer.classList.contains('on')) pushPage(true); } });
  document.addEventListener('fullscreenchange', onFS); document.addEventListener('webkitfullscreenchange', onFS);
  function openPanel(tab) { ui.drawer.classList.add('on'); pushPage(true); if (tab) showTab(tab); else drawTab(true); }
  function closePanel() { ui.drawer.classList.remove('on'); pushPage(false); }
  var curTab = null;
  var TABNAME = { note: '노트', memo: '메모', phrase: '구문', word: '단어', acct: '계정' };
  function showTab(t) { curTab = t; Array.prototype.forEach.call(ui.tabs.children, function (b) { b.classList.toggle('on', b.dataset.t === t); }); drawTab(true); }
  function drawTab(force) {
    if (!curTab) return;
    var fn = { note: drawNote, memo: drawMemo, phrase: drawPhrase, word: drawWord, acct: drawAcct }[curTab];
    var keep = root.activeElement, ks = keep && keep.dataset && keep.dataset.keep;
    if (!force && ks && ui.body.contains(keep)) return;     // 입력 중에는 다시 그리지 않음
    ui.body.textContent = ''; fn(ui.body);
  }

  /* ───────── 폴더 (노트 · 구문 · 단어 탭별 독립) ───────── */
  var fsel = pref.fs || {};
  function selF(tab) { var v = fsel[tab]; if (v == null) return 'all'; if (v !== 'all' && v !== '' && !Store.get('*', 'folder', v)) return 'all'; return v; }
  function setF(tab, v) { fsel[tab] = v; pref.fs = fsel; jset(K_PREF, pref); drawTab(true); }
  function folders(tab) { return Store.list('folder', '*').filter(function (f) { return f.body.tab === tab; }).sort(function (a, b) { return a.body.name.localeCompare(b.body.name, 'ko', { numeric: true }); }); }
  function newFolder(tab) { var n = prompt('폴더 이름'); if (!n || !n.trim()) return null; var k = uid(); Store.put('*', 'folder', k, { tab: tab, name: n.trim() }); return k; }
  function curNewF(tab) { var s = selF(tab); return s && s !== 'all' ? s : ''; }
  function fBody(body, f) { var b = Object.assign({}, body); if (f) b.f = f; else delete b.f; return b; }
  function fOK(tab) { var sel = selF(tab); return function (it) { return sel === 'all' || (it.body.f || '') === sel; }; }
  function folderBar(box, tab, kind) {
    var list = Store.list(kind), sel = selF(tab), fs = folders(tab);
    var cnt = function (f) { return list.filter(function (it) { return (it.body.f || '') === f; }).length; };
    var wrap = h('div', { class: 'fchips' });
    var chip = function (v, label, n) { return h('button', { class: 'fc' + (sel === v ? ' on' : ''), onclick: function () { setF(tab, v); } }, [label, h('small', { text: String(n) })]); };
    wrap.appendChild(chip('all', '전체', list.length));
    fs.forEach(function (f) { wrap.appendChild(chip(f.k, '📁 ' + f.body.name, cnt(f.k))); });
    wrap.appendChild(chip('', '미분류', cnt('')));
    wrap.appendChild(h('button', { class: 'fc add', text: '+ 폴더', onclick: function () { var k = newFolder(tab); if (k) setF(tab, k); } }));
    box.appendChild(wrap);
    if (sel && sel !== 'all') {
      var f = Store.get('*', 'folder', sel);
      box.appendChild(h('div', { class: 'row fm' }, [
        h('b', { text: '📁 ' + f.name }), h('span', { class: 'sp' }),
        h('button', { class: 'btn sm', text: '이름 변경', onclick: function () { var n = prompt('폴더 이름', f.name); if (n && n.trim()) Store.put('*', 'folder', sel, { tab: tab, name: n.trim() }); } }),
        h('button', { class: 'btn sm', text: '폴더 삭제', onclick: function () {
          if (!confirm('"' + f.name + '" 폴더를 삭제할까요?\n안의 항목은 지워지지 않고 미분류로 이동합니다.')) return;
          list.forEach(function (it) { if (it.body.f === sel) Store.put(it.doc, kind, it.k, fBody(it.body, '')); });
          Store.remove('*', 'folder', sel); fsel[tab] = 'all'; pref.fs = fsel; jset(K_PREF, pref); drawTab(true);
        } })
      ]));
    }
  }
  function moveSel(it, kind, tab) {
    var s = h('select', { class: 'mv', title: '폴더 이동' });
    s.appendChild(h('option', { value: '', text: '미분류' }));
    folders(tab).forEach(function (f) { s.appendChild(h('option', { value: f.k, text: '📁 ' + f.body.name })); });
    s.appendChild(h('option', { value: '__new', text: '+ 새 폴더…' }));
    s.value = it.body.f || '';
    s.onchange = function () {
      var v = s.value;
      if (v === '__new') { v = newFolder(tab); if (!v) { s.value = it.body.f || ''; return; } }
      Store.put(it.doc, kind, it.k, fBody(it.body, v));
    };
    return s;
  }

  /* ───────── 노트 (여러 개 + 폴더) ───────── */
  var noteOpen = null, ntQ = '';
  function noteTitle(it) { var b = it.body; return (b.title && b.title.trim()) || (b.t || '').split('\n')[0].trim().slice(0, 40) || (it.doc !== '*' ? it.doc + ' 노트' : '(빈 노트)'); }
  function drawNote(box) {
    if (noteOpen) {
      var cur = Store.list('note').filter(function (x) { return x.k === noteOpen.k && x.doc === noteOpen.doc; })[0];
      if (cur) return drawNoteEdit(box, cur);
      noteOpen = null;
    }
    var q = h('input', { placeholder: '노트 검색', value: ntQ, 'data-keep': 1, oninput: function (e) { ntQ = e.target.value; renderList(); } });
    box.appendChild(h('div', { class: 'row' }, [q, h('button', { class: 'btn pri sm', text: '+ 새 노트', onclick: function () {
      var k = uid(); Store.put('*', 'note', k, fBody({ t: '', title: '', ts: nowISO() }, curNewF('note'))); noteOpen = { k: k, doc: '*' }; drawTab(true);
    } })]));
    folderBar(box, 'note', 'note');
    var listBox = h('div'); box.appendChild(listBox);
    var ok = fOK('note');
    function renderList() {
      listBox.textContent = '';
      var arr = Store.list('note').filter(function (it) { return !(it.k === 'main' && !(it.body.t || '').trim()); }).filter(ok)
        .filter(function (it) { return !ntQ || (noteTitle(it) + ' ' + (it.body.t || '')).toLowerCase().indexOf(ntQ.toLowerCase()) >= 0; })
        .sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      if (!arr.length) { listBox.appendChild(h('div', { class: 'empty', text: '노트가 없습니다. "+ 새 노트"로 만들어 보세요.' })); return; }
      arr.forEach(function (it) {
        listBox.appendChild(h('div', { class: 'card' }, [
          h('div', { class: 't', onclick: function () { noteOpen = { k: it.k, doc: it.doc }; drawTab(true); } }, [h('b', { text: noteTitle(it) }), h('div', { class: 'sn', text: (it.body.t || '').replace(/\s+/g, ' ').slice(0, 90) })]),
          h('div', { class: 'm' }, [h('span', { text: fmtTime(it.ts) }), h('span', { class: 'sp' }), moveSel(it, 'note', 'note'),
            h('button', { class: 'del', text: '삭제', onclick: function () { if (confirm('이 노트를 지울까요?')) Store.remove(it.doc, 'note', it.k); } })])
        ]));
      });
    }
    renderList();
  }
  function drawNoteEdit(box, it) {
    var ti = h('input', { placeholder: '제목', 'data-keep': 1 }); ti.value = it.body.title || '';
    var ta = h('textarea', { class: 'note note2', 'data-keep': 1, placeholder: '자유롭게 적으세요. 자동 저장됩니다.' }); ta.value = it.body.t || '';
    var info = h('div', { class: 'hint', text: it.body.ts ? '마지막 저장 ' + fmtTime(it.body.ts) : '' });
    var save = debounce(function () {
      var b = Store.get(it.doc, 'note', it.k) || {};
      Store.put(it.doc, 'note', it.k, Object.assign({}, b, { t: ta.value, title: ti.value, ts: nowISO() })); info.textContent = '저장됨 ' + fmtTime(nowISO());
    }, 600);
    ti.addEventListener('input', save); ta.addEventListener('input', save);
    box.appendChild(h('div', { class: 'row' }, [h('button', { class: 'btn sm', text: '‹ 목록', onclick: function () { noteOpen = null; drawTab(true); } }), h('span', { class: 'sp' }), moveSel(it, 'note', 'note'),
      h('button', { class: 'btn sm', text: '삭제', onclick: function () { if (confirm('이 노트를 지울까요?')) { Store.remove(it.doc, 'note', it.k); noteOpen = null; } } })]));
    box.appendChild(ti); box.appendChild(h('div', { style: 'height:8px' })); box.appendChild(ta); box.appendChild(info);
  }

  /* ───────── 메모 (포스트잇) ───────── */
  var memoScope = 'doc';
  function drawMemo(box) {
    ui.addMemoBtn = h('button', { class: 'btn pri', text: '+ 메모 붙이기', onclick: function () { setPlacing(!placing); } });
    var tog = h('button', { class: 'btn', text: pref.hideMemo ? '메모 보이기' : '메모 숨기기', onclick: function () { pref.hideMemo = !pref.hideMemo; jset(K_PREF, pref); renderStickies(); drawTab(); } });
    var sc = h('button', { class: 'btn sm', text: memoScope === 'doc' ? '이 자료만' : '전체 자료', onclick: function () { memoScope = memoScope === 'doc' ? 'all' : 'doc'; drawTab(true); } });
    box.appendChild(h('div', { class: 'row' }, [ui.addMemoBtn, tog, sc]));
    box.appendChild(h('div', { class: 'hint', text: '붙인 메모는 머리 부분을 끌어서 옮기고, 색 점으로 색을 바꿉니다.' }));
    var list = Store.list('memo', memoScope === 'doc' ? CFG.doc : undefined).sort(function (a, b) { return a.doc === b.doc ? (a.ts < b.ts ? 1 : -1) : (a.doc === CFG.doc ? -1 : b.doc === CFG.doc ? 1 : a.doc.localeCompare(b.doc, 'ko')); });
    if (!list.length) box.appendChild(h('div', { class: 'empty', text: '아직 메모가 없습니다.' }));
    var last = null;
    list.forEach(function (it) {
      if (memoScope === 'all' && it.doc !== last) { last = it.doc; box.appendChild(h('div', { class: 'gh', text: '📄 ' + it.doc + (it.doc === CFG.doc ? ' (현재)' : '') })); }
      var here = it.doc === CFG.doc;
      box.appendChild(h('div', { class: 'card' }, [
        h('div', { class: 't', text: it.body.t || '(빈 메모)', onclick: function () { var el = here && stickyEls[it.k]; if (el) { closePanel(); window.scrollTo({ top: Math.max(0, el.offsetTop - 120), behavior: 'smooth' }); } } }),
        h('div', { class: 'm' }, [h('span', { text: fmtTime(it.ts) }), h('span', { class: 'sp' }), h('button', { class: 'del', text: '삭제', onclick: function () { Store.remove(it.doc, 'memo', it.k); } })])
      ]));
    });
  }

  /* ───────── 구문 ───────── */
  var phScope = 'doc', phQ = '';
  function drawPhrase(box) {
    var q = h('input', { placeholder: '구문 검색', value: phQ, 'data-keep': 1, oninput: function (e) { phQ = e.target.value; renderList(); } });
    var sc = h('button', { class: 'btn sm', text: phScope === 'doc' ? '이 자료만' : '전체 자료', onclick: function () { phScope = phScope === 'doc' ? 'all' : 'doc'; drawTab(); } });
    box.appendChild(h('div', { class: 'row' }, [q, sc]));
    box.appendChild(h('div', { class: 'hint', text: '본문에서 문장을 드래그하면 나타나는 "구문 담기"로 저장합니다. 선택한 폴더에 담깁니다.' }));
    folderBar(box, 'phrase', 'phrase');
    var listBox = h('div'); box.appendChild(listBox);
    var ok = fOK('phrase');
    function renderList() {
      listBox.textContent = '';
      var arr = Store.list('phrase', undefined).filter(ok).filter(function (it) { if (phScope === 'doc' && (it.body.src || it.doc) !== CFG.doc) return false; var s = (it.body.text + ' ' + (it.body.memo || '')).toLowerCase(); return !phQ || s.indexOf(phQ.toLowerCase()) >= 0; })
        .sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      if (!arr.length) { listBox.appendChild(h('div', { class: 'empty', text: '담은 구문이 없습니다.' })); return; }
      arr.forEach(function (it) {
        var memo = h('textarea', { placeholder: '내 메모', 'data-keep': 1 }); memo.value = it.body.memo || '';
        var sv = debounce(function () { Store.put(it.doc, 'phrase', it.k, Object.assign({}, Store.get(it.doc, 'phrase', it.k) || it.body, { memo: memo.value })); }, 600);
        memo.addEventListener('input', sv);
        var here = (it.body.src || it.doc) === CFG.doc;
        listBox.appendChild(h('div', { class: 'card' }, [
          h('div', { class: 't', text: it.body.text, onclick: function () { if (here && jumpTo(it.body.text, it.body.ctx)) closePanel(); } }),
          memo,
          h('div', { class: 'm' }, [h('span', { text: fmtTime(it.ts) }), h('span', { class: 'sp', text: here ? '' : (it.body.src || it.doc) }), moveSel(it, 'phrase', 'phrase'),
            h('button', { class: 'del', text: '삭제', onclick: function () { if (confirm('이 구문을 지울까요?')) Store.remove(it.doc, 'phrase', it.k); } })])
        ]));
      });
    }
    renderList();
  }

  /* ───────── 단어 ───────── */
  var wdQ = '', focusWord = null, focusEn = false;
  var wdMode = 'mine', dQ = '', dOpen = null;
  function drawWord(box) {
    var seg = h('div', { class: 'seg' }, [
      h('button', { class: wdMode === 'mine' ? 'on' : '', text: '내 단어장', onclick: function () { wdMode = 'mine'; drawTab(true); } }),
      h('button', { class: wdMode === 'dict' ? 'on' : '', text: '사전', onclick: function () { wdMode = 'dict'; drawTab(true); } })]);
    box.appendChild(seg);
    var had = !!DICT; ensureDict().then(function () { if (!had && DICT && curTab === 'word') drawTab(true); });
    if (wdMode === 'dict') return drawDict(box);
    var en = h('input', { placeholder: '영어', 'data-keep': 1 }), ko = h('input', { placeholder: '뜻', 'data-keep': 1 });
    var add = function () {
      var e = en.value.trim(); if (!e) return;
      var old = Store.get('*', 'word', e.toLowerCase()), hit = ko.value.trim() ? null : lookup(e);
      Store.put('*', 'word', e.toLowerCase(), fBody({ en: e, ko: ko.value.trim() || (hit ? koOf(hit.ent) : ''), star: old ? old.star : false, src: CFG.doc }, old ? old.f : curNewF('word')));
      en.value = ko.value = ''; focusEn = true; drawTab(true);
    };
    ko.addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
    en.addEventListener('keydown', function (e) { if (e.key === 'Enter') ko.focus(); });
    box.appendChild(h('div', { class: 'row' }, [en, ko, h('button', { class: 'btn pri sm', text: '추가', onclick: add })]));
    if (focusEn) { focusEn = false; setTimeout(function () { en.focus(); }, 30); }
    var q = h('input', { placeholder: '내 단어장 검색', value: wdQ, 'data-keep': 1, oninput: function (e) { wdQ = e.target.value; renderList(); } });
    box.appendChild(h('div', { class: 'row' }, [q]));
    folderBar(box, 'word', 'word');
    var listBox = h('div'); box.appendChild(listBox);
    var ok = fOK('word');
    function renderList() {
      listBox.textContent = '';
      var arr = Store.list('word').filter(ok).filter(function (it) { return !wdQ || (it.body.en + ' ' + it.body.ko).toLowerCase().indexOf(wdQ.toLowerCase()) >= 0; })
        .sort(function (a, b) { return a.ts < b.ts ? 1 : -1; });
      if (!arr.length) { listBox.appendChild(h('div', { class: 'empty', text: '단어를 추가해 보세요. 모든 자료에서 같은 단어장이 보입니다.' })); return; }
      arr.forEach(function (it) {
        var kin = h('input', { placeholder: '뜻', 'data-keep': 1 }); kin.value = it.body.ko || '';
        var sv = debounce(function () { Store.put('*', 'word', it.k, Object.assign({}, Store.get('*', 'word', it.k) || it.body, { ko: kin.value })); }, 600);
        kin.addEventListener('input', sv);
        var st = h('button', { class: 'star' + (it.body.star ? ' on' : ''), text: '★', onclick: function () { Store.put('*', 'word', it.k, Object.assign({}, it.body, { star: !it.body.star })); } });
        listBox.appendChild(h('div', { class: 'wd' }, [
          h('span', { class: 'en', text: it.body.en, title: '누르면 발음', onclick: function () { speak(it.body.en); } }), kin, moveSel(it, 'word', 'word'), st,
          h('button', { class: 'del', text: '×', onclick: function () { Store.remove('*', 'word', it.k); } })
        ]));
        if (focusWord === it.k) { setTimeout(function () { kin.focus(); }, 30); focusWord = null; }
      });
    }
    renderList();
  }

  function dictSearch(q) {
    q = q.trim().toLowerCase(); if (!q || !DICT) return [];
    var out = [], seen = {};
    var push = function (k) { if (!seen[k] && out.length < 60) { seen[k] = 1; out.push(k); } };
    if (/[가-힣]/.test(q)) { KEYS.forEach(function (k) { if (out.length < 60 && DICT.w[k].some(function (e) { return e[0].indexOf(q) >= 0; })) push(k); }); }
    else {
      var c = cands(q); c.forEach(function (x) { if (DICT.w[x]) push(x); });
      KEYS.forEach(function (k) { if (k.indexOf(q) === 0) push(k); });
      KEYS.forEach(function (k) { if (k.indexOf(q) > 0) push(k); });
    }
    return out;
  }
  function drawDict(box) {
    var q = h('input', { placeholder: '영어 또는 한글로 검색 (예: abandon, 포기)', value: dQ, 'data-keep': 1, oninput: function (e) { dQ = e.target.value; dOpen = null; renderList(); } });
    box.appendChild(h('div', { class: 'row' }, [q]));
    box.appendChild(h('div', { class: 'hint', text: DICT ? '단어장 ' + DICT.b.length + '권 · ' + KEYS.length + '개 단어. 단어를 누르면 지금 열린 파일에서 쓰인 예문을 찾아 줍니다.' : '사전을 불러오는 중…' }));
    var listBox = h('div'); box.appendChild(listBox);
    function renderList() {
      listBox.textContent = '';
      if (!DICT) { listBox.appendChild(h('div', { class: 'empty', text: CFG.wordsUrl ? '사전을 불러오는 중이거나 불러오지 못했습니다.' : '사전 파일 주소가 설정되지 않았습니다.' })); return; }
      var keys = dictSearch(dQ);
      if (!dQ.trim()) { listBox.appendChild(h('div', { class: 'empty', text: '검색어를 입력하세요.' })); return; }
      if (!keys.length) { listBox.appendChild(h('div', { class: 'empty', text: '찾는 단어가 없습니다.' })); return; }
      keys.forEach(function (k) {
        var ent = DICT.w[k], mine = !!Store.get('*', 'word', k), open = dOpen === k;
        var row = h('div', { class: 'dr' + (open ? ' open' : '') }, [
          h('div', { class: 'dh', onclick: function () { dOpen = open ? null : k; renderList(); } }, [
            h('span', { class: 'en', text: k, onclick: function (e) { e.stopPropagation(); speak(k); }, title: '누르면 발음' }),
            h('span', { class: 'dk', text: koOf(ent) }),
            h('button', { class: 'btn sm' + (mine ? '' : ' pri'), text: mine ? '담음' : '+ 담기', onclick: function (e) { e.stopPropagation(); if (!mine) { addFromDict(k, ent, false); renderList(); } } })
          ])
        ]);
        var all = srcChips(ent, 200);
        if (!open) { var cl = h('div', { class: 'ch' }); all.slice(0, 2).forEach(function (c) { cl.appendChild(h('span', { class: 'c', text: c })); }); if (all.length > 2) cl.appendChild(h('span', { class: 'c more', text: '+' + (all.length - 2) })); row.appendChild(cl); }
        if (open) {
          var chips = h('div', { class: 'ch' }); srcChips(ent, 30).forEach(function (c) { chips.appendChild(h('span', { class: 'c', text: c })); }); row.appendChild(chips);
          var ex = examples(k, 1000), full = ex.length ? textIndex().full : '';
          row.appendChild(h('div', { class: 'hint', text: ex.length ? '📄 이 파일에서 찾은 예문 ' + ex.length + (ex.length >= 1000 ? '개 이상 (처음 1000개만 표시)' : '개') : '📄 이 파일에서 찾은 예문이 없습니다.' }));
          ex.forEach(function (x) {
            var here = full.indexOf(x.s.slice(0, 40)) >= 0;
            row.appendChild(h('div', { class: 'ex' }, [hiNode(x.s, x.re), here ? h('div', { class: 'xs' }, [h('a', { class: 'link', text: '본문에서 보기', onclick: function () { jumpTo(x.s.slice(0, 80), ''); } })]) : null]));
          });
        }
        listBox.appendChild(row);
      });
    }
    renderList();
  }
  function speak(t) { try { var u = new SpeechSynthesisUtterance(t); u.lang = 'en-US'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { } }

  var acctEmail = '', acctStep = 0, acctMsg = '', acctMode = 'pw';
  var STXT = { local: '이 기기에만 저장 중 (서버 미설정)', out: '로그인하면 서버에 동기화됩니다', idle: '대기', busy: '동기화 중…', ok: '동기화됨', err: '동기화 오류', offline: '오프라인 (연결되면 자동 동기화)' };
  function drawAcct(box) {
    var pend = Object.keys(dirty).length;
    box.appendChild(h('div', { class: 'stat' }, [
      h('span', { class: 'pill', text: STXT[state.s] || state.s }),
      h('div', { text: state.msg || '' }),
      h('div', { text: state.at ? '마지막 동기화 ' + fmtTime(state.at) : '' }),
      h('div', { text: '서버에 올리지 못한 항목 ' + pend + '개' }),
      Auth.email() ? h('div', { text: '계정: ' + Auth.email() }) : null
    ]));
    if (!REMOTE) { box.appendChild(h('div', { class: 'hint', text: 'data-supabase-url / data-supabase-key를 설정하면 서버 동기화가 켜집니다.' })); return; }
    if (sess) {
      box.appendChild(h('div', { class: 'row' }, [
        h('button', { class: 'btn pri', text: '지금 동기화', onclick: function () { Sync.run(); } }),
        h('button', { class: 'btn', text: '로그아웃', onclick: function () { Auth.logout(); drawTab(); } })
      ])); return;
    }
    var em = h('input', { type: 'email', placeholder: '이메일', value: acctEmail, 'data-keep': 1 });
    var pw = h('input', { type: 'password', placeholder: '비밀번호', 'data-keep': 1 });
    var cd = h('input', { placeholder: '이메일로 받은 6자리 코드', inputmode: 'numeric', 'data-keep': 1 });
    var msg = h('div', { class: 'hint', text: acctMsg });
    var doPw = function () {
      acctEmail = em.value.trim(); if (!acctEmail || !pw.value) { msg.textContent = '이메일과 비밀번호를 입력하세요'; return; }
      msg.textContent = '확인 중…';
      Auth.password(acctEmail, pw.value).then(function () { acctMsg = ''; drawTab(true); }).catch(function (e) { msg.textContent = '실패: ' + e.message; });
    };
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doPw(); });
    if (acctMode === 'pw') {
      box.appendChild(h('div', { class: 'row' }, [em])); box.appendChild(h('div', { class: 'row' }, [pw, h('button', { class: 'btn pri sm', text: '로그인', onclick: doPw })]));
      box.appendChild(h('div', { class: 'row' }, [h('button', { class: 'btn sm', text: '이메일 코드로 로그인', onclick: function () { acctEmail = em.value.trim(); acctMode = 'code'; acctStep = 0; acctMsg = ''; drawTab(true); } })]));
    } else if (acctStep === 0) {
      box.appendChild(h('div', { class: 'row' }, [em, h('button', { class: 'btn pri sm', text: '코드 받기', onclick: function () {
        acctEmail = em.value.trim(); if (!acctEmail) return; msg.textContent = '보내는 중…';
        Auth.sendCode(acctEmail).then(function () { acctStep = 1; acctMsg = '메일로 코드를 보냈습니다.'; drawTab(true); }).catch(function (e) { msg.textContent = '실패: ' + e.message; });
      } })]));
      box.appendChild(h('div', { class: 'row' }, [h('button', { class: 'btn sm', text: '비밀번호로 로그인', onclick: function () { acctMode = 'pw'; acctMsg = ''; drawTab(true); } })]));
    } else {
      box.appendChild(h('div', { class: 'row' }, [cd, h('button', { class: 'btn pri sm', text: '로그인', onclick: function () {
        msg.textContent = '확인 중…';
        Auth.verify(acctEmail, cd.value).then(function () { acctStep = 0; acctMsg = ''; drawTab(true); }).catch(function (e) { msg.textContent = '실패: ' + e.message; });
      } })]));
      box.appendChild(h('div', { class: 'row' }, [h('button', { class: 'btn sm', text: '이메일 다시 입력', onclick: function () { acctStep = 0; acctMsg = ''; drawTab(true); } })]));
    }
    box.appendChild(msg);
  }

  /* ───────── 내장 단어 사전 ───────── */
  var DICT = null, DICT_P = null, KEYS = [];
  function ensureDict() {
    if (DICT) return Promise.resolve(DICT);
    if (!CFG.wordsUrl) return Promise.resolve(null);
    if (!DICT_P) DICT_P = fetch(CFG.wordsUrl).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (d) { DICT = d; KEYS = Object.keys(d.w); return d; }).catch(function () { DICT_P = null; return null; });
    return DICT_P;
  }
  function cands(t) {
    t = (t || '').toLowerCase().replace(/[^a-z' \-]/g, '').replace(/\s+/g, ' ').trim();
    var o = [t]; if (!t || /\s/.test(t)) return o;
    var add = function (x) { if (x && x.length > 1 && o.indexOf(x) < 0) o.push(x); };
    if (/'s$/.test(t)) add(t.slice(0, -2));
    if (/ies$/.test(t)) add(t.slice(0, -3) + 'y');
    if (/ied$/.test(t)) add(t.slice(0, -3) + 'y');
    if (/es$/.test(t)) add(t.slice(0, -2));
    if (/s$/.test(t)) add(t.slice(0, -1));
    if (/ed$/.test(t)) { add(t.slice(0, -2)); add(t.slice(0, -1)); if (/(.)\1$/.test(t.slice(0, -2))) add(t.slice(0, -3)); }
    if (/ing$/.test(t)) { add(t.slice(0, -3)); add(t.slice(0, -3) + 'e'); if (/(.)\1$/.test(t.slice(0, -3))) add(t.slice(0, -4)); }
    if (/ly$/.test(t)) add(t.slice(0, -2));
    if (/er$/.test(t)) { add(t.slice(0, -2)); add(t.slice(0, -1)); }
    if (/est$/.test(t)) { add(t.slice(0, -3)); add(t.slice(0, -2)); }
    return o;
  }
  function lookup(t) {
    if (!DICT) return null;
    var c = cands(t);
    for (var i = 0; i < c.length; i++) if (DICT.w[c[i]]) return { key: c[i], ent: DICT.w[c[i]] };
    return null;
  }
  function koOf(ent) {
    var t = [];
    ent.slice(0, 4).forEach(function (e) { e[0].split(/\s*[;,]\s*/).forEach(function (x) { x = x.trim(); if (x && t.indexOf(x) < 0) t.push(x); }); });
    return t.slice(0, 4).join(', ');
  }
  function srcChips(ent, n) {
    var seen = {}, out = [];
    ent.forEach(function (e) { e[1].forEach(function (p) { var k = p[0] + ':' + p[1]; if (!seen[k]) { seen[k] = 1; out.push(DICT.b[p[0]][1] + ' ' + p[1]); } }); });
    return out.slice(0, n);
  }
  function wordRe(key) {
    var e = function (x) { return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }, a = [e(key)];
    if (!/\s/.test(key)) {
      var suf = '(?:s|es|ed|d|ing|er|est|ly)?';
      a = [e(key) + suf];
      if (/e$/.test(key)) a.push(e(key.slice(0, -1)) + '(?:ing|ed)');
      if (/y$/.test(key)) a.push(e(key.slice(0, -1)) + '(?:ies|ied|ily)');
      if (/[^aeiou][aeiou][bdgmnprt]$/.test(key)) a.push(e(key) + e(key.slice(-1)) + '(?:ed|ing|er)');
    }
    return new RegExp('\\b(?:' + a.join('|') + ')\\b', 'i');
  }
  /* 열려 있는 파일 자체에서 예문 찾기 (보이는 화면뿐 아니라 파일 안의 전체 내용) */
  var SRC = null;
  function docSrc() {
    var now = Date.now(); if (SRC && now - SRC.t < 30000) return SRC.s;
    var s = ''; try { s = document.documentElement.outerHTML; } catch (e) { }
    SRC = { t: now, s: s }; return s;
  }
  function sentAround(src, a, b) {
    var left = src.slice(Math.max(0, a - 320), a), right = src.slice(b, Math.min(src.length, b + 320));
    var cl = -1, m, rx = /[<>"`\n\\{}\[\]]|[.?!]["”’']?\s/g;
    while ((m = rx.exec(left))) cl = m.index + m[0].length;
    left = left.slice(cl < 0 ? 0 : cl);
    var cr = right.search(/[<>"`\n\\{}\[\]]|[.?!]["”’']?(?:\s|$)/), t = null;
    if (cr >= 0) { var ch = right.charAt(cr); t = /[.?!]/.test(ch) ? right.slice(0, cr + 1 + (/["”’']/.test(right.charAt(cr + 1)) ? 1 : 0)) : right.slice(0, cr); } else t = right;
    var s = (left + src.slice(a, b) + t).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    if (s.length < 20 || s.length > 320 || /[{};=<>【】]|\(\+/.test(s) || !/^[A-Z“‘"'(]/.test(s) || !/[.?!][”’"')]?$/.test(s) || s.split(' ').length < 5) return '';
    return s;
  }
  function examples(key, n) {
    var src = docSrc(), re = wordRe(key), g = new RegExp(re.source, 'gi'), out = [], seen = {}, m, guard = 0;
    while ((m = g.exec(src)) && out.length < n && guard++ < 40000) {
      var s = sentAround(src, m.index, m.index + m[0].length); if (!s) continue;
      var k = s.toLowerCase(); if (seen[k]) continue; seen[k] = 1; out.push({ s: s, re: re });
    }
    return out;
  }
  function hiNode(text, re) {
    var m = re.exec(text), box = h('span');
    if (!m) { box.textContent = text; return box; }
    box.appendChild(document.createTextNode(text.slice(0, m.index)));
    box.appendChild(h('b', { class: 'hl', text: m[0] }));
    box.appendChild(document.createTextNode(text.slice(m.index + m[0].length)));
    return box;
  }
  function addFromDict(key, ent, note) {
    if (Store.get('*', 'word', key)) { if (note !== false) toast('이미 내 단어장에 있어요'); return false; }
    Store.put('*', 'word', key, fBody({ en: key, ko: koOf(ent), star: false, src: CFG.doc }, curNewF('word')));
    if (note !== false) toast('담았어요: ' + key); return true;
  }
  function toast(m) { if (!ui.msg) return; ui.msg.textContent = m; ui.msg.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(function () { ui.msg.classList.remove('on'); }, 1600); }

  /* 선택한 단어 위에 뜻 카드 */
  function showTip(r, t) {
    if (!ui.tip) return;
    ensureDict().then(function (d) {
      if (!d || ui.selText !== t || !ui.sel.classList.contains('on')) return;
      var hit = lookup(t); if (!hit) { ui.tip.classList.remove('on'); return; }
      ui.tip.textContent = '';
      var head = h('div', { class: 'w' }, [h('span', { text: hit.key, onclick: function () { speak(hit.key); }, title: '누르면 발음' })]);
      if (hit.key !== t.toLowerCase()) head.appendChild(h('small', { text: '  ← ' + t }));
      ui.tip.appendChild(head);
      ui.tip.appendChild(h('div', { class: 'k', text: koOf(hit.ent) }));
      var chips = h('div'); srcChips(hit.ent, 3).forEach(function (c) { chips.appendChild(h('span', { class: 'c', text: c })); }); ui.tip.appendChild(chips);
      ui.tip.appendChild(h('div', { class: 'tb' }, [
        h('button', { class: 'btn pri sm', text: '+ 내 단어장', onclick: function () { addFromDict(hit.key, hit.ent); } }),
        h('button', { class: 'btn sm', text: '예문·사전', onclick: function () { wdMode = 'dict'; dQ = hit.key; dOpen = hit.key; window.getSelection().removeAllRanges(); ui.sel.classList.remove('on'); ui.tip.classList.remove('on'); openPanel('word'); } })
      ]));
      var th = 120, top = r.bottom + 8; if (top + th > innerHeight) top = Math.max(8, r.top - th - 50);
      ui.tip.style.left = Math.min(innerWidth - 276, Math.max(8, r.left + r.width / 2 - 130)) + 'px'; ui.tip.style.top = top + 'px';
      ui.tip.classList.add('on');
    });
  }

  /* ───────── 선택 → 구문/단어 담기 ───────── */
  function onSelect() {
    var s = window.getSelection(), t = s ? s.toString().trim() : '';
    if (!t || t.length > 600 || s.rangeCount === 0) { ui.sel.classList.remove('on'); ui.tip && ui.tip.classList.remove('on'); return; }
    var n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
    if (n && n.closest && (n.closest('#ion-tools-host') || n.closest('textarea,input'))) { ui.sel.classList.remove('on'); return; }
    var r = s.getRangeAt(0).getBoundingClientRect();
    var words = t.split(/\s+/).length;
    ui.selWord.style.display = words <= 3 && /[A-Za-z]/.test(t) ? '' : 'none';
    ui.sel.style.left = Math.min(innerWidth - 170, Math.max(8, r.left + r.width / 2 - 70)) + 'px';
    ui.sel.style.top = Math.max(8, r.top - 44) + 'px';
    ui.sel.classList.add('on'); ui.selText = t;
    ui.tip && ui.tip.classList.remove('on');
    if (words <= 3 && /^[A-Za-z][A-Za-z' \-]*$/.test(t)) showTip(r, t);
  }
  function ctxOf(t) {
    var s = window.getSelection(); if (!s.rangeCount) return '';
    var idx = textIndex(), rg = s.getRangeAt(0), p = -1;
    for (var i = 0; i < idx.nodes.length; i++) if (idx.nodes[i].n === rg.startContainer) { p = idx.nodes[i].s + rg.startOffset; break; }
    if (p < 0) return '';
    return idx.full.slice(Math.max(0, p - 60), p + t.length + 60);
  }
  function savePhrase() {
    var t = ui.selText.replace(/\s+/g, ' ').trim(); if (!t) return;
    var ctx = ctxOf(ui.selText);
    var k = hash(CFG.doc + '|' + t), old = Store.get('*', 'phrase', k);
    Store.put('*', 'phrase', k, fBody({ text: t, ctx: ctx, memo: old ? old.memo : '', src: CFG.doc }, old ? old.f : curNewF('phrase')));
    window.getSelection().removeAllRanges(); ui.sel.classList.remove('on'); paintHL(); openPanel('phrase');
  }
  function saveWord() {
    var t = ui.selText.replace(/[^A-Za-z'\- ]/g, '').trim(); if (!t) return;
    var k = t.toLowerCase();
    var hit = lookup(t), nf = curNewF('word');
    if (!Store.get('*', 'word', k)) {
      Store.put('*', 'word', k, fBody({ en: t, ko: hit ? koOf(hit.ent) : '', star: false, src: CFG.doc }, nf));
      if (!hit) ensureDict().then(function () { var h2 = lookup(t), b = Store.get('*', 'word', k); if (h2 && b && !b.ko) Store.put('*', 'word', k, Object.assign({}, b, { ko: koOf(h2.ent) })); });
    }
    ui.tip && ui.tip.classList.remove('on');
    focusWord = k; window.getSelection().removeAllRanges(); ui.sel.classList.remove('on'); openPanel('word');
  }

  /* ───────── 조립 ───────── */
  function build() {
    host = h('div', { id: 'ion-tools-host' });
    host.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483000';
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(h('style', { text: CSS_TEXT }));
    ui.layer = h('div', { class: 'layer' });
    ui.dt = h('span', { class: 'dt local' });
    ui.dock = h('button', { class: 'dock', title: 'ION 도구', onclick: function () { ui.drawer.classList.contains('on') ? closePanel() : openPanel(curTab || CFG.tabs[0]); } }, ['ION', ui.dt]);
    ui.tabs = h('div', { class: 'tabs' }, CFG.tabs.concat(['acct']).map(function (t) { return h('button', { 'data-t': t, text: TABNAME[t] || t, onclick: function () { showTab(t); } }); }));
    ui.body = h('div', { class: 'body' });
    ui.drawer = h('div', { class: 'drawer' }, [
      h('div', { class: 'hd' }, [h('b', { text: CFG.doc }), h('button', { class: 'x', text: '×', onclick: closePanel })]), ui.tabs, ui.body]);
    ui.selWord = h('button', { text: '단어 담기', onclick: saveWord });
    ui.sel = h('div', { class: 'sel' }, [h('button', { text: '구문 담기', onclick: savePhrase }), ui.selWord]);
    ui.sel.addEventListener('mousedown', function (e) { e.preventDefault(); });
    ui.toast = h('div', { class: 'toast' }, [h('span', { text: '다른 기기에서 바뀐 데이터가 있어요' }), h('button', { text: '새로고침', onclick: function () { location.reload(); } }), h('button', { text: '×', onclick: function () { ui.toast.classList.remove('on'); } })]);
    ui.tip = h('div', { class: 'tip' }); ui.tip.addEventListener('mousedown', function (e) { if (e.target.tagName !== 'INPUT') e.preventDefault(); });
    ui.msg = h('div', { class: 'msg' });
    root.appendChild(ui.tip); root.appendChild(ui.msg); root.appendChild(ui.toast); root.appendChild(ui.layer); root.appendChild(ui.dock); root.appendChild(ui.drawer); root.appendChild(ui.sel);
    document.body.appendChild(host);
    applyZoom();

    var st = document.createElement('style');
    st.textContent = '::highlight(ion-phrase){background:#fde58a;color:inherit}::highlight(ion-flash){background:#ffb347;color:inherit}html.ion-placing,html.ion-placing *{cursor:crosshair!important}';
    document.head.appendChild(st);

    curTab = CFG.tabs[0];
    showTab(curTab);
    document.addEventListener('mouseup', function () { setTimeout(onSelect, 10); });
    document.addEventListener('keyup', function (e) { if (e.shiftKey || e.key.indexOf('Arrow') === 0) setTimeout(onSelect, 10); });
    document.addEventListener('selectionchange', debounce(function () { if (!window.getSelection().toString().trim()) { ui.sel.classList.remove('on'); ui.tip && ui.tip.classList.remove('on'); } else if ('ontouchstart' in window) onSelect(); }, 250));
    window.addEventListener('resize', relayout);
    if (window.ResizeObserver) new ResizeObserver(relayout).observe(document.body);
    window.addEventListener('load', function () { relayout(); paintHL(); });
    window.addEventListener('beforeunload', flushLocal);
    window.addEventListener('online', function () { Sync.run(); });
    window.addEventListener('offline', function () { setState('offline'); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) Sync.run(); });
    setInterval(function () { if (!document.hidden) Sync.run(); }, 60000);
    renderStickies(); paintHL();
  }

  listeners.push(function (ev) {
    if (!host) return;
    if (ev.type === 'state') { ui.dt.className = 'dt ' + (state.s === 'idle' ? 'ok' : state.s); if (curTab === 'acct') { ui.body.textContent = ''; drawAcct(ui.body); } return; }
    if (ev.kind === '*' && bridgeApply()) ui.toast.classList.add('on');
    renderStickies(); paintHL(); drawTab();
  });

  window.IonTools = {
    config: CFG, store: Store, auth: Auth, sync: function () { return Sync.run(); },
    state: function () { return { state: state.s, msg: state.msg, pending: Object.keys(dirty).length, email: Auth.email() }; },
    open: openPanel, close: closePanel, on: function (f) { listeners.push(f); },
    importLocal: function (map) {          // 기존 앱의 localStorage 값을 한 번에 올릴 때 사용: {키: 값}
      Object.keys(map).forEach(function (k) { Store.put('*', 'kv', k, map[k]); });
    }
  };

  function boot() { build(); bridgeScan(); if (REMOTE && sess) { setState('idle'); Sync.run(); } else emit({ type: 'state' }); }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
