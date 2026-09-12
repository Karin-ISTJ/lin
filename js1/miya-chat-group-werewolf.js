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
      id: '', chatId: '', status: 'idle', phase: PHASE.NIGHT, day: 0,
      seats: [], roles: {}, night: null, dawnDeaths: [], speeches: [],
      speechCursor: 0, votes: {}, voteCursor: 0, lastResult: null,
      winner: '', healUsed: false, poisonUsed: false, finalVotes: null,
      /* 本局输出上限（token）：0 = 跟随设置里的「最大回复长度」 */
      maxTokens: 0,
      log: [], updatedAt: now()
    };
  }

  function load(store, chatId) {
    var raw = getBg(store, chatId).werewolf;
    var g = emptyGame();
    g.chatId = chatId ? String(chatId) : '';
    if (!raw || typeof raw !== 'object') return g;
    g.id = clean(raw.id, 40);
    g.chatId = clean(raw.chatId, 80) || (chatId ? String(chatId) : '');
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
      return { whoId: clean(sp.whoId, 60), name: clean(sp.name, 40), text: clean(sp.text, 1200), truncated: !!sp.truncated, at: num(sp.at) };
    }).filter(Boolean) : [];
    g.speechCursor = Math.max(0, Math.floor(num(raw.speechCursor)));
    g.votes = raw.votes && typeof raw.votes === 'object' ? raw.votes : {};
    g.voteCursor = Math.max(0, Math.floor(num(raw.voteCursor)));
    g.lastResult = raw.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null;
    g.winner = clean(raw.winner, 20);
    g.healUsed = raw.healUsed === true;
    g.poisonUsed = raw.poisonUsed === true;
    g.finalVotes = raw.finalVotes && typeof raw.finalVotes === 'object' ? raw.finalVotes : null;
    g.maxTokens = Math.max(0, Math.floor(num(raw.maxTokens)));
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
    g.chatId = chatId ? String(chatId) : '';
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
    /* 投票结果留档：清空票型会让「谁把谁投出去」无从追溯 */
    if (g.lastResult && g.lastResult.type === 'out') {
      g.finalVotes = {
        votes: Object.assign({}, g.votes || {}),
        text: g.lastResult.text,
        outId: g.lastResult.outId
      };
    }
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

  /**
   * 下一个该发言的座位。
   *
   * 【修复：玩家不再被跳过】
   * 旧实现是 `if (!alive[i].isUser) return ...` —— 直接把玩家座位跳过去，
   * 于是轮次从头到尾只在 AI 之间流转，玩家永远等不到自己的回合，
   * 面板上也没有任何输入入口，看起来就是「本来该我发言，结果把我跳过了」。
   * 现在玩家座位同样参与轮转，轮到玩家时由 UI 渲染输入框（isUser: true）。
   */
  function nextSpeaker(g) {
    var alive = aliveSeats(g);
    for (var i = g.speechCursor; i < alive.length; i++) {
      return { seat: alive[i], index: i, isUser: alive[i].isUser === true || alive[i].whoId === USER_OWNER_ID };
    }
    return null;
  }

  /** 玩家是否已在本轮发过言 */
  function userHasSpoken(g) {
    return (g.speeches || []).some(function (sp) { return sp.whoId === USER_OWNER_ID; });
  }

  /**
   * 把发言游标推进到「刚发完言的座位」之后。
   * 之前这段逻辑内联在 AI 分支里，玩家发言也需要，抽出来共用。
   */
  function advanceSpeechCursor(g, whoId) {
    var alive = aliveSeats(g);
    for (var i = 0; i < alive.length; i++) {
      if (alive[i].whoId === whoId) { g.speechCursor = i + 1; return; }
    }
  }

  function recordSpeech(g, whoId, text, truncated) {
    var s = seatOf(g, whoId);
    g.speeches.push({
      whoId: whoId,
      name: s ? s.name : '某人',
      text: clean(text, 1200),
      truncated: !!truncated,
      at: now()
    });
  }

  /* ---------------- AI 调用 ---------------- */
  function buildSituation(g, opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    var lines = [];
    lines.push('你在参与一场群聊里的「狼人杀」游戏。请严格遵守游戏规则，不要跳戏、不要输出规则说明。');
    lines.push('板子：' + TOTAL_SEATS + ' 人局 —— 2 狼人 / 2 村民 / 1 预言家 / 1 女巫。');
    lines.push('第 ' + g.day + ' 天，当前阶段：' + (PHASE_LABEL[g.phase] || g.phase) + '。');

    /*
     * 【修复：AI 护着玩家的根因】
     * 旧代码这里给玩家加了一个 '(真人玩家)' 标记，等于直接告诉模型
     * 「这位是操控者本人」。叠加人设/好感度/关系上下文后，模型自然
     * 不肯怀疑、不肯投票——表现出来就是「角色都护着我，基本不会把我投出去」。
     * 现在对局内所有人一律平铺为普通玩家，不暴露任何「谁是真人」的信息。
     */
    lines.push('在场玩家：' + g.seats.map(function (s) {
      return s.name + (s.alive ? '' : '（已出局）');
    }).join('、'));

    /*
     * 强制定调：人设语气要保留，但胜负判断必须只依据对局内信息。
     * 不写这段的话，「保持角色性格」会被模型理解成「要顺着关系亲疏来站边」。
     */
    lines.push('【对局纪律·优先于一切人设偏好】');
    lines.push('1. 你的性格、称呼习惯、说话语气照常保留，但这是在你「认真玩这局游戏」的前提下展现的。');
    lines.push('2. 判断谁是狼，只能依据本轮发言逻辑、投票行为、身份声明与矛盾之处。');
    lines.push('3. 禁止因为私交、好感、亲密度、关系设定而回避怀疑或放弃投票。该怀疑就怀疑，该投就投。');
    lines.push('4. 不要因为某人是「最熟悉的人」就无条件相信他；也不要刻意针对他。所有人一视同仁。');
    lines.push('5. 投票必须给出由发言/行为推出的理由，不允许「不想投他」「相信他就好」这类无信息理由。');

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
      g.speeches.slice(-8).forEach(function (sp) {
        /*
         * 玩家统一署名「用户」而不是「你」：
         * 这段文本是喂给 AI 的，用「你」会让模型以为那是它自己说过的话，
         * 进而在后续发言里自我附和。
         */
        lines.push('  ' + (sp.whoId === USER_OWNER_ID ? '用户' : sp.name) + '：' + sp.text);
      });
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

  /** 判断是否值得重试：网络抖动 / 超时 / 限流 这类一次性错误 */
  function isRetryable(err) {
    var m = String((err && err.message) || err || '').toLowerCase();
    if (!m) return false;
    if (m.indexOf('http 4') === 0) return false;          /* 客户端错误，重试没用 */
    return m.indexOf('超时') >= 0 ||
      m.indexOf('timeout') >= 0 ||
      m.indexOf('abort') >= 0 ||
      m.indexOf('failed to fetch') >= 0 ||
      m.indexOf('load failed') >= 0 ||
      m.indexOf('network') >= 0 ||
      m.indexOf('http 429') >= 0 ||
      m.indexOf('http 5') >= 0;
  }

  /**
   * 输出上限（token）解析。三级优先级：
   *   1) 本局面板里手动设的 maxTokens（g.maxTokens > 0）
   *   2) 设置 → ST 预设 → 生成参数 → 「最大回复长度 (Token)」
   *   3) 调用处传入的兜底值
   * 之所以要接设置：以前这里是硬编码 1500/400，用户去 ST 预设里把
   * 最大回复长度调到多大都没用，弹窗却让他「去设置里调大输出上限」——
   * 提示语指向了一个对狼人杀无效的开关。
   */
  var SPEECH_FLOOR = 800;   /* 发言低于这个数，思维链会把正文吃光 */
  var ACTION_FLOOR = 400;   /* 投票/查验/毒杀这类短 JSON 任务 */

  function readGlobalMaxTokens() {
    try {
      var st = global.miyaStPromptPresetsStore;
      if (st && typeof st.getActiveGeneration === 'function') {
        var gen = st.getActiveGeneration() || {};
        var v = Number(gen.maxTokens);
        if (Number.isFinite(v) && v > 0) return Math.floor(v);
      }
    } catch (e) {}
    return 0;
  }

  /** floor 决定这是「发言」还是「短 JSON 动作」任务 */
  function resolveMaxTokens(g, floor) {
    var manual = g && Number(g.maxTokens);
    if (Number.isFinite(manual) && manual > 0) return Math.floor(manual);
    var global = readGlobalMaxTokens();
    if (global > 0) return Math.max(floor, global);
    return Math.max(floor, floor === ACTION_FLOOR ? 400 : 1500);
  }

  /**
   * 裸调大模型：不落库、不进群聊历史。
   * 关键参数（与行程模块对齐，否则会踩三个坑）：
   *   contentOnly    —— 只用正文，绝不拿 reasoning 兜底当发言（否则 <thinking> 泄漏到聊天里）
   *   disableThinking—— 尽量让服务端关掉思维链，把 token 全留给正文
   *   onTruncated    —— 撞到 max_tokens 时通知上层，提示「这话没说完」
   * 另外自带重试：网络抖动/超时/限流这类一次性失败最多重试 2 次，
   * 避免「前两句好好的，第三句突然失败」。
   */
  function callApiOnce(systemHint, userContent, maxTokens, onTruncated) {
    return ensureApiBridge().then(function (ready) {
      var br = global.miyaApiBridge;
      if (!ready || !br || typeof br.callMainChatCompletionsRaw !== 'function') {
        throw new Error('API 尚未就绪，请确认已在设置里配置好对话 API');
      }
      return br.callMainChatCompletionsRaw(systemHint, userContent, null, {
        /*
         * 关掉 API 桥的通用世界书兜底注入。
         * 通用（globalReach==='all'）词条已经通过群聊上下文进了 systemHint，
         * 而桥里的 prependUniversalWorldbookMessage 只对 messages 数组查重，
         * 狼人杀把上下文拼成了单个字符串，查重永远不命中 —— 会再塞一遍，
         * 白白翻倍世界书体积。
         */
        skipUniversalWorldbook: true,
        disableThinking: true,
        contentOnly: true,
        max_tokens: maxTokens || resolveMaxTokens(null, SPEECH_FLOOR),
        timeoutMs: 120000,
        onTruncated: onTruncated
      });
    });
  }

  function callApi(systemHint, userContent, maxTokens, onTruncated) {
    var attempt = 0;
    function run() {
      attempt += 1;
      return callApiOnce(systemHint, userContent, maxTokens, onTruncated).catch(function (err) {
        if (attempt < 3 && isRetryable(err)) {
          /* 退避：1.2s → 2.4s，给服务端喘口气 */
          return new Promise(function (res) { setTimeout(res, 1200 * attempt); }).then(run);
        }
        throw err;
      });
    }
    return run();
  }

  /* 上一次组装上下文时的诊断快照（供 UI 展示） */
  var ctxStats = null;

  /**
   * 与「本局对局」无关、但会显著撑大上下文的群聊 system 块。
   * 狼人杀只需要「这个角色是谁、怎么说话」，不需要群昵称头衔、关系网、
   * 私密记忆、天气地点、以及群聊专用的输出格式提醒。
   *
   * 【为什么上一版过滤无效（152.5k 纹丝不动的原因）】
   * buildGroupSystemPrompt() 是把所有块 join('\n\n') 成【一个】大字符串，
   * buildApiMessages() 再把它包成【一个】system message。旧代码在
   * messages.forEach 里按块判定，可整条消息的开头永远是人设或【全局】，
   * 于是 indexOf(prefix) === 0 几乎从不命中 —— 过滤形同虚设。
   * 正确做法：先按「【标题】」把大字符串切回块，再逐块判定。
   */
  var CTX_DROP_PREFIXES = [
    '【群头衔·当前】',
    '【群头衔·规则】',
    '【群昵称·与本群显示名】',
    '【各角色与用户关系】',
    '【成员彼此关系】',
    '【群聊回复格式】',
    '【本轮输出格式·群聊·强制复核】',
    '【互通·单聊记忆】',
    '【本群·记忆总结】',
    '【群聊上下文·必读】',
    '【紧挨上文·群聊末条状态】',
    '【地点运转】',
    '【本群身份·群主与管理员】'
  ];

  function shouldDropCtxBlock(text) {
    var t = trim(text);
    for (var i = 0; i < CTX_DROP_PREFIXES.length; i++) {
      if (t.indexOf(CTX_DROP_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  /**
   * 把群聊那个「join 成一条」的巨型 system 字符串，按【标题】边界切回独立块。
   *
   * 群聊的块标题统一以「【」开头、以「】」结尾，且每个块内部极少再出现
   * 行首的「【」（偶有嵌套，例如【全局】正文里可能引用别的标题）。
   * 因此只在「【」出现在行首、且该行能以「】」收尾时才认作新块起点，
   * 宁可少切一刀（内容仍完整保留）也不要把正文腰斩。
   */
  function splitCtxBlocks(text) {
    var raw = String(text == null ? '' : text);
    if (!raw) return [];
    var parts = raw.split('\n\n');
    var blocks = [];
    var buf = '';
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg) continue;
      var isStart = /^\s*【[^】\n]{1,40}】/.test(seg);
      if (isStart && buf) {
        blocks.push(buf);
        buf = seg;
      } else if (isStart) {
        buf = seg;
      } else if (buf) {
        buf += '\n\n' + seg;
      } else {
        buf = seg;
      }
    }
    if (buf) blocks.push(buf);
    return blocks;
  }

  /**
   * 组装「对局需要的角色上下文」。
   * 复用群聊自己的 buildApiMessages 拿到人设/世界书/关系等系统块，
   * 再按白名单裁掉与狼人杀无关的部分，并把 ST 预设（前置换·后置换）拼进来。
   *
   * 关键修复（此前世界书恒显示 0 条）：
   * 旧代码给 buildApiMessages 传的 userText 是空字符串，而世界书的关键词
   * 扫描池正是「群历史 + userText」。扫描池为空 → 所有靠关键词触发的词条
   * 都被 ST 流水线判为 rejected → matched 为空 → 体检条报「世界书 0 条」。
   * 现在把当前局势摘要作为扫描文本传进去，关键词词条才能正常命中。
   */
  function buildWorldContext(store, chatId, scanHint) {
    var lines = [];
    var group = global.MiyaChatGroup;
    if (!group || typeof group.buildApiMessages !== 'function') {
      /* 早期返回也要留痕，否则体检条永远显示「开局后可见」，反而掩盖问题 */
      ctxStats = { systemBlocks: 0, chars: 0, stFront: 0, stBack: 0, groupSystem: 0,
        worldbook: 0, dropped: 0, members: 0, error: '群聊模块未就绪' };
      return '';
    }

    /* scanHint = 当前局势（含玩家名/身份/发言），喂给世界书做关键词扫描 */
    var scanText = trim(scanHint);
    var built = null;
    try {
      built = group.buildApiMessages(chatId, scanText, {});
    } catch (e) { built = null; }
    if (!built || !Array.isArray(built.messages) || !built.messages.length) {
      ctxStats = { systemBlocks: 0, chars: 0, stFront: 0, stBack: 0, groupSystem: 0,
        worldbook: 0, dropped: 0, members: 0, error: (built && built.error) || '该群暂无可用的角色上下文' };
      return '';
    }

    /* ST 预设：前置换放最前，后置换放最后 */
    var eng = global.miyaChatEngine;
    var stFront = [];
    var stBack = [];
    if (eng && typeof eng.buildStPresetMessages === 'function') {
      try { stFront = eng.buildStPresetMessages('front') || []; } catch (e) {}
      try { stBack = eng.buildStPresetMessages('back') || []; } catch (e) {}
    }

    var dropped = 0;
    var droppedChars = 0;

    function pushMsg(m) {
      if (!m || !m.content) return;
      var text = typeof m.content === 'string' ? m.content : '';
      if (!trim(text)) return;
      lines.push(trim(text));
    }

    /*
     * 群聊的 system 是一个「join 成一条」的巨型字符串，必须切开逐块过滤。
     * 不切的话 shouldDropCtxBlock 只能看开头一处，等于不过滤 —— 这正是
     * 上一版改完字数还是 152.5k 的原因。
     */
    function pushSystemBody(body) {
      var pieces = splitCtxBlocks(body);
      if (!pieces.length) return;
      for (var i = 0; i < pieces.length; i++) {
        var piece = trim(pieces[i]);
        if (!piece) continue;
        if (shouldDropCtxBlock(piece)) {
          dropped += 1;
          droppedChars += piece.length;
          continue;
        }
        lines.push(piece);
      }
    }

    var groupSystemCount = 0;
    (stFront || []).forEach(pushMsg);
    built.messages.forEach(function (m) {
      /* 只取 system：user/assistant 历史与狼人杀无关，避免把聊天记录带进对局 */
      if (!m || m.role !== 'system') return;
      groupSystemCount += 1;
      var body = typeof m.content === 'string' ? m.content : '';
      pushSystemBody(body);
    });
    (stBack || []).forEach(pushMsg);

    var text = lines.join('\n\n');
    var wbMeta = built.worldbookMeta || {};
    /*
     * 记一份诊断信息：体检弹窗里能直接看到「到底读进去了多少上下文」。
     * worldbookDetail 用于解释「为什么是 0 条」——以前只报数字，用户无法判断
     * 到底是没配词条、还是配了但没命中。
     */
    ctxStats = {
      systemBlocks: lines.length,
      chars: text.length,
      stFront: (stFront || []).length,
      stBack: (stBack || []).length,
      groupSystem: groupSystemCount,
      dropped: dropped,
      droppedChars: droppedChars,
      worldbook: (wbMeta.matchedSummary || []).length || 0,
      /* 世界书诊断：命中 / 被预算丢弃 / 扫描池长度 / 扫描文本样例 */
      wbMatched: (wbMeta.matchedSummary || []).slice(0, 20),
      wbDropped: ((wbMeta.budget && wbMeta.budget.dropped) || []).length || 0,
      wbBudget: (wbMeta.budget && wbMeta.budget.usedTokens) || 0,
      wbBudgetMax: (wbMeta.budget && wbMeta.budget.budgetTokens) || 0,
      wbUniversal: wbMeta.universalCount || 0,
      wbFront: wbMeta.frontCount || 0,
      wbMiddle: wbMeta.middleCount || 0,
      wbBack: wbMeta.backCount || 0,
      scanChars: scanText.length,
      /* 发言回顾占了多少字：这部分随对局推进而增长，不是静态开销 */
      speechChars: scanText.length ? (function () {
        var m = scanText.match(/本轮已有发言：\n([\s\S]*)$/);
        return m ? m[1].length : 0;
      })() : 0,
      members: (built.members || []).length,
      error: built.error || ''
    };
    return text;
  }

  function getCtxStats() { return ctxStats; }

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

    var welcome = '你正在参与一场群聊里的狼人杀游戏。'
      + '本局在你的世界观里真实发生了：你会用你一贯的语气和称呼方式参与讨论，'
      + '不会突然变成一个「只会打牌的陌生人」。'
      /* 「一贯的判断方式」会诱导模型按亲疏站边，这里换成「只认对局逻辑」 */
      + '但在这场游戏里你是认真想赢的：判断谁可疑只看发言和投票，不看私下关系。'
      + '不解释规则、不加旁白括号、不重复系统提示、不输出「某某说：」这类前缀。';

  /* 只有需要结构化结果的任务（投票/猎杀/查验/女巫）才允许出现 JSON。
     发言任务绝不能吐 JSON —— 提示词里必须说死，否则模型会把上一轮的格式惯性带过来。 */
  var JSON_RULE = '\n【格式要求·务必遵守】这一轮**只输出一个 JSON 对象**，不要有任何解释、寒暄、标点包裹或代码块标记。';
  var SAY_RULE = '\n【格式要求·务必遵守】这一轮**只输出角色说的话本身**：纯自然语言，'
    + '**绝对不要**输出 JSON、花括号、字段名（如 vote/reason）、引号包裹的键值对，也不要输出「某某说：」这类前缀。'
    + '想象你就是这个角色，正在群里打字发出这句话。';

  /**
   * 让某个 AI 完成一个任务
   * task: speech | vote | wolf_kill | seer_check | witch_action
   * 返回 Promise<{ text, reason, target, targetName, save, poison }>
   */
  function askAi(g, whoId, task, extra) {
    var selfSeat = seatOf(g, whoId);
    var selfName = selfSeat ? selfSeat.name : '你';

    /*
     * 世界上下文（人设/世界书/ST预设）—— 让 AI 不脱缰。
     * scanHint 传当前局势：世界书的关键词扫描池就是它，
     * 传空串会让所有关键词词条判为未命中、体检条恒显示 0 条。
     */
    var situation = buildSituation(g, { selfId: whoId });
    var worldCtx = buildWorldContext(global.miyaChatStore, g.chatId, situation);

    var head = [];
    head.push('【你在这场对局中的身份】');
    head.push('你在群里的名字是「' + selfName + '」。下面所有发言和判断，都要以「' + selfName + '」这个角色的身份、性格和说话方式来表达。');
    head.push('');
    /*
     * 纪律条款压在「人设」正后方：人设上下文里通常带着好感度/亲密度/
     * 关系设定，如果不紧跟一条「游戏内一律平等」的约束，模型就会把
     * 那些社交设定当成站边依据，表现得处处护着最亲近的那个人。
     */
    head.push('【对局纪律·最高优先级】');
    head.push('- 性格、语气、称呼照常，但这是一场要认真分出胜负的游戏，不是社交场合。');
    head.push('- 判定身份只依据：本轮发言的逻辑漏洞、前后矛盾、投票行为、身份声明。');
    head.push('- 你与任何人的好感度、亲密度、关系设定，都不得作为投票或站边的依据。');
    head.push('- 不因私交放过可疑者，也不因私交针对无辜者；所有人用同一套标准衡量。');
    head.push('- 投票理由必须指向具体发言或行为，禁止「相信他」「不想投他」这类空泛理由。');
    head.push('');

    var lead = situation;
    var others = aliveSeats(g).filter(function (s) { return s.whoId !== whoId; });

    if (task === 'speech') {
      lead += '\n\n现在轮到你发言。请用 2~3 句话说出你的判断：可以怀疑某个人、为自己辩解、或分析局势。'
        + '\n要求：保持你一贯的说话风格和语气，像平时在群里聊天一样自然，不要机械套话，不要输出旁白。'
        + SAY_RULE;
      /* 发言预算取「本局设置 → ST 预设最大回复长度 → 1500」的最大值。
         1500 是「模型先吐一段思维链再说话」的实测下限：再小会被思考吃光、
         正文断在半句。用户若在设置里调大了，这里跟着一起放大。 */
      var wasTruncated = false;
      var speechTokens = resolveMaxTokens(g, SPEECH_FLOOR);
      return callApi(head.join('\n') + worldCtx + '\n\n' + welcome, lead, speechTokens, function () {
        wasTruncated = true;
      }).then(function (res) {
        var text = cleanSpeech(extractText(res));
        return { text: text || '（沉默）', truncated: wasTruncated };
      });
    }

    if (task === 'vote') {
      lead += '\n\n现在进入投票阶段，你要投出你认为最像狼人的一个玩家（不能投自己）。'
        + '\n先回想每个人的发言：谁在带节奏、谁的逻辑站不住、谁在含糊其辞，然后据此下判断。'
        + '\n不许因为与该玩家关系好就改投别人；理由里必须写出他让你起疑的具体言行。'
        + '\n可选目标：' + others.map(function (s) { return s.name; }).join('、')
        + '\n只输出 JSON：{"vote":"玩家名字","reason":"简短理由"}'
        + JSON_RULE;
      return callApi(head.join('\n') + worldCtx + '\n\n' + welcome, lead, resolveMaxTokens(g, ACTION_FLOOR)).then(function (res) {
        return parseVote(extractText(res), others);
      });
    }

    if (task === 'wolf_kill') {
      var targets = aliveSeats(g).filter(function (s) { return g.roles[s.whoId] !== 'werewolf'; });
      lead += '\n\n现在是夜晚，你要和同伴一起选一个好人猎杀（不能猎杀狼人同伴）。'
        + '\n可选目标：' + targets.map(function (s) { return s.name; }).join('、')
        + '\n只输出 JSON：{"vote":"玩家名字","reason":"简短理由"}'
        + JSON_RULE;
      return callApi(head.join('\n') + worldCtx + '\n\n' + welcome, lead, resolveMaxTokens(g, ACTION_FLOOR)).then(function (res) {
        return parseVote(extractText(res), targets);
      });
    }

    if (task === 'seer_check') {
      lead += '\n\n你是预言家，今晚要查验一个人的身份（不能查验自己）。'
        + '\n可选目标：' + others.map(function (s) { return s.name; }).join('、')
        + '\n只输出 JSON：{"vote":"玩家名字","reason":"简短理由"}'
        + JSON_RULE;
      return callApi(head.join('\n') + worldCtx + '\n\n' + welcome, lead, resolveMaxTokens(g, ACTION_FLOOR)).then(function (res) {
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
      lead += '\n只输出 JSON：{"save":true或false,"poison":"玩家名字或空字符串","reason":"简短理由"}'
        + JSON_RULE;
      return callApi(head.join('\n') + worldCtx + '\n\n' + welcome, lead, resolveMaxTokens(g, ACTION_FLOOR)).then(function (res) {
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

  /**
   * 发言兜底清洗：模型偶尔会把「JSON 格式惯性」带到发言里，
   * 吐出 {"vote":"陆衍","reason":"..."} 这种。这里把它翻译回人话。
   */
  function cleanSpeech(text) {
    var t = trim(text);
    if (!t) return '';
    /* 去掉 markdown 代码块包裹 */
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    /* 只有「整段就是一个 JSON 对象」才走翻译；否则视为夹带碎片的正文 */
    var obj = (t.charAt(0) === '{' && t.charAt(t.length - 1) === '}') ? extractJson(t) : null;
    if (obj && typeof obj === 'object') {
      /* 整段就是一个 JSON：取可读字段拼成人话 */
      var said = trim(obj.say || obj.speech || obj.text || obj.content || '');
      var vote = trim(obj.vote || obj.target || '');
      var reason = trim(obj.reason || '');
      if (said) return said;
      if (vote || reason) {
        /* 收尾统一补句号，读起来才像人说的话 */
        if (reason && !/[。！？.!?]$/.test(reason)) reason += '。';
        if (vote && reason) return '我投' + vote + '。' + reason;
        if (vote) return '我投' + vote + '。';
        return reason;
      }
    }
    /* 只是前后粘了 JSON 碎片：先看能否翻译成一句人话，否则剥掉裸 JSON 留正文 */
    var frag = t.match(/\{[\s\S]*?\}/);
    if (frag) {
      var fo = extractJson(frag[0]);
      if (fo && typeof fo === 'object') {
        var fv = trim(fo.vote || fo.target || '');
        var fr = trim(fo.reason || '');
        var rest = trim(t.replace(/\{[\s\S]*?\}/g, ' ').replace(/\s+/g, ' '));
        if (fr && !/[。！？.!?]$/.test(fr)) fr += '。';
        if (rest) return rest;                 /* 正文优先 */
        if (fv) return '我投' + fv + '。' + fr;
        if (fr) return fr;
      }
    }
    return t;
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
  var state = { chatId: '', busy: false, busyText: '', ctxOpen: false, maxOpen: false };

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

  /**
   * 输出上限设置条：一句话说明当前生效值，点开可改。
   * 以前这里没有入口，弹窗却让用户「去设置里调大输出上限」——
   * 而狼人杀是裸调 API，压根不读那个设置，用户怎么找都找不到。
   */
  function maxTokensBarHtml(g) {
    var manual = g && Number(g.maxTokens);
    var hasManual = Number.isFinite(manual) && manual > 0;
    var globalVal = readGlobalMaxTokens();
    var val = hasManual ? Math.floor(manual) : (globalVal > 0 ? Math.max(SPEECH_FLOOR, globalVal) : 1500);
    var src = hasManual ? '本局自定义' : (globalVal > 0 ? '跟随设置' : '默认');
    var open = state.maxOpen;
    var html = '<button type="button" class="ww__ctx ww__ctx--opt' + (open ? ' is-open' : '') + '"'
      + ' data-ww-act="maxtoggle" aria-expanded="' + (open ? 'true' : 'false') + '">'
      + '<span class="ww__ctx-dot is-opt"></span>输出上限'
      + '<span class="ww__ctx-sub">' + val + ' token · ' + src + '</span>'
      + '<span class="ww__ctx-more">' + (open ? '收起 ›' : '调整 ›') + '</span></button>';
    if (!open) return html;
    return html
      + '<div class="ww-maxtok">'
      +   '<div class="ww-maxtok__row">'
      +     '<button type="button" class="ww__pick-btn" data-ww-act="maxset" data-ww-target="0">跟随设置</button>'
      +     '<button type="button" class="ww__pick-btn' + (hasManual && manual === 1500 ? ' is-selected' : '') + '" data-ww-act="maxset" data-ww-target="1500">1500</button>'
      +     '<button type="button" class="ww__pick-btn' + (hasManual && manual === 3000 ? ' is-selected' : '') + '" data-ww-act="maxset" data-ww-target="3000">3000</button>'
      +     '<button type="button" class="ww__pick-btn' + (hasManual && manual === 6000 ? ' is-selected' : '') + '" data-ww-act="maxset" data-ww-target="6000">6000</button>'
      +   '</div>'
      +   '<div class="ww-maxtok__row">'
      +     '<input class="ww-maxtok__input" type="number" min="200" max="32000" step="100"'
      +       ' value="' + val + '" aria-label="自定义输出上限">'
      +     '<button type="button" class="ww__btn ww__btn--main ww-maxtok__save" data-ww-act="maxsave">保存</button>'
      +   '</div>'
      +   '<div class="ww-maxtok__hint">发言任务用这个上限；投票/查验/毒杀这类短 JSON 任务最多用一半。'
      +     '填 0 或点「跟随设置」即回到设置里的「最大回复长度」。</div>'
      + '</div>';
  }

  /**
   * 上下文体检条：一行可点，点开看完整详情。
   * 原来这行直接铺在顶部，窄屏会被裁掉看不见 —— 现在收成按钮 + 弹窗。
   */
  function ctxBarHtml() {
    var st = getCtxStats();
    if (!st) {
      return '<button type="button" class="ww__ctx ww__ctx--idle" data-ww-act="ctx">'
        + '<span class="ww__ctx-dot"></span>上下文'
        + '<span class="ww__ctx-sub">发言后可见</span>'
        + '<span class="ww__ctx-more">详情 ›</span></button>';
    }
    if (st.error) {
      return '<button type="button" class="ww__ctx ww__ctx--bad" data-ww-act="ctx">'
        + '<span class="ww__ctx-dot"></span>上下文未读到'
        + '<span class="ww__ctx-sub">' + esc(st.error) + '</span>'
        + '<span class="ww__ctx-more">详情 ›</span></button>';
    }
    var size = st.chars >= 1000 ? (st.chars / 1000).toFixed(1) + 'k' : st.chars;
    return '<button type="button" class="ww__ctx" data-ww-act="ctx">'
      + '<span class="ww__ctx-dot is-ok"></span>上下文已载入'
      + '<span class="ww__ctx-sub">' + st.systemBlocks + ' 段 · ' + size + ' 字 · 世界书 ' + st.worldbook + ' 条'
      + ((st.dropped || 0) > 0 ? ' · 已精简 ' + st.dropped + ' 块' : '') + '</span>'
      + '<span class="ww__ctx-more">详情 ›</span></button>';
  }

  /** 上下文详情弹窗：把「角色到底读到了什么」摊开给用户看 */
  function ctxModalHtml() {
    var st = getCtxStats();
    var eng = global.miyaChatEngine;
    var rows = [];
    var stFront = 0, stBack = 0;
    if (eng && typeof eng.buildStPresetMessages === 'function') {
      try { stFront = (eng.buildStPresetMessages('front') || []).length; } catch (e) {}
      try { stBack = (eng.buildStPresetMessages('back') || []).length; } catch (e) {}
    }

    function row(k, v, warn) {
      rows.push('<div class="ww-ctx-row' + (warn ? ' is-warn' : '') + '">'
        + '<span class="ww-ctx-k">' + esc(k) + '</span>'
        + '<span class="ww-ctx-v">' + esc(String(v)) + '</span></div>');
    }

    var body = '';
    if (!st) {
      body = '<div class="ww-ctx-empty">还没有加载过上下文。<br>点「让下一位发言」后，这里会显示角色实际读到的设定。</div>';
    } else if (st.error) {
      row('状态', '读取异常', true);
      row('错误', st.error, true);
      body = '<div class="ww-ctx-list">' + rows.join('') + '</div>'
        + '<div class="ww-ctx-tip">请检查该群的角色卡、世界书与 API 配置是否正常。</div>';
    } else {
      row('提示词段数', st.systemBlocks + ' 段');
      row('总字数', st.chars >= 1000 ? (st.chars / 1000).toFixed(1) + 'k 字' : st.chars + ' 字');
      row('ST 预设', '前置 ' + stFront + ' 条 / 后置 ' + stBack + ' 条');
      row('群聊 system 块', st.groupSystem + ' 条');
      row('已精简', (st.dropped || 0) + ' 块'
        + ((st.droppedChars || 0) > 0 ? ' · 约 ' + Math.round(st.droppedChars / 1000) + 'k 字' : '')
        + '（昵称/头衔/关系/记忆/地点等与对局无关）');
      row('命中的世界书', st.worldbook + ' 条');
      row('群成员', st.members + ' 人');

      /* 世界书诊断：解释「为什么是这个条数」，而不是只甩一个数字 */
      var wbRows = [];
      if (st.worldbook > 0) {
        (st.wbMatched || []).forEach(function (e) {
          wbRows.push('<div class="ww-ctx-wb"><span class="ww-ctx-wb__name">'
            + esc(e.name || '未命名片段')
            + '</span><span class="ww-ctx-wb__meta">'
            + esc((e.scope === 'local' ? '局部' : '全局') + ' · ' + (e.depth || 'middle') + ' · ' + (e.charCount || 0) + ' 字')
            + '</span></div>');
        });
      }
      var wbTotal = (st.wbFront || 0) + (st.wbMiddle || 0) + (st.wbBack || 0);
      var wbDiag = '<div class="ww-ctx-wbmeta">'
        + '分桶：前 ' + (st.wbFront || 0) + ' · 中 ' + (st.wbMiddle || 0) + ' · 后 ' + (st.wbBack || 0)
        + '（合计 ' + wbTotal + '）<br>'
        + '全软件词条 ' + (st.wbUniversal || 0) + ' 条 · 预算 '
        + (st.wbBudget || 0) + '/' + (st.wbBudgetMax || '∞') + ' token'
        + ((st.wbDropped || 0) > 0 ? ' · 超预算丢弃 ' + st.wbDropped + ' 条' : '')
        + '<br>扫描文本 ' + (st.scanChars || 0) + ' 字</div>';

      /* 字数会随对局推进增长：发言回顾（最近 8 条）是唯一的动态项，
         把它单独标出来，避免误以为有个固定的巨大开销。 */
      var speechChars = st.speechChars || 0;
      var growDiag = '';
      if (speechChars > 0) {
        growDiag = '<div class="ww-ctx-wbmeta">'
          + '字数会随对局增长：其中<b>发言回顾约 ' + speechChars + ' 字</b>'
          + '（最近 8 条发言，每条约 1200 字上限）。<br>'
          + '这部分每轮都在变，不是静态开销；人设、世界书与预设是相对固定的部分。'
          + '</div>';
      }

      var wbTip;
      if (st.worldbook > 0) {
        wbTip = '✅ 世界书已命中并注入提示词。';
      } else if ((st.wbUniversal || 0) > 0) {
        wbTip = 'ℹ️ 没有关键词词条命中，但有 ' + st.wbUniversal + ' 条「全软件」词条已注入。'
          + '关键词词条需要在「世界书」里配置触发词，且触发词要出现在本局局势中。';
      } else {
        wbTip = '⚠️ 世界书 0 条：本群没有绑定世界书，或所有词条都没配触发词/未命中。'
          + '到「世界书」App 给词条加上触发词即可。';
      }

      var health = st.systemBlocks >= 2 && st.chars > 200;
      body = '<div class="ww-ctx-list">' + rows.join('') + '</div>'
        + (wbRows.length ? '<div class="ww-ctx-wblist">' + wbRows.join('') + '</div>' : '')
        + wbDiag + growDiag + '<div class="ww-ctx-tip">' + wbTip + '</div>'
        + '<div class="ww-ctx-tip">'
        + (health
          ? '✅ 角色发言时会带上以上设定，说话风格贴近你在群里的那个角色。'
          : '⚠️ 读到的内容偏少，AI 可能「不像本人」。建议给该群补上角色卡或世界书。')
        + '</div>';
    }

    return '<div class="ww-ctx-modal" data-ww-act="ctx-close">'
      + '<div class="ww-ctx-card">'
      + '<div class="ww-ctx-title">📋 上下文体检</div>'
      + body
      + '<button type="button" class="ww__btn ww__btn--main ww-ctx-ok" data-ww-act="ctx-close">知道了</button>'
      + '</div></div>';
  }

  function renderPanel(store, chatId) {
    var g = load(store, chatId);
    var head =
      '<div class="ww__head">' +
        '<div class="ww__title">🐺 狼人杀</div>' +
        '<button type="button" class="ww__close" data-sheet-close aria-label="关闭">关闭</button>' +
      '</div>';

    /* 顶部两条状态栏：输出上限（可调）+ 上下文体检（可点开） */
    var ctxTip = maxTokensBarHtml(g) + ctxBarHtml();

    var html = '';
    var modal = state.ctxOpen ? ctxModalHtml() : '';

    if (g.status === 'idle') {
      var cands = collectCandidates(store, chatId);
      var enough = cands.length >= TOTAL_SEATS;
      return '<div class="ww" id="ww-panel">' + head + ctxTip +
        '<div class="ww__scroll">' +
          '<div class="ww__intro">' +
            '<p class="ww__intro-lead">' + TOTAL_SEATS + ' 人局 · 2 狼人 / 2 村民 / 1 预言家 / 1 女巫</p>' +
            '<p class="ww__intro-desc">你与群里 ' + Math.max(0, cands.length - 1) + ' 位角色同桌。' +
              '身份随机分配，AI 会真实推理发言。<br>本局记录不会出现在群聊里。</p>' +
            (enough ? '' : '<p class="ww__intro-warn">⚠️ 群成员不足 ' + TOTAL_SEATS + ' 人（当前 ' + cands.length + ' 人），请先拉人进群</p>') +
          '</div>' +
          '<div class="ww__actions">' +
            '<button type="button" class="ww__btn ww__btn--main" data-ww-act="start"' + (enough ? '' : ' disabled') + '>开始游戏</button>' +
          '</div>' +
        '</div>' +
        (g.log && g.log.length ? '<div class="ww__log">' + g.log.slice(-4).map(function (l) {
          return '<div class="ww__log-item">' + esc(l.text) + '</div>';
        }).join('') + '</div>' : '') +
      '</div>' + modal;
    }

    if (g.status === 'over') {
      var winText = g.winner === 'wolf' ? '🐺 狼人阵营胜利' : '🛡️ 好人阵营胜利';
      var allRoles = g.seats.map(function (s) {
        var r = roleOf(g.roles[s.whoId]);
        return '<div class="ww-result-row"><span>' + esc(s.whoId === USER_OWNER_ID ? '你' : s.name) + '</span>'
          + '<span>' + r.icon + r.name + '</span>'
          + '<span>' + (s.alive ? '存活' : '出局') + '</span></div>';
      }).join('');
      return '<div class="ww" id="ww-panel">' + head + ctxTip +
        '<div class="ww__scroll">' +
          '<div class="ww__over">' +
            '<div class="ww__over-title">' + winText + '</div>' +
            '<div class="ww__result-list">' + allRoles + '</div>' +
          '</div>' +
          '<div class="ww__actions">' +
            '<button type="button" class="ww__btn ww__btn--main" data-ww-act="start">再来一局</button>' +
            '<button type="button" class="ww__btn" data-ww-act="reset">清空记录</button>' +
          '</div>' +
        '</div>' +
      '</div>' + modal;
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
        var isMine = sp.whoId === USER_OWNER_ID;
        return '<div class="ww-say' + (isMine ? ' is-mine' : '') + '">' +
          '<span class="ww-say-name">' + esc(isMine ? '你' : sp.name) + '</span>' +
          '<span class="ww-say-text">' + esc(sp.text) + '</span>' +
          (sp.truncated ? '<span class="ww-say-cut">⚠️ 输出被截断</span>' : '') +
          '</div>';
      }).join('');

      /*
       * 轮到谁了：nextSpeaker 现在会把玩家座位一起返回。
       * 轮到玩家 → 渲染输入框；轮到 AI → 渲染「让下一位发言」按钮。
       */
      var nxtSeat = nextSpeaker(g);
      var myTurn = !!(nxtSeat && nxtSeat.isUser);
      var allDone = !nxtSeat;

      var turnHtml = '';
      if (myTurn && !state.busy) {
        turnHtml = '<div class="ww__myturn">'
          + '<div class="ww__myturn-title">🎤 轮到你发言了</div>'
          + '<textarea class="ww__input" data-ww-input="speech" rows="3" maxlength="600"'
          +   ' placeholder="说出你的判断：可以怀疑某个人、为自己辩解，或分析局势…"></textarea>'
          + '<div class="ww__actions">'
          +   '<button type="button" class="ww__btn ww__btn--main" data-ww-act="user_speak">发送发言</button>'
          +   '<button type="button" class="ww__btn" data-ww-act="skip_speak">这轮跳过</button>'
          + '</div>'
          + '</div>';
      }

      var nextLabel = state.busy
        ? esc(state.busyText || '思考中…')
        : (allDone ? '所有人都发言完了' : (nxtSeat ? '让「' + nxtSeat.seat.name + '」发言' : '让下一位发言'));

      stageHtml = '<div class="ww__stage">' +
        '<div class="ww__stage-title">💬 白天讨论</div>' +
        '<div class="ww__speeches">' + (spoken || '<div class="ww__hint">还没有人发言</div>') + '</div>' +
        turnHtml +
        '<div class="ww__actions">' +
          (myTurn ? '' : '<button type="button" class="ww__btn ww__btn--main" data-ww-act="next_speech"'
            + (state.busy || allDone ? ' disabled' : '') + '>' + nextLabel + '</button>') +
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

    return '<div class="ww" id="ww-panel">' + head + ctxTip +
      '<div class="ww__scroll">' +
        myRoleBar + phaseHtml +
        '<div class="ww__seats">' + seatsHtml + '</div>' +
        stageHtml +
      '</div>' +
      (logTail ? '<div class="ww__log">' + logTail + '</div>' : '') +
      '</div>' + modal;
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

    if (act === 'ctx') {
      state.ctxOpen = true;
      rerender();
      return true;
    }

    /* ---- 输出上限设置 ---- */
    if (act === 'maxtoggle') {
      state.maxOpen = !state.maxOpen;
      rerender();
      return true;
    }

    if (act === 'maxset') {
      var pick = Math.floor(num(target));
      g.maxTokens = pick > 0 ? pick : 0;
      pushLog(g, pick > 0 ? '输出上限设为 ' + pick + ' token' : '输出上限改为跟随设置');
      save(store, chatId, g);
      rerender();
      if (toast) toast(pick > 0 ? '输出上限已设为 ' + pick : '输出上限已改为跟随设置');
      return true;
    }

    if (act === 'maxsave') {
      var input = el.closest ? el.closest('.ww-maxtok') : null;
      var box = input ? input.querySelector('.ww-maxtok__input') : btn;
      var raw = box ? trim(box.value) : '';
      var typed = Math.floor(num(raw));
      /* 低于 200 一律按「跟随设置」处理，避免手滑填 1 把发言掐死 */
      g.maxTokens = typed >= 200 ? Math.min(32000, typed) : 0;
      pushLog(g, g.maxTokens ? '输出上限设为 ' + g.maxTokens + ' token' : '输出上限改为跟随设置');
      save(store, chatId, g);
      rerender();
      if (toast) {
        if (!g.maxTokens && raw && typed < 200) toast('数值太小，已改为跟随设置（下限 200）');
        else toast(g.maxTokens ? '输出上限已保存' : '输出上限已改为跟随设置');
      }
      return true;
    }

    if (act === 'ctx-close') {
      /* 点卡片内部不关闭，只有点遮罩或「知道了」按钮才关 */
      var inCard = el.closest && el.closest('.ww-ctx-card');
      var isOkBtn = el.closest && el.closest('.ww-ctx-ok');
      if (inCard && !isOkBtn) return true;
      state.ctxOpen = false;
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
      /* 轮到玩家时不该走这条分支：那是输入框的活儿 */
      if (nxt.isUser) { rerender(); return true; }
      state.busy = true;
      state.busyText = nxt.seat.name + ' 正在思考…';
      rerender();
      askAi(g, nxt.seat.whoId, 'speech').then(function (out) {
        var fresh2 = load(store, chatId);
        recordSpeech(fresh2, nxt.seat.whoId, out.text, out.truncated);
        /* 游标推进到该座位之后 */
        advanceSpeechCursor(fresh2, nxt.seat.whoId);
        state.busy = false;
        save(store, chatId, fresh2).then(function () {
          rerender();
          /* 截断时顺手把输出上限面板展开，让用户一眼看到该调哪个开关 */
          if (out.truncated) {
            state.maxOpen = true;
            rerender();
            if (toast) toast('这条发言被模型截断了，点顶部「输出上限」调大');
          }
        });
      }).catch(function (err) {
        state.busy = false;
        fail('AI 发言失败：' + ((err && err.message) || '未知错误'));
        rerender();
      });
      return true;
    }

    /* ---- 玩家发言 ---- */
    if (act === 'user_speak') {
      var box = panel ? panel.querySelector('[data-ww-input="speech"]') : null;
      var say = box ? trim(box.value) : '';
      if (!say) {
        if (toast) toast('先写点什么再发送吧');
        if (box && box.focus) box.focus();
        return true;
      }
      var mine = nextSpeaker(g);
      if (!mine || !mine.isUser) { rerender(); return true; }
      recordSpeech(g, USER_OWNER_ID, say, false);
      pushLog(g, '你完成了发言');
      advanceSpeechCursor(g, USER_OWNER_ID);
      save(store, chatId, g);
      rerender();
      return true;
    }

    /* 玩家跳过本轮发言：直接推进游标，不写入 speeches */
    if (act === 'skip_speak') {
      var cur = nextSpeaker(g);
      if (!cur || !cur.isUser) { rerender(); return true; }
      recordSpeech(g, USER_OWNER_ID, '（这轮我先不发言，听你们说。）', false);
      pushLog(g, '你选择了本轮跳过发言');
      advanceSpeechCursor(g, USER_OWNER_ID);
      save(store, chatId, g);
      rerender();
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
    handlePanelClick: handlePanelClick,
    buildWorldContext: buildWorldContext,
    getCtxStats: getCtxStats,
    cleanSpeech: cleanSpeech
  };
})(window);
