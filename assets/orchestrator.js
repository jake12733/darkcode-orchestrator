/*
 * DARK CODE Orchestrator Engine
 * 로컬 Ollama의 ai-router / ai-music / ai-dev / ai-media / ai-qa / ai-critic 을
 * router → worker → critic (→ revise 루프) 순서로 한 번에 하나씩 호출한다.
 * 사용: const orch = new DCOrchestrator({ host, maxRevisions, saveMemory });
 *       const result = await orch.run(input, { state, onEvent, signal });
 */
(function (global) {
  'use strict';

  var TARGETS = ['music', 'dev', 'media', 'qa'];
  var MODELS = ['ai-router', 'ai-music', 'ai-dev', 'ai-media', 'ai-qa', 'ai-critic'];

  var ROUTER_SCHEMA = {
    type: 'object',
    properties: {
      target: { type: 'string', enum: TARGETS },
      reason: { type: 'string' }
    },
    required: ['target', 'reason']
  };

  var CRITIC_SCHEMA = {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['PASS', 'REVISE'] },
      score: { type: 'integer' },
      reason: { type: 'string' },
      fixes: { type: 'array', items: { type: 'string' }, maxItems: 3 }
    },
    required: ['verdict', 'score', 'reason', 'fixes']
  };

  // 개발 AI만 생각 모드 사용 (Modelfile 설계와 동일)
  var THINK = { music: false, dev: true, media: false, qa: false };

  var NEXT_STEP = {
    music: 'Suno/Udio에 [Style / Prompt]와 가사를 붙여넣어 생성해 보세요. 분위기 수정은 이어서 요청하면 됩니다.',
    dev: '코드를 저장해 실행해 보고, 오류가 나면 에러 메시지를 그대로 붙여 이어서 요청하세요.',
    media: '고정 묘사 블록을 유지한 채 장면별 프롬프트로 이미지·영상을 생성하고, 편집 가이드대로 컷을 붙이세요.',
    qa: '더 깊게 알고 싶은 부분을 이어서 질문하세요. 숫자·법·의료 정보는 공식 자료로 한 번 더 확인하세요.'
  };

  var LABEL = { music: '음악·작사', dev: '개발', media: '영상·사진', qa: '일반 답변' };

  function DCOrchestrator(opts) {
    opts = opts || {};
    this.host = (opts.host || 'http://localhost:11434').replace(/\/+$/, '');
    this.maxRevisions = clamp(parseInt(opts.maxRevisions, 10) || 2, 1, 3);
    this.saveMemory = opts.saveMemory !== false; // true면 호출마다 모델을 VRAM에서 내림
  }

  DCOrchestrator.TARGETS = TARGETS;
  DCOrchestrator.MODELS = MODELS;
  DCOrchestrator.LABEL = LABEL;

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function now() { return (global.performance && performance.now) ? performance.now() : Date.now(); }

  /* ---------- JSON 파싱 (깨진 출력 대비) ---------- */
  function parseLooseJSON(text) {
    if (!text) return null;
    var t = String(text).replace(/^\uFEFF/, '').trim();
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    var s = t.indexOf('{');
    var e = t.lastIndexOf('}');
    if (s === -1 || e <= s) return null;
    try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
  }

  function pickTarget(text) {
    var j = parseLooseJSON(text);
    if (j && TARGETS.indexOf(String(j.target).toLowerCase()) !== -1) {
      return { target: String(j.target).toLowerCase(), reason: String(j.reason || '').trim(), parsed: true };
    }
    var m = String(text || '').toLowerCase().match(/\b(music|dev|media|qa)\b/);
    if (m) return { target: m[1], reason: '라우터 출력 일부에서 분야 추출', parsed: false };
    return { target: 'qa', reason: '라우터 출력을 해석하지 못해 qa로 폴백', parsed: false };
  }

  function cleanFix(f) { return String(f || '').replace(/^\s*\d+\s*[.)]\s*/, '').trim(); }

  function pickVerdict(text) {
    var j = parseLooseJSON(text);
    if (j && (j.verdict === 'PASS' || j.verdict === 'REVISE')) {
      var fixes = Array.isArray(j.fixes) ? j.fixes.map(cleanFix).filter(Boolean).slice(0, 3) : [];
      if (j.verdict === 'REVISE' && !fixes.length) fixes = [String(j.reason || '검수 지적 사항 보완')];
      return { verdict: j.verdict, score: Number(j.score) || 0, reason: String(j.reason || ''), fixes: j.verdict === 'PASS' ? [] : fixes, parsed: true };
    }
    var vm = String(text || '').match(/"verdict"\s*:\s*"(PASS|REVISE)"/);
    if (vm && vm[1] === 'REVISE') {
      var fm = String(text).match(/"fixes"\s*:\s*\[([\s\S]*)/);
      var raw = fm ? fm[1].split(/"\s*,\s*"/).map(function (x) { return cleanFix(x.replace(/^[\s"]+|[\s"\]}]+$/g, '')); }).filter(Boolean).slice(0, 3) : [];
      return { verdict: 'REVISE', score: 0, reason: '검수 출력 일부 복구', fixes: raw.length ? raw : ['검수 지적 사항 보완'], parsed: false };
    }
    // 판정을 읽을 수 없으면 무한 루프 방지를 위해 PASS 처리
    return { verdict: 'PASS', score: 0, reason: '검수 출력을 해석하지 못해 통과 처리', fixes: [], parsed: false };
  }

  /* ---------- 코드 기반 사전 점검 (토큰 0) ---------- */
  var OMISSION_RE = /(\/\/\s*(중략|생략|나머지|이하\s*동일|기존\s*코드|\.\.\.))|(#\s*(중략|생략|나머지|\.\.\.))|(<!--\s*(중략|생략|나머지|\.\.\.)[^>]*-->)|(\bTODO\b)|(나머지\s*(코드는?\s*)?(동일|같습니다|생략))|(이하\s*생략)/i;

  function preCheck(target, output) {
    var fixes = [];
    if (OMISSION_RE.test(output)) {
      fixes.push('생략 표현(// 중략, TODO, 나머지 동일 등) 제거 → 해당 부분을 완전한 내용으로 채워 전체 출력');
    }
    var prose = stripCode(output);
    var han = prose.match(/[\u4E00-\u9FFF]+/g);
    if (han && han.length) {
      fixes.push('중국어 한자(' + han.slice(0, 3).join(', ') + ') → 자연스러운 한국어 표현으로 바꿔 쓰기');
    }
    if (target === 'media' && /(man|woman|male|female|person|people|girl|boy|doctor|assistant|patient|staff|model)\b/i.test(prose) && !/korean/i.test(prose)) {
      fixes.push('[고정 묘사 블록]과 생성 프롬프트의 인물 묘사 → Korean을 명시 (예: a Korean woman in her 30s)');
    }
    if (target === 'qa' && /\[\d+\]/.test(output)) {
      fixes.push('[참고 자료]가 없으므로 [1] 같은 출처 번호 삭제');
    }
    if (target === 'music' && !/\[(Verse|Chorus|Intro|Outro|Bridge|Hook|Pre-Chorus)/i.test(output) && !/인스트|instrumental/i.test(output)) {
      fixes.push('[가사] → [Verse 1] [Chorus] 같은 섹션 태그를 붙여 구분');
    }
    if (target === 'music' && !/style\s*\/\s*prompt/i.test(output)) {
      fixes.push('[Style / Prompt] 블록 → 영어 쉼표 구분 스타일 프롬프트를 별도로 추가');
    }
    return fixes;
  }

  function stripCode(s) { return String(s || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' '); }

  /* ---------- 결과 요약 (토큰 0) ---------- */
  function summarize(target, text) {
    var lines = String(text || '').split('\n');
    var inCode = false;
    var picked = [];
    for (var i = 0; i < lines.length && picked.length < 3; i++) {
      var l = lines[i];
      if (/^\s*```/.test(l)) { inCode = !inCode; continue; }
      if (inCode) continue;
      l = l.replace(/^#+\s*/, '').replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '').replace(/\|/g, ' ').trim();
      if (!l || /^\[.*\]$/.test(l) || /^[-:\s]+$/.test(l)) continue;
      picked.push(l);
    }
    var s = picked.join(' / ');
    if (s.length > 180) s = s.slice(0, 177) + '...';
    return (LABEL[target] || target) + ' 결과: ' + (s || '(요약할 텍스트 없음)');
  }

  function buildState(r) {
    var finalVerdict = r.rounds.length ? r.rounds[r.rounds.length - 1].verdict : 'PASS';
    var applied = [];
    r.rounds.forEach(function (rd, idx) {
      if (rd.verdict === 'REVISE' && idx < r.rounds.length - 1) applied = applied.concat(rd.fixes);
    });
    var remaining = finalVerdict === 'REVISE' ? r.rounds[r.rounds.length - 1].fixes : [];
    var lines = {
      model: 'ai-' + r.target + ' · 검수 ' + r.rounds.length + '회 (수정 ' + r.revisions + '회) · 최종 ' + finalVerdict,
      summary: summarize(r.target, r.final),
      improved: applied.length ? applied.join(' / ') : '없음 (1차 검수 통과)',
      next: remaining.length ? ('미해결: ' + remaining.join(' / ') + ' → 이어서 요청해 보완') : NEXT_STEP[r.target]
    };
    var text =
      '[최종 채택 모델 & 라운드 수] ' + lines.model + '\n' +
      '[확정 핵심 결과 요약] ' + lines.summary + '\n' +
      '[검수에서 보완된 주요 사항] ' + lines.improved + '\n' +
      '[남은 이슈 / 다음 단계 제안] ' + lines.next;
    return { target: r.target, lines: lines, text: text };
  }

  /* ---------- Ollama 호출 ---------- */
  DCOrchestrator.prototype._post = function (path, body, signal) {
    return fetch(this.host + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error('Ollama ' + res.status + ': ' + t.slice(0, 200)); });
      }
      return res;
    });
  };

  DCOrchestrator.prototype._chatOnce = function (body, signal) {
    body.stream = false;
    return this._post('/api/chat', body, signal).then(function (res) { return res.json(); });
  };

  DCOrchestrator.prototype._chatStream = function (body, onDelta, signal) {
    body.stream = true;
    return this._post('/api/chat', body, signal).then(function (res) {
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      var content = '';
      var thinking = '';
      var last = null;
      function handle(line) {
        if (!line.trim()) return;
        var j;
        try { j = JSON.parse(line); } catch (e) { return; }
        if (j.error) throw new Error('Ollama: ' + j.error);
        if (j.message) {
          if (j.message.thinking) { thinking += j.message.thinking; onDelta && onDelta('thinking', j.message.thinking); }
          if (j.message.content) { content += j.message.content; onDelta && onDelta('content', j.message.content); }
        }
        if (j.done) last = j;
      }
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            if (buf) handle(buf);
            return;
          }
          buf += dec.decode(r.value, { stream: true });
          var parts = buf.split('\n');
          buf = parts.pop();
          parts.forEach(handle);
          return pump();
        });
      }
      return pump().then(function () {
        // 혹시 <think> 태그가 본문에 섞여 오면 분리
        var m = content.match(/^\s*<think>([\s\S]*?)<\/think>\s*/);
        if (m) { thinking += m[1]; content = content.slice(m[0].length); }
        return { content: content, thinking: thinking, stats: last };
      });
    });
  };

  DCOrchestrator.prototype._keep = function () {
    return this.saveMemory ? 0 : '5m';
  };

  DCOrchestrator.prototype.checkConnection = function (timeoutMs) {
    var self = this;
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 5000) : null;
    return fetch(this.host + '/api/tags', ctl ? { signal: ctl.signal, cache: 'no-store' } : undefined).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var names = (data.models || []).map(function (m) { return String(m.name).replace(/:latest$/, ''); });
      var missing = MODELS.filter(function (m) { return names.indexOf(m) === -1; });
      return { ok: true, missing: missing, host: self.host };
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      var timeout = err && err.name === 'AbortError';
      return { ok: false, error: timeout ? 'timeout' : err.message, timeout: timeout, host: self.host };
    });
  };

  /* ---------- 프롬프트 빌더 ---------- */
  function workerPrompt(input, target, state) {
    var p = '[원래 사용자 요청]\n' + input;
    if (state && state.text) p += '\n\n[이전 작업 상태]\n' + state.text;
    p += '\n\n[확정된 스펙/제약조건]\n- 담당: ai-' + target + ' (' + LABEL[target] + ')' +
      '\n- // 중략, TODO, "나머지 동일" 같은 생략 없이 완결된 형태로 출력';
    return p;
  }

  function revisePrompt(input, target, draft, fixes) {
    return '[원래 사용자 요청]\n' + input +
      '\n\n[직전 산출물]\n' + draft +
      '\n\n[직전 검수 피드백 - 아래 항목만 고치세요]\n' + fixes.map(function (f, i) { return (i + 1) + '. ' + f; }).join('\n') +
      '\n\n[수정 규칙]\n- 지적된 항목만 고치고 나머지 내용과 출력 형식은 그대로 유지\n- 결과물 전체를 생략 없이 처음부터 끝까지 다시 출력\n- 인사나 사과 문구 없이 결과물만 출력';
  }

  function criticPrompt(input, target, round, prevFixes, output) {
    var p = '[원래 요청]\n' + input + '\n\n[담당 AI]\nai-' + target + '\n\n[검수 회차]\n' + round + '\n\n';
    if (prevFixes && prevFixes.length) p += '[이전 수정 지시]\n' + prevFixes.map(function (f, i) { return (i + 1) + '. ' + f; }).join('\n') + '\n\n';
    return p + '[산출물]\n' + output;
  }

  /* ---------- 메인 파이프라인 ---------- */
  DCOrchestrator.prototype.run = function (input, ctx) {
    ctx = ctx || {};
    var self = this;
    var emit = ctx.onEvent || function () {};
    var signal = ctx.signal;
    var state = ctx.state || null;
    var t0 = now();
    var result = {
      input: input, target: 'qa', reason: '', routeParsed: false,
      rounds: [], revisions: 0, final: '', thinking: '', timings: {}, startedAt: new Date().toISOString()
    };

    input = String(input || '').trim();
    if (!input) return Promise.reject(new Error('요청 내용을 입력하세요.'));

    // 1단계: 라우팅
    emit({ type: 'stage', stage: 'route', status: 'running' });
    var ts = now();
    return self._chatOnce({
      model: 'ai-router',
      messages: [{ role: 'user', content: input }],
      think: false,
      format: ROUTER_SCHEMA,
      keep_alive: 0
    }, signal).then(function (data) {
      var r = pickTarget(data && data.message && data.message.content);
      // 짧은 후속 요청("더 신나게")이 qa로 빠지면 이전 분야 유지
      if (state && state.target && r.target === 'qa' && input.length <= 30 && state.target !== 'qa') {
        r = { target: state.target, reason: '짧은 후속 요청이라 이전 작업 분야(' + state.target + ') 유지', parsed: r.parsed };
      }
      result.target = r.target;
      result.reason = r.reason;
      result.routeParsed = r.parsed;
      result.timings.route = now() - ts;
      emit({ type: 'stage', stage: 'route', status: 'done', target: r.target, reason: r.reason, parsed: r.parsed, ms: result.timings.route });

      // 2단계: 초안
      return draft(workerPrompt(input, result.target, state), 'draft');
    }).then(function (out) {
      result.final = out.content;
      result.thinking = out.thinking;
      return loop(1, []);
    }).then(function () {
      result.timings.total = now() - t0;
      result.state = buildState(result);
      emit({ type: 'stage', stage: 'done', status: 'done', result: result });
      return result;
    });

    function draft(prompt, kind) {
      var model = 'ai-' + result.target;
      emit({ type: 'stage', stage: kind, status: 'running', model: model, round: result.revisions });
      var ts2 = now();
      var body = {
        model: model,
        messages: [{ role: 'user', content: prompt }],
        think: THINK[result.target],
        keep_alive: self._keep()
      };
      return self._chatStream(body, function (kindDelta, text) {
        emit({ type: kindDelta === 'thinking' ? 'thinking' : 'token', text: text, kind: kind });
      }, signal).then(function (out) {
        var ms = now() - ts2;
        result.timings[kind + '_' + result.revisions] = ms;
        emit({ type: 'stage', stage: kind, status: 'done', model: model, ms: ms, chars: out.content.length, round: result.revisions });
        if (!out.content.trim()) throw new Error(model + ' 응답이 비어 있습니다.');
        return out;
      });
    }

    // 3단계: 검수 루프
    function loop(round, prevFixes) {
      emit({ type: 'stage', stage: 'critic', status: 'running', round: round });
      var ts3 = now();
      var local = preCheck(result.target, result.final);
      return self._chatOnce({
        model: 'ai-critic',
        messages: [{ role: 'user', content: criticPrompt(input, result.target, round, prevFixes, result.final) }],
        think: false,
        format: CRITIC_SCHEMA,
        keep_alive: self._keep()
      }, signal).then(function (data) {
        var v = pickVerdict(data && data.message && data.message.content);
        var source = 'ai-critic';
        if (local.length) {
          // 코드 점검에서 확실한 결함이 나오면 REVISE로 올리고 지시를 합친다
          var merged = local.concat(v.verdict === 'REVISE' ? v.fixes : []);
          var seen = {};
          merged = merged.filter(function (f) { if (seen[f]) return false; seen[f] = 1; return true; }).slice(0, 3);
          if (v.verdict === 'PASS') { v.reason = '자동 점검에서 결함 발견: ' + local[0]; source = 'auto-check'; }
          else source = 'ai-critic + auto-check';
          v.verdict = 'REVISE';
          v.fixes = merged;
          v.score = Math.min(v.score || 6, 6);
        }
        var rd = { round: round, verdict: v.verdict, score: v.score, reason: v.reason, fixes: v.fixes, parsed: v.parsed, source: source, ms: now() - ts3 };
        result.rounds.push(rd);
        emit({ type: 'stage', stage: 'critic', status: 'done', round: round, verdict: rd });

        if (v.verdict === 'PASS' || result.revisions >= self.maxRevisions) return null;

        result.revisions += 1;
        return draft(revisePrompt(input, result.target, result.final, v.fixes), 'revise').then(function (out) {
          result.final = out.content;
          if (out.thinking) result.thinking = out.thinking;
          return loop(round + 1, v.fixes);
        });
      });
    }
  };

  DCOrchestrator.parseLooseJSON = parseLooseJSON;
  DCOrchestrator.preCheck = preCheck;
  DCOrchestrator.buildState = buildState;

  global.DCOrchestrator = DCOrchestrator;
})(typeof window !== 'undefined' ? window : globalThis);
