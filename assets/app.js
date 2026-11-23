(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LS_HOST = 'dc-orch-host';
  var LS_STATE = 'dc-orch-state';
  var LS_HIST = 'dc-orch-history';
  var LS_OPTS = 'dc-orch-opts';

  var ui = {
    prompt: $('prompt'), run: $('runBtn'), stop: $('stopBtn'), maxRev: $('maxRev'), saveMem: $('saveMem'),
    follow: $('follow'), followWrap: $('followWrap'), host: $('host'), settings: $('settings'),
    conn: $('connPill'), connText: $('connText'), help: $('helpBox'), helpReason: $('helpReason'), missing: $('missingBox'),
    route: $('routeBox'), rounds: $('roundBox'), state: $('stateBox'), log: $('logBox'), hist: $('histBox'),
    md: $('mdOut'), raw: $('rawOut'), rawBtn: $('rawBtn'), meta: $('resultMeta'), think: $('thinkBox'), thinkOut: $('thinkOut'),
    nRoute: $('nRoute'), nWorker: $('nWorker'), nCritic: $('nCritic'), nOut: $('nOut')
  };

  var running = null;      // AbortController
  var lastState = load(LS_STATE, null);
  var history = load(LS_HIST, []);
  var streamBuf = '';
  var thinkBuf = '';
  var renderPending = false;

  /* ---------- storage ---------- */
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 용량 초과 무시 */ } }

  /* ---------- util ---------- */
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function sec(ms) { return (ms / 1000).toFixed(1) + 's'; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function log(msg, isErr) {
    var d = el('div', isErr ? 'e' : '');
    var t = el('span', 't', new Date().toTimeString().slice(0, 8));
    d.appendChild(t);
    d.appendChild(document.createTextNode(msg));
    ui.log.appendChild(d);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  function setNode(name, status, sub) {
    var n = document.querySelector('[data-node="' + name + '"]');
    if (!n) return;
    n.classList.remove('run', 'done', 'fail');
    if (status) n.classList.add(status);
    var map = { route: ui.nRoute, worker: ui.nWorker, critic: ui.nCritic, out: ui.nOut };
    if (sub != null) map[name].textContent = sub;
  }

  function resetNodes() { ['route', 'worker', 'critic', 'out'].forEach(function (n) { setNode(n, null, '대기'); }); }

  /* ---------- markdown (안전: 먼저 이스케이프) ---------- */
  function inline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return s;
  }

  function renderMD(src) {
    var lines = String(src || '').replace(/\r/g, '').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var l = lines[i];
      var fence = l.match(/^\s*```\s*([\w.+-]*)\s*$/);
      if (fence) {
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push('<pre>' + (fence[1] ? '<span class="lang">' + esc(fence[1]) + '</span>' : '') +
          '<button class="mini copy-code" type="button">복사</button><code>' + esc(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        var head = splitRow(l);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        out.push('<table><thead><tr>' + head.map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>');
        continue;
      }
      var h = l.match(/^(#{1,4})\s+(.*)$/);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>\s?/.test(l)) {
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        out.push('<blockquote>' + q.map(inline).join('<br>') + '</blockquote>');
        continue;
      }
      if (/^\s*[-*+]\s+/.test(l)) {
        var ul = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { ul.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
        out.push('<ul>' + ul.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ul>');
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(l)) {
        var ol = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { ol.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++; }
        out.push('<ol>' + ol.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ol>');
        continue;
      }
      if (!l.trim()) { i++; continue; }
      var p = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(lines[i])) { p.push(lines[i]); i++; }
      if (!p.length) { p.push(lines[i]); i++; }
      out.push('<p>' + p.map(inline).join('<br>') + '</p>');
    }
    return out.join('\n');
  }

  function splitRow(r) { return r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); }

  function showResult(text, streaming) {
    ui.raw.textContent = text;
    ui.md.innerHTML = text ? renderMD(text) : '';
    ui.md.classList.toggle('muted', !text);
    ui.md.classList.toggle('streaming', !!streaming);
  }

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(function () {
      renderPending = false;
      showResult(streamBuf, true);
      if (thinkBuf) { ui.think.hidden = false; ui.thinkOut.textContent = thinkBuf; }
    });
  }

  /* ---------- 결과 패널 ---------- */
  function renderRoute(target, reason, parsed, ms) {
    ui.route.className = '';
    ui.route.innerHTML = '';
    var top = el('div', 'route-target');
    top.appendChild(el('span', 'badge', target.toUpperCase()));
    top.appendChild(el('span', '', 'ai-' + target + ' · ' + DCOrchestrator.LABEL[target]));
    ui.route.appendChild(top);
    var kv = el('div', 'kv');
    kv.innerHTML = '<b>판단 근거</b> ' + esc(reason || '-') + '<br><b>소요</b> ' + sec(ms) + (parsed ? '' : ' · <span class="warn">폴백 적용</span>');
    ui.route.appendChild(kv);
  }

  function renderRounds(rounds, revisions, maxRev, finished) {
    ui.rounds.className = '';
    ui.rounds.innerHTML = '';
    if (!rounds.length) { ui.rounds.className = 'muted'; ui.rounds.textContent = '검수 중...'; return; }
    rounds.forEach(function (rd) {
      var box = el('div', 'round ' + rd.verdict.toLowerCase());
      var head = el('div', 'round-head');
      head.appendChild(el('span', 'badge ' + rd.verdict.toLowerCase(), rd.verdict));
      head.appendChild(el('b', '', rd.round + '차 검수'));
      head.appendChild(el('span', 'kv', '점수 ' + rd.score + '/10 · ' + rd.source + ' · ' + sec(rd.ms)));
      box.appendChild(head);
      if (rd.reason) box.appendChild(el('div', 'why', rd.reason));
      if (rd.fixes && rd.fixes.length) {
        var ol = el('ol');
        rd.fixes.forEach(function (f) { ol.appendChild(el('li', '', String(f).replace(/^\d+\.\s*/, ''))); });
        box.appendChild(ol);
      }
      ui.rounds.appendChild(box);
    });
    if (finished) {
      var last = rounds[rounds.length - 1];
      var s = el('div', 'summary-line');
      s.textContent = '검수 ' + rounds.length + '회 · 자동 수정 ' + revisions + '회 (상한 ' + maxRev + '회) · ' +
        (last.verdict === 'PASS' ? '최종 PASS' : '상한 도달, 남은 지적은 상태 압축에 기록');
      ui.rounds.appendChild(s);
    }
  }

  function renderState(state) {
    if (state && state.text) {
      ui.state.textContent = state.text;
      ui.state.classList.remove('muted');
    } else {
      ui.state.textContent = '아직 없습니다.';
      ui.state.classList.add('muted');
    }
    ui.followWrap.hidden = !(state && state.text);
  }

  function renderHistory() {
    ui.hist.innerHTML = '';
    if (!history.length) { ui.hist.appendChild(el('li', 'muted', '기록 없음')); return; }
    history.forEach(function (h, idx) {
      var li = el('li');
      var b = el('button');
      b.type = 'button';
      b.appendChild(el('span', 'h-b', h.target.toUpperCase()));
      b.appendChild(el('span', 'h-t', h.input));
      b.addEventListener('click', function () { restore(idx); });
      li.appendChild(b);
      ui.hist.appendChild(li);
    });
  }

  function restore(idx) {
    var h = history[idx];
    if (!h || running) return;
    ui.prompt.value = h.input;
    renderRoute(h.target, h.reason, true, h.routeMs || 0);
    renderRounds(h.rounds, h.revisions, h.maxRev || 2, true);
    showResult(h.final, false);
    ui.think.hidden = true;
    ui.meta.textContent = 'ai-' + h.target + ' · ' + new Date(h.at).toLocaleString('ko-KR');
    lastState = h.state;
    save(LS_STATE, lastState);
    renderState(lastState);
    log('기록 불러옴: ' + h.input.slice(0, 40));
  }

  /* ---------- 연결 확인 + 원클릭 연결 ---------- */
  function orch() {
    return new DCOrchestrator({ host: ui.host.value.trim(), maxRevisions: ui.maxRev.value, saveMemory: ui.saveMem.checked });
  }

  var LS_CONNECTOR = 'dc-orch-connector';
  var CMD_WIN = 'powershell -ExecutionPolicy Bypass -c "irm https://jake12733.github.io/darkcode-orchestrator/connect/win.txt|iex"';
  var CMD_UNIX = 'curl -fsSL https://jake12733.github.io/darkcode-orchestrator/connect/unix.sh | sh';
  var connState = '';
  var pollTimer = null;
  var cx = { title: $('cxTitle'), live: $('cxLive'), start: $('cxStart'), connect: $('cxConnect'), copyMain: $('cxCopyMain'), sub: $('cxSub'), cmd: $('cxCmd'), altText: $('cxAltText'), note: $('cxNote'), more: $('cxMore') };

  function detectOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (p.indexOf('win') !== -1) return 'win';
    if (p.indexOf('mac') !== -1 || p.indexOf('iphone') !== -1 || p.indexOf('ipad') !== -1) return 'mac';
    if (p.indexOf('android') !== -1) return 'mobile';
    if (p.indexOf('linux') !== -1 || p.indexOf('x11') !== -1 || p.indexOf('cros') !== -1) return 'linux';
    return 'win';
  }
  var OS = detectOS();

  function setupConnectUI() {
    if (OS === 'win') {
      cx.connect.hidden = false; cx.copyMain.hidden = true;
      cx.connect.textContent = '원클릭 연결 (Windows)';
      cx.cmd.textContent = CMD_WIN;
    } else if (OS === 'mobile') {
      cx.connect.hidden = true; cx.copyMain.hidden = true;
      cx.sub.textContent = 'Ollama는 PC에서 실행됩니다. 이 페이지를 Ollama가 설치된 PC 브라우저에서 열어 주세요.';
      cx.more.hidden = true;
    } else {
      cx.connect.hidden = true; cx.copyMain.hidden = false;
      cx.copyMain.textContent = '연결 명령어 복사 (' + (OS === 'mac' ? 'Mac' : 'Linux') + ')';
      cx.sub.textContent = '터미널을 열고 붙여넣기(' + (OS === 'mac' ? 'Cmd' : 'Ctrl+Shift') + ' + V) → Enter. 설치 확인, 접속 허용, 재시작, 모델 준비까지 자동으로 끝나고 이 화면이 저절로 바뀝니다.';
      cx.cmd.textContent = CMD_UNIX;
      cx.altText.innerHTML = '터미널에 아래 명령어를 붙여넣고 <b>Enter</b>';
      cx.note.innerHTML = 'Linux는 설정 중 sudo 비밀번호를 물을 수 있어요. 브라우저가 "로컬 네트워크 기기 접근"을 물으면 <b>허용</b>을 누르세요.';
    }
  }

  function probeRunning(host) {
    // CORS로 막혀도 Ollama가 켜져 있으면 no-cors 요청은 성공한다
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, 4000);
    return fetch(host + '/api/version', { mode: 'no-cors', cache: 'no-store', signal: ctl.signal }).then(function () { clearTimeout(t); return true; }, function () { clearTimeout(t); return false; });
  }

  function showConnect(state, detail) {
    ui.help.hidden = false;
    var installed = localStorage.getItem(LS_CONNECTOR) === '1';
    cx.start.hidden = !(state === 'off' && installed && OS === 'win');
    if (state === 'off') {
      cx.title.textContent = installed ? 'Ollama가 꺼져 있어요' : 'Ollama 연결이 필요해요';
      ui.helpReason.textContent = installed
        ? '[Ollama 켜기]를 누르면 바로 켜집니다. (처음 한 번 브라우저가 앱 열기를 물으면 허용)'
        : 'Ollama가 꺼져 있거나, 아직 이 사이트와 연결 설정이 안 된 상태입니다. 아래 버튼 하나로 설치 확인부터 연결까지 자동으로 처리됩니다.';
    } else if (state === 'permission') {
      cx.title.textContent = '브라우저에서 [허용]만 눌러 주세요';
      ui.helpReason.innerHTML = '브라우저가 이 사이트의 <b>로컬 네트워크 기기 접근</b>을 허용할지 묻고 있어요. 주소창 아래에 뜬 창에서 <b>허용</b>을 누르면 바로 연결됩니다. 창이 안 보이면 주소창 왼쪽 아이콘 → 사이트 설정 → 로컬 네트워크 액세스 → 허용. 그래도 안 되면 아래 원클릭 연결을 실행하세요.';
    } else if (state === 'blocked') {
      cx.title.textContent = 'Ollama는 켜져 있어요. 접속 허용만 하면 돼요';
      ui.helpReason.textContent = '보안 설정 때문에 이 사이트가 Ollama를 부르지 못하고 있습니다. 아래 버튼을 한 번 실행하면 허용 설정과 재시작이 자동으로 됩니다.';
    } else if (state === 'models') {
      cx.title.textContent = 'DARK CODE 모델 준비가 필요해요';
      ui.helpReason.textContent = 'Ollama에는 연결됐지만 전용 모델 일부가 없습니다. 아래 버튼을 실행하면 없는 모델만 자동으로 만듭니다.';
    }
    ui.missing.hidden = !detail;
    ui.missing.textContent = detail || '';
    startPolling();
  }

  function setPill(cls, text) { ui.conn.className = 'pill ' + cls; ui.connText.textContent = text; }

  function checkConn(silent) {
    if (!silent) setPill('pill-wait', 'Ollama 확인 중');
    var o = orch();
    return o.checkConnection().then(function (r) {
      if (r.ok && !r.missing.length) {
        if (connState !== 'ok') log('Ollama 연결 OK (' + r.host + '), 모델 6개 확인');
        if (connState && connState !== 'ok') { cx.live.innerHTML = '<span class="dot"></span>연결됨'; }
        connState = 'ok';
        setPill('pill-ok', 'Ollama 연결됨 · 모델 6/6');
        ui.help.hidden = true;
        stopPolling();
        return true;
      }
      if (r.ok) {
        if (connState !== 'models') log('누락 모델: ' + r.missing.join(', '), true);
        connState = 'models';
        setPill('pill-bad', '모델 ' + r.missing.length + '개 없음');
        showConnect('models', '없는 모델: ' + r.missing.join(', '));
        return true;
      }
      if (r.timeout) {
        if (connState !== 'permission') log('브라우저가 로컬 Ollama 접근 허용을 기다리는 중', true);
        connState = 'permission';
        setPill('pill-wait', '브라우저 허용 대기');
        showConnect('permission', '');
        return false;
      }
      return probeRunning(o.host).then(function (running) {
        var st = running ? 'blocked' : 'off';
        if (connState !== st) log(running ? 'Ollama 실행 중이지만 이 사이트 접속이 허용되지 않음' : 'Ollama에 연결할 수 없음 (꺼짐 또는 연결 설정 필요)', true);
        connState = st;
        setPill('pill-bad', running ? '접속 허용 필요' : '연결 안 됨');
        showConnect(st, '');
        return false;
      });
    });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () { if (!document.hidden && !running) checkConn(true); }, 3000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  cx.start.addEventListener('click', function () {
    cx.live.innerHTML = '<span class="dot"></span>켜는 중...';
    log('Ollama 켜기 요청 (darkcode-ollama://start)');
    window.location.href = 'darkcode-ollama://start';
    startPolling();
  });
  cx.connect.addEventListener('click', function () {
    log('원클릭 연결 파일 다운로드 → 더블클릭해서 실행하세요');
    cx.live.innerHTML = '<span class="dot"></span>실행 기다리는 중';
    startPolling();
  });
  cx.copyMain.addEventListener('click', function () {
    navigator.clipboard.writeText(CMD_UNIX).then(function () {
      cx.copyMain.textContent = '복사됨! 터미널에 붙여넣으세요';
      cx.live.innerHTML = '<span class="dot"></span>실행 기다리는 중';
      setTimeout(setupConnectUI, 2500);
    });
    startPolling();
  });

  /* ---------- 실행 ---------- */
  function setRunning(on) {
    ui.run.disabled = on;
    ui.stop.disabled = !on;
    ui.prompt.disabled = on;
  }

  function run() {
    var input = ui.prompt.value.trim();
    if (!input || running) { if (!input) ui.prompt.focus(); return; }
    save(LS_OPTS, { maxRev: ui.maxRev.value, saveMem: ui.saveMem.checked });

    var useState = lastState && ui.follow.checked && !ui.followWrap.hidden ? lastState : null;
    var o = orch();
    running = new AbortController();
    setRunning(true);
    resetNodes();
    streamBuf = ''; thinkBuf = '';
    ui.think.hidden = true; ui.thinkOut.textContent = '';
    showResult('', true);
    ui.md.textContent = '라우팅 중...';
    ui.meta.textContent = '';
    ui.route.className = 'muted'; ui.route.textContent = '라우터가 분야를 판단하는 중...';
    ui.rounds.className = 'muted'; ui.rounds.textContent = '초안 생성 후 검수합니다.';
    var roundsView = [];
    log('실행 시작' + (useState ? ' (이전 상태 이어서)' : '') + ' · 수정 최대 ' + o.maxRevisions + '회 · 메모리 절약 ' + (o.saveMemory ? 'ON' : 'OFF'));

    o.run(input, {
      state: useState,
      signal: running.signal,
      onEvent: function (ev) {
        if (ev.type === 'token') { streamBuf += ev.text; scheduleRender(); return; }
        if (ev.type === 'thinking') { thinkBuf += ev.text; scheduleRender(); return; }
        if (ev.type !== 'stage') return;
        if (ev.stage === 'route') {
          if (ev.status === 'running') { setNode('route', 'run', '분류 중'); log('1단계 ai-router 호출'); }
          else {
            setNode('route', 'done', ev.target.toUpperCase());
            renderRoute(ev.target, ev.reason, ev.parsed, ev.ms);
            log('라우팅 → ' + ev.target + ' (' + ev.reason + ', ' + sec(ev.ms) + ')');
          }
        } else if (ev.stage === 'draft' || ev.stage === 'revise') {
          if (ev.status === 'running') {
            streamBuf = ''; thinkBuf = '';
            setNode('worker', 'run', ev.stage === 'draft' ? '초안 생성' : '수정 ' + ev.round + '회차');
            setNode('critic', roundsView.length ? 'done' : null, roundsView.length ? '대기' : '대기');
            ui.md.textContent = ev.model + (ev.stage === 'draft' ? ' 초안 생성 중...' : ' 수정본 생성 중...');
            log((ev.stage === 'draft' ? '2단계 ' : '수정 ') + ev.model + ' 호출');
          } else {
            setNode('worker', 'done', ev.model);
            showResult(streamBuf, false);
            log(ev.model + ' 완료 (' + ev.chars + '자, ' + sec(ev.ms) + ')');
          }
        } else if (ev.stage === 'critic') {
          if (ev.status === 'running') { setNode('critic', 'run', ev.round + '차 검수'); log('3단계 ai-critic ' + ev.round + '차 검수'); }
          else {
            roundsView.push(ev.verdict);
            setNode('critic', 'done', ev.verdict.verdict + ' · ' + ev.round + '차');
            renderRounds(roundsView, roundsView.length - 1, o.maxRevisions, false);
            log('검수 ' + ev.round + '차 → ' + ev.verdict.verdict + (ev.verdict.fixes.length ? ' (지적 ' + ev.verdict.fixes.length + '건)' : ''));
          }
        } else if (ev.stage === 'done') {
          var r = ev.result;
          setNode('out', 'done', '완료 ' + sec(r.timings.total));
          showResult(r.final, false);
          if (r.thinking) { ui.think.hidden = false; ui.thinkOut.textContent = r.thinking; }
          renderRounds(r.rounds, r.revisions, o.maxRevisions, true);
          ui.meta.textContent = 'ai-' + r.target + ' · 검수 ' + r.rounds.length + '회 · ' + sec(r.timings.total);
          lastState = r.state;
          save(LS_STATE, lastState);
          renderState(lastState);
          history.unshift({
            at: Date.now(), input: r.input, target: r.target, reason: r.reason, routeMs: r.timings.route,
            rounds: r.rounds, revisions: r.revisions, maxRev: o.maxRevisions, final: r.final, state: r.state
          });
          history = history.slice(0, 20);
          save(LS_HIST, history);
          renderHistory();
          log('4단계 완료 · 총 ' + sec(r.timings.total) + ' · 상태 압축 저장');
        }
      }
    }).catch(function (err) {
      var aborted = err && err.name === 'AbortError';
      log(aborted ? '사용자가 중지했습니다.' : '오류: ' + err.message, !aborted);
      document.querySelectorAll('.node.run').forEach(function (n) { n.classList.remove('run'); n.classList.add('fail'); });
      if (streamBuf) showResult(streamBuf, false);
      else { ui.md.classList.remove('streaming'); ui.md.textContent = aborted ? '중지됨' : '오류: ' + err.message; }
      if (!aborted && /Failed to fetch|NetworkError|Load failed/i.test(String(err.message))) checkConn();
    }).then(function () {
      running = null;
      setRunning(false);
    });
  }

  /* ---------- 이벤트 ---------- */
  ui.run.addEventListener('click', run);
  ui.stop.addEventListener('click', function () { if (running) running.abort(); });
  ui.prompt.addEventListener('keydown', function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } });
  ui.conn.addEventListener('click', function () { checkConn(false); });
  $('settingsBtn').addEventListener('click', function () { ui.settings.hidden = !ui.settings.hidden; });
  ui.host.addEventListener('change', function () { save(LS_HOST, ui.host.value.trim()); checkConn(); });
  $('newChatBtn').addEventListener('click', function () {
    lastState = null; save(LS_STATE, null); renderState(null); log('이전 상태를 비웠습니다. 새 작업으로 시작합니다.');
  });
  ui.rawBtn.addEventListener('click', function () {
    var showRaw = ui.raw.hidden;
    ui.raw.hidden = !showRaw; ui.md.hidden = showRaw;
    ui.rawBtn.textContent = showRaw ? '보기 좋게' : '원문 보기';
  });

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof HTMLElement)) return;
    var text = null;
    if (t.dataset.copy) text = $(t.dataset.copy).textContent;
    else if (t.classList.contains('copy-code')) { var c = t.parentElement.querySelector('code'); text = c ? c.textContent : ''; }
    if (text == null) return;
    navigator.clipboard.writeText(text).then(function () {
      var old = t.textContent; t.textContent = '복사됨'; setTimeout(function () { t.textContent = old; }, 1200);
    }).catch(function () { log('복사 실패: 브라우저가 클립보드 접근을 막았습니다.', true); });
  });

  /* ---------- 배경 코드 비 ---------- */
  (function rain() {
    var c = $('rain');
    if (!c || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    var ctx = c.getContext('2d');
    var cols = [], fs = 16, w = 0, h = 0, last = 0;
    var chars = '01アイウエオカキクケコサシスセソ<>/{}[]=+*#$';
    function size() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Array(Math.ceil(w / fs)).fill(0).map(function () { return Math.random() * -50; });
    }
    function frame(t) {
      requestAnimationFrame(frame);
      if (document.hidden || t - last < 60) return;
      last = t;
      ctx.fillStyle = 'rgba(0,0,0,0.12)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#00FF66'; ctx.font = fs + 'px monospace';
      for (var i = 0; i < cols.length; i++) {
        ctx.fillText(chars[(Math.random() * chars.length) | 0], i * fs, cols[i] * fs);
        if (cols[i] * fs > h && Math.random() > 0.975) cols[i] = 0;
        cols[i] += running ? 1.4 : 0.6;
      }
    }
    size(); window.addEventListener('resize', size); requestAnimationFrame(frame);
  })();

  /* ---------- 시작 ---------- */
  var savedHost = load(LS_HOST, null);
  if (savedHost) ui.host.value = savedHost;
  var opts = load(LS_OPTS, null);
  if (opts) { ui.maxRev.value = opts.maxRev || '2'; ui.saveMem.checked = opts.saveMem !== false; }
  if (/[?&]connected=1/.test(location.search)) {
    localStorage.setItem(LS_CONNECTOR, '1');
    history.replaceState(null, '', location.pathname);
    log('원클릭 연결 도구 설치 완료. 다음부터는 [Ollama 켜기] 버튼으로 켤 수 있어요.');
  }
  setupConnectUI();
  renderState(lastState);
  renderHistory();
  checkConn();
  document.addEventListener('visibilitychange', function () { if (!document.hidden && connState !== 'ok') checkConn(true); });
})();
