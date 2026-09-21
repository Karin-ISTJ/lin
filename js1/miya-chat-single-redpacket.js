/**
 * Miya 单聊 · 红包（普通 / 拼手气 / 专属）
 *
 * 与群红包（MiyaChatGroupRedPacket）并列的独立模块：
 *   · 消息类型 type = 'red_packet'（群聊是 'group_red_packet'）
 *   · 载荷字段 m.singleRedPacket（注意：m.redPacket 已被「转账」占用，禁止复用）
 *   · 单聊目标恒为「对话双方」，因此无需群成员列表
 *
 * 钱包记账：发送预扣托管 → 领取入账 → 未领完 / 过期退回。
 * 所有金额运算以「分」为单位做整数计算，避免浮点误差。
 */
(function (global) {
    'use strict';

    var USER_OWNER_ID = '__user__';
    /** 角色发红包后，留多少秒给用户先抢，之后用户自动领取 */
    var USER_GRACE_MS = 4000;
    /** 红包有效期：24 小时 */
    var EXPIRE_MS = 24 * 60 * 60 * 1000;
    /** 单聊红包输出协议：红包-金额｜祝福语  或  红包-金额-份数-祝福语 */
    var RE_PARSE = /^红包[-－—]([\d.]+)(?:[-－—](\d+))?[-－—]?(.+)$/;

    function trim(s) {
        return String(s || '').trim();
    }

    function toCents(n) {
        return Math.round((Number(n) || 0) * 100);
    }

    function fromCents(c) {
        return Math.round(Number(c) || 0) / 100;
    }

    function roundMoney(n) {
        return fromCents(toCents(n));
    }

    function formatMoney(n) {
        var v = roundMoney(n);
        var s = v.toFixed(2);
        if (s.slice(-3) === '.00') return s.slice(0, -3);
        if (s.charAt(s.length - 1) === '0') return s.slice(0, -1);
        return s;
    }

    function uid(prefix) {
        return (
            (prefix || 'srp') +
            '_' +
            Date.now().toString(36) +
            '_' +
            Math.random().toString(36).slice(2, 8)
        );
    }

    function shuffle(arr) {
        var a = (arr || []).slice();
        for (var i = a.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = a[i];
            a[i] = a[j];
            a[j] = t;
        }
        return a;
    }

    /* ── 金额拆分（分为单位整数运算，保证总和精确等于总额） ── */

    /** 拼手气：每份至少 1 分，其余随机，末份补齐差额 */
    function splitLuckyAmounts(total, count) {
        var totalC = toCents(total);
        var c = Math.max(1, Math.floor(Number(count) || 1));
        var minC = 1;
        if (totalC < minC * c) return null;
        var cents = [];
        var remainC = totalC;
        var remainCnt = c;
        var i;
        for (i = 0; i < c - 1; i++) {
            /* 留够后面每份 1 分后的可分配上限 */
            var maxC = remainC - minC * (remainCnt - 1);
            var span = maxC - minC;
            var pick = minC + (span > 0 ? Math.floor(Math.random() * (span + 1)) : 0);
            if (pick < minC) pick = minC;
            if (pick > maxC) pick = maxC;
            cents.push(pick);
            remainC -= pick;
            remainCnt--;
        }
        cents.push(remainC);
        return shuffle(cents).map(fromCents);
    }

    /** 普通 / 专属：均分，余数补给最后一份 */
    function splitEqualAmounts(total, count) {
        var totalC = toCents(total);
        var c = Math.max(1, Math.floor(Number(count) || 1));
        if (totalC < c) return null;
        var base = Math.floor(totalC / c);
        var cents = [];
        var used = 0;
        var i;
        for (i = 0; i < c - 1; i++) {
            cents.push(base);
            used += base;
        }
        cents.push(totalC - used);
        return cents.map(fromCents);
    }

    function splitByMode(mode, total, count) {
        return mode === 'lucky' ? splitLuckyAmounts(total, count) : splitEqualAmounts(total, count);
    }

    /* ── 祝福语清洗 ── */

    function cleanNote(note) {
        var n = trim(note);
        if (!n) return '恭喜发财，大吉大利';
        /* 去掉模型可能续写的进度尾巴 */
        var cut = n.split(/[-－—|｜](?:发起人|进度|已领|待领|状态|手气王|最少|专属|金额|份数)/)[0];
        n = trim(cut || n);
        var quoted = n.match(/^「([^」]*)」$/);
        if (quoted) n = trim(quoted[1]);
        n = n.replace(/^「+|」+$/g, '').trim();
        return n || '恭喜发财，大吉大利';
    }

    /** 从行尾提取祝福语：支持「…」包裹，也支持 | 或 - 分隔 */
    function extractNoteFromTail(tail) {
        var t = trim(tail);
        if (!t) return '恭喜发财，大吉大利';
        var quoted = t.match(/^「([^」]*)」/);
        if (quoted) return cleanNote(quoted[1]);
        var seg = t.split(/[|｜]/).pop();
        return cleanNote(seg || t);
    }

    /* ── 规范化 ── */

    function isSingleRedPacket(value) {
        if (!value || typeof value !== 'object') return false;
        if (!Array.isArray(value.shares)) return false;
        if (!Number.isFinite(Number(value.totalAmount))) return false;
        return true;
    }

    function normalizeShare(raw) {
        if (!raw || typeof raw !== 'object') return null;
        return {
            amount: roundMoney(raw.amount),
            claimedBy: trim(raw.claimedBy),
            claimedAt: Number(raw.claimedAt) || 0,
            claimId: trim(raw.claimId)
        };
    }

    function normalizeSingleRedPacket(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var modeRaw = trim(raw.mode);
        var mode = modeRaw === 'lucky' || modeRaw === 'exclusive' ? modeRaw : 'normal';
        var count = Math.max(1, Math.floor(Number(raw.count) || 1));
        var shares = Array.isArray(raw.shares)
            ? raw.shares.map(normalizeShare).filter(Boolean)
            : [];
        if (!shares.length) {
            var fallback = splitByMode(mode, raw.totalAmount, count);
            if (fallback) {
                shares = fallback.map(function (amt) {
                    return { amount: amt, claimedBy: '', claimedAt: 0, claimId: '' };
                });
            }
        }
        var st = trim(raw.status);
        if (st !== 'done' && st !== 'expired') st = 'active';
        /* 过期时间：优先取显式 expireAt；否则以 createdAt 为基准往后推一个有效期。
         * 注意这里必须 "createdAt + EXPIRE_MS"，不能直接拿 createdAt 当过期时间——
         * 否则任何只带 createdAt 的载荷（旧数据、导入数据、对方同步过来的红包）
         * 会被判定为「下发即过期」，点开就显示已过期。 */
        var createdMs = Number(raw.createdAt) || Date.now();
        var expireMs = Number(raw.expireAt) || (createdMs + EXPIRE_MS);
        return {
            id: trim(raw.id) || uid('srp'),
            mode: mode,
            totalAmount: roundMoney(raw.totalAmount),
            count: shares.length || count,
            note: cleanNote(raw.note),
            fromRole: trim(raw.fromRole) === 'role' ? 'role' : 'user',
            senderName: trim(raw.senderName),
            targetName: trim(raw.targetName),
            shares: shares,
            status: st,
            createdAt: createdMs,
            expireAt: expireMs,
            walletHeld: !!raw.walletHeld,
            walletSettled: !!raw.walletSettled,
            doneAt: Number(raw.doneAt) || 0
        };
    }

    /* ── 领取状态查询 ── */

    function claimedNames(pkt) {
        var set = {};
        (pkt && pkt.shares ? pkt.shares : []).forEach(function (s) {
            if (s && s.claimedBy) set[s.claimedBy] = true;
        });
        return set;
    }

    function claimedCount(pkt) {
        if (!pkt || !pkt.shares) return 0;
        return pkt.shares.filter(function (s) {
            return s && s.claimedBy;
        }).length;
    }

    function claimedSum(pkt) {
        var sum = 0;
        (pkt && pkt.shares ? pkt.shares : []).forEach(function (s) {
            if (s && s.claimedBy) sum = roundMoney(sum + (s.amount || 0));
        });
        return sum;
    }

    function remainingSlots(pkt) {
        if (!pkt) return 0;
        return Math.max(0, pkt.count - claimedCount(pkt));
    }

    function isExpired(pkt) {
        if (!pkt) return false;
        if (pkt.status === 'expired') return true;
        return pkt.expireAt > 0 && Date.now() > pkt.expireAt && pkt.status !== 'done';
    }

    /** 谁能领：普通/拼手气双方都能领；专属只有 targetName 能领；发送方本人不能领 */
    function canClaim(pkt, claimantName, ctx) {
        if (!pkt || pkt.status !== 'active') return false;
        if (isExpired(pkt)) return false;
        if (remainingSlots(pkt) <= 0) return false;
        var who = trim(claimantName);
        if (!who) return false;
        if (claimedNames(pkt)[who]) return false;
        /* 发送方本人不能领自己发的红包（红包是「发给对方」的）。
           注意：单聊的发送方可能是用户、也可能是角色，两边都要挡住，
           否则会出现「自己发自己领 → 红包立刻 done → 卡面褪色」的怪象。 */
        if (isSenderName(pkt, who, ctx)) return false;
        /* 专属：targetName 为空表示「目标即对话对方」，由调用方在 ctx 层面判定；
           此处仅在显式指定了目标名且不匹配时拒绝 */
        if (pkt.mode === 'exclusive' && pkt.targetName && pkt.targetName !== who) return false;
        return true;
    }

    /**
     * 判断 claimantName 是否就是这笔红包的发送方本人。
     *  - fromRole === 'user'：发送方是「当前用户面具」
     *  - fromRole === 'role'：发送方是该联系人（单聊里只有双方两人）
     * 兜底还会比对 senderName，以覆盖导入 / 同步过来的老载荷。
     */
    function isSenderName(pkt, who, ctx) {
        var name = trim(who);
        if (!pkt || !name) return false;
        var sender = '';
        if (pkt.fromRole === 'user') {
            sender = trim(ctx && ctx.profile && ctx.profile.name) || '我';
        } else {
            sender = trim(pkt.senderName) || trim(ctx && ctx.contact && ctx.contact.name);
        }
        if (sender && sender === name) return true;
        /* 兜底：senderName 显式记录时，同名也视为发送方本人 */
        var sn = trim(pkt.senderName);
        return !!sn && sn === name;
    }

    /**
     * 单聊的「可领人」只有双方两人。专属红包的目标恒为「发送方的对方」：
     *  - 角色发 → 用户可领
     *  - 用户发 → 角色可领
     * 若未显式记录 targetName，则按上述规则推断。
     */
    function exclusiveTargetName(pkt, ctx) {
        if (!pkt) return '';
        if (pkt.targetName) return pkt.targetName;
        var profileName = trim(ctx && ctx.profile && ctx.profile.name) || '用户';
        var contactName = trim(ctx && ctx.contact && ctx.contact.name) || '对方';
        return pkt.fromRole === 'role' ? profileName : contactName;
    }

    /**
     * 返回该红包理论上还能领的人名列表（用于判断是否已无人可领 → 应结算）。
     */
    function eligibleNames(pkt, ctx) {
        if (!pkt) return [];
        var profileName = trim(ctx && ctx.profile && ctx.profile.name) || '用户';
        var contactName = trim(ctx && ctx.contact && ctx.contact.name) || '对方';
        if (pkt.mode === 'exclusive') {
            var t = exclusiveTargetName(pkt, ctx);
            return t ? [t] : [];
        }
        var names = [profileName];
        if (contactName && contactName !== profileName) names.push(contactName);
        return names;
    }

    /** 是否已无人可领（可安全结算：剩余退回发送方） */
    function noOneLeftToClaim(pkt, ctx) {
        if (!pkt) return true;
        var claimed = claimedNames(pkt);
        return !eligibleNames(pkt, ctx).some(function (n) {
            return !claimed[n];
        });
    }

    /** 当前用户（USER_OWNER_ID 视角）能否领：专属需与推断目标一致 */
    function canUserClaim(pkt, ctx) {
        var profileName = trim(ctx && ctx.profile && ctx.profile.name) || '用户';
        if (!canClaimTo(pkt, profileName, ctx)) return false;
        return true;
    }

    /** ctx 感知的领取资格判定：能正确处理「专属目标未显式记录」的情况 */
    function canClaimTo(pkt, claimantName, ctx) {
        if (!canClaim(pkt, claimantName, ctx)) return false;
        var who = trim(claimantName);
        if (pkt.mode === 'exclusive') {
            var target = exclusiveTargetName(pkt, ctx);
            if (target && target !== who) return false;
        }
        return true;
    }

    /* ── 钱包结算 ── */

    function st() {
        return global.miyaChatStore || null;
    }

    function contactIdOf(ctx) {
        return ctx && ctx.contact && ctx.contact.id ? String(ctx.contact.id) : '';
    }

    function profileIdOf(ctx) {
        return ctx && ctx.profile && ctx.profile.id ? String(ctx.profile.id) : '';
    }

    function refreshWalletUi() {
        if (global.miyaChatApp && typeof global.miyaChatApp.refreshProfileUI === 'function') {
            global.miyaChatApp.refreshProfileUI();
        }
    }

    /**
     * 发送方预扣托管。
     * - 用户发：从当前面具扣
     * - 角色发：从该联系人钱包扣
     * 返回 Promise<boolean>，true 表示已托管（后续才有退回逻辑）。
     */
    function holdOutgoing(pkt, ctx) {
        var wallet = global.MiyaChatWallet;
        var amt = roundMoney(pkt && pkt.totalAmount);
        if (!(amt > 0)) return Promise.resolve(false);
        if (!wallet) return Promise.resolve(false);
        if (pkt.fromRole === 'role') {
            if (typeof wallet.holdRoleOutgoingTransfer !== 'function') return Promise.resolve(false);
            return wallet
                .holdRoleOutgoingTransfer(contactIdOf(ctx), amt)
                .then(function () {
                    return true;
                })
                .catch(function () {
                    return false;
                });
        }
        if (typeof wallet.holdUserOutgoingTransfer !== 'function') return Promise.resolve(false);
        return wallet
            .holdUserOutgoingTransfer(profileIdOf(ctx), amt)
            .then(function () {
                return true;
            })
            .catch(function () {
                return false;
            });
    }

    /**
     * 领取入账。
     * - 用户领：入账当前面具
     * - 角色领：入账联系人钱包
     */
    function creditClaimWallet(pkt, share, ctx) {
        var store = st();
        var amt = roundMoney(share && share.amount);
        if (!store || !(amt > 0)) return Promise.resolve(false);
        var who = trim(share && share.claimedBy);
        /* 领取人是否为「当前用户面具」：是则入账面具，否则入账联系人 */
        var isUser = isUserClaimant(who, ctx);
        var chain;
        if (isUser) {
            var pid = profileIdOf(ctx);
            if (!pid || typeof store.adjustWalletBalance !== 'function') return Promise.resolve(false);
            chain = store.adjustWalletBalance(pid, amt);
        } else {
            var cid = contactIdOf(ctx);
            if (!cid || typeof store.adjustContactWalletBalance !== 'function') return Promise.resolve(false);
            chain = store.adjustContactWalletBalance(cid, amt);
        }
        return chain
            .then(function () {
                refreshWalletUi();
                return true;
            })
            .catch(function () {
                return false;
            });
    }

    /** 判断某领取人是不是「当前用户面具」 */
    function isUserClaimant(name, ctx) {
        var who = trim(name);
        if (!who) return false;
        var pn = trim(ctx && ctx.profile && ctx.profile.name) || '用户';
        return who === pn || who === '用户' || who === '我';
    }

    /**
     * 剩余金额退回发送方。
     * 仅在 walletHeld 且未 settled 时执行，保证「不重复退」。
     */
    function refundSenderWallet(pkt, amountCents, ctx) {
        var store = st();
        var amt = fromCents(amountCents);
        if (!store || !(amt > 0)) return Promise.resolve(false);
        if (!pkt || !pkt.walletHeld || pkt.walletSettled) return Promise.resolve(false);
        var chain;
        if (pkt.fromRole === 'role') {
            var cid = contactIdOf(ctx);
            if (!cid || typeof store.adjustContactWalletBalance !== 'function') return Promise.resolve(false);
            chain = store.adjustContactWalletBalance(cid, amt);
        } else {
            var pid = profileIdOf(ctx);
            if (!pid || typeof store.adjustWalletBalance !== 'function') return Promise.resolve(false);
            chain = store.adjustWalletBalance(pid, amt);
        }
        return chain
            .then(function () {
                refreshWalletUi();
                return true;
            })
            .catch(function () {
                return false;
            });
    }

    /** 结算入口：把未领完的部分退回发送方，并置 walletSettled 防重复
     *
     * normalizeSingleRedPacket 会返回「新对象」，若只标记新对象，
     * 调用方手里的原对象仍是 walletSettled=false，同一载荷再次传入就会重复退回。
     * 因此这里同时把标记写回原对象（src），保证幂等。
     */
    function settleRemainder(pkt, ctx) {
        var src = pkt; /* 保留原始引用，用于同步幂等标记 */
        pkt = normalizeSingleRedPacket(pkt);
        if (!pkt) return Promise.resolve(null);
        if (!pkt.walletHeld || pkt.walletSettled) return Promise.resolve(pkt);
        /* 原对象已结算过：同步结果后直接返回，不再重复退回 */
        if (src && typeof src === 'object' && src.walletSettled) {
            pkt.walletSettled = true;
            return Promise.resolve(pkt);
        }
        var refundC = toCents(pkt.totalAmount) - toCents(claimedSum(pkt));
        var chain = refundC > 0 ? refundSenderWallet(pkt, refundC, ctx) : Promise.resolve(true);
        return chain.then(function () {
            pkt.walletSettled = true;
            if (src && typeof src === 'object') {
                src.walletSettled = true;
                /* 让原对象的状态与规范化结果保持一致 */
                src.status = pkt.status;
            }
            return pkt;
        });
    }

    /* ── 领取流程 ── */

    var claimInflight = {};

    function claimKey(chatId, msgId, who) {
        return String(chatId) + ':' + String(msgId) + ':' + String(who);
    }

    function nextShareIndex(pkt) {
        if (!pkt || !pkt.shares) return -1;
        for (var i = 0; i < pkt.shares.length; i++) {
            if (!pkt.shares[i].claimedBy) return i;
        }
        return -1;
    }

    /**
     * 领取一份。返回 { ok, amount, share, packet, done }
     * 领取顺序即 shares 数组顺序（拼手气已在拆分时打乱）。
     */
    function runClaim(store, chatId, msgId, claimantName, ctx) {
        var msg = store.findMessage(chatId, msgId);
        if (!msg || !msg.singleRedPacket) return Promise.reject(new Error('not_found'));
        var pkt = normalizeSingleRedPacket(msg.singleRedPacket);
        if (!canClaimTo(pkt, claimantName, ctx)) return Promise.reject(new Error('cannot_claim'));
        var idx = nextShareIndex(pkt);
        if (idx < 0) return Promise.reject(new Error('no_amount'));
        var amount = pkt.shares[idx].amount;
        var who = trim(claimantName);
        pkt.shares[idx] = {
            amount: amount,
            claimedBy: who,
            claimedAt: Date.now(),
            claimId: uid('clm')
        };
        var done = claimedCount(pkt) >= pkt.count || remainingSlots(pkt) <= 0;
        /* 单聊只有双方两人：若已无人可领，也应立刻完结并把剩余退回发送方 */
        if (!done && noOneLeftToClaim(pkt, ctx)) done = true;
        pkt.status = done ? 'done' : 'active';
        pkt.doneAt = done ? Date.now() : 0;
        var share = pkt.shares[idx];
        return creditClaimWallet(pkt, share, ctx).then(function () {
            var commit = done
                ? settleRemainder(pkt, ctx).then(function (settled) {
                      return settled || pkt;
                  })
                : Promise.resolve(pkt);
            return commit.then(function (finalPkt) {
                return store
                    .updateMessage(chatId, msgId, {
                        singleRedPacket: finalPkt,
                        content: buildMessageContent(finalPkt)
                    })
                    .then(function () {
                        refreshRoom(chatId);
                        return { ok: true, amount: amount, share: share, packet: finalPkt, done: done };
                    });
            });
        });
    }

    function claimPacket(store, chatId, msgId, claimantName, ctx) {
        if (!store || !chatId || !msgId || !trim(claimantName)) {
            return Promise.reject(new Error('invalid'));
        }
        var key = claimKey(chatId, msgId, claimantName);
        if (claimInflight[key]) return claimInflight[key];
        claimInflight[key] = runClaim(store, chatId, msgId, claimantName, ctx).finally(function () {
            delete claimInflight[key];
        });
        return claimInflight[key];
    }

    /* ── 角色发的红包：用户自动领取 ── */

    var autoTimers = {};

    function clearAutoClaim(chatId, msgId) {
        var key = String(chatId) + ':' + String(msgId);
        if (autoTimers[key]) {
            clearTimeout(autoTimers[key]);
            delete autoTimers[key];
        }
    }

    /**
     * 角色发红包后：等 USER_GRACE_MS 让用户先手动点，
     * 若仍未领则自动入账（模拟对方红包已到手）。
     */
    function scheduleAutoClaims(store, chatId, msgId, ctx, opts) {
        if (!store || !chatId || !msgId) return;
        clearAutoClaim(chatId, msgId);
        var msg = store.findMessage(chatId, msgId);
        if (!msg || !msg.singleRedPacket) return;
        var pkt = normalizeSingleRedPacket(msg.singleRedPacket);
        if (pkt.status !== 'active') return;
        var profileName = trim(ctx && ctx.profile && ctx.profile.name) || '用户';
        if (!canClaimTo(pkt, profileName, ctx)) return;
        opts = opts && typeof opts === 'object' ? opts : {};
        var delay =
            typeof opts.userGraceMs === 'number' && opts.userGraceMs >= 0 ? opts.userGraceMs : USER_GRACE_MS;
        autoTimers[String(chatId) + ':' + String(msgId)] = setTimeout(function () {
            delete autoTimers[String(chatId) + ':' + String(msgId)];
            var now = store.findMessage(chatId, msgId);
            if (!now || !now.singleRedPacket) return;
            var p = normalizeSingleRedPacket(now.singleRedPacket);
            if (!canClaimTo(p, profileName, ctx)) return;
            claimPacket(store, chatId, msgId, profileName, ctx).catch(function () {});
        }, delay);
    }

    /* ── 消息构造 ── */

    function buildMessageContent(pkt) {
        pkt = normalizeSingleRedPacket(pkt);
        if (!pkt) return '';
        var parts = [
            '红包-' + formatMoney(pkt.totalAmount) + '-' + pkt.count + '-' + (pkt.note || '恭喜发财')
        ];
        return parts.join('-');
    }

    /**
     * 由模型输出行构造红包字段。
     * 支持：红包-20｜恭喜发财 / 红包-66-5｜恭喜发财 / 红包-20-1｜专属|恭喜发财
     * opts.targetName：单聊里「专属」的目标即对话对方，由调用方注入
     */
    function buildFromLine(raw, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var text = trim(raw);
        var m = text.match(RE_PARSE);
        if (!m) return null;
        var amount = parseFloat(m[1]);
        if (!Number.isFinite(amount) || amount <= 0) return null;
        var count = m[2] ? parseInt(m[2], 10) : 1;
        if (!Number.isFinite(count) || count < 1) count = 1;
        var tail = trim(m[3]);
        var mode = count > 1 ? 'lucky' : 'normal';
        /* 专属：祝福语前带「专属」标记。单聊里目标恒为对话对方。
         * 模型常写成 `红包-5｜专属|给你`（并列分隔符紧跟在金额后面），
         * 上面的 RE_PARSE 会把 `｜` 一起吞进 tail，所以这里要容忍前导分隔符，
         * 否则专属红包会被误判成普通红包。 */
        var exclusiveHit = /^[\s|｜:：，,]*专属\s*[|｜:：，,]?/.test(tail);
        if (exclusiveHit) {
            mode = 'exclusive';
            count = 1;
            tail = tail.replace(/^[\s|｜:：，,]*专属\s*[|｜:：，,]?\s*/, '');
        }
        var note = extractNoteFromTail(tail);
        var shares = splitByMode(mode, amount, count);
        if (!shares) return null;
        var pkt = normalizeSingleRedPacket({
            mode: mode,
            totalAmount: amount,
            count: count,
            note: note,
            fromRole: 'role',
            senderName: trim(opts.senderName),
            targetName: mode === 'exclusive' ? trim(opts.targetName) : '',
            shares: shares.map(function (amt) {
                return { amount: amt, claimedBy: '', claimedAt: 0, claimId: '' };
            }),
            status: 'active',
            createdAt: Date.now(),
            expireAt: Date.now() + EXPIRE_MS,
            walletHeld: false,
            walletSettled: false
        });
        return { type: 'red_packet', singleRedPacket: pkt, content: buildMessageContent(pkt) };
    }

    /** 发送方创建红包字段 */
    function createPacketFields(opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var amount = roundMoney(opts.totalAmount);
        if (!(amount > 0)) return null;
        var modeRaw = trim(opts.mode);
        var mode = modeRaw === 'lucky' || modeRaw === 'exclusive' ? modeRaw : 'normal';
        var count = Math.max(1, Math.floor(Number(opts.count) || 1));
        if (mode === 'exclusive') count = 1;
        var shares = splitByMode(mode, amount, count);
        if (!shares) return null;
        var fromRole = trim(opts.fromRole) === 'role' ? 'role' : 'user';
        var pkt = normalizeSingleRedPacket({
            mode: mode,
            totalAmount: amount,
            count: count,
            note: cleanNote(opts.note),
            fromRole: fromRole,
            senderName: trim(opts.senderName) || (fromRole === 'user' ? '我' : '对方'),
            targetName: trim(opts.targetName),
            shares: shares.map(function (amt) {
                return { amount: amt, claimedBy: '', claimedAt: 0, claimId: '' };
            }),
            status: 'active',
            createdAt: Date.now(),
            expireAt: Date.now() + EXPIRE_MS,
            walletHeld: false,
            walletSettled: false
        });
        return { type: 'red_packet', singleRedPacket: pkt, content: buildMessageContent(pkt) };
    }

    /** 用户发送红包（含预扣托管） */
    function sendUserPacket(store, chatId, opts, ctx) {
        var targetName = '';
        if (trim(opts.mode) === 'exclusive') {
            targetName = trim(ctx && ctx.contact && ctx.contact.name) || '对方';
        }
        var fields = createPacketFields(
            Object.assign({}, opts, {
                fromRole: 'user',
                senderName: trim(ctx && ctx.profile && ctx.profile.name) || '我',
                targetName: targetName
            })
        );
        if (!fields) return Promise.reject(new Error('invalid_packet'));
        return holdOutgoing(fields.singleRedPacket, ctx)
            .then(function (held) {
                fields.singleRedPacket.walletHeld = !!held;
                fields.role = 'user';
                return store.addMessage(chatId, fields);
            })
            .then(function (msg) {
                refreshRoom(chatId);
                return msg;
            });
    }

    /** 角色发红包：托管角色钱包 + 排定用户自动领取 */
    function sendRolePacket(store, chatId, fields, ctx) {
        if (!fields || !fields.singleRedPacket) return Promise.resolve(fields);
        return holdOutgoing(fields.singleRedPacket, ctx).then(function (held) {
            fields.singleRedPacket.walletHeld = !!held;
            return store.addMessage(chatId, fields).then(function (msg) {
                scheduleAutoClaims(store, chatId, msg.id, ctx);
                return msg;
            });
        });
    }

    /* ── 从消息内容恢复（老消息 / 无字段时兜底） ── */

    function parseLineSimple(raw) {
        var text = trim(raw);
        var m = text.match(RE_PARSE);
        if (!m) return null;
        var amount = parseFloat(m[1]);
        if (!Number.isFinite(amount) || amount <= 0) return null;
        var count = m[2] ? parseInt(m[2], 10) : 1;
        if (!Number.isFinite(count) || count < 1) count = 1;
        var mode = count > 1 ? 'lucky' : 'normal';
        var tail = trim(m[3]);
        /* 与 buildFromLine 保持一致：容忍 `红包-5｜专属|给你` 这类前导分隔符写法 */
        if (/^[\s|｜:：，,]*专属\s*[|｜:：，,]?/.test(tail)) {
            mode = 'exclusive';
            count = 1;
            tail = tail.replace(/^[\s|｜:：，,]*专属\s*[|｜:：，,]?\s*/, '');
        }
        var shares = splitByMode(mode, amount, count);
        if (!shares) return null;
        return normalizeSingleRedPacket({
            mode: mode,
            totalAmount: amount,
            count: count,
            note: extractNoteFromTail(tail),
            fromRole: 'role',
            shares: shares.map(function (amt) {
                return { amount: amt, claimedBy: '', claimedAt: 0, claimId: '' };
            }),
            status: 'active'
        });
    }

    /** 从消息解析出红包对象（字段优先，内容兜底） */
    function resolveMessagePacket(m) {
        if (!m || typeof m !== 'object') return null;
        if (isSingleRedPacket(m.singleRedPacket)) {
            return normalizeSingleRedPacket(m.singleRedPacket);
        }
        var content = trim(m.content);
        if (!content) return null;
        /* 只取头部（跳过可能的进度尾巴） */
        var head = content.split(/[-－—](?:已领|待领|状态|发起人|进度)[：:]/)[0];
        return parseLineSimple(head);
    }

    /* ── 渲染上下文辅助 ── */

    function senderDisplayName(pkt, ctx) {
        if (!pkt) return '对方';
        if (pkt.fromRole === 'user') return trim(ctx && ctx.profile && ctx.profile.name) || '我';
        if (pkt.senderName) return pkt.senderName;
        var c = ctx && ctx.contact;
        return trim(c && c.name) || '对方';
    }

    function isFromMe(pkt, ctx) {
        if (!pkt) return false;
        return pkt.fromRole === 'user';
    }

    function refreshRoom(chatId) {
        var room = global.miyaChatRoom;
        if (room && typeof room.refresh === 'function' && typeof room.getOpenChatId === 'function') {
            if (String(room.getOpenChatId()) === String(chatId)) {
                room.refresh({ toBottom: true });
            }
        }
        if (global.miyaChatApp && typeof global.miyaChatApp.refreshLists === 'function') {
            global.miyaChatApp.refreshLists();
        }
    }

    /* ── 卡片渲染 ── */

    function modeLabel(pkt) {
        if (!pkt) return '红包';
        if (pkt.mode === 'lucky') return '拼手气 · Lucky';
        if (pkt.mode === 'exclusive') return '专属 · Exclusive';
        return '普通 · Normal';
    }

    function stateLabel(pkt, canOpen) {
        if (!pkt) return '查看';
        if (pkt.status === 'done') return '已领完';
        if (isExpired(pkt)) return '已过期';
        return canOpen ? '开' : '查看';
    }

    /**
     * 聊天里的红包卡片：就是封面图本身。
     * 素材已印有「招财进宝」与「開」，因此卡面不再叠加任何文字、底栏或按钮。
     * 状态（可领 / 已领完 / 已过期）只通过整体观感体现，不额外画字。
     */
    function renderCard(m, esc, fmtMoney, ctx) {
        var pkt = resolveMessagePacket(m);
        if (!pkt) return '';
        var canOpen = canUserClaim(pkt, ctx);
        var done = pkt.status === 'done';
        var expired = isExpired(pkt);
        var mine = isFromMe(pkt, ctx);
        var cls =
            'srp-card srp-card--' +
            (done ? 'done' : expired ? 'expired' : 'active') +
            (canOpen ? ' is-ready' : '') +
            (mine ? ' srp-card--out' : ' srp-card--in');
        return (
            '<button type="button" class="' +
            cls +
            '" data-msg-id="' +
            esc(m.id) +
            '" data-srp-card data-srp-open="' +
            esc(m.id) +
            '" aria-label="红包">' +
            '<span class="srp-card__cover" aria-hidden="true"></span>' +
            '<span class="srp-card__glow" aria-hidden="true"></span>' +
            '</button>'
        );
    }

    /* ── 发送面板 ── */

    function buildSendSheetHtml(ctx, esc, walletFmt) {
        var bal = '';
        var store = st();
        if (store && ctx && ctx.profile && store.getWallet && walletFmt) {
            var w = store.getWallet(ctx.profile.id);
            bal =
                '<p class="qq-sheet__hint srp-sheet__bal">余额 ' +
                esc(walletFmt(w.balance)) +
                '</p>';
        }
        var contactName = trim(ctx && ctx.contact && ctx.contact.name) || '对方';
        return (
            '<div class="qq-sheet qq-sheet--srp">' +
            '<div class="qq-sheet__panel srp-sheet__panel">' +
            '<div class="qq-sheet__grab"></div>' +
            '<header class="srp-sheet__head">' +
            '<span class="srp-sheet__kicker">红包</span>' +
            '<h2 class="srp-sheet__title">塞钱进红包</h2>' +
            '</header>' +
            bal +
            '<div class="srp-sheet__modes" role="tablist">' +
            '<button type="button" class="srp-mode is-active" data-srp-mode="normal">普通</button>' +
            '<button type="button" class="srp-mode" data-srp-mode="lucky">拼手气</button>' +
            '<button type="button" class="srp-mode" data-srp-mode="exclusive">专属</button>' +
            '</div>' +
            '<div class="qq-sheet__body srp-sheet__body">' +
            '<label class="srp-field"><span class="srp-field__label">金额</span>' +
            '<div class="srp-field__input-wrap"><span class="srp-field__prefix">¥</span>' +
            '<input class="srp-field__input" id="srp-amt" type="number" min="0.01" step="0.01" placeholder="0.00" inputmode="decimal"></div></label>' +
            '<label class="srp-field srp-field--count" hidden><span class="srp-field__label">份数</span>' +
            '<input class="srp-field__input" id="srp-count" type="number" min="2" step="1" value="2"></label>' +
            '<p class="srp-field srp-field--exclusive" hidden>' +
            '<span class="srp-field__label">专属给</span>' +
            '<span class="srp-field__target" id="srp-target">' +
            esc(contactName) +
            '</span></p>' +
            '<label class="srp-field"><span class="srp-field__label">祝福语</span>' +
            '<input class="srp-field__input" id="srp-note" type="text" maxlength="60" placeholder="恭喜发财，大吉大利"></label>' +
            '</div>' +
            '<div class="srp-sheet__actions">' +
            '<button type="button" class="srp-sheet__send" id="srp-send">塞钱进红包</button>' +
            '<button type="button" class="qq-sheet__cancel" data-sheet-close>取消</button>' +
            '</div></div></div>'
        );
    }

    function bindSendSheet(root, store, chatId, ctx, onDone) {
        if (!root) return;
        var mode = 'normal';
        var modeBtns = root.querySelectorAll('[data-srp-mode]');
        var countField = root.querySelector('.srp-field--count');
        var exField = root.querySelector('.srp-field--exclusive');
        modeBtns.forEach(function (btn) {
            btn.addEventListener('click', function () {
                mode = btn.getAttribute('data-srp-mode') || 'normal';
                modeBtns.forEach(function (b) {
                    b.classList.toggle('is-active', b === btn);
                });
                if (countField) countField.hidden = mode !== 'lucky';
                if (exField) exField.hidden = mode !== 'exclusive';
            });
        });
        var sendBtn = root.querySelector('#srp-send');
        if (!sendBtn) return;
        sendBtn.addEventListener('click', function () {
            var amtEl = root.querySelector('#srp-amt');
            var cntEl = root.querySelector('#srp-count');
            var noteEl = root.querySelector('#srp-note');
            var amt = Number((amtEl && amtEl.value) || 0);
            var note = (noteEl && noteEl.value) || '';
            if (!(amt > 0)) {
                onDone && onDone({ error: 'invalid_amount' });
                return;
            }
            var opts = { mode: mode, totalAmount: amt, note: note };
            if (mode === 'lucky') opts.count = Number((cntEl && cntEl.value) || 2);
            if (mode === 'exclusive') opts.count = 1;
            sendUserPacket(store, chatId, opts, ctx)
                .then(function (msg) {
                    onDone && onDone({ ok: true, msg: msg });
                })
                .catch(function (err) {
                    var wallet = global.MiyaChatWallet;
                    var code = wallet && wallet.errCode ? wallet.errCode(err) : '';
                    onDone && onDone({ error: code || 'send_failed' });
                });
        });
    }

    function escText(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* ── 拆红包弹层：对齐参考图（顶部红弧 → 開印 → 标题 → 祝福语 → 金额 → 已存入零钱） ── */
    function buildOpenOverlayHtml(amount, note, senderName) {
        return (
            '<div class="srp-open" data-srp-open-layer>' +
            '<div class="srp-open__panel">' +
            '<div class="srp-open__arc" aria-hidden="true"></div>' +
            '<div class="srp-open__seal" aria-hidden="true">開</div>' +
            '<p class="srp-open__title">' +
            escText(senderName ? senderName + '的红包' : '收到的红包') +
            '</p>' +
            '<p class="srp-open__note">' +
            escText(note || '恭喜发财，大吉大利') +
            '</p>' +
            '<p class="srp-open__amt">' +
            escText(formatMoney(amount)) +
            '<small>元</small>' +
            '</p>' +
            '<p class="srp-open__hint">' +
            '<span>已存入零钱</span>' +
            '</p>' +
            '<button type="button" class="srp-open__close" data-srp-open-close>完成</button>' +
            '</div></div>'
        );
    }

    /* ── 详情页：严格对齐参考图（顶部红弧 → 标题 → 祝福语 → 大金额 → 已存入零钱） ── */
    function buildDetailHtml(msg, ctx, esc) {
        var pkt = resolveMessagePacket(msg);
        if (!pkt) return '';
        var esc2 = typeof esc === 'function' ? esc : escText;
        var mine = isFromMe(pkt, ctx);
        var claimedAmt = claimedSum(pkt);
        var leftoverC = toCents(pkt.totalAmount) - toCents(claimedAmt);
        var settledOut = mine && pkt.walletSettled && leftoverC > 0;
        /* 发出的红包显示总额；收到的显示自己实际到手（未领则显示总额） */
        var myName = (ctx && ctx.profile && ctx.profile.name) || '用户';
        var myClaim = (pkt.shares || []).filter(function (s) {
            return s && s.claimedBy === myName;
        })[0];
        var showAmt = mine ? pkt.totalAmount : myClaim ? myClaim.amount : pkt.totalAmount;
        var title = mine ? '发出的红包' : myClaim ? '收到的红包' : '红包详情';
        var hint = mine
            ? settledOut
                ? claimedCount(pkt) + '/' + pkt.count + ' 已领取，剩余 ¥' +
                  formatMoney(fromCents(leftoverC)) + ' 已退回'
                : claimedCount(pkt) + '/' + pkt.count + ' 已领取'
            : myClaim
              ? '已存入零钱'
              : pkt.status === 'done'
                ? '红包已被领完'
                : isExpired(pkt)
                  ? '红包已过期'
                  : '尚未领取';
        return (
            '<div class="qq-sheet qq-sheet--srp-detail">' +
            '<div class="qq-sheet__panel srp-detail__panel">' +
            /* 顶部红弧：顶边贴平、底边向下鼓出，左右两侧溢出到面板外，不留白角 */
            '<div class="srp-detail__arc" aria-hidden="true"></div>' +
            '<div class="srp-detail__body">' +
            '<h3 class="srp-detail__title">' +
            esc2(title) +
            '</h3>' +
            '<p class="srp-detail__note">' +
            esc2(pkt.note || '恭喜发财，大吉大利') +
            '</p>' +
            '<p class="srp-detail__sum">' +
            esc2(formatMoney(showAmt)) +
            '<small>元</small>' +
            '</p>' +
            '<p class="srp-detail__hint">' +
            '<span>' +
            esc2(hint) +
            '</span>' +
            '</p>' +
            '</div>' +
            '<button type="button" class="qq-sheet__cancel" data-sheet-close>关闭</button>' +
            '</div></div>'
        );
    }

    /**
     * 领取成功后的详情页装饰：在标题上方注入一条「已领取」徽标。
     * 用于「点封面 → 自动领取 → 详情页即时反馈」这条链路，
     * 让用户一眼看到本次到账金额，而无需额外的弹窗。
     */
    function decorateJustClaimed(html, amount) {
        if (!html || !(Number(amount) > 0)) return html;
        var badge =
            '<div class="srp-detail__claimed">' +
            '<span class="srp-detail__claimed-icon" aria-hidden="true">' +
            '<svg viewBox="0 0 24 24" width="13" height="13">' +
            '<path d="M20 6L9 17l-5-5" fill="none" stroke="currentColor" ' +
            'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</span>' +
            '<span>已领取 ¥' +
            escText(formatMoney(amount)) +
            '</span>' +
            '</div>';
        /* 插到红弧之后、内容区之前，保持版式居中 */
        return html.replace(
            '<div class="srp-detail__body">',
            badge + '<div class="srp-detail__body">'
        );
    }

    /* ── 系统消息（领取 / 完结播报） ── */

    function isSingleRedPacketSystem(m) {
        if (!m || m.role !== 'system') return false;
        return (
            m.type === 'red_packet_claim' ||
            m.type === 'red_packet_done' ||
            m.systemKind === 'red_packet_claim' ||
            m.systemKind === 'red_packet_done'
        );
    }

    function formatClaimSystemContent(claim) {
        if (!claim) return '';
        return '领取-' + trim(claim.claimedBy) + '-' + formatMoney(claim.amount);
    }

    function formatSystemForDisplay(m) {
        if (!m) return '';
        var kind = trim(m.type || m.systemKind);
        var raw = trim(m.content);
        if (kind === 'red_packet_claim') {
            var mm = raw.match(/^领取[-－—]([^-－—]+)[-－—]?(?:¥)?([\d.]+)/);
            if (mm) return trim(mm[1]) + ' 领取了红包 ¥' + formatMoney(mm[2]);
            return '有人领取了红包';
        }
        if (kind === 'red_packet_done') return '红包已被领完';
        return '红包动态';
    }

    /* ── 导出 ── */

    global.MiyaChatSingleRedPacket = {
        USER_OWNER_ID: USER_OWNER_ID,
        EXPIRE_MS: EXPIRE_MS,
        isSingleRedPacket: isSingleRedPacket,
        normalizeSingleRedPacket: normalizeSingleRedPacket,
        buildFromLine: buildFromLine,
        createPacketFields: createPacketFields,
        sendUserPacket: sendUserPacket,
        sendRolePacket: sendRolePacket,
        splitNormalAmounts: splitEqualAmounts,
        splitEqualAmounts: splitEqualAmounts,
        splitLuckyAmounts: splitLuckyAmounts,
        holdOutgoing: holdOutgoing,
        creditClaimWallet: creditClaimWallet,
        refundSenderWallet: refundSenderWallet,
        settleRemainder: settleRemainder,
        claimPacket: claimPacket,
        canClaim: canClaim,
        canClaimTo: canClaimTo,
        canUserClaim: canUserClaim,
        eligibleNames: eligibleNames,
        exclusiveTargetName: exclusiveTargetName,
        noOneLeftToClaim: noOneLeftToClaim,
        remainingSlots: remainingSlots,
        claimedCount: claimedCount,
        claimedSum: claimedSum,
        isExpired: isExpired,
        scheduleAutoClaims: scheduleAutoClaims,
        resolveMessagePacket: resolveMessagePacket,
        senderDisplayName: senderDisplayName,
        buildMessageContent: buildMessageContent,
        isSingleRedPacketSystem: isSingleRedPacketSystem,
        formatClaimSystemContent: formatClaimSystemContent,
        formatSystemForDisplay: formatSystemForDisplay,
        renderCard: renderCard,
        buildSendSheetHtml: buildSendSheetHtml,
        bindSendSheet: bindSendSheet,
        buildOpenOverlayHtml: buildOpenOverlayHtml,
        buildDetailHtml: buildDetailHtml,
        decorateJustClaimed: decorateJustClaimed
    };
})(window);
