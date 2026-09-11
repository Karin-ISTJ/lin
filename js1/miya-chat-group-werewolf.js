/* miya-chat-group-werewolf.js — 群聊狼人杀
 * 6 人板子：2 狼人 + 2 村民 + 1 预言家 + 1 女巫，玩家(你) + 5 个 AI 角色
 * 代码做法官：身份分配 / 夜晚结算 / 投票计票 / 胜负判定全部本地判定
 * AI 只做两件事：按人设发言（自然语言）、投票（返回 JSON）
 * AI 走 miyaApiBridge.callMainChatCompletionsRaw 裸调，不污染群聊消息
 * 对局状态存 chatSettings.backgroundMessage.werewolf
 */
(function (global) {
  'use strict';

  var USER_OWNER_ID = '__user__';

  /* ---------------- 身份配置 ---------------- */
  var ROLES = {
    werewolf: { id: 'werewolf', name: '狼人', icon: '🐺', camp: 'wolf', desc: '每晚与同伴共同猎杀一人' },
    villager: { id: 'villager', name: '村民', icon: '👤', camp: 'good', desc: '白天与大家一起推理投票' },
    seer: { id: 'seer', name: '预言家', icon: '🔮', camp: 'good', desc: '每晚查验一人身份' },
    witch: { id: 'witch', name: '女巫', icon: '🧪', camp: 'good', desc: '解药救人一次，毒药毒人一次' }
  };

  var DECK = ['werewolf', 'werewolf', 'villager', 'villager', 'seer', 'witch'];
  var TOTAL_SEATS = DECK.length;

  var PHASE = { NIGHT: 'night', DAWN: 'dawn', SPEECH: 'speech', VOTE: 'vote', OVER: 'over' };
  var PHASE_LABEL = {
    night: '夜晚', dawn: '天亮', speech: '白天讨论', vote: '投票', over: '已结束'
  };

  /* ---------------- 工具 ---------------- */
  function now() { return Date.now(); }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function trim(v) { return String(v == null ? '' : v).trim(); }
  function clean(v, max) { return trim(v).slice(0, max || 200); }
  function uid(p) { return (p || 'ww') + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function shuffle(list) {
    var a = (list || []).slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function roleOf(id) { return ROLES[id] || ROLES.villager; }

  /* ---------------- 持久化 ---------------- */
  function getBg(store, chatId) {
    var s = store && store.getChatSettings ? store.getChatSettings(chatId) || {} : {};
    return s.backgroundMessage || {};
  }

  function emptyGame() {
    return {
      id: '', status: 'idle', phase: PHASE.NIGHT, day: 0,
      seats: [], roles: {}, night: null, dawnDeaths: [], speeches: [],
      speechCursor: 0, votes: {}, voteCursor: 0, lastResult: null,
      winner: '', healUsed: false, poisonUsed: false,
      log: [], updatedAt: now()
    };
  }

  function load(store, chatId) {
    var raw = getBg(store, chatId).werewolf;
    var g = emptyGame();
    if (!raw || typeof raw !== 'object') return g;
    g.id = clean(raw.id, 40);
    g.status = ['idle', 'playing', 'over'].indexOf(raw.status) >= 0 ? raw.status : 'idle';
    g.phase = Object.keys(PHASE).map(function (k) { return PHASE[k]; }).indexOf(raw.phase) >= 0 ? raw.phase : PHASE.NIGHT;
    g.day = Math.max(0, Math.floor(num(raw.day)));
    g.seats = Array.isArray(raw.seats) ? raw.seats.map(function (s) {
      if (!s || typeof s !== 'object') return null;
      var whoId = clean(s.whoId, 60);
      if (!whoId) return null;
      return {
        whoId: whoId,
        name: clean(s.name, 40) || '玩家',
        isUser: s.isUser === true || whoId === USER_OWNER_ID,
        alive: s.alive !== false,
        avatar: clean(s.avatar, 400),
        seatNo: Math.floor(num(s.seatNo))
      };
    }).filter(Boolean) : [];
    g.roles = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
    g.night = raw.night && typeof raw.night === 'object' ? raw.night : null;
    g.dawnDeaths = Array.isArray(raw.dawnDeaths) ? raw.dawnDeaths.slice() : [];
    g.speeches = Array.isArray(raw.speeches) ? raw.speeches.map(function (sp) {
      if (!sp || typeof sp !== 'object') return null;
      return { whoId: clean(sp.whoId, 60), name: clean(sp.name, 40), text: clean(sp.text, 600), at: num(sp.at) };
    }).filter(Boolean) : [];
    g.speechCursor = Math.max(0, Math.floor(num(raw.speechCursor)));
    g.votes = raw.votes && typeof raw.votes === 'object' ? raw.votes : {};
    g.voteCursor = Math.max(0, Math.floor(num(raw.voteCursor)));
    g.lastResult = raw.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null;
    g.winner = clean(raw.winner, 20);
    g.healUsed = raw.healUsed === true;
    g.poisonUsed = raw.poisonUsed === true;
    g.log = Array.isArray(raw.log) ? raw.log.slice(-60) : [];
    g.updatedAt = num(raw.updatedAt) || now();
    return g;
  }

  function save(store, chatId, g) {
    if (!store || !store.saveChatSettings || !chatId) return Promise.resolve();
    g.updatedAt = now();
    return store.saveChatSettings(chatId, { backgroundMessage: { werewolf: g } });
  }

  function pushLog(g, text, kind) {
    g.log = (g.log || []).concat([{ at: now(), text: clean(text, 160), kind: clean(kind, 20) || 'info' }]);
    if (g.log.length > 60) g.log = g.log.slice(-60);
  }

  /* ---------------- 座位 / 身份 ---------------- */
  function seatOf(g, whoId) {
    for (var i = 0; i < g.seats.length; i++) if (g.seats[i].whoId === whoId) return g.seats[i];
    return null;
  }
  function aliveSeats(g) { return (g.seats || []).filter(function (s) { return s.alive; }); }
  function aliveIds(g) { return aliveSeats(g).map(function (s) { return s.whoId; }); }
  function nameOf(g, whoId) {
    if (whoId === USER_OWNER_ID) return '你';
    var s = seatOf(g, whoId);
    return s ? s.name : '某人';
  }

  function collectCandidates(store, chatId) {
    var out = [];
    var chat = store && store.findChat ? store.findChat(chatId) : null;
    if (!chat || chat.type !== 'group') return out;
    var members = global.MiyaChatGroup && typeof global.MiyaChatGroup.getMembers === 'function'
      ? global.MiyaChatGroup.getMembers(store, chat)
      : (store.getGroupMembers ? store.getGroupMembers(chatId) : []);
    (members || []).forEach(function (c) {
      if (!c || !c.id) return;
      var nm = '';
      try {
        nm = global.MiyaChatGroup && typeof global.MiyaChatGroup.memberDisplayName === 'function'
          ? global.MiyaChatGroup.memberDisplayName(store, c, chatId)
          : (c.name || '');
      } catch (e) { nm = c.name || ''; }
      out.push({
        whoId: c.id,
        name: trim(nm) || trim(c.name) || '成员',
        isUser: false,
        avatar: trim(c.avatar || c.avatarUrl || '')
      });
    });
    out.unshift({ whoId: USER_OWNER_ID, name: '你', isUser: true, avatar: '' });
    return out;
  }

  /* ---------------- 开局 ---------------- */
  function startGame(store, chatId, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    var cands = collectCandidates(store, chatId);
    if (cands.length < TOTAL_SEATS) {
      return { ok: false, error: '群成员不足 ' + TOTAL_SEATS + ' 人（当前 ' + cands.length + ' 人）' };
    }
    var picked = pickSeats(cands, TOTAL_SEATS);
    var g = emptyGame();
    g.id = uid('wwg');
    g.status = 'playing';
    g.day = 0;
    var deck = shuffle(DECK);
    g.seats = picked.map(function (c, idx) {
      return { whoId: c.whoId, name: c.name, isUser: !!c.isUser, alive: true, avatar: c.avatar || '', seatNo: idx + 1 };
    });
    g.seats.forEach(function (s, idx) { g.roles[s.whoId] = deck[idx]; });
    g.healUsed = false;
    g.poisonUsed = false;
    pushLog(g, '开局 · ' + TOTAL_SEATS + ' 人局：2 狼人 / 2 村民 / 1 预言家 / 1 女巫', 'start');
    beginNight(g);
    save(store, chatId, g);
    return { ok: true, game: g };
  }

  function pickSeats(cands, need) {
    var user = cands.filter(function (c) { return c.isUser; })[0];
    var others = shuffle(cands.filter(function (c) { return !c.isUser; }));
    var out = user ? [user] : [];
    for (var i = 0; i < others.length && out.length < need; i++) out.push(others[i]);
    return shuffle(out);
  }

  /* ---------------- 夜晚 ---------------- */
  function beginNight(g) {
    g.day = g.day + 1;
    g.phase = PHASE.NIGHT;
    var alive = aliveIds(g);
    g.night = {
      wolfTarget: '', seerTarget: '', seerResult: '',
      witchSave: false, witchPoison: '', resolved: false,
      wolfVotes: {}
    };
    g.dawnDeaths = [];
    g.votes = {};
    g.voteCursor = 0;
    pushLog(g, '第 ' + g.day + ' 夜 · 天黑请闭眼');
  }

  /** 夜晚结算 */
  function resolveNight(store, chatId, g) {
    if (!g.night) return g;
    var deaths = [];
    var target = g.night.wolfTarget;
    var saved = false;
    if (target && g.night.witchSave && !g.healUsed) {
      g.healUsed = true;
      saved = true;
    }
    if (target && !saved) deaths.push(target);
    if (g.night.witchPoison && !g.poisonUsed) {
      g.poisonUsed = true;
      if (deaths.indexOf(g.night.witchPoison) < 0) deaths.push(g.night.witchPoison);
    }
    deaths.forEach(function (id) { var s = seatOf(g, id); if (s) s.alive = false; });
    g.dawnDeaths = deaths.slice();
    g.night = null;
    g.phase = PHASE.DAWN;
    pushLog(g, deaths.length
      ? '天亮 · 昨晚倒牌：' + deaths.map(function (id) { return nameOf(g, id); }).join('、')
      : '天亮 · 昨晚是平安夜', 'dawn');
    if (store && chatId) save(store, chatId, g);
    return g;
  }

  /* ---------------- 胜负 ---------------- */
  function checkWinner(g) {
    var alive = aliveSeats(g);
    var wolfAlive = alive.filter(function (s) { return g.roles[s.whoId] === 'werewolf'; }).length;
    var goodAlive = alive.length - wolfAlive;
    if (wolfAlive === 0) return 'good';
    if (wolfAlive >= goodAlive) return 'wolf';
    return '';
  }

  function finish(g, winner) {
    g.status = 'over';
    g.phase = PHASE.OVER;
    g.winner = winner;
    pushLog(g, winner === 'wolf' ? '狼人阵营胜利' : '好人阵营胜利', 'over');
  }

  /* ---------------- 投票 ---------------- */
  function tallyVotes(g) {
    var count = {}, voters = {};
    Object.keys(g.votes || {}).forEach(function (voterId) {
      var voter = seatOf(g, voterId);
      if (!voter || !voter.alive) return;
      var t = g.votes[voterId];
      var tgt = seatOf(g, t);
      if (!tgt || !tgt.alive) return;
      count[t] = (count[t] || 0) + 1;
      (voters[t] = voters[t] || []).push(voterId);
    });
    var max = 0, top = [];
    Object.keys(count).forEach(function (k) {
      if (count[k] > max) { max = count[k]; top = [k]; }
      else if (count[k] === max) top.push(k);
    });
    return { count: count, top: top, max: max, tie: top.length > 1, voters: voters };
  }

  function applyVoteResult(store, chatId, g) {
    var t = tallyVotes(g);
    if (!t.max) {
      g.lastResult = { type: 'no_vote', text: '本轮无人投票，无人出局' };
    } else if (t.tie) {
      var names = t.top.map(function (id) { return nameOf(g, id); }).join('、');
      g.lastResult = { type: 'tie', text: '平票（' + names + '），本轮无人出局', top: t.top.slice() };
      pushLog(g, '平票：' + names + '，无人出局', 'vote');
    } else {
      var outId = t.top[0];
      var s = seatOf(g, outId);
      if (s) s.alive = false;
      var role = roleOf(g.roles[outId]);
      g.lastResult = {
        type: 'out', outId: outId, name: nameOf(g, outId),
        roleId: g.roles[outId], roleName: role.name, count: t.max,
        text: nameOf(g, outId) + ' 被投出局（' + t.max + ' 票），身份是 ' + role.icon + role.name
      };
      pushLog(g, g.lastResult.text, 'vote');
    }
    var winner = checkWinner(g);
    if (winner) finish(g, winner);
    else { g.phase = PHASE.SPEECH; g.speechCursor = 0; }
    save(store, chatId, g);
    return g.lastResult;
  }

  /* ---------------- 从夜晚推进到白天发言 ---------------- */
  function advanceFromNight(store, chatId, g) {
    if (g.phase !== PHASE.NIGHT) return g;
    resolveNight(store, chatId, g);
    var winner = checkWinner(g);
    if (winner) { finish(g, winner); save(store, chatId, g); return g; }
    g.phase = PHASE.SPEECH;
    g.speechCursor = 0;
    g.speeches = [];
    save(store, chatId, g);
    return g;
  }

  function nextSpeaker(g) {
    var alive = aliveSeats(g);
    for (var i = g.speechCursor; i < alive.length; i++) {
      if (!alive[i].isUser) return { seat: alive[i], index: i };
    }
    return null;
  }

  function recordSpeech(g, whoId, text) {
    var s = seatOf(g, whoId);
    g.speeches.push({ whoId: whoId, name: s ? s.name : '某人', text: clean(text, 600), at: now() });
  }

  /* ---------------- AI 调用 ---------------- */
  function buildSituation(g, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    var lines = [];
    lines.push('你在参与一场群聊里的「狼人杀」游戏。请严格遵守游戏规则，不要跳戏、不要输出规则说明。');
    lines.push('板子：' + TOTAL_SEATS + ' 人局 —— 2 狼人 / 2 村民 / 1 预言家 / 1 女巫。');
    lines.push('第 ' + g.day + ' 天，当前阶段：' + (PHASE_LABEL[g.phase] || g.phase) + '。');
    lines.push('在场玩家：' + g.seats.map(function (s) {
      return s.name + (s.isUser ? '(真人玩家)' : '') + (s.alive ? '' : '（已出局）');
    }).join('、'));
    if (opts.selfId) {
      var selfRole = roleOf(g.roles[opts.selfId]);
      lines.push('你的身份是：' + selfRole.icon + selfRole.name + '——' + selfRole.desc + '。');
      if (selfRole.id === 'werewolf') {
        var mates = g.seats.filter(function (s) {
          return g.roles[s.whoId] === 'werewolf' && s.whoId !== opts.selfId;
        }).map(function (s) { return s.name; });
        lines.push('你的狼人同伴：' + (mates.length ? mates.join('、') : '（已无）') + '。');
      }
    }
    if (g.speeches.length) {
      lines.push('本轮已有发言：');
      g.speeches.slice(-8).forEach(function (sp) { lines.push('  ' + sp.name + '：' + sp.text); });
    }
    if (g.dawnDeaths && g.dawnDeaths.length) {
      lines.push('昨夜出局：' + g.dawnDeaths.map(function (id) { return nameOf(g, id); }).join('、') + '。');
    } else if (g.phase !== PHASE.NIGHT && g.day > 1) {
      lines.push('昨夜是平安夜。');
    }
    return lines.join('\n');
  }

  /** 确保 API 桥就绪：它是懒加载的，首次用狼人杀时可能还没到 */
  var apiBridgeWait = null;
  function ensureApiBridge(timeoutMs) {
    if (global.miyaApiBridge && typeof global.miyaApiBridge.callMainChatCompletionsRaw === 'function') {
      return Promise.resolve(true);
    }
    if (apiBridgeWait) return apiBridgeWait;
    var started = false;
    if (typeof global.miyaLazyEnsureGroups === 'function') {
      try {
        started = true;
        apiBridgeWait = global.miyaLazyEnsureGroups(['apiCore']).then(function () {
          return true;
        }).catch(function () { return false; });
      } catch (e) { started = false; }
    }
    if (!started) apiBridgeWait = Promise.resolve(false);
    /* 兜底轮询：lazy-boot 缺失或加载失败时给一段时间 */
    var deadline = now() + (timeoutMs || 12000);
    return apiBridgeWait.then(function () {
      return new Promise(function (resolve) {
        (function poll() {
          if (global.miyaApiBridge && typeof global.miyaApiBridge.callMainChatCompletionsRaw === 'function') {
            return resolve(true);
          }
          if (now() > deadline) return resolve(false);
          setTimeout(poll, 150);
        })();
      });
    }).then(function (ok) {
      if (!ok) apiBridgeWait = null;
      return ok;
    });
  }

  /** 裸调大模型：不落库、不进群聊历史 */
  function callApi(systemHint, userContent, maxTokens) {
    return ensureApiBridge().then(function (ready) {
      var br = global.miyaApiBridge;
      if (!ready || !br || typeof br.callMainChatCompletionsRaw !== 'function') {
        throw new Error('API 尚未就绪，请确认已在设置里配置好对话 API');
      }
      return br.callMainChatCompletionsRaw(systemHint, userContent, null, {
        skipUniversalWorldbook: true,
        disableThinking: true,
        max_tokens: maxTokens || 400,
        timeoutMs: 60000
      });
    });
  }

  /** 从各种返回结构里抠出文本 */
  function extractText(res) {
    if (!res) return '';
    if (typeof res === 'string') return trim(res);
    var d = res.data || res;
    if (typeof d === 'string') return trim(d);
    var ch = d.choices && d.choices[0];
    if (ch) {
      if (ch.message && ch.message.content != null) return trim(ch.message.content);
      if (ch.delta && ch.delta.content != null) return trim(ch.delta.content);
      if (ch.text != null) return trim(ch.text);
    }
    if (d.reply != null) return trim(d.reply);
    if (d.content != null) return trim(d.content);
    if (d.text != null) return trim(d.text);
    return '';
  }

  var SYS_HINT = '你是一位参与狼人杀游戏的玩家。你只输出符合要求的游戏内容本身，'
    + '不解释规则、不加旁白括号、不重复系统提示。需要输出 JSON 时只输出 JSON。';

  /**
   * 让某个 AI 完成一个任务
   * task: speech | vote | wolf_kill | seer_check | witch_action
   * 返回 Promise<{ text, reason, target, targetName, save, poison }>
   */
  function askAi(g, whoId, task, extra) {
    var lead = buildSituation(g, { selfId: whoId });
    var others = aliveSeats(g).filter(function (s) { return s.whoId !== whoId; });

    if (task === 'speech') {
      lead += '\n\n现在轮到你发言。请用 1~2 句话说出你的判断：可以怀疑某个人、为自己辩解、或分析局势。'
        + '\n要求：像在群里聊天一样口语化、有个性，不要输出「某某说：」这种前缀，不要输出旁白。';
      return callApi(SYS_HINT, lead, 300).then(function (res) {
        var text = extractText(res);
        return { text: text || '（沉默）' };
      });
    }

    if (task === 'vote') {
      lead += '\n\n现在进入投票阶段，你要投出你认为最像狼人的一个玩家（不能投自己）。'
        + '\n可选目标：' + others.map(function (s) { return s.name; }).join('、')
        + '\n只输出 JSON：{"vote":"玩家名字","reason":"简短理由"}';
      return callApi(SYS_HINT, lead, 200).then(function (res) {
        return parseVote(extractText(res), others);
      });
    }

    if (task === 'wolf_kill') {
      var targets = aliveSeats(g).filter(function (s) { return g.roles[s.whoId] !== 'werewolf' || s.whoId === whoId; })
        .filter(function (s) { return !(g.roles[s.whoId] === 'werewolf' && s.whoId !== whoId); });
      lead += '\n\n现在是夜晚，你要和同伴一起选一个好人猎杀（不能猎杀狼人同伴）。'
        + '\n可选目标：' + targets.map(function (s) { return s.name; }).join('、')
        + '\n只输出 JSON：{"vote":"玩家名字","reason":"简短理由"}';
      return callApi(SYS_HINT, lead, 200).then(function (res) {
        return parseVote(extractText(res), targets);
      });
    }

    if (task === 'seer_check') {
      lead += '\n\n你是预言家，今晚要查验一个人的身份（不能查验自己）。'
        + '\n可选目标：' + others.map(function (s) { return s.name; }).join('、')
        + '\n只输出 JSON：{"vote":"玩家名字","reason":"简短理由"}';
      return callApi(SYS_HINT, lead, 200).then(function (res) {
        return parseVote(extractText(res), others);
      });
    }

    if (task === 'witch_action') {
      extra = extra || {};
      lead += '\n\n你是女巫，现在是夜晚。';
      if (extra.canSave) {
        lead += '\n今晚被猎杀的是「' + (extra.wolfTargetName || '某人') + '」，你手上还有一瓶解药。';
      } else {
        lead += '\n你的解药已经用过了。';
      }
      if (extra.canPoison) {
        lead += '\n你手上还有一瓶毒药，可以毒杀一个人。可选：'
          + others.map(function (s) { return s.name; }).join('、');
      } else {
        lead += '\n你的毒药已经用过了。';
      }
      lead += '\n只输出 JSON：{"save":true或false,"poison":"玩家名字或空字符串","reason":"简短理由"}';
      return callApi(SYS_HINT, lead, 250).then(function (res) {
        var text = extractText(res);
        var obj = extractJson(text);
        var out = { save: false, poison: '', poisonId: '', reason: '', text: text };
        if (obj) {
          out.save = obj.save === true || String(obj.save) === 'true';
          var pname = trim(obj.poison || obj.poisonTarget || '');
          out.reason = trim(obj.reason || '');
          if (pname) {
            var hit = null;
            for (var i = 0; i < others.length; i++) {
              if (others[i].name === pname) { hit = others[i]; break; }
            }
            if (hit) { out.poison = hit.name; out.poisonId = hit.whoId; }
          }
        }
        return out;
      });
    }

    return Promise.reject(new Error('unknown_task'));
  }

  function extractJson(text) {
    var t = trim(text);
    if (!t) return null;
    var m = t.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch (e) {
      try {
        return JSON.parse(m[0].replace(/[""]/g, '"').replace(/，/g, ',').replace(/：/g, ':'));
      } catch (e2) { return null; }
    }
  }

  function parseVote(text, candidates) {
    var t = trim(text);
    var obj = extractJson(t);
    var picked = '';
    if (obj) picked = trim(obj.vote || obj.target || obj.name || '');
    var hit = null;
    if (picked) {
      for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].name === picked) { hit = candidates[i]; break; }
      }
    }
    if (!hit) {
      /* 退化匹配：文本里出现的第一个候选名 */
      for (var j = 0; j < candidates.length; j++) {
        if (t.indexOf(candidates[j].name) >= 0) { hit = candidates[j]; break; }
      }
    }
    if (!hit && candidates.length) hit = candidates[Math.floor(Math.random() * candidates.length)];
    return {
      target: hit ? hit.whoId : '',
      targetName: hit ? hit.name : '',
      reason: obj && trim(obj.reason) || '',
      text: t
    };
  }

  /* ---------------- UI ---------------- */
  var state = { chatId: '', busy: false, busyText: '' };

  function phaseStepHtml(g) {
    var order = [
      { k: PHASE.NIGHT, t: '夜晚' },
      { k: PHASE.SPEECH, t: '发言' },
      { k: PHASE.VOTE, t: '投票' }
    ];
    /* DAWN 属于「夜晚刚结束」，高亮夜晚这一步；SPEECH 及之后高亮发言 */
    return order.map(function (s) {
      var on = g.phase === s.k || (g.phase === PHASE.DAWN && s.k === PHASE.NIGHT);
      return '<span class="ww-step' + (on ? ' is-on' : '') + '">' + s.t + '</span>';
    }).join('<span class="ww-step-arrow">›</span>');
  }

  function seatCardHtml(g, seat, opts) {
    opts = opts || {};
    var isMe = seat.whoId === USER_OWNER_ID;
    var cls = 'ww-seat';
    if (!seat.alive) cls += ' is-dead';
    if (isMe) cls += ' is-me';
    if (opts.pickable) cls += ' is-pickable';
    if (opts.selected) cls += ' is-selected';

    var roleHtml = '';
    /* 只对玩家自己、或游戏结束后，显示身份 */
    if (isMe || g.status === 'over') {
      var r = roleOf(g.roles[seat.whoId]);
      roleHtml = '<span class="ww-seat-role">' + r.icon + r.name + '</span>';
    } else {
      roleHtml = '<span class="ww-seat-role ww-seat-role--hidden">？</span>';
    }

    var attrs = opts.pickable ? ' data-ww-pick="' + esc(seat.whoId) + '"' : '';
    return '<div class="' + cls + '"' + attrs + '>' +
      '<span class="ww-seat-no">' + (seat.seatNo || '') + '</span>' +
      '<span class="ww-seat-name">' + esc(isMe ? '你' : seat.name) + '</span>' +
      roleHtml +
      (seat.alive ? '' : '<span class="ww-seat-dead">出局</span>') +
      '</div>';
  }

  function renderPanel(store, chatId) {
    var g = load(store, chatId);
    var head =
      '<div class="ww__head">' +
        '<div class="ww__title">🐺 狼人杀</div>' +
        '<button type="button" class="ww__close" data-sheet-close aria-label="关闭">关闭</button>' +
      '</div>';

    if (g.status === 'idle') {
      var cands = collectCandidates(store, chatId);
      var enough = cands.length >= TOTAL_SEATS;
      return '<div class="ww" id="ww-panel">' + head +
        '<div class="ww__intro">' +
          '<p class="ww__intro-lead">' + TOTAL_SEATS + ' 人局 · 2 狼人 / 2 村民 / 1 预言家 / 1 女巫</p>' +
          '<p class="ww__intro-desc">你与群里 ' + Math.max(0, cands.length - 1) + ' 位角色同桌。' +
            '身份随机分配，AI 会真实推理发言。<br>本局记录不会出现在群聊里。</p>' +
          (enough ? '' : '<p class="ww__intro-warn">⚠️ 群成员不足 ' + TOTAL_SEATS + ' 人（当前 ' + cands.length + ' 人），请先拉人进群</p>') +
        '</div>' +
        '<div class="ww__actions">' +
          '<button type="button" class="ww__btn ww__btn--main" data-ww-act="start"' + (enough ? '' : ' disabled') + '>开始游戏</button>' +
        '</div>' +
        (g.log && g.log.length ? '<div class="ww__log">' + g.log.slice(-4).map(function (l) {
          return '<div class="ww__log-item">' + esc(l.text) + '</div>';
        }).join('') + '</div>' : '') +
      '</div>';
    }

    if (g.status === 'over') {
      var winText = g.winner === 'wolf' ? '🐺 狼人阵营胜利' : '🛡️ 好人阵营胜利';
      var allRoles = g.seats.map(function (s) {
        var r = roleOf(g.roles[s.whoId]);
        return '<div class="ww-result-row"><span>' + esc(s.whoId === USER_OWNER_ID ? '你' : s.name) + '</span>'
          + '<span>' + r.icon + r.name + '</span>'
          + '<span>' + (s.alive ? '存活' : '出局') + '</span></div>';
      }).join('');
      return '<div class="ww" id="ww-panel">' + head +
        '<div class="ww__over">' +
          '<div class="ww__over-title">' + winText + '</div>' +
          '<div class="ww__result-list">' + allRoles + '</div>' +
        '</div>' +
        '<div class="ww__actions">' +
          '<button type="button" class="ww__btn ww__btn--main" data-ww-act="start">再来一局</button>' +
          '<button type="button" class="ww__btn" data-ww-act="reset">清空记录</button>' +
        '</div>' +
      '</div>';
    }

    /* 进行中 */
    var isMyRole = roleOf(g.roles[USER_OWNER_ID]);
    var myRoleBar = '<div class="ww__myrole">你的身份：<b>' + isMyRole.icon + isMyRole.name + '</b>' +
      '<span class="ww__myrole-desc">' + esc(isMyRole.desc) + '</span></div>';

    var seatsHtml = g.seats.map(function (s) { return seatCardHtml(g, s); }).join('');

    var phaseHtml = '<div class="ww__phase">第 ' + g.day + ' 天 · ' + phaseStepHtml(g) + '</div>';

    /* 阶段专属操作区 */
    var stageHtml = '';

    if (g.phase === PHASE.NIGHT) {
      var myRoleId = g.roles[USER_OWNER_ID];
      var aliveOthers = aliveSeats(g).filter(function (s) { return s.whoId !== USER_OWNER_ID; });
      var deadList = g.night && g.night.wolfTarget ? nameOf(g, g.night.wolfTarget) : '';

      if (myRoleId === 'werewolf') {
        var wolfTargets = aliveOthers.filter(function (s) { return g.roles[s.whoId] !== 'werewolf'; });
        stageHtml = '<div class="ww__stage">' +
          '<div class="ww__stage-title">🌙 你是狼人，选择今晚的猎杀目标</div>' +
          '<div class="ww__pick">' + wolfTargets.map(function (s) {
            return '<button type="button" class="ww__pick-btn' +
              (g.night && g.night.wolfTarget === s.whoId ? ' is-selected' : '') +
              '" data-ww-act="wolf_pick" data-ww-target="' + esc(s.whoId) + '">' + esc(s.name) + '</button>';
          }).join('') + '</div>' +
          '<div class="ww__hint">' + (deadList ? '已选择：' + esc(deadList) : '尚未选择') + '</div>' +
          '</div>';
      } else if (myRoleId === 'seer') {
        stageHtml = '<div class="ww__stage">' +
          '<div class="ww__stage-title">🔮 你是预言家，选择要查验的人</div>' +
          '<div class="ww__pick">' + aliveOthers.map(function (s) {
            return '<button type="button" class="ww__pick-btn' +
              (g.night && g.night.seerTarget === s.whoId ? ' is-selected' : '') +
              '" data-ww-act="seer_pick" data-ww-target="' + esc(s.whoId) + '">' + esc(s.name) + '</button>';
          }).join('') + '</div>' +
          (g.night && g.night.seerResult
            ? '<div class="ww__hint ww__hint--ok">' + esc(g.night.seerResult) + '</div>'
            : '<div class="ww__hint">尚未查验</div>') +
          '</div>';
      } else if (myRoleId === 'witch') {
        var wtName = g.night && g.night.wolfTarget ? nameOf(g, g.night.wolfTarget) : '';
        stageHtml = '<div class="ww__stage">' +
          '<div class="ww__stage-title">🧪 你是女巫</div>' +
          '<div class="ww__hint">' + (wtName ? '今晚被猎杀的是：<b>' + esc(wtName) + '</b>' : '今晚暂时没有刀口信息') + '</div>' +
          '<label class="ww__witch-row">' +
            '<input type="checkbox" data-ww-act="witch_save"' + (!g.healUsed && g.night && g.night.witchSave ? ' checked' : '') +
            (g.healUsed ? ' disabled' : '') + '> 使用解药救人' + (g.healUsed ? '（已用完）' : '') +
          '</label>' +
          '<div class="ww__stage-sub">毒药（可选）：</div>' +
          '<div class="ww__pick">' +
            '<button type="button" class="ww__pick-btn' + (g.night && !g.night.witchPoison ? ' is-selected' : '') +
              '" data-ww-act="witch_poison" data-ww-target="">不用毒</button>' +
            aliveOthers.map(function (s) {
              return '<button type="button" class="ww__pick-btn' +
                (g.night && g.night.witchPoison === s.whoId ? ' is-selected' : '') +
                '" data-ww-act="witch_poison" data-ww-target="' + esc(s.whoId) + '"' +
                (g.poisonUsed ? ' disabled' : '') + '>' + esc(s.name) + '</button>';
            }).join('') +
          '</div>' +
          (g.poisonUsed ? '<div class="ww__hint">毒药已用完</div>' : '') +
          '</div>';
      } else {
        /* 村民 / 已出局的玩家：夜晚无事可做 */
        stageHtml = '<div class="ww__stage">' +
          '<div class="ww__stage-title">🌙 天黑请闭眼</div>' +
          '<div class="ww__hint">你是' + isMyRole.name + '，今夜无事可做，请等待天亮…</div>' +
          '</div>';
      }

      stageHtml += '<div class="ww__actions">' +
        '<button type="button" class="ww__btn ww__btn--main" data-ww-act="dawn">天亮（结算夜晚）</button>' +
        '</div>';
    }

    if (g.phase === PHASE.SPEECH) {
      var spoken = g.speeches.map(function (sp) {
        return '<div class="ww-say"><span class="ww-say-name">' + esc(sp.name) + '</span>' +
          '<span class="ww-say-text">' + esc(sp.text) + '</span></div>';
      }).join('');
      stageHtml = '<div class="ww__stage">' +
        '<div class="ww__stage-title">💬 白天讨论</div>' +
        '<div class="ww__speeches">' + (spoken || '<div class="ww__hint">还没有人发言</div>') + '</div>' +
        '<div class="ww__actions">' +
          '<button type="button" class="ww__btn ww__btn--main" data-ww-act="next_speech"' +
            (state.busy ? ' disabled' : '') + '>' + (state.busy ? esc(state.busyText || '思考中…') : '让下一位发言') + '</button>' +
          '<button type="button" class="ww__btn" data-ww-act="to_vote">进入投票</button>' +
        '</div>' +
      '</div>';
    }

    if (g.phase === PHASE.VOTE) {
      var voteOthers = aliveSeats(g).filter(function (s) { return s.whoId !== USER_OWNER_ID; });
      var voted = g.votes[USER_OWNER_ID];
      stageHtml = '<div class="ww__stage">' +
        '<div class="ww__stage-title">🗳️ 投票</div>' +
        '<div class="ww__pick">' + voteOthers.map(function (s) {
          return '<button type="button" class="ww__pick-btn' + (voted === s.whoId ? ' is-selected' : '') +
            '" data-ww-act="vote" data-ww-target="' + esc(s.whoId) + '">' + esc(s.name) + '</button>';
        }).join('') + '</div>' +
        (g.lastResult ? '<div class="ww__hint ww__hint--ok">' + esc(g.lastResult.text) + '</div>' : '') +
        '<div class="ww__actions">' +
          '<button type="button" class="ww__btn ww__btn--main" data-ww-act="do_vote"' +
            (state.busy ? ' disabled' : '') + '>' + (state.busy ? esc(state.busyText || 'AI 投票中…') : '让 AI 投票并计票') + '</button>' +
        '</div>' +
      '</div>';
    }

    var logTail = (g.log || []).slice(-3).reverse().map(function (l) {
      return '<div class="ww__log-item">' + esc(l.text) + '</div>';
    }).join('');

    return '<div class="ww" id="ww-panel">' + head +
      myRoleBar + phaseHtml +
      '<div class="ww__seats">' + seatsHtml + '</div>' +
      stageHtml +
      (logTail ? '<div class="ww__log">' + logTail + '</div>' : '') +
      '</div>';
  }

  function openPanel(store, chatId, openOverlay) {
    if (!store || !chatId || !openOverlay) return;
    state.chatId = chatId;
    openOverlay('<div class="qq-sheet qq-sheet--ww"><div class="qq-sheet__panel ww-sheet__panel">' +
      renderPanel(store, chatId) + '</div></div>');
  }

  function refresh(store, chatId, openOverlay) {
    openPanel(store, chatId, openOverlay);
  }

  /* ---------------- 事件处理 ---------------- */
  function handlePanelClick(store, chatId, el, toast, openOverlay, engine) {
    if (!el || !store || !chatId) return false;
    var btn = el.closest ? el.closest('[data-ww-act]') : null;
    if (!btn) return false;
    var act = btn.getAttribute('data-ww-act');
    var target = btn.getAttribute('data-ww-target') || '';
    var g = load(store, chatId);

    function rerender() { refresh(store, chatId, openOverlay); }
    function fail(msg) { if (toast) toast(msg || '操作失败'); }

    if (act === 'start') {
      var res = startGame(store, chatId);
      if (!res.ok) { fail(res.error); return true; }
      if (toast) toast('游戏开始！天黑请闭眼');
      rerender();
      return true;
    }

    if (act === 'reset') {
      var fresh = emptyGame();
      save(store, chatId, fresh);
      rerender();
      return true;
    }

    if (g.status !== 'playing') return true;

    if (act === 'wolf_pick') {
      if (!g.night) return true;
      g.night.wolfTarget = target;
      pushLog(g, '你选择了猎杀目标');
      save(store, chatId, g);
      rerender();
      return true;
    }

    if (act === 'seer_pick') {
      if (!g.night || !target) return true;
      g.night.seerTarget = target;
      var r = roleOf(g.roles[target]);
      var isWolf = r.camp === 'wolf';
      g.night.seerResult = '查验结果：' + nameOf(g, target) + ' 是 ' + (isWolf ? '🐺 狼人' : '👤 好人');
      pushLog(g, '预言家查验了 ' + nameOf(g, target), 'seer');
      save(store, chatId, g);
      rerender();
      return true;
    }

    if (act === 'witch_save') {
      if (!g.night || g.healUsed) return true;
      g.night.witchSave = !!btn.checked;
      save(store, chatId, g);
      rerender();
      return true;
    }

    if (act === 'witch_poison') {
      if (!g.night || g.poisonUsed) return true;
      g.night.witchPoison = target;
      pushLog(g, target ? '女巫选择了毒杀目标' : '女巫没有使用毒药');
      save(store, chatId, g);
      rerender();
      return true;
    }

    if (act === 'dawn') {
      advanceFromNight(store, chatId, g);
      if (toast) toast(g.dawnDeaths && g.dawnDeaths.length
        ? '天亮了，昨晚有人出局' : '天亮了，昨晚是平安夜');
      rerender();
      return true;
    }

    if (act === 'next_speech') {
      var nxt = nextSpeaker(g);
      if (!nxt) {
        if (toast) toast('所有人都发言完了，可以进入投票');
        return true;
      }
      state.busy = true;
      state.busyText = nxt.seat.name + ' 正在思考…';
      rerender();
      askAi(g, nxt.seat.whoId, 'speech').then(function (out) {
        var fresh2 = load(store, chatId);
        recordSpeech(fresh2, nxt.seat.whoId, out.text);
        /* 游标推进到该座位之后 */
        var aliveNow = aliveSeats(fresh2);
        for (var i = 0; i < aliveNow.length; i++) {
          if (aliveNow[i].whoId === nxt.seat.whoId) { fresh2.speechCursor = i + 1; break; }
        }
        state.busy = false;
        save(store, chatId, fresh2).then(function () { rerender(); });
      }).catch(function (err) {
        state.busy = false;
        fail('AI 发言失败：' + ((err && err.message) || '未知错误'));
        rerender();
      });
      return true;
    }

    if (act === 'to_vote') {
      g.phase = PHASE.VOTE;
      g.votes = {};
      g.lastResult = null;
      save(store, chatId, g);
      rerender();
      return true;
    }

    if (act === 'vote') {
      if (!target) return true;
      g.votes[USER_OWNER_ID] = target;
      save(store, chatId, g);
      rerender();
      return true;
    }

    if (act === 'do_vote') {
      state.busy = true;
      state.busyText = 'AI 投票中…';
      rerender();
      runAiVotes(store, chatId).then(function () {
        state.busy = false;
        rerender();
      }).catch(function (err) {
        state.busy = false;
        fail('投票出错：' + ((err && err.message) || '未知错误'));
        rerender();
      });
      return true;
    }

    return true;
  }

  /** 让所有存活 AI 依次投票（串行），然后计票 */
  function runAiVotes(store, chatId) {
    var g = load(store, chatId);
    var alive = aliveSeats(g).filter(function (s) { return !s.isUser; });
    var idx = 0;

    function step() {
      if (idx >= alive.length) {
        var fresh = load(store, chatId);
        var result = applyVoteResult(store, chatId, fresh);
        if (result && result.type === 'out') {
          pushLog(fresh, '进入下一夜');
        }
        if (fresh.status === 'playing') {
          beginNight(fresh);
        }
        return save(store, chatId, fresh);
      }
      var seat = alive[idx++];
      /* 已出局则跳过 */
      var cur = load(store, chatId);
      if (!seatOf(cur, seat.whoId) || !seatOf(cur, seat.whoId).alive) return step();

      return askAi(cur, seat.whoId, 'vote').then(function (out) {
        var fresh = load(store, chatId);
        if (out && out.target && seatOf(fresh, out.target) && seatOf(fresh, out.target).alive) {
          fresh.votes[seat.whoId] = out.target;
        }
        return save(store, chatId, fresh);
      }).catch(function () {
        /* 单个 AI 失败不阻塞整体：随机投一个存活玩家 */
        var fresh = load(store, chatId);
        var pool = aliveSeats(fresh).filter(function (s) { return s.whoId !== seat.whoId; });
        if (pool.length) {
          fresh.votes[seat.whoId] = pool[Math.floor(Math.random() * pool.length)].whoId;
        }
        return save(store, chatId, fresh);
      }).then(function () {
        return step();
      });
    }

    return Promise.resolve().then(step);
  }

  /* ---------------- 对外接口 ---------------- */
  global.MiyaChatGroupWerewolf = {
    ROLES: ROLES,
    DECK: DECK,
    TOTAL_SEATS: TOTAL_SEATS,
    PHASE: PHASE,
    USER_OWNER_ID: USER_OWNER_ID,
    load: load,
    save: save,
    emptyGame: emptyGame,
    collectCandidates: collectCandidates,
    startGame: startGame,
    beginNight: beginNight,
    resolveNight: resolveNight,
    advanceFromNight: advanceFromNight,
    tallyVotes: tallyVotes,
    applyVoteResult: applyVoteResult,
    checkWinner: checkWinner,
    finish: finish,
    askAi: askAi,
    parseVote: parseVote,
    buildSituation: buildSituation,
    nextSpeaker: nextSpeaker,
    recordSpeech: recordSpeech,
    runAiVotes: runAiVotes,
    seatOf: seatOf,
    aliveSeats: aliveSeats,
    nameOf: nameOf,
    roleOf: roleOf,
    renderPanel: renderPanel,
    openPanel: openPanel,
    handlePanelClick: handlePanelClick
  };
})(window);
