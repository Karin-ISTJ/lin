(function (global) {
    'use strict';

    var USER_MSG_JOIN = '\n\n';

    /*
     * 两段**独立**用户发言之间的分隔标记。
     *
     * 只在「多个不同楼层的 user 因为中间角色回复被删而变成相邻」时才会用到。
     * 正常的单条 user 完全不经过它，所以对日常请求零影响。
     *
     * ⚠️ 这段文本必须**足够强硬**，不能只写成一句软提示。
     *
     * 出过的故障（用户实测）：昨天说「我下飞机了」，今天说「那你路上吃点东西」，
     * 点刷新后角色仍答「在飞机上吃了」。排查发现 prompt 里长这样：
     *
     *     user: 我下飞机了\n\n（以下是用户的新一条发言）\n\n那你路上吃点东西
     *
     * 本该是「两轮」，但那段软提示挡不住模型把它们读成一坨 ——
     * 它看到第一句是刚聊过的「飞机」，就顺着旧语境写，完全无视后面那句新提问。
     *
     * 现在把分隔符升级成带编号的硬分隔：
     *   · 明确标注「第 N 段」，让模型数得清这里有几次发言；
     *   · 明确写出「只回应最后一段」，把生成目标钉死在最新那句上；
     *   · 明确写出「更早的段落已完成、不要重答」，堵住「回去接旧话题」这条路。
     */
    var USER_TURN_DIVIDER = '\n\n【用户发言分隔·第 %N% 段开始】\n\n';
    /*
     * 分隔符收尾：紧跟在最后一段之后，告诉模型「到这儿是最后一段」。
     * 只在真的存在多段时才加（单段不经过分隔符，行为与改动前完全一致）。
     */
    var USER_TURN_TAIL =
        '\n\n【用户发言分隔·以上共 %TOTAL% 段；你只需回应最后一段，更早的段落已由你（或已被撤回）处理过，不要再重答】';

    /* 流式空闲超时：多久没收到数据算「卡死」。
       离线是长文生成，不能设请求级总时长（会误杀正常的长回复），
       所以只在「持续无进展」时判定，每收到一块数据就重置。 */
    var STREAM_IDLE_TIMEOUT_MS = 60000;

    /*
     * 单层楼层的候选上限。
     *
     * ── 为什么从「固定 8 条」改成「按字符总量」──
     *
     * 先确认一个关键事实：**候选内容不进 prompt**。
     * appendSessionHistory 只读 m.content（也就是当前显示的那一版），
     * swipes 数组在整条 prompt 构造链路上没有任何读取点。
     * 实测（真浏览器 + 真引擎，4 个候选共 624 字符）：
     *
     *   候选总数 4 条 / 624 字符
     *   进 prompt 的候选 = 1 条（只有当前显示的那条，作为普通历史楼层）
     *   其他候选进 prompt = 0 条
     *
     * 所以「攒了很多候选」**不会**让后续楼层的请求变大 ——
     * 用户担心的 token 累积不存在。唯一代价是 localStorage 体积：
     * 候选是整份文本存着的，反复刷几十次会明显撑大存储。
     *
     * 因此上限不该按「条数」切：有的回复 50 字，有的 3000 字，
     * 8 条对前者太浪费、对后者又太多。按**字符总量**切才贴合真实成本。
     *
     * 策略：保留第一条（原始锚点，用来对照）+ 最近若干条，
     * 从中间开始丢 —— 中间的版本用户基本不会再翻回去看，
     * 而「最早那版」和「最新几版」是真正会被用到的。
     *
     * 40 万字符 ≈ 单层约 30 万汉字，按每次刷新 3000 字算能留一百多条，
     * 足够用了；真到这个量级，存储压力也该到头了。
     */
    var SWIPE_MAX = 200;
    var SWIPE_CHAR_LIMIT = 400000;

    /**
     * 往候选表里追加一条，并按上限裁剪。
     *
     * 抽成函数是因为「重回」和「楼层右下角 ›」两条路径都要用到，
     * 上限规则必须只有一份实现 —— 否则改了一处、另一处会漂。
     *
     * @returns {{list: string[], keepIdx: number[]}}
     *   list    —— 裁剪后的候选表
     *   keepIdx —— 每个保留项在**入参数组**里的原下标，末尾额外补一个
     *              新追加项的下标（即入参长度）。调用方用它把**平行的**
     *              数组（如各候选的记忆标记 swipeMtRaw）裁成同一形状，
     *              不必把裁剪规则抄第二遍 —— 抄了就会漂。
     */
    function pushSwipeCandidate(prevSwipes, content) {
        var src = Array.isArray(prevSwipes) ? prevSwipes.slice() : [];
        var list = src.slice();
        list.push(String(content || ''));
        /* 保留项的原下标表；末尾补上「新追加项」的下标 = src.length */
        var keepIdx = [];
        var i;
        for (i = 0; i < src.length; i++) keepIdx.push(i);
        keepIdx.push(src.length);
        /* 条数上限：先粗筛一道，避免下面那个循环在极端数据上跑太久 */
        if (list.length > SWIPE_MAX) {
            list = [list[0]].concat(list.slice(-(SWIPE_MAX - 1)));
            keepIdx = [keepIdx[0]].concat(keepIdx.slice(-(SWIPE_MAX - 1)));
        }
        /*
         * 字符总量上限：从**中间**开始丢，保住头部锚点与尾部新候选。
         * 注意永远至少留 2 条 —— 只有一条的话切换器就不渲染了，
         * 用户会以为「刷出来的候选被吃了」，比存储超限更难理解。
         */
        var totalChars = 0;
        for (i = 0; i < list.length; i++) totalChars += String(list[i] || '').length;
        while (list.length > 2 && totalChars > SWIPE_CHAR_LIMIT) {
            var dropIdx = 1;
            totalChars -= String(list[dropIdx] || '').length;
            list.splice(dropIdx, 1);
            keepIdx.splice(dropIdx, 1);
        }
        return { list: list, keepIdx: keepIdx };
    }

    /**
     * 按候选表的裁剪结果，把平行数组（各候选的记忆标记）裁成同一形状。
     *
     * 与 pushSwipeCandidate 配套使用：那边给出 keepIdx，这里照着选。
     * 长度不足的位置补空串 —— 缺标记比错位安全（错位会写错楼层的记忆）。
     */
    function alignSwipeMtRaw(prevMtRaw, keepIdx) {
        var src = Array.isArray(prevMtRaw) ? prevMtRaw : [];
        return (Array.isArray(keepIdx) ? keepIdx : []).map(function (i) {
            return String(src[i] == null ? '' : src[i]);
        });
    }

    function eng() {
        return global.miyaChatEngine;
    }

    function apStore() {
        return global.MiyaAppointmentStore;
    }

    function clampInt(v, lo, hi, fb) {
        var n = parseInt(v, 10);
        if (!Number.isFinite(n)) return fb;
        return Math.min(hi, Math.max(lo, n));
    }


    function appointmentWorldbookExtraBindings(preset) {
        return ((preset && preset.worldbookBindings) || [])
            .map(function (b) {
                if (!b || typeof b !== 'object') return null;
                var entryId = String(b.entryId || b.id || '').trim();
                if (!entryId) return null;
                return { type: 'entry', entryId: entryId, force: true };
            })
            .filter(Boolean);
    }

    function appointmentWorldbookOpts(extra) {
        var opts = { scopeMode: 'appointment', promptContext: 'offline', includeAllBoundLocal: true };
        if (extra && typeof extra === 'object') {
            if (Array.isArray(extra.roleIds) && extra.roleIds.length) {
                opts.roleIds = extra.roleIds
                    .map(function (x) {
                        return String(x || '').trim();
                    })
                    .filter(Boolean);
            }
        }
        return opts;
    }

    function resolveSessionCastContacts(st, sess, primaryContact) {
        var cast = Array.isArray(sess && sess.cast) ? sess.cast : [];
        var list = [];
        var seen = Object.create(null);
        cast.forEach(function (row) {
            var cid = String((row && row.contactId) || '').trim();
            if (!cid || seen[cid] || !st || !st.findContact) return;
            var c = st.findContact(cid);
            if (c) {
                seen[cid] = true;
                list.push(c);
            }
        });
        if (!list.length && primaryContact) list = [primaryContact];
        return list;
    }

    function mergeWorldbookBundles(bundles) {
        var front = [];
        var layers = [];
        var back = [];
        var inChat = [];
        var matched = [];
        var seenText = Object.create(null);
        function pushUnique(arr, text) {
            var t = String(text || '').trim();
            if (!t || seenText[t]) return;
            seenText[t] = true;
            arr.push(t);
        }
        (bundles || []).forEach(function (b) {
            if (!b) return;
            (b.frontLayers || []).forEach(function (t) {
                pushUnique(front, t);
            });
            (b.layers || []).forEach(function (t) {
                pushUnique(layers, t);
            });
            (b.backLayers || []).forEach(function (t) {
                pushUnique(back, t);
            });
            /* 深度注入条目也要合并 —— 多角色约会时每个 cast 的词条都得进来。
               漏了这行会导致「多人约会场景下深度注入静默失效」，而单人约会正常。 */
            (b.inChatItems || []).forEach(function (item) {
                if (item) inChat.push(item);
            });
            if (Array.isArray(b.matched)) matched = matched.concat(b.matched);
        });
        /* meta 也必须合并 —— 以前这里只拼了层文本，把每个 bundle 的 meta 全丢了。
           单人线下拿 wbBundle.meta 一切正常，多角色（castContacts > 1）拿到的是
           undefined：世界书命中数 / 候选数 / 注入字符数全部归零，
           下游「模型高级」面板对多人约会的世界书统计就永远是一片空白。
           字符数不按各 bundle 的 injectedChars 相加（同一条目被两个角色同时
           命中时会重复计数），而是按去重后的层文本重算，与实际发送内容一致。 */
        var mergedMeta = null;
        var metas = [];
        (bundles || []).forEach(function (b) {
            if (b && b.meta && typeof b.meta === 'object') metas.push(b.meta);
        });
        if (metas.length === 1) {
            mergedMeta = Object.assign({}, metas[0]);
        } else if (metas.length > 1) {
            mergedMeta = {
                matched: matched.length,
                chars: sumLayerCharsLocal(front) + sumLayerCharsLocal(layers) + sumLayerCharsLocal(back),
                injectedChars:
                    sumLayerCharsLocal(front) + sumLayerCharsLocal(layers) + sumLayerCharsLocal(back),
                matchedContentChars: 0,
                emptyMatched: 0,
                roleIds: [],
                budgetDropped: [],
                budgetDroppedCount: 0,
                consideredCount: 0,
                matchedSummary: []
            };
            var seenRoleId = Object.create(null);
            var seenSummary = Object.create(null);
            metas.forEach(function (m) {
                mergedMeta.matchedContentChars += Number(m.matchedContentChars) || 0;
                mergedMeta.emptyMatched += Number(m.emptyMatched) || 0;
                (Array.isArray(m.roleIds) ? m.roleIds : []).forEach(function (rid) {
                    var key = String(rid || '');
                    if (key && !seenRoleId[key]) {
                        seenRoleId[key] = true;
                        mergedMeta.roleIds.push(key);
                    }
                });
                mergedMeta.budgetDroppedCount += Number(m.budgetDroppedCount) || 0;
                mergedMeta.consideredCount += Number(m.consideredCount) || 0;
                (Array.isArray(m.budgetDropped) ? m.budgetDropped : []).forEach(function (d) {
                    if (d) mergedMeta.budgetDropped.push(d);
                });
                (Array.isArray(m.matchedSummary) ? m.matchedSummary : []).forEach(function (s) {
                    var key = String((s && s.name) || '');
                    if (key && !seenSummary[key]) {
                        seenSummary[key] = true;
                        mergedMeta.matchedSummary.push(s);
                    }
                });
            });
        }
        return {
            frontLayers: front,
            layers: layers,
            backLayers: back,
            inChatItems: inChat,
            matched: matched,
            meta: mergedMeta
        };
    }

    function sumLayerCharsLocal(layers) {
        if (!Array.isArray(layers)) return 0;
        var n = 0;
        layers.forEach(function (t) {
            n += String(t || '').length;
        });
        return n;
    }

    function appendLayerListLocal(parts, layers) {
        if (!Array.isArray(layers)) return parts;
        layers.forEach(function (layer) {
            var t = String(layer || '').trim();
            if (t) parts.push(t);
        });
        return parts;
    }

    function buildWorldbookLayers(contact, contextText, preset) {
        var e = eng();
        if (e && typeof e.buildWorldbookBundle === 'function') {
            return e.buildWorldbookBundle(
                contact,
                contextText,
                appointmentWorldbookExtraBindings(preset),
                appointmentWorldbookOpts()
            ).layers;
        }
        var builder = global.miyaWorldbookPrompt || global.miyaBuildWorldbookPrompt;
        if (!builder || typeof builder.buildWorldbookPrompt !== 'function') return [];
        var roleIds =
            e && typeof e.collectContactRoleIds === 'function'
                ? e.collectContactRoleIds(contact)
                : [];
        if (!roleIds.length && contact) {
            ['characterId', 'chronicleId', 'id', 'contactId'].forEach(function (k) {
                var v = String(contact[k] || '').trim();
                if (v) roleIds.push(v);
            });
        }
        var result = builder.buildWorldbookPrompt({
            roleId: roleIds[0] || '',
            roleIds: roleIds,
            roleName: contact && contact.name,
            contextText: contextText || '',
            skipChronicleProfile: true,
            extraBindings: appointmentWorldbookExtraBindings(preset),
            scopeMode: 'appointment'
        });
        var sec = result && result.sections ? result.sections : {};
        var layers = [sec.global, sec.local]
            .map(function (x) {
                return String(x || '').trim();
            })
            .filter(Boolean);
        if (!layers.length && result && result.text) {
            var fullText = String(result.text || '').trim();
            if (fullText) layers = [fullText];
        }
        return layers;
    }

    /** 世界书关键词匹配：纳入线上近期对话 + 跨场景记忆 + 当前场景正文，避免只读当轮输入 */
    function buildWorldbookContextText(canonId, sessionMsgs, userText, settings, cross) {
        var parts = [];
        var st = global.miyaChatStore;
        var limit =
            settings && settings.memoryCount
                ? Math.min(500, Math.max(1, parseInt(settings.memoryCount, 10) || 40))
                : 40;
        if (st && typeof st.getMessages === 'function' && canonId) {
            st.getMessages(canonId)
                .filter(function (m) {
                    return m && !m.deleted && String(m.content || '').trim();
                })
                .slice(-limit)
                .forEach(function (m) {
                    parts.push(String(m.content || '').trim());
                });
        }
        if (cross) {
            /*
             * 这一段只用于**世界书关键词命中**，不是送进请求的正文。
             *
             * 关键：只喂「时间线片段」，绝不把「总结」喂进来。
             * 时间线片段是一条条 〔时间·线上/线下〕角色：正文 的行，
             * 关键词命中拿它有天然依据 —— 里面出现的名词就是剧情里真出现过的名词。
             *
             * 而总结是模型对旧剧情写的压缩叙述，里面同样满是关键词，却来自
             * 早已发生的场次。原文案连 summaryText 一起 concat 进来，
             * 于是「用户早先删掉的卷宗」只要其总结还在任何地方存活过一轮，
             * 就会把当年的世界书条目重新打亮，模型拿到那份上下文后顺着旧剧情
             * 往下写 —— 用户看到的就是「思维链读到了我删过的卷宗内容」。
             * 真正把总结送给模型的只有 injectAppointmentCrossMemory 一处，
             * 让它单独负责，世界书这里不重复、也不借道。
             */
            (cross.slotItems || []).forEach(function (it) {
                var body = String((it && it.content) || '').trim();
                if (body) parts.push(body);
            });
        }
        (sessionMsgs || []).forEach(function (m) {
            var body = String((m && m.content) || '').trim();
            if (body) parts.push(body);
        });
        var extra = String(userText || '').trim();
        if (extra) parts.push(extra);
        return parts.filter(Boolean).join('\n');
    }

    function renderContactProfileBlock(contact) {
        var cs = global.miyaContactsStore;
        if (!cs || !contact) return '';
        var rid = String(contact.characterId || contact.id || contact.chronicleId || '').trim();
        if (rid && typeof cs.renderChronicleBlock === 'function') {
            var fromStore = String(cs.renderChronicleBlock(rid) || '').trim();
            if (fromStore) return fromStore;
        }
        if (rid && typeof cs.findCharacter === 'function') {
            var row = cs.findCharacter(rid);
            if (row && row.name) {
                var lines = ['【角色·档案·' + String(row.name) + '】'];
                if (row.gender) lines.push('- 性别: ' + row.gender);
                if (row.age) lines.push('- 年龄: ' + row.age);
                if (row.birthday) lines.push('- 生日: ' + row.birthday);
                if (row.persona) lines.push('- 人设与背景: ' + row.persona);
                if (lines.length > 1) return lines.join('\n');
            }
        }
        var name = String(contact.name || '').trim();
        if (!name) return '';
        return '【角色·档案·' + name + '】';
    }

    function renderProfileBlock(profile) {
        if (!profile) return '';
        var lines = ['【用户身份·' + String(profile.name || '用户') + '】'];
        if (profile.gender) lines.push('- 性别: ' + profile.gender);
        if (profile.age) lines.push('- 年龄: ' + profile.age);
        if (profile.persona) lines.push('- 人设: ' + profile.persona);
        return lines.join('\n');
    }

    function buildNovelWriterBlock(contact, profile) {
        var roleName = String((contact && contact.name) || '角色');
        var userName = String((profile && profile.name) || '用户');
        return (
            '【叙事引擎·线下】\n' +
            '你正在进行一段与用户共同推进的线下剧情叙事，不是即时线上聊天，也不是要接线上气泡。\n' +
            '须完整消化联系人档案与世界书后再回应。\n' +
            '角色（' + roleName + '）与用户（' + userName + '）的人设、口吻与心理必须分开，禁止混写。\n' +
            '世界书分两类：绑定该联系人的设定，以及调参里额外挂载的规则/番外；先归类后再回应。'
        )
    }

    function buildAppointmentModeBlock(contact, profile, castContacts) {
        var cast = Array.isArray(castContacts) && castContacts.length ? castContacts : [contact];
        var names = cast
            .map(function (c) {
                return String((c && c.name) || '').trim();
            })
            .filter(Boolean);
        var multi = names.length > 1;
        var lines = [
            '【对话模式·线下】',
            multi
                ? '当前是多人线下互动。本场出演：' +
                  names.join('、') +
                  '；与用户「' +
                  String((profile && profile.name) || '用户') +
                  '」共同推进。'
                : '当前是线下互动。你以「' +
                  String((contact && contact.name) || '对方') +
                  '」的身份与「' +
                  String((profile && profile.name) || '用户') +
                  '」互动。',
            '- 禁止线上专属格式（语音-/表情包-/引用-等）。',
        ];
        if (multi) {
            lines.push('- 多人同场：每位出演角色言行须符合各自人设与关系。');
            lines.push('- 主联系人：「' + String((contact && contact.name) || names[0] || '对方') + '」。');
        }
        lines.push(
            '- 提示词顺序：模式 → 联系人档案 → 用户 → 关系 → 感知 → 世界书说明 → 世界书正文 → 跨场景记忆 → 上下文 → 【末尾·用户元指令】。'
        );
        lines.push('- 世界书注入规则见下文【世界书·本场读取说明】。');
        return lines.join('\n');
    }

    function buildOfflineOperationRules(contact, profile, castContacts) {
        var cast = Array.isArray(castContacts) && castContacts.length ? castContacts : [contact];
        var names = cast
            .map(function (c) {
                return String((c && c.name) || '').trim();
            })
            .filter(Boolean);
        var multi = names.length > 1;
        var roleName = String((contact && contact.name) || '对方');
        var userName = String((profile && profile.name) || '用户');
        var base =
            '【运转规则·线下】\n' +
            (multi
                ? '1、本场出演 ' + names.join('、') + '，须消化各自人设与世界书。\n'
                : '1、你是' + roleName + '，须消化人设与世界书。\n') +
            '2、你清楚' + userName + '是谁，关系与情绪须与上下文一致。\n' +
            '3、本场是线下剧情叙事，不是线上即时聊天。禁止输出「〔…·线上〕」「〔…·线下〕」时间标签，禁止「角色名：台词」气泡连发，禁止语音-/表情包-/引用- 等线上格式。\n' +
            '4、正文应为场景描写 + 动作 + 对话的连贯叙事（小说/剧本体），承接的是本场线下楼层与用户本轮输入，不是线上聊天记录。\n' +
            '5、跨场景记忆仅作背景知晓，禁止把记忆原文复述成新的线上气泡。\n' +
            '6、回顾近期跨场景记忆，勿机械复读相同开场与句式。\n' +
            '7、若用户要求番外、小剧场、HTML 页或其它特殊玩法，以该轮 $ 元指令为准；见提示词最末【用户元指令·线下·最高优先级】；仍须贴合人设与世界书核心设定。';
        var statusApi = global.MiyaOfflineStatus;
        if (statusApi && typeof statusApi.isEnabled === 'function' && statusApi.isEnabled()) {
            /* 编号接在基础规则之后；且必须排在剧情建议规则**之前**——
               状态栏在正文之后、<plot> 之前输出，规则顺序与输出顺序一致，
               模型才不容易把 <plot> 写到状态栏前面导致解析层互相干扰。 */
            base +=
                '\n7、正文结束后先按【线下格式规则·状态栏】完整输出 <miyastatus>...</miyastatus>，状态不得写入正文；' +
                '状态栏写完后，再输出剧情走向建议 <plot>（见下）。';
        }
        base +=
            '\n' +
            buildPlotHintRules(roleName, userName);
        return base;
    }

    /**
     * 剧情走向建议 —— 输出规则。
     *
     * 这一段是给「正文底部的剧情建议卡」喂数据的唯一来源。
     * 卡片要能点，就必须先有内容；而内容由谁产生是个绕不开的选择：
     *
     *   · 静态预设 —— 改动最小，但固定四句和剧情对不上，
     *     点下去模型接不住，等于是个摆设。
     *   · 模型动态生成 —— 建议由「这一场戏到底走到哪儿了」推出来，
     *     点哪条都接得上。这是用户选定的方案。
     *
     * 于是这里规定标记与格式。三条设计约束：
     *
     *   ① 独立标记 <plot>…</plot>，且**必须放在正文与状态栏之后**。
     *      解析层整段摘走它，标记不进楼层正文 —— 否则下一轮会被当历史
     *      送回给模型，它会照着格式自己再吐一遍（历史上 <tableEdit>
     *      / <miyaevent> 都踩过这个坑，见引擎里那两处剥离）。
     *
     *   ② 每行以「- 」开头。解析用宽松前缀，但规则里给出规范写法，
     *      让模型吐出来的东西尽量整齐，减少后端兜底解析的压力。
     *
     *   ③ 条数与长度都封死。这是贴在正文末尾的卡片，四条以内一眼看完；
     *      写成长段落就变成第二篇正文了。
     *
     * 人称刻意说明「用户视角第一人称」：卡片的语义是「接下来我可以说/做」，
     * 不是「角色会做什么」。写成角色动作的话，点下去等于替角色做决定。
     */
    function buildPlotHintRules(roleName, userName) {
        return (
            '【运转规则·剧情走向建议】\n' +
            '① 正文（以及状态栏，若启用）全部写完后，另起一段输出剧情走向建议，' +
            '用 <plot> 与 </plot> 包住，标记内不要写任何解释文字。\n' +
            '② 建议固定 3 到 4 条，每条独占一行，行首写「- 」（连字符 + 一个空格）。\n' +
            '③ 每条都必须是' + userName + '此刻**可以直接说出口或直接做出来**的一个具体选择，' +
            '用' + userName + '的第一人称写，例如「我说：…」「我把…递过去」「我什么都不说，只是站着」。\n' +
            '④ 四条之间要拉开方向差异：至少覆盖「主动推进」「试探/迂回」「退让或沉默」等不同走向，' +
            '不要四条都是同一个意思的改写。\n' +
            '⑤ 每条不超过 40 字，只写这一个动作或这一句话本身，不要附带解释、不要写结果、不要写' +
            roleName + '的反应。\n' +
            '⑥ 建议必须承接当前这一幕的处境与情绪，与' + roleName +
            '的人设、世界书设定都说得通；不得凭空引入新角色、新场景或与上文矛盾的信息。\n' +
            '⑦ <plot> 只出现在整段回复的最末尾，正文中间任何位置都不得出现该标记。'
        );
    }

    function buildWorldbookScopeBlock(contact, preset) {
        var roleName = String((contact && contact.name) || '当前联系人');
        var lines = [
            '【世界书·本场读取说明】',
            '线下场景注入下列词条；紧挨其后的【世界书·前/中/后】等为实际正文，须全部消化并在回应与叙事中落实：',
            '',
            '1、全局世界书（对所有联系人均可生效，不绑定角色）',
            '　· 「全软件」范围：所有 API 场景均可注入；注入位置由词条深度（前/中/后）决定，不再强制顶置。',
            '　· 「仅线下」「线上线下」等范围：仅在线下场景参与匹配；须关键词命中（无关键词则始终参与）。',
            '',
            '2、绑定该联系人的局部世界书（须生效范围包含线下）',
            '　· 「全软件」：绑定「' + roleName + '」后始终纳入（位置同样由深度决定）。',
            '　· 「仅线下」「线上线下」等：仅在线下场景参与；无关键词则始终纳入，有关键词须命中。',
            '　· 「仅线上」范围：本场不纳入。',
            '',
            '3、调参里额外挂载的词条',
            '　· 指线下「调参 → 额外挂世界书」里为本联系人勾选的词条，一律强制纳入。',
            '　· 不依赖关键词是否命中，须优先遵守其设定。'
        ];
        var bindings = (preset && preset.worldbookBindings) || [];
        if (bindings.length) {
            var wbStore = global.miyaWorldbookStore;
            var entryMap = {};
            if (wbStore && typeof wbStore.listEntries === 'function') {
                wbStore.listEntries().forEach(function (ent) {
                    if (ent && ent.id) entryMap[String(ent.id)] = ent;
                });
            }
            var names = bindings
                .map(function (b, i) {
                    var ent = entryMap[String((b && b.entryId) || '')];
                    var label = (ent && ent.name) || String((b && b.entryId) || '').trim();
                    return label ? String(i + 1) + '）' + label : '';
                })
                .filter(Boolean);
            if (names.length) {
                lines.push('', '【本场额外挂载】' + names.join('；') + '。');
            }
        } else {
            lines.push('', '【本场额外挂载】（未配置；使用上述全局与局部世界书。）');
        }
        return lines.join('\n');
    }


    function getGlobalUserMetaPrompt() {
        var chatEng = eng();
        if (chatEng && typeof chatEng.getGlobalPrompt === 'function') {
            return String(chatEng.getGlobalPrompt() || '').trim();
        }
        if (typeof global.miyaGetGlobalBreakPrompt === 'function') {
            return String(global.miyaGetGlobalBreakPrompt() || '').trim();
        }
        try {
            return String(localStorage.getItem('miya-global-break-prompt') || '').trim();
        } catch (e) {
            return '';
        }
    }

    function extractTurnDollarMeta(text) {
        var hp = htmlApi();
        if (hp && typeof hp.collectMetaDirectiveText === 'function') {
            return String(hp.collectMetaDirectiveText(text).metaOnly || '').trim();
        }
        var metaLines = [];
        String(text || '')
            .split(/\r?\n/)
            .forEach(function (line) {
                var trimmed = String(line || '').trim();
                if (/^[$＄]/.test(trimmed)) {
                    metaLines.push(trimmed.replace(/^[$＄]\s*/, ''));
                }
            });
        return metaLines.join('\n');
    }

    /** 线下：用户元指令置于整轮 messages 最末，优先级最高 */
    function buildOfflineUserMetaTailBlock(turnUserText) {
        var turnMeta = extractTurnDollarMeta(turnUserText);
        var globalMeta = getGlobalUserMetaPrompt();
        if (!turnMeta && !globalMeta) return '';
        var lines = [
            '【用户元指令·线下·最高优先级】',
            '若与上文系统提示或世界书等冲突，一律以本段为准。',
            '仍须贴合联系人档案与世界书核心设定，不得违背人设底线。'
        ];
        if (globalMeta) {
            lines.push('', '【审美母题·全局元指令】', globalMeta);
        }
        if (turnMeta) {
            lines.push('', '【本轮用户消息·$ 元指令】', turnMeta);
        }
        return lines.join('\n');
    }

    function appendOfflineUserMetaTail(apiMessages, turnUserText) {
        var block = buildOfflineUserMetaTailBlock(turnUserText);
        if (!block || !Array.isArray(apiMessages)) return;
        apiMessages.push({ role: 'system', content: block });
    }

    /**
     * 「重答」提示块 —— 专门用来打破「刷新了但还是同一段话」。
     *
     * 起因是一个看上去不像 bug 的 bug：用户点「刷新楼层 / 重回」，
     * 界面确实变了、候选也真的加了一条，但读起来跟上一版一字不差。
     *
     * 根因在输入侧：regenerateAppointment 调 runAppointmentCompletion 时
     * 传的 userText 是空串，而 buildApiMessages 里那段
     * 「if (extra) 才追加当前 user」的逻辑不会生效，于是**当前轮 user
     * 是直接从会话历史里倒着捞出来的上一条 user**。实测两次请求的
     * 会话段逐字节相同（只少了被软删的末条 assistant），相似度 91%：
     *
     *   首次生成：… user:问题X / assistant:角色对上轮的回答
     *   点刷新后：… user:问题X            ← 末条 assistant 被软删后消失
     *              + 倒着捞回来的 user:问题X 原地重复一次
     *
     * 也就是说，刷新时模型看到的上下文是「问题X … 问题X」中间**没有任何
     * 角色回复**，而且全篇没有一处告诉它「这是一次重答、请换个写法」。
     * 对它而言这就是同一次请求，重答当然收敛到同一段话。
     *
     * 所以这里补一条显式提示，明确四件事：
     *   ① 这不是新的一轮，是同一次提问的重答；
     *   ② 上一条角色回复已被撤回，不要把它当成已发生的事实续写；
     *   ③ 必须换一条不同的叙事路径，不许照搬上一版措辞与句式；
     *   ④ 人设、世界书、格式规则一律不变。
     *
     * 为什么不靠调 temperature：温度只影响采样随机性，在「输入完全相同」
     * 的前提下经常照样收敛；而且用户配置好的生成参数不该被我们偷偷改掉。
     * 真正缺的是**语义信号**，那就补语义信号。
     *
     * 位置与「元指令尾」同级（都在当前 user 之前、所有 system 之末），
     * 这样它离生成点最近，且不会插进历史中间破坏上下文连贯。
     */
    function buildRegenerateHintBlock(attempt) {
        var n = Math.floor(Number(attempt) || 0);
        var lines = [
            '【重答要求·本次为同一提问的重新生成】',
            '上一条角色回复已被撤回，它不再属于本次上下文，请勿把它当作已经发生的事实继续推进。',
            /*
             * ⚠️ 这一条针对「上一轮的提问还留在历史里、这一轮又来了新提问」的形态。
             *
             * 用户实测：昨天「我下飞机了」，今天「那你路上吃点东西」，刷新后角色
             * 仍答「在飞机上吃了」—— 因为上文里那句旧提问没有对应的回复压着，
             * 模型把它当成「我该回应的那句话」，于是回去接旧话题。
             * 所以必须显式说明：更早的提问已经讨论过了，生成目标是最后那一句。
             */
            '若下方历史里出现多段用户发言：更早的那些属于**已完成的前几轮**，已经得到过回应，你本轮**不要**再去回答它们；',
            '你本轮唯一要回应的，是**最后那一段**用户发言（通常紧贴在本提示之后）。',
            '本轮必须给出**不同于上一版**的内容：换一个切入点、换一组动作与对白、换一种叙事节奏，',
            '严禁复用上一版的句子结构、比喻、收尾方式与段落划分。',
            '但角色的身份、性格、说话习惯、与用户的关系，以及世界书核心设定与格式规则，一律保持不变。',
            '用户提出的问题与诉求不变，你要做的是给出另一种同样合理的演绎，而不是换一个话题。'
        ];
        if (n > 1) {
            /*
             * 连续重答时把次数带进去。
             *
             * 连点两三次「重回」后仍出同一段话，是很常见的抱怨 ——
             * 因为每一轮的输入都长得一模一样，模型没有任何「这是第几次」的概念。
             * 把序号写进提示，至少让「再刷一次」这件事在输入侧是可区分的。
             */
            lines.push('这是同一提问的第 ' + String(n) + ' 次重答，请比上一次的差异更明显一些。');
        }
        return lines.join('\n');
    }

    function htmlApi() {
        return global.MiyaChatHtml || null;
    }

    /**
     * 本轮用户正文：优先参数，否则取会话里「最后一次提问」。
     *
     * ⚠️ 这里原来只做「倒着找最后一条 user」，在正常发送路径上没问题，
     * 但在**重答**路径上会取错：重答时 extra 为空，被软删的是末条 assistant，
     * 历史末尾于是变成「… user:问题X / user:问题X」这种把同一条提问
     * 原地重复的形态（上一条被捞出来当了当前轮，历史里那条又还在）。
     *
     * 更糟的是「末条是 user」的场次：软删后倒着找会一路摸到**更早那一轮**
     * 的 user，把上一轮的提问当成这一轮的 —— 于是模型答的是另一个话题。
     *
     * 所以倒着找时要跳过「紧贴着末尾那一整段重复的连续 user」之前的形态：
     * 取到最后一条 user 之后，再看它前面是否还有 user；若有，说明末尾这段
     * 是合并缓冲（appendSessionHistory 会把连续 user 合并成一条），
     * 直接取该合并段即可 —— 合并段本身就是「最后一次提问」的完整形态。
     *
     * 注意：这个函数只负责定位「当前轮讲的是什么」，不负责标记来源。
     * 「当前轮是重答」这件事由 buildApiMessages 里那段注入逻辑显式告知模型
     * （它要把提示块插到当前 user **之前**，不能简单 append，所以直接内联，
     *  不再走一个独立的小转发函数）。
     */
    function resolveTurnUserText(messages, extra) {
        var t = String(extra || '').trim();
        if (t) return t;
        var list = Array.isArray(messages) ? messages : [];
        var i;
        for (i = list.length - 1; i >= 0; i--) {
            var m = list[i];
            if (m && m.role === 'user' && !m.deleted) {
                return String(m.content || '').trim();
            }
        }
        return '';
    }

    /**
     * 判断「这一次生成是不是重答」。
     *
     * 只看一个信号：handlers.replaceLastAssistant。
     * regenerateAppointment 会把它置 true，sendAppointment 不会设 ——
     * 语义边界很干净，不需要额外发明一套标志。
     */
    function isRegenerateRun(opts) {
        var o = opts && typeof opts === 'object' ? opts : {};
        return !!o.regenerate;
    }

    function finalizeAppointmentAssistantBody(parsed, htmlMode, chatId) {
        var body = String((parsed && parsed.content) || '').trim();
        if (!body) return { content: '', lines: [], renderAsHtml: false };

        /*
         * 剧情走向建议：必须最先摘走。
         *
         * 位置比状态栏还靠前，理由是「它在整段回复的最末尾、且是唯一一处
         * 带行首列表符号的结构」—— 越早剥掉，后面所有按行/按段处理的逻辑
         * （状态栏解析、splitDisplayParagraphs 分段）都不会把建议行卷进去。
         * 顺序反了的话，建议会被当成正文段落渲染一遍：正文里出现四行
         * 「- 我说：…」，末尾再挂一张同样的卡片，用户看到的是重复内容。
         *
         * 这里只做两件事：解析出列表、把标记从 body 里删掉。
         * 解析结果原样随消息落库（plotHints），渲染层直接取用，
         * 不在渲染时重复解析 —— 与 statusBar 的处理方式一致。
         */
        var plotApi = global.MiyaOfflinePlot;
        var plotItems = [];
        if (plotApi && typeof plotApi.extractPlotItems === 'function') {
            try {
                plotItems = plotApi.extractPlotItems(body) || [];
            } catch (ePlot) {
                plotItems = [];
            }
            if (typeof plotApi.stripPlot === 'function') {
                body = String(plotApi.stripPlot(body) || '');
            }
        }

        var statusApi = global.MiyaOfflineStatus;
        /*
         * 角色状态栏：在分段之前先摘走，理由和线上完全一致 ——
         * <STATUSBAR_DATA> 里是「字段: 值」逐行排列，进了 splitDisplayParagraphs
         * 会被拆成一段段正文，整块状态栏就散了。
         * 解析结果随消息落库（statusBar 字段），渲染时再套模板。
         *
         * ⚠️ 顺序铁律：parseFromText 靠 <miyastatus> 标记定位，必须**先解析、后剥离**。
         * 旧代码先 stripStatusFromText 再 parseFromText，标记先被删光，
         * 解析永远落空 —— 状态栏因此整块消失（剧情建议上线时引入的回归）。
         */
        var sbParsed = null;
        var sbMod = global.MiyaChatStatusBar;
        if (sbMod && typeof sbMod.parseFromText === 'function') {
            try {
                var sbCfg = typeof sbMod.resolveConfig === 'function'
                    ? sbMod.resolveConfig(global.miyaChatStore, chatId || '')
                    : null;
                if (!sbCfg || sbCfg.enabled !== false) {
                    var hit = sbMod.parseFromText(body);
                    if (hit && hit.fields && hit.fields.length) {
                        sbParsed = { fields: hit.fields, tag: hit.tag };
                    }
                }
            } catch (eSb) {}
        }
        if (statusApi && typeof statusApi.stripStatusFromText === 'function') {
            body = statusApi.stripStatusFromText(body);
        } else if (sbParsed && sbMod && typeof sbMod.stripFromText === 'function') {
            body = String(sbMod.stripFromText(body) || '');
        }
        var hpApi = htmlApi();
        if (htmlMode && hpApi && typeof hpApi.extractHtmlOnlyFromReply === 'function') {
            var hp = hpApi.extractHtmlOnlyFromReply(body);
            if (hp && hp.raw) {
                return {
                    content: hp.raw,
                    lines: [hp.raw],
                    renderAsHtml: true,
                    htmlRaw: hp.raw,
                    htmlPayload: hp,
                    statusBar: sbParsed,
                    plotHints: plotItems
                };
            }
        }
        var lines = splitDisplayParagraphs(body);
        if (!lines.length) {
            var salvage = stripThinking(body);
            if (statusApi && typeof statusApi.stripStatusFromText === 'function') {
                salvage = statusApi.stripStatusFromText(salvage);
            }
            if (salvage) lines = [salvage];
        }
        return {
            content: lines.join('\n\n'),
            lines: lines,
            renderAsHtml: false,
            statusBar: sbParsed,
            plotHints: plotItems
        };
    }


    function sessionSummaryRanges(session) {
        return ((session && session.summaryList) || []).map(function (row) {
            return {
                start: clampInt(row.startIndex, 0, 9999999, 0),
                end: clampInt(row.endIndex, 0, 9999999, 0)
            };
        });
    }

    function messageIndexCovered(idx, ranges) {
        if (!idx || !ranges.length) return false;
        for (var i = 0; i < ranges.length; i++) {
            var r = ranges[i];
            if (r.start && r.end && idx >= r.start && idx <= r.end) return true;
        }
        return false;
    }

    function buildSessionSummaryBlock(session) {
        var list = (session && session.summaryList) || [];
        if (!list.length) return '';
        var items = list
            .slice()
            .sort(function (a, b) {
                return (a.startIndex || 0) - (b.startIndex || 0);
            })
            .map(function (row, i) {
                var body = String((row && row.content) || '').trim();
                if (!body) return '';
                return (
                    '【线下场次总结' +
                    String(i + 1) +
                    ' · 第' +
                    String(row.startIndex || '?') +
                    '–' +
                    String(row.endIndex || '?') +
                    '条】\n' +
                    body
                );
            })
            .filter(Boolean);
        if (!items.length) return '';
        return '【当前场景·已总结段落】\n' + items.join('\n\n');
    }

    function appendSessionHistory(apiMessages, messages, chatSettings, session) {
        var buf = [];
        var aw = global.MiyaChatAwareness;
        var ranges = sessionSummaryRanges(session);
        function flushUser() {
            if (!buf.length) return;
            /*
             * 只有一条：原样送出，一个字节都不动（最常见的路径）。
             */
            if (buf.length === 1) {
                apiMessages.push({ role: 'user', content: buf[0] });
                buf = [];
                return;
            }
            /*
             * ⚠️ 多条 user 被合并时，必须标出「这是两段独立发言」。
             *
             * 背景：appendSessionHistory 会把相邻的 user 合成一条 —— 这在
             * 「用户连着补了两句」时是对的（SillyTavern 也是这个语义），
             * 但一旦中间夹着的角色回复被**删掉**，两条本来隔着对话的用户
             * 发言就会变成相邻、继而粘成一条：
             *
             *   删前：user:问题A / assistant:回复A / user:问题B
             *   删掉回复A → user:问题A / user:问题B  → "问题A\n\n问题B"
             *
             * 对模型而言，这读起来像**一次发言里说了两件事**，而不是
             * 「问了A、得到了回答、又问了B」。用户体感就是
             * 「我明明删了那一楼，生成出来的却还是跟删除前一模一样」——
             * 因为被删掉的回复所对应的**上下文关系**并没有跟着消失，
             * 两句提问仍然黏在一起被当成同一轮。
             *
             * 怎么判断「是不是两次发言」：一个楼层只会往 buf 里 push 一次
             * （下面 user 分支一次调用），所以 buf.length > 1 就等价于
             * 「这些内容来自不同楼层」= 两次独立发言。不需要额外记来源。
             *
             * 分隔符用一句极短的说明而不是空行：空行模型不敏感，
             * 一眼扫过去还是连着的；明确写出「以下是新的发言」它才会
             * 把两段当成前后两轮来读。
             */
            var parts = [];
            for (var bi = 0; bi < buf.length; bi++) {
                if (bi > 0) {
                    /* 带编号的硬分隔：让模型能数清这里有几次独立发言 */
                    parts.push(USER_TURN_DIVIDER.replace('%N%', String(bi + 1)));
                }
                parts.push(buf[bi]);
            }
            var mergedUserText = parts.join('');
            /*
             * 多段时补一条收尾指令，把生成目标钉死在最后一段。
             * 单段（绝大多数情况）不加，保证日常请求与改动前逐字节一致。
             */
            if (buf.length > 1) {
                mergedUserText += USER_TURN_TAIL.replace('%TOTAL%', String(buf.length));
            }
            apiMessages.push({ role: 'user', content: mergedUserText });
            buf = [];
        }
        (messages || []).forEach(function (m, i) {
            /*
             * 隐藏楼层不进 API：hidden 是用户手动标记的「不参与生成」层。
             * 此前只做了 CSS 隐藏，内容照样整段塞进请求里，等于白烧 token。
             * 这里直接跳过，隐藏层对模型完全不存在——不占上下文、不计费。
             * 注意要在开头就 return，避免落到下面的 flushUser() 把已攒的
             * user 缓冲合并错位。
             */
            if (!m || m.deleted || m.hidden) return;
            if (m.role === 'system' && m.type === 'opening') {
                flushUser();
                var openingBody = String(m.content || '').trim();
                if (openingBody) {
                    apiMessages.push({
                        role: 'system',
                        content: '【本场线下·开场白】\n' + openingBody
                    });
                }
                return;
            }
            if (messageIndexCovered(i + 1, ranges)) return;
            var body = String(m.content || '').trim();
            if (!body) return;
            /*
             * 历史里的 <miyaevent> 标记要剥掉再进请求。
             * 正常路径上这些标记在落库前就被 extractAndStore 摘走了，
             * 但旧楼层（接入前产生的回复）或导入的会话里可能还留着。
             * 不剥的话模型会把标签当成一种写法跟着学，
             * 从此每轮都吐一串 JSON，正文全被吃掉。
             */
            var teHistMod = global.MiyaChatTimeEvents;
            if (
                teHistMod &&
                typeof teHistMod.stripTags === 'function'
            ) {
                var teStripped = teHistMod.stripTags(body);
                if (teStripped != null) {
                    body = String(teStripped).trim();
                    if (!body) return;
                }
            }
            if (m.role === 'user') {
                /* 线下楼层保持纯正文，不加线上时间戳前缀 */
                buf.push(body);
                return;
            }
            flushUser();
            if (m.role === 'assistant') {
                apiMessages.push({ role: 'assistant', content: body });
            }
        });
        flushUser();
    }

    function buildAppointmentSystemPrompt(input) {
        var contact = input.contact;
        var profile = input.profile;
        var chatSettings = input.chatSettings;
        var preset = input.preset;
        var history = input.history || [];
        var contextText = String(input.contextText || '');
        var castContacts =
            Array.isArray(input.castContacts) && input.castContacts.length
                ? input.castContacts
                : contact
                  ? [contact]
                  : [];
        var parts = [];
        var aw = global.MiyaChatAwareness;
        var st = global.miyaChatStore;

        appendLayerListLocal(parts, input.worldbookFrontLayers);

        parts.push(buildAppointmentModeBlock(contact, profile, castContacts));
        parts.push(buildNovelWriterBlock(contact, profile));

        castContacts.forEach(function (c) {
            var contactProfile = renderContactProfileBlock(c);
            if (contactProfile) parts.push(contactProfile);
            if (aw && typeof aw.buildRelationshipLine === 'function') {
                var settingsFor = chatSettings;
                if (st && typeof st.findChatByContact === 'function' && c && c.id) {
                    var cChat = st.findChatByContact(c.id);
                    if (cChat && typeof st.getChatSettings === 'function') {
                        settingsFor = st.getChatSettings(cChat.id) || chatSettings;
                    }
                }
                var rel = aw.buildRelationshipLine(settingsFor, c);
                if (rel) {
                    parts.push(
                        castContacts.length > 1
                            ? '【与用户关系·' + String(c.name || '') + '】\n' + rel
                            : rel
                    );
                }
                var netBlock = aw.buildChronicleRelationshipBlock(c);
                if (netBlock) {
                    parts.push(
                        castContacts.length > 1
                            ? '【人际脉络·' + String(c.name || '') + '】\n' + netBlock
                            : netBlock
                    );
                }
            }
        });

        var userBlock = renderProfileBlock(profile);
        if (userBlock) parts.push(userBlock);
        if (eng() && typeof eng().buildAvatarRecognitionBlock === 'function') {
            var avatar = eng().buildAvatarRecognitionBlock(chatSettings, contact, profile);
            if (avatar) parts.push(avatar);
        }
        if (aw) {
            var timeRules = aw.buildTimeAwarenessRules(chatSettings, history, profile);
            if (timeRules) parts.push(timeRules);
            var placeRules = aw.buildPlaceAwarenessRules(chatSettings, contact, profile);
            if (placeRules) parts.push('【地点运转】\n' + placeRules);
            var weatherRules = aw.buildWeatherAwarenessRules(chatSettings);
            if (weatherRules) parts.push(weatherRules);
        }
        parts.push(buildWorldbookScopeBlock(contact, preset));
        var wbLayers = Array.isArray(input.worldbookLayers)
            ? input.worldbookLayers
            : buildWorldbookLayers(contact, contextText, preset);
        appendLayerListLocal(parts, wbLayers);
        parts.push(buildOfflineOperationRules(contact, profile, castContacts));
        var statusApi = global.MiyaOfflineStatus;
        if (
            statusApi &&
            typeof statusApi.isEnabled === 'function' &&
            statusApi.isEnabled() &&
            typeof statusApi.buildStatusRulesBlock === 'function'
        ) {
            /* 传 chatId：教学取模板须与楼层卡片渲染同层级（聊天级 > 全局级），
               否则聊天级模板的字段与教学字段错位，卡片只剩壳子。 */
            var statusRules = statusApi.buildStatusRulesBlock(castContacts, chatId);
            if (statusRules) parts.push(statusRules);
        }
        return parts.filter(Boolean).join('\n\n');
    }

    /** 线下：优先用联系人绑定的用户面具，而非全局当前面具或会话创建时的面具 */
    function resolveProfileForContact(st, contact, chat) {
        if (!st) return null;
        var profiles = st.getProfiles ? st.getProfiles() : [];
        var boundId = '';
        if (contact && contact.defaultProfileId) {
            boundId = String(contact.defaultProfileId).trim();
        }
        if (!boundId && chat && chat.profileId) {
            boundId = String(chat.profileId).trim();
        }
        if (boundId) {
            var found = profiles.find(function (p) {
                return p && p.id === boundId;
            });
            if (found) return found;
        }
        return st.getActiveProfile ? st.getActiveProfile() : null;
    }

    function resolveProfileForChat(st, chat) {
        if (!st || !chat) return null;
        var contact = st.findContact ? st.findContact(chat.contactId) : null;
        return resolveProfileForContact(st, contact, chat);
    }

    function buildApiMessages(chatId, sessionId, userText, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var st = global.miyaChatStore;
        var aps = apStore();
        if (!st || !aps) return { error: 'store_missing', messages: [] };
        var chat = st.findChat(chatId);
        if (!chat) return { error: 'chat_not_found', messages: [] };
        var contact = st.findContact(chat.contactId);
        if (!contact) return { error: 'contact_not_found', messages: [] };
        var profile = resolveProfileForChat(st, chat);
        if (!profile) return { error: 'profile_missing', messages: [] };
        var sess = aps.getSession(chatId, sessionId);
        if (!sess) return { error: 'session_not_found', messages: [] };
        var memMod = global.MiyaAppointmentMemory;
        var canonId = chatId;
        if (memMod && typeof memMod.resolveCanonicalChatId === 'function') {
            canonId = memMod.resolveCanonicalChatId(chatId) || chatId;
        }
        var settings = st.getChatSettings ? st.getChatSettings(chatId) : null;
        if (canonId && canonId !== chatId && st.getChatSettings) {
            var canonSettings = st.getChatSettings(canonId);
            if (canonSettings) settings = canonSettings;
        }
        var preset = aps.resolvePresetForContact(chat.contactId);
        /* 全量镜像改到 open/leave/seal，避免每轮发送阻塞主线程 */
        var sessionMsgs = aps.getSessionMessages(chatId, sessionId);
        var slice = sessionMsgs.slice();
        var castContacts = resolveSessionCastContacts(st, sess, contact);
        /* 【W11 修复】线下角色 ID 必须用**别名全集**，不能只手取 contact.id。
           ------------------------------------------------------------------
           旧实现：

               var castRoleIds = castContacts.map(function (c) {
                   return String((c && c.id) || '').trim();
               }).filter(Boolean);

           只取记录 id 一个值。而世界书面板的角色选择器
           （miya-worldbook-store.resolveAvailableRoles → contactsStore
           .resolveRolesForWorldbook）把同一个角色的 **characterId 和 id
           各列成一张卡**：

               [c.characterId, c.id].forEach(function (rid) { ... 各推一行 ... });

           用户点的是哪张卡，boundRoleIds 里存的就是哪个 ID。若存的是
           characterId，而这里只喂 contact.id，两者是否等价**完全依赖**
           matcher.expandRoleAliases 能通过 global.miyaContactsStore
           .findCharacter 把别名展开出来。

           实测（线下、局部词条绑角色、无关键词）：
             · contactsStore 就绪、别名可展开        → 命中 1
             · contactsStore 未就绪 / findCharacter 落空 → **命中 0**

           也就是说：**联系人存储稍有闪失，用户的局部词条就会集体「未命中」，
           且面板只报一个 0，不给任何线索。**

           线上链路不会这样 —— 它走 collectContactRoleIds(contact)，一次收
           characterId / chronicleId / store 里的 id/characterId 多个值，
           天然对别名不敏感。线下这里是自己攒的一份，比线上窄，属于老问题。

           修法：与线上同源，直接用 engine 导出的 collectContactRoleIds，
           并把 cast 里每个联系人的 ID 全集都并进来。 */
        var castRoleIds = [];
        (function () {
            var seen = Object.create(null);
            var push = function (v) {
                var id = String(v || '').trim();
                if (!id || seen[id]) return;
                seen[id] = true;
                castRoleIds.push(id);
            };
            var engRef2 = eng();
            var collectIds =
                engRef2 && typeof engRef2.collectContactRoleIds === 'function'
                    ? engRef2.collectContactRoleIds
                    : null;
            castContacts.forEach(function (c) {
                if (!c) return;
                /* 宽集合优先：characterId / chronicleId / store 别名一次收齐 */
                if (collectIds) {
                    try {
                        collectIds(c).forEach(push);
                    } catch (eCollect) { /* 落回窄集合，别因为一个联系人的取 ID 失败而全废 */ }
                }
                /* 兜底：无论 collectIds 是否可用，记录 id 一定要在 */
                push(c.id);
                push(c.characterId);
                push(c.chronicleId);
            });
        })();

        var mem = global.MiyaAppointmentMemory;
        var cross =
            mem && typeof mem.buildAppointmentCrossMemory === 'function'
                ? mem.buildAppointmentCrossMemory(canonId, contact, profile, settings, { sessionId: sessionId })
                : null;
        var worldbookContextText = buildWorldbookContextText(canonId, slice, userText, settings, cross);

        var wbBundle = { layers: [], matched: [], frontLayers: [], backLayers: [], inChatItems: [] };
        var engRef = eng();
        if (engRef && typeof engRef.buildWorldbookBundle === 'function') {
            if (castContacts.length > 1) {
                var bundles = castContacts.map(function (c) {
                    var cPreset = aps.resolvePresetForContact(c.id);
                    return engRef.buildWorldbookBundle(
                        c,
                        worldbookContextText,
                        appointmentWorldbookExtraBindings(cPreset),
                        appointmentWorldbookOpts({ roleIds: [c.id] })
                    );
                });
                wbBundle = mergeWorldbookBundles(bundles);
            } else {
                wbBundle = engRef.buildWorldbookBundle(
                    contact,
                    worldbookContextText,
                    appointmentWorldbookExtraBindings(preset),
                    appointmentWorldbookOpts({ roleIds: castRoleIds })
                );
            }
        } else {
            wbBundle.layers = buildWorldbookLayers(contact, worldbookContextText, preset);
        }
        var extra = String(userText || '').trim();
        var turnUserText = resolveTurnUserText(slice, extra);
        var hpApiEarly = htmlApi();
        /* 线下 HTML 仅由用户 $ 元指令触发，不用世界书，避免误伤正常叙事 */
        var htmlFromUserMeta =
            hpApiEarly &&
            typeof hpApiEarly.userOfflineMetaRequestsHtml === 'function' &&
            hpApiEarly.userOfflineMetaRequestsHtml(turnUserText);
        var htmlMode = !!htmlFromUserMeta;

        var apiMessages = [];
        /*
         * 线下与线上共用同一套 ST 主预设。
         * ST 前置规则位于线下运行上下文之前；ST 后置规则则在会话历史之后、
         * 当前用户消息之前。世界书仍由下方 buildAppointmentSystemPrompt 按原有机制注入，
         * 因此整体顺序为：ST 前置 → 线下上下文/世界书 → 会话历史 → ST 后置 → 当前用户消息。
         * 不在这里复制或生成任何文风、人称、字数、分段规则。
         */
        var stEngine = global.miyaChatEngine;
        var stPresetFrontMessages = [];
        var stPresetBackMessages = [];
        if (stEngine && typeof stEngine.buildStPresetMessages === 'function') {
            try {
                /* 带上 contact / profile / slice，让条目正文里的 {{char}} {{user}} {{lastMessage}}
                   等宏解析成真实值（与线上保持同一套解析器） */
                var stMacroOpts = { contact: contact, profile: profile, history: slice };
                stPresetFrontMessages = stEngine.buildStPresetMessages('front', stMacroOpts) || [];
                stPresetBackMessages = stEngine.buildStPresetMessages('back', stMacroOpts) || [];
                /* 【V9】必须复用 engine 的来源标记，不能手工重建 {role, content}。
                   手工重建会把 __src（条目名 / identifier / position / depth）
                   整个丢掉，于是「Token 来源明细」里这 20+ 条 ST 预设全部退化成
                   裸 system 消息，被分类器兜底成「其它系统块」，用户既看不到
                   条目名清单，也看不到「ST 预设」这一块的真实占比。
                   线上链路（miya-chat-engine.js 的 frontTagged）走的就是
                   stTaggedMessage，线下必须同构，否则同一次请求里
                   「ST 预设」的统计会因链路不同而分裂。 */
                var stTagger = typeof stEngine.stTaggedMessage === 'function'
                    ? stEngine.stTaggedMessage
                    : function (m) {
                        return {
                            role: m && (m.role === 'user' || m.role === 'assistant') ? m.role : 'system',
                            content: (m && m.content) || ''
                        };
                    };
                stPresetFrontMessages.forEach(function (m) {
                    if (!m || !String(m.content || '').trim()) return;
                    apiMessages.push(stTagger(m));
                });
            } catch (e) {}
        }
        var systemContent = buildAppointmentSystemPrompt({
            contact: contact,
            profile: profile,
            chatSettings: settings,
            preset: preset,
            history: slice,
            contextText: worldbookContextText,
            worldbookFrontLayers: wbBundle.frontLayers,
            worldbookLayers: wbBundle.layers,
            castContacts: castContacts
        });
        /*
         * 现实时钟事件账本（线下注入点）。
         *
         * 与线上 miya-chat-engine.js 的区别：那边用 !opts.appointmentMode 做守卫，
         * 因为线下也走同一个引擎、同一个 chatId，不挡住会在一次请求里注入两遍。
         * 线下这条路径本身就是 appointment 流程，没有重复问题，所以直接注入。
         *
         * 位置要紧贴系统层最后：账本描述的是「此刻的世界状态」，
         * 放在世界书/人物档案之前会被后面的规则盖过去，
         * 模型就只当背景知识读，不会真的按「已到期 / 已错过」来写。
         */
        var teMod = global.MiyaChatTimeEvents;
        if (teMod && typeof teMod.buildPromptContext === 'function') {
            try {
                var teContext = teMod.buildPromptContext(st, canonId || chatId, Date.now());
                if (teContext) apiMessages.push({ role: 'system', content: teContext });
            } catch (eTe) {}
        }
        apiMessages.push({ role: 'system', content: systemContent });

        if (mem && typeof mem.injectAppointmentCrossMemory === 'function') {
            mem.injectAppointmentCrossMemory(apiMessages, cross);
        } else if (cross) {
            if (cross.summaryText) {
                apiMessages.push({ role: 'system', content: cross.summaryText });
            }
            if (
                cross.slotItems &&
                cross.slotItems.length &&
                typeof mem.injectCrossMemoryToApiMessages === 'function'
            ) {
                mem.injectCrossMemoryToApiMessages(apiMessages, cross.slotItems, '线上及往期线下');
            }
        }

        var historyStart = apiMessages.length;
        appendSessionHistory(apiMessages, slice, settings, sess);

        /*
         * 真正按 SillyTavern 的 In-Chat 方式注入：
         * injection_position=1 不是“历史后面再 append 一条 system”，而是
         * 按 injection_depth / injection_order 插入聊天记录内部。
         */
        if (stEngine && typeof stEngine.injectStInChatMessages === 'function') {
            try {
                stEngine.injectStInChatMessages(apiMessages, historyStart, stPresetBackMessages);
            } catch (e) {}
        } else {
            /* 兜底：engine 没导出注入器时也要保住 __src 标记，
               否则 back 条目同样会掉进「其它系统块」。 */
            var stTaggerBack = stEngine && typeof stEngine.stTaggedMessage === 'function'
                ? stEngine.stTaggedMessage
                : function (m) {
                    return { role: m && m.role ? m.role : 'system', content: (m && m.content) || '' };
                };
            stPresetBackMessages.forEach(function (m) {
                if (!m || !String(m.content || '').trim()) return;
                apiMessages.push(stTaggerBack(m));
            });
        }

        /*
         * 关键修复：当前用户消息必须是请求里的最后一条 user。
         * 旧版先 push user、再追加世界书 back，导致「当前用户」后面还有 system，
         * ST/世界书的后置层不再是真正的生成末端。
         */
        if (engRef && typeof engRef.appendWorldbookBackMessages === 'function') {
            /* 深度注入先于 back 追加：理由同 miya-chat-engine.js ——
               back 会让 apiMessages 变长，先追加会让 depth 的定位基数偏移。 */
            if (typeof engRef.insertWorldbookInChatMessages === 'function') {
                engRef.insertWorldbookInChatMessages(apiMessages, wbBundle.inChatItems);
            }
            engRef.appendWorldbookBackMessages(apiMessages, wbBundle.backLayers);
        } else {
            (wbBundle.backLayers || []).forEach(function (layer) {
                var t = String(layer || '').trim();
                if (t) apiMessages.push({ role: 'system', content: t });
            });
        }

        /*
         * ST 最终执行层：必须是所有 system 规则里的最后一层，紧贴本轮 user。
         * 这样即使世界书存在后置注入，也不能把 ST COT/身份/环境规则隔开。
         *
         * 这里必须真正把 ST 预设原文送进请求：ST 的工作流是
         * 「先读提示词与预设 → 生成思维链 CoT → 再输出正文」，
         * 因此启用条目的身份 / 环境 / 世界观 / 人称 / 格式等规则
         * 必须出现在思维链开始之前、且尽量贴近生成点。
         * 否则模型会另起一套默认角色设定，表现为
         * 「思维链里全是默认内容，没有我导入的预设身份」。
         * 原先 buildStCotPromptBlock() 只定义与导出、从未被调用，属于断链，此处补上。
         *
         * 去重：条目正文已在 buildStPresetMessages 阶段注入（relative 在前、
         * in_chat 按深度插入历史内）。这里不再重复整份原文，只补一条轻量的
         * 「执行检查」提示，避免同一段规则出现两次、白白占用上下文。
         * 仅当本轮没有任何 ST 条目注入时，才退化为全量兜底输出。
         */
        if (stEngine && typeof stEngine.buildStCotPromptBlock === 'function') {
            try {
                var stInjected = (stPresetFrontMessages || []).concat(stPresetBackMessages || [])
                    .some(function (m) { return String(m && m.content || '').trim(); });
                if (stInjected) {
                    if (typeof stEngine.buildStPresetCheckHint === 'function') {
                        var stHint = String(stEngine.buildStPresetCheckHint() || '').trim();
                        if (stHint) apiMessages.push({ role: 'system', content: stHint });
                    }
                } else {
                    var stCotBlock = String(stEngine.buildStCotPromptBlock() || '').trim();
                    if (stCotBlock) {
                        apiMessages.push({ role: 'system', content: stCotBlock });
                    }
                }
            } catch (eStCot) {}
        }
        if (htmlMode && hpApiEarly) {
            apiMessages.push({
                role: 'system',
                content: hpApiEarly.buildHtmlGenerationRules({
                    mode: 'offline',
                    fromUserMeta: true
                })
            });
        }
        appendOfflineUserMetaTail(apiMessages, turnUserText);

        /* 当前轮 user 永远是最后一条消息：ST/HTML/元指令全部位于 user 之前。 */
        if (extra) {
            var last = apiMessages[apiMessages.length - 1];
            if (last && last.role === 'user') {
                last.content = last.content ? last.content + USER_MSG_JOIN + extra : extra;
            } else {
                apiMessages.push({ role: 'user', content: extra });
            }
        }

        /*
         * 重答提示：必须插在**当前轮 user 之前**，紧贴生成点。
         *
         * ── 为什么要「插在 user 之前」而不是 append 到末尾 ──
         *
         * 这段代码原来是无脑 append 的，位置在「元指令尾之后、当前 user 之前」。
         * 那个位置在**正常发送**路径上是对的：appendSessionHistory 已经把
         * 当前轮 user 写进历史、成为最后一条，append 上去的提示块正好落在
         * user 之前。原注释也是照这个情形写的。
         *
         * 但**重答路径**（刷新 / 重发 / › 键）的形态完全不同：
         *
         *   · 被刷的那一层已经被软删，getSessionMessages 把它滤掉了；
         *   · runAppointmentCompletion 调 buildApiMessages 时传的 extra 是空串
         *     （见那里 `buildApiMessages(chatId, sessionId, '', {...})`），
         *     所以下面那个 `if (extra)` 分支**根本不会执行**。
         *
         * 两件事叠起来：历史里最后一条活着的恰好就是那条 user（被刷的
         * assistant 已经软删了），appendSessionHistory 把它正常 push 进去，
         * 于是提示块 append 到它**后面**，请求尾巴长成：
         *
         *     … user:你还记得去年那场雨吗？
         *       system:【重答要求·…】        ← 最后一条是 system
         *
         * 最后一条不是 user，这是对话补全里最容易出事的一种形态：
         * 多数网关/模型会把它读成「系统在补充规则、还没轮到我说」，
         * 于是要么续写得很保守、要么直接照着上一条 assistant 的语感收尾 ——
         * 表现就是**刷新出来的内容跟刚才高度雷同**。
         *
         * 正确形态是提示块插在 user 之前、user 仍然垫底：
         *
         *     … system:【重答要求·…】
         *       user:你还记得去年那场雨吗？   ← 最后一条是 user
         *
         * ── 怎么定位插入点 ──
         *
         * 从末尾往前找第一条 user，插在它前面。这样不论 extra 分支跑没跑、
         * 历史里有没有 user，落点都对：
         *   · 正常发送 → user 是最后一条，提示块插到它前面（与此前一致）；
         *   · 重答     → 命中历史里那条 user，提示块不再跑到它后面。
         *
         * 找不到 user 时退化为 append（并把 user 补回去，见下），
         * 保证「最后一条永远是 user」这条不变式无论如何都成立。
         *
         * 只在重答路径注入，正常发送完全不受影响。
         */
        if (isRegenerateRun(opts)) {
            var hintBlock = buildRegenerateHintBlock(opts.regenerateAttempt);
            var lastUserIdx = -1;
            for (var ui2 = apiMessages.length - 1; ui2 >= 0; ui2--) {
                if (apiMessages[ui2] && apiMessages[ui2].role === 'user') {
                    lastUserIdx = ui2;
                    break;
                }
            }
            if (lastUserIdx >= 0) {
                apiMessages.splice(lastUserIdx, 0, { role: 'system', content: hintBlock });
            } else {
                /*
                 * 极罕见：整段上下文里一条 user 都没有（比如用户把提问层
                 * 也删了再刷新）。此时提示块 append 上去会把 system 顶到
                 * 末尾，所以补一条空的 user 垫底 —— 后面若还有 extra 分支
                 * 也会正确合并进这一条。
                 */
                apiMessages.push({ role: 'system', content: hintBlock });
                apiMessages.push({ role: 'user', content: '' });
            }
        }

        var debugResult = {
            messages: apiMessages.map(function (m, i) {
                return { index: i, role: m.role, content: String(m.content || '') };
            }),
            stFront: stPresetFrontMessages.map(function (m) { return Object.assign({}, m); }),
            stBack: stPresetBackMessages.map(function (m) { return Object.assign({}, m); }),
            chatId: chatId,
            sessionId: sessionId
        };
        try { global.__MiyaLastOfflinePrompt = debugResult; } catch (eDbg) {}
        return {
            messages: apiMessages,
            contact: contact,
            profile: profile,
            chat: chat,
            session: sess,
            preset: preset,
            htmlMode: !!htmlMode,
            debug: debugResult,
            /* 世界书统计随 built 透出（与线上 miya-chat-engine 的 built.worldbookMeta
               同名同构）：runAppointmentCompletion 收尾要拿它拼「本轮真实发送」的
               快照写进宿主 chat 行 —— 缺了这份 meta，快照里的世界书
               命中数/候选数/注入字符数就全是 0，等于白写。 */
            worldbookMeta: (wbBundle && wbBundle.meta) || null,
            /* 【W11 诊断】供 writeOfflinePromptSnapshot 在 0 命中时还原现场：
               explainEntry 需要的 contextText 与本次下发的角色 ID 集合。
               不带上这两样，快照里就只剩一个光秃秃的 0，用户和排查者都无从下手。 */
            worldbookDiagContext: worldbookContextText || '',
            worldbookDiagRoleIds: castRoleIds.slice()
        };
    }

    function normalizeBaseUrl(base) {
        if (eng() && global.miyaChatEngine) {
            /* duplicate from engine - use config */
        }
        var t = String(base || '').trim().replace(/\/+$/, '');
        if (!t) return '';
        try {
            var u = new URL(t);
            var path = (u.pathname || '/').replace(/\/+$/, '');
            var segs = path.split('/').filter(Boolean);
            if (segs.length && segs[segs.length - 1].toLowerCase() === 'v1') return u.origin + path;
            if (!path || path === '/') return u.origin + '/v1';
            return u.origin + path + '/v1';
        } catch (e) {
            return t.toLowerCase().endsWith('/v1') ? t : t + '/v1';
        }
    }

    function getApiConfig() {
        if (typeof global.miyaGetApiConfigCached === 'function') return global.miyaGetApiConfigCached();
        return {};
    }

    function appointmentStreamEnabled(cfg) {
        var c = cfg && typeof cfg === 'object' ? cfg : getApiConfig();
        return c.appointmentStream !== false;
    }

    /**
     * 读取 ST「生成参数」面板里的采样设置。
     * 线下与线上共用同一套 ST 预设，线上（miya-chat-engine.js 的
     * getStGenerationSettings）已经在用；线下此前完全没读，属遗漏。
     * 读不到时返回空对象，由各处自行回退，行为与旧版一致。
     */
    function getStGenerationSettings() {
        try {
            var st = global.miyaStPromptPresetsStore;
            if (st && typeof st.getActiveGeneration === 'function') {
                return st.getActiveGeneration() || {};
            }
        } catch (e) { /* ignore */ }
        return {};
    }

    /** 温度：ST 优先，其次 API 配置，最后兜底 1（与线上取值顺序一致）。 */
    function appointmentTemperature(cfg, stGen) {
        var g = stGen && typeof stGen === 'object' ? stGen : {};
        if (g.temperature != null && Number.isFinite(Number(g.temperature))) {
            return Number(g.temperature);
        }
        var c = cfg && typeof cfg === 'object' ? cfg : {};
        if (c.temperature != null && Number.isFinite(Number(c.temperature))) {
            return Number(c.temperature);
        }
        return 1;
    }

    /**
     * 把 ST 生成参数映射到 OpenAI 兼容请求体。
     * 只在本轮确实有值时上送，缺省项不下发（沿用网关默认），
     * 与线上 miya-chat-engine.js 的处理保持一致。
     * 注意：不处理 stream —— 线下流式由「输出方式」下拉单独控制。
     */
    function applyStGenerationToPayload(payload, stGen) {
        if (!payload || typeof payload !== 'object') return payload;
        var g = stGen && typeof stGen === 'object' ? stGen : {};
        if (g.maxTokens != null && Number.isFinite(Number(g.maxTokens)) && Number(g.maxTokens) > 0) {
            payload.max_tokens = Math.floor(Number(g.maxTokens));
        }
        if (g.topP != null && Number.isFinite(Number(g.topP))) {
            payload.top_p = Number(g.topP);
        }
        if (g.frequencyPenalty != null && Number.isFinite(Number(g.frequencyPenalty))) {
            payload.frequency_penalty = Number(g.frequencyPenalty);
        }
        if (g.presencePenalty != null && Number.isFinite(Number(g.presencePenalty))) {
            payload.presence_penalty = Number(g.presencePenalty);
        }
        return payload;
    }

    function normalizeMessageContent(content) {
        if (content == null) return '';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            var parts = [];
            content.forEach(function (part) {
                if (part == null) return;
                if (typeof part === 'string') {
                    if (part) parts.push(part);
                    return;
                }
                if (typeof part === 'object') {
                    var t =
                        part.text != null
                            ? part.text
                            : part.content != null
                              ? part.content
                              : part.output_text != null
                                ? part.output_text
                                : part.value;
                    if (t != null && String(t)) parts.push(String(t));
                }
            });
            return parts.join('\n');
        }
        var s = String(content);
        return s === '[object Object]' ? '' : s;
    }

    function extractStreamParts(obj) {
        if (!obj || typeof obj !== 'object') return { content: '', reasoning: '' };
        var ch = obj.choices && obj.choices[0];
        if (!ch) return { content: '', reasoning: '' };
        var d = ch.delta && typeof ch.delta === 'object' ? ch.delta : ch.message && typeof ch.message === 'object' ? ch.message : {};
        var out = { content: '', reasoning: '' };
        if (d.content != null) out.content = normalizeMessageContent(d.content);
        if (d.reasoning_content != null) out.reasoning = normalizeMessageContent(d.reasoning_content);
        else if (d.reasoning != null) out.reasoning = normalizeMessageContent(d.reasoning);
        if (!out.content && ch.text != null) out.content = normalizeMessageContent(ch.text);
        return out;
    }

    function buildStreamDisplayRaw(contentAcc, reasoningAcc) {
        var c = String(contentAcc || '');
        var r = String(reasoningAcc || '').trim();
        if (r && !/<thinking>/i.test(c) && !/＜thinking＞/i.test(c)) {
            return '<thinking>' + r + '</thinking>\n\n' + c;
        }
        return c;
    }

    function extractReplyContent(data) {
        var e = eng();
        if (e && typeof e.extractReplyContent === 'function') return e.extractReplyContent(data);
        if (!data) return '';
        if (data.choices && data.choices[0]) {
            var ch = data.choices[0];
            if (ch.message && ch.message.content != null) return normalizeMessageContent(ch.message.content).trim();
            if (ch.text != null) return normalizeMessageContent(ch.text).trim();
        }
        if (data.content != null) return normalizeMessageContent(data.content).trim();
        return '';
    }

    /**
     * 线下专用：某些模型/网关会把 reasoning_content 同时复制进 message.content。
     * 这种情况下 parseThinking 已经拿到了真正的思维链，但正文仍会完整重复一份。
     * 这里只处理“正文与思维链高度重复”的情况，不按关键词粗暴删除，避免误伤正常剧情。
     */
    function stripDuplicatedOfflineThinking(content, thinking) {
        var body = String(content || '').trim();
        var think = String(thinking || '').trim();
        if (!body || !think) return body;

        function norm(s) {
            return String(s || '')
                .replace(/\r/g, '')
                .replace(/[ \t]+/g, ' ')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }

        var b = norm(body);
        var t = norm(think);
        if (b === t) return '';

        // 只有当正文开头与 thinking 有很长且高度一致的重叠时才剥离。
        // 这样“思考后真正开始写剧情”的正文会保留下来。
        var max = Math.min(b.length, t.length);
        if (max < 80) return body;
        var common = 0;
        while (common < max && b.charAt(common) === t.charAt(common)) common += 1;

        var threshold = Math.max(80, Math.floor(Math.min(t.length, b.length) * 0.72));
        if (common < threshold) return body;

        // 优先从一个完整的 thinking 结尾切掉；如果只是轻微尾部差异，则保留差异部分。
        if (b.indexOf(t) === 0) {
            var rest = b.slice(t.length).trim();
            return rest;
        }

        // 常见情况是末尾多一个标点/换行，允许在 thinking 末尾附近切分。
        var cut = common;
        while (cut > 0 && /[\s，。！？；：、,!?;:]/.test(b.charAt(cut - 1))) cut -= 1;
        var rest2 = b.slice(cut).trim();
        return rest2 && rest2 !== b ? rest2 : '';
    }

    function parseAppointmentResponse(fullRaw, data) {
        var raw = String(fullRaw || '');
        var e = eng();
        var thinking = '';
        if (e && typeof e.extractThinkingFromResponse === 'function') {
            thinking = String(e.extractThinkingFromResponse(data, raw) || '').trim();
        }
        var parsed =
            e && typeof e.parseThinking === 'function' ? e.parseThinking(raw) : parseThinkingPayload(raw);
        if (!thinking && parsed.thinking) thinking = String(parsed.thinking || '').trim();
        var content = String(parsed.content || '').trim();
        if (!content) {
            var salvaged = salvageAppointmentParsedContent(raw, parsed);
            content = String(salvaged.content || '').trim();
            if (!thinking && salvaged.thinking) thinking = String(salvaged.thinking || '').trim();
        }
        if (!content && data) {
            var apiBody = extractReplyContent(data);
            if (apiBody) {
                var alt =
                    e && typeof e.parseThinking === 'function'
                        ? e.parseThinking(apiBody)
                        : parseThinkingPayload(apiBody);
                if (String(alt.content || '').trim()) content = String(alt.content || '').trim();
                if (!thinking && alt.thinking) thinking = String(alt.thinking || '').trim();
            }
            if (!content) {
                var msg = data.choices && data.choices[0] && data.choices[0].message;
                if (msg) {
                    var rsnPart =
                        msg.reasoning_content != null ? msg.reasoning_content : msg.reasoning;
                    if (rsnPart != null) {
                        var rsn = normalizeMessageContent(rsnPart).trim();
                        if (rsn) {
                            var rParsed =
                                e && typeof e.parseThinking === 'function'
                                    ? e.parseThinking(rsn)
                                    : parseThinkingPayload(rsn);
                            var rBody = String(rParsed.content || '').trim();
                            if (!rBody) rBody = String(stripThinkingFromBody(rsn) || '').trim();
                            if (rBody && rBody !== thinking) content = rBody;
                        }
                    }
                }
            }
        }
        // 线下专用去重：只在正文高度重复思维链时处理。
        content = stripDuplicatedOfflineThinking(content, thinking);
        return { thinking: thinking, content: content };
    }

    function findFirstThinkingClose(raw) {
        var src = String(raw || '');
        var tags = [/<\/thinking>/i, /＜\/thinking＞/i];
        var best = null;
        tags.forEach(function (re) {
            var m = src.match(re);
            if (m && m.index != null && (best == null || m.index < best.index)) {
                best = { index: m.index, length: m[0].length };
            }
        });
        return best;
    }

    function findFirstThinkingOpen(raw) {
        var src = String(raw || '');
        var tags = [/<thinking>/i, /＜thinking＞/i];
        var best = null;
        tags.forEach(function (re) {
            var m = src.match(re);
            if (m && m.index != null && (best == null || m.index < best.index)) {
                best = { index: m.index, length: m[0].length };
            }
        });
        return best;
    }

    function extractClosedThinkingText(raw) {
        var src = String(raw || '');
        var patterns = [
            /<thinking>([\s\S]*?)<\/thinking>/i,
            /＜thinking＞([\s\S]*?)＜\/thinking＞/i
        ];
        var i;
        for (i = 0; i < patterns.length; i++) {
            var m = src.match(patterns[i]);
            if (m && m[1] != null) return String(m[1]).trim();
        }
        return '';
    }

    function stripThinkingFromBody(text) {
        var e = eng();
        if (e && typeof e.parseThinking === 'function') {
            return String(e.parseThinking(text).content || '').trim();
        }
        return String(text || '')
            .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
            .replace(/<thinking>[\s\S]*$/gi, '')
            .replace(/＜thinking＞[\s\S]*?＜\/thinking＞/gi, '')
            .replace(/＜thinking＞[\s\S]*$/gi, '')
            .trim();
    }

    /** 思维链与正文严格分离：已闭合时正文只取首个 </thinking> 之后，避免流式时正文并入思维链 */
    function parseThinkingPayload(text) {
        var raw = String(text || '');
        if (!raw.trim()) return { thinking: '', content: '' };

        var close = findFirstThinkingClose(raw);
        if (close) {
            var eClose = eng();
            if (eClose && typeof eClose.parseThinking === 'function') {
                return eClose.parseThinking(raw);
            }
            return {
                thinking: extractClosedThinkingText(raw),
                content: stripThinkingFromBody(raw.slice(close.index + close.length))
            };
        }

        var open = findFirstThinkingOpen(raw);
        if (open) {
            var eOpen = eng();
            if (eOpen && typeof eOpen.parseThinking === 'function') {
                return eOpen.parseThinking(raw);
            }
            return {
                thinking: raw.slice(open.index + open.length).trim(),
                content: stripThinkingFromBody(raw)
            };
        }

        var e = eng();
        if (e && typeof e.parseThinking === 'function') {
            return e.parseThinking(raw);
        }
        return { thinking: '', content: raw.trim() };
    }

    function salvageAppointmentParsedContent(fullRaw, parsed) {
        var p = parsed && typeof parsed === 'object' ? parsed : { thinking: '', content: '' };
        var content = String(p.content || '').trim();
        if (content) return p;
        var raw = String(fullRaw || '').trim();
        if (!raw) return p;
        var e = eng();
        if (e && typeof e.parseThinking === 'function') {
            var alt = e.parseThinking(raw);
            if (String(alt.content || '').trim()) {
                return {
                    thinking: String(alt.thinking || p.thinking || '').trim(),
                    content: String(alt.content || '').trim()
                };
            }
        }
        var stripped = stripThinkingFromBody(raw);
        if (String(stripped || '').trim()) {
            return { thinking: String(p.thinking || '').trim(), content: stripped };
        }
        return { thinking: String(p.thinking || '').trim(), content: '' };
    }

    function stripThinking(text) {
        return parseThinkingPayload(text).content;
    }

    function stripTimelineFromParagraph(para) {
        var aw = global.MiyaChatAwareness;
        if (!aw || typeof aw.stripTimelinePrefixForDisplay !== 'function') {
            return String(para || '').trim();
        }
        return String(para || '')
            .split('\n')
            .map(function (line) {
                return aw.stripTimelinePrefixForDisplay(line);
            })
            .join('\n')
            .trim();
    }

    /** 线下正文分段：优先「空一行」为段；若无空行则按单行分段 */
    function splitDisplayParagraphs(text) {
        var body = stripThinking(text);
        body = String(body || '').trim();
        if (!body) return [];
        var parts = body
            .split(/\n\s*\n+/)
            .map(function (s) {
                return String(s || '').trim();
            })
            .filter(Boolean);
        if (parts.length <= 1 && /\n/.test(body)) {
            var lines = body
                .split(/\n/)
                .map(function (s) {
                    return String(s || '').trim();
                })
                .filter(Boolean);
            if (lines.length > 1) parts = lines;
        }
        parts = parts.map(stripTimelineFromParagraph).filter(Boolean);
        if (parts.length) return parts;
        var fallback = stripTimelineFromParagraph(body);
        return fallback ? [fallback] : [];
    }

    function splitDisplayLines(text) {
        var body = stripThinking(text);
        body = String(body || '').trim();
        if (!body) return [];
        return body
            .split(/\n/)
            .map(function (s) {
                return stripTimelineFromParagraph(s);
            })
            .filter(Boolean);
    }

    var replyInFlight = Object.create(null);

    function fetchAppointmentCompletion(url, headers, payload, handlers, useStream) {
        handlers = handlers && typeof handlers === 'object' ? handlers : {};
        var streamOn = useStream !== false;

        function emitDisplay(contentAcc, reasoningAcc) {
            var display = buildStreamDisplayRaw(contentAcc, reasoningAcc);
            if (handlers.onDelta) handlers.onDelta(display, display);
            return display;
        }

        if (!streamOn) {
            var body = Object.assign({}, payload);
            body.stream = false;
            function doFetch(bodyToSend) {
                var fo = {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(bodyToSend)
                };
                if (handlers.signal) fo.signal = handlers.signal;
                return fetch(url, fo);
            }
            return doFetch(body).then(function (res) {
                if (!res.ok && body.thinking && [400, 404, 422].indexOf(res.status) >= 0) {
                    return res.text().catch(function () { return ''; }).then(function () {
                        var retryBody = Object.assign({}, body);
                        delete retryBody.thinking;
                        return doFetch(retryBody);
                    });
                }
                return res;
            }).then(function (res) {
                if (!res.ok) {
                    return res.text().then(function (t) {
                        throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : ''));
                    });
                }
                return res.json().then(function (data) {
                    var msg = data && data.choices && data.choices[0] && data.choices[0].message;
                    var contentPart = msg ? normalizeMessageContent(msg.content) : '';
                    var reasoningPart = '';
                    if (msg) {
                        if (msg.reasoning_content != null) {
                            reasoningPart = normalizeMessageContent(msg.reasoning_content);
                        } else if (msg.reasoning != null) {
                            reasoningPart = normalizeMessageContent(msg.reasoning);
                        }
                    }
                    if (!contentPart) contentPart = extractReplyContent(data);
                    var display = buildStreamDisplayRaw(contentPart, reasoningPart);
                    if (handlers.onDelta) handlers.onDelta(display, display);
                    return { raw: display, data: data };
                });
            });
        }

        var req = Object.assign({}, payload);
        req.stream = true;
        function doStreamFetch(bodyToSend) {
            var fo = {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(bodyToSend)
            };
            if (handlers.signal) fo.signal = handlers.signal;
            return fetch(url, fo);
        }
        return doStreamFetch(req).then(function (res) {
            if (!res.ok && req.thinking && [400, 404, 422].indexOf(res.status) >= 0) {
                return res.text().catch(function () { return ''; }).then(function () {
                    var retryReq = Object.assign({}, req);
                    delete retryReq.thinking;
                    return doStreamFetch(retryReq);
                });
            }
            return res;
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (t) {
                    throw new Error('HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : ''));
                });
            }
            if (!res.body || !res.body.getReader) {
                return res.json().then(function (data) {
                    var reply = extractReplyContent(data);
                    emitDisplay(reply, '');
                    return { raw: reply, data: data };
                });
            }
            var reader = res.body.getReader();
            var decoder = new TextDecoder('utf-8');
            var buffer = '';
            var contentAcc = '';
            var reasoningAcc = '';

            /* 读流中断韧性。
               线下是长文生成，中途断一次就丢掉整段回复代价很大，
               所以这里以已收内容收尾，并标记 partial 让上层提示用户。
               注意：不再是「退避续读」——同一个 reader 出错后不会复活，
               重试只会白等 1.2 秒（实测：重试拿到的永远是同一个错误）。 */
            function hasAny() {
                return !!(String(contentAcc || '').length || String(reasoningAcc || '').length);
            }
            function finishPartial(err) {
                if (buffer.trim()) {
                    var tailLine = buffer.trim();
                    if (tailLine.indexOf('data:') === 0) tailLine = tailLine.slice(5).trim();
                    if (tailLine && tailLine !== '[DONE]') {
                        try {
                            var tailObj = JSON.parse(tailLine);
                            var tailDelta = extractStreamParts(tailObj);
                            if (tailDelta.reasoning) reasoningAcc += tailDelta.reasoning;
                            if (tailDelta.content) contentAcc += tailDelta.content;
                        } catch (eTail) { /* 半截行，忽略 */ }
                    }
                }
                if (typeof handlers.onPartial === 'function') {
                    try {
                        handlers.onPartial({
                            reason: (err && err.name === 'StreamIdleTimeout') ? 'idle_timeout' : 'disconnected',
                            message: String((err && err.message) || '流式中断')
                        });
                    } catch (eCb) {}
                }
                var partial = emitDisplay(contentAcc, reasoningAcc);
                return { raw: partial, data: null, partial: true };
            }

            return (function pump() {
                var idleTimer = null;
                var stalled = false;
                function clearIdle() {
                    if (idleTimer != null) { clearTimeout(idleTimer); idleTimer = null; }
                }
                /* 空闲超时看门狗：每收到一块数据就重置。
                   只判断「有没有进展」，不限制总时长——长文生成本就会持续很久。 */
                function armIdle() {
                    clearIdle();
                    idleTimer = setTimeout(function () {
                        stalled = true;
                        if (global.console && console.warn) {
                            console.warn('[miya] 线下流式空闲超时（' + STREAM_IDLE_TIMEOUT_MS + 'ms 无数据），以已收内容收尾');
                        }
                        try { reader.cancel(); } catch (e) { /* 尽力而为 */ }
                    }, STREAM_IDLE_TIMEOUT_MS);
                }
                function step() {
                    if (stalled) {
                        var idleErr = new Error('流式空闲超时');
                        idleErr.name = 'StreamIdleTimeout';
                        if (!hasAny()) throw idleErr;
                        return finishPartial(idleErr);
                    }
                    armIdle();
                    return reader.read().then(function (result) {
                        clearIdle();
                        if (result.done) {
                            var display = emitDisplay(contentAcc, reasoningAcc);
                            return { raw: display, data: null };
                        }
                        buffer += decoder.decode(result.value, { stream: true });
                        var parts = buffer.split('\n');
                        buffer = parts.pop() || '';
                        parts.forEach(function (line) {
                            var trimmed = line.trim();
                            if (!trimmed || trimmed === 'data: [DONE]') return;
                            if (trimmed.indexOf('data:') === 0) trimmed = trimmed.slice(5).trim();
                            if (!trimmed || trimmed === '[DONE]') return;
                            try {
                                var obj = JSON.parse(trimmed);
                                var delta = extractStreamParts(obj);
                                if (delta.reasoning) reasoningAcc += delta.reasoning;
                                if (delta.content) contentAcc += delta.content;
                                if (delta.reasoning || delta.content) emitDisplay(contentAcc, reasoningAcc);
                            } catch (e) {}
                        });
                        return step();
                    }, function (err) {
                        clearIdle();
                        /* 用户主动中止（停止生成）→ 原样抛出，不做部分收尾 */
                        var aborted = !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError'));
                        if (aborted) throw err;
                        /* 无内容可保 → 真失败 */
                        if (!hasAny()) throw err;
                        if (global.console && console.warn) {
                            console.warn('[miya] 线下流式中断，以已收内容收尾：', err && err.message);
                        }
                        return finishPartial(err);
                    });
                }
                return step();
            })();
        });
    }

    /*
     * 摘要硬护栏。
     * 之前这里只有一句「客观总结本段线下剧情」，模型经常把它当成续写指令，
     * 于是纪要里出现凭空生成的剧情；思维链还会空转报怨「未提供具体内容」。
     * 现在把任务边界、禁止项、输入说明一次说清，且不可被自定义提示词顶掉。
     */
    var SUMMARY_GUARDRAIL =
        '你是一个剧情摘要器，唯一任务是把给定的对话记录压缩成一段客观摘要。\n' +
        '\n' +
        '【绝对禁止】\n' +
        '1. 禁止续写、扩写、推演任何后续剧情；\n' +
        '2. 禁止新增原文没有的对话、动作、场景、心理描写；\n' +
        '3. 禁止以任何角色身份说话或输出对话体；\n' +
        '4. 禁止输出思维链、分析过程、自我检查、任务复述；\n' +
        '5. 禁止提及「输入」「用户消息」「未提供内容」等元信息；\n' +
        '6. 禁止输出 <tableEdit>、宏占位符（如 {{...}}、{xxx}）或格式标签。\n' +
        '\n' +
        '【输入说明】\n' +
        '下面给出的对话记录即全部可用素材，已经被完整提供。\n' +
        '不要抱怨内容缺失，不要要求补充，不要猜测未写出的部分。\n' +
        '只依据已写出的内容做摘要，未写到的就不写。\n' +
        '\n' +
        '【输出要求】\n' +
        '直接输出摘要正文，不要任何前言、标题、序号或代码块。\n' +
        '以时间线为序，区分双方，保留关键情节、情绪转折与约定。\n' +
        '100–280 字，中文，纯叙述，不要复述修辞。';

    /*
     * 摘要结果清洗：模型偶尔仍会带出禁止内容。
     * 这里做最后一道兜底，保证脏东西既不进卡片也不进长期记忆。
     */
    function sanitizeSummaryText(text) {
        var s = String(text || '');
        if (!s) return '';
        /* 思考块：成对、未闭合、以及常见标签名 */
        s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
        s = s.replace(/<think(?:ing)?>[\s\S]*$/gi, '');
        s = s.replace(/<\/think(?:ing)?>/gi, '');
        s = s.replace(/```[\s\S]*?```/g, '');
        /* 记忆表格写操作：不该出现在摘要里 */
        s = s.replace(/<tableEdit>[\s\S]*?<\/tableEdit>/gi, '');
        s = s.replace(/<\/?tableEdit>/gi, '');
        /* 未替换的宏占位符（{{name}} / {name} / <user_input> 这类） */
        s = s.replace(/\{\{[\s\S]*?\}\}/g, '');
        s = s.replace(/<user_input>[\s\S]*?<\/user_input>/gi, '');
        s = s.replace(/\{[a-z_][a-z0-9_]{2,}\}/gi, '');
        /* 模型自我检查时爱写的元信息前缀，整行删掉 */
        s = s
            .split('\n')
            .filter(function (line) {
                var t = String(line || '').trim();
                if (!t) return false;
                if (/^(?:用户最新输入|用户输入|最新输入|输入内容)\s*[是为:：]/.test(t)) return false;
                if (/未提供具体内容|没有提供具体内容|未提供内容/.test(t)) return false;
                return true;
            })
            .join('\n');
        /* 常见包装：摘要：/总结：/摘要如下 */
        s = s.replace(/^\s*(?:摘要|总结|剧情摘要|摘要如下|总结如下)\s*[:：]?\s*/i, '');
        return s.replace(/\n{3,}/g, '\n\n').trim();
    }

    /*
     * ══════════════════════════════════════════════════════════════════
     * 候选「延迟写入」判据 —— 末层还在挑时不落记忆
     * ══════════════════════════════════════════════════════════════════
     *
     * 问题
     * ────
     * 线下一条角色楼层可以用右下角 ‹ › 翻出多个候选（不同剧情走向），
     * 但候选**共用同一个消息 id**（引擎用 replaceTargetId 写回同一层）。
     * 记忆表的行溯源只记到消息 id 这一层，无法区分候选。
     *
     * 于是出现两种错法：
     *   · 生成候选 B 时，软删会把 A 写的记忆一起回收 —— A 的记忆凭空空了；
     *   · 用户翻回候选 A，界面回到 A，记忆表却停在 B —— 这就是「串味」。
     *
     * 解法（延迟写入）
     * ────────────────
     * 候选还悬着（用户没选定）时，**先不写记忆**。
     * 等用户在某个候选下面继续发消息，那个候选才算被钉住，
     * 这时才补写它的记忆（见 MiyaMemoryTableApp.commitConfirmedFloor）。
     *
     * 为什么判据是「末尾 + 有候选」而不是只看候选
     * ──────────────────────────────────────────
     * 单候选的正常生成也走同一个收尾分支。若只看「有候选」就跳过，
     * 结果会是**所有**线下记忆都不写 —— 那是把功能关掉，不是修 bug。
     * 只有「末尾那个还在挑的」才该延迟。
     *
     * 判不出来时按「是末尾」处理：宁可少写一次（下一轮或确认时补上），
     * 也不要在两条时间线之间串味。方向是刻意选的。
     *
     * @param {object} sess 会话（带 messages 数组）
     * @param {object} msg  本轮落地的消息（引擎刚写回/新增的那条）
     * @returns {boolean} true = 应当跳过本轮记忆写入
     */
    function shouldDeferMemoryForPendingSwipe(sess, msg) {
        try {
            if (!sess || !Array.isArray(sess.messages) || !msg || !msg.id) return false;
            /*
             * 只有角色楼层才有候选。用户楼层不该被这条逻辑影响 ——
             * 用户发言本身就是「已确认」的信号（见 commitConfirmedFloor）。
             */
            if (msg.role !== 'assistant') return false;
            var swipes = Array.isArray(msg.swipes) ? msg.swipes : [];
            /* 没有候选 = 用户没在挑，照旧写（这是绝大多数生成） */
            if (swipes.length < 1) return false;
            /*
             * 后面还有活着的楼层 → 这一层已经被用户的选择钉住了，
             * 下面是历史楼层，按老行为正常写。
             */
            var rows = sess.messages;
            var idx = -1;
            for (var i = rows.length - 1; i >= 0; i--) {
                if (rows[i] && rows[i].id === msg.id) {
                    idx = i;
                    break;
                }
            }
            if (idx < 0) return true; /* 找不到自己 → 保守按末尾处理 */
            for (var j = idx + 1; j < rows.length; j++) {
                var row = rows[j];
                if (!row || row.deleted) continue;
                /* 有正文的消息才算「下面的楼层」；空占位行不算 */
                if (String(row.content || '').trim()) return false;
            }
            return true; /* 确认是末尾 → 还在挑 → 延迟 */
        } catch (e) {
            /* 判不出来一律按「是末尾」：少写一次可以补，串味补不回来 */
            return true;
        }
    }

    function maybeAutoSummary(chatId, sessionId, preset) {
        /*
         * 自动场次纪要已下线：以前每满 N 层自动写一份纪要卡片插进正片，
         * 用户明确不要这个卡片，所以这里直接不生成。
         * 保留函数与导出仅为兼容旧调用点，避免 ReferenceError。
         */
        return;
    }

    /*
     * 找到“可安全总结”的末位序号：从末尾往前跳过尾部连续的 user 消息，
     * 使摘要素材停在用户最新发言之前。
     * 若整个区间内没有任何 assistant 回复（例如只有用户单方面发言），
     * 则退回原始末位，避免把区间压成空、导致永远总结不出来。
     */
    function resolveSummaryEndExcludingLatestUser(msgs, start) {
        var list = msgs || [];
        var last = list.length;
        if (!last) return 0;
        var i = last;
        while (i >= start) {
            var m = list[i - 1];
            if (m && m.role === 'user') i -= 1;
            else break;
        }
        if (i < start) return last;
        return i;
    }

    function appointmentSummary(chatId, sessionId, opts) {
        opts = opts && typeof opts === 'object' ? opts : {};
        var st = global.miyaChatStore;
        var aps = apStore();
        if (!st || !aps) return Promise.reject(new Error('store_missing'));
        var sess = aps.getSession(chatId, sessionId);
        if (!sess) return Promise.reject(new Error('session_not_found'));
        var chat = st.findChat(chatId);
        var contact = chat && st.findContact(chat.contactId);
        var profile = resolveProfileForChat(st, chat);
        var preset = aps.resolvePresetForContact(chat && chat.contactId);
        var msgs = aps.getSessionMessages(chatId, sessionId);
        var replaceId = String(opts.replaceSummaryId || '').trim();
        var start;
        var end;
        if (replaceId) {
            var existing = (sess.summaryList || []).find(function (r) {
                return r && r.id === replaceId;
            });
            if (!existing) return Promise.reject(new Error('summary_not_found'));
            start = clampInt(existing.startIndex, 1, 9999999, 0);
            end = clampInt(existing.endIndex, 1, 9999999, 0);
        } else if (opts.startIndex != null && opts.endIndex != null) {
            start = clampInt(opts.startIndex, 1, 9999999, 0);
            end = clampInt(opts.endIndex, 1, 9999999, 0);
        } else {
            start = (aps.lastSummaryEnd(sess) || 0) + 1;
            /*
             * 关键：默认区间必须停在「用户最新一条发言」之前。
             * 原来 end = msgs.length 会把用户刚发的那条也算进待总结素材，
             * 模型看到对话停在用户这边，就顺着往下编剧情——这正是
             * 「纪要自造剧情、像没读我新消息」的直接原因。
             * 手动传 startIndex/endIndex 或重写已有纪要时不受此约束。
             */
            end = resolveSummaryEndExcludingLatestUser(msgs, start);
        }
        if (end < start) return Promise.resolve(null);
        /*
         * 生成摘要素材时排除隐藏楼层。
         * 序号口径与 summaryList 一致（getSessionMessages，仅排除 deleted），
         * 因此这里按 i+1 判断区间覆盖是准确的；hidden 只决定「是否进摘要素材」。
         * 若不排除，被隐藏的剧情会被写进纪要，再经纪要回流到线上上下文，
         * 等于绕过了 hidden 的「不参与生成」语义。
         */
        var lines = msgs
            .slice(start - 1, end)
            .filter(function (m) {
                return m && !m.hidden;
            })
            .map(function (m) {
                var who =
                    m.role === 'user'
                        ? (profile && profile.name) || '我'
                        : (contact && contact.name) || '对方';
                return who + '：' + String(m.content || '').trim();
            });
        if (!lines.length || !String(lines.join('\n')).trim()) {
            return Promise.resolve(null);
        }
        var cfg = getApiConfig();
        var baseUrl = normalizeBaseUrl(cfg.baseUrl);
        var apiKey = String(cfg.apiKey || '').trim();
        var model = String(cfg.model || '').trim();
        if (!baseUrl || !apiKey || !model) return Promise.reject(new Error('api_not_configured'));
        /*
         * 摘要提示词：用户自定义的 summaryPrompt 只作为“摘要口径”追加在硬护栏之后。
         * 护栏必须在前且不可被覆盖——之前自定义提示词可以直接顶掉整个 system，
         * 于是模型把「总结」任务当成「续写」任务，在纪要里自造剧情。
         */
        var customPrompt = String((preset && preset.summaryPrompt) || '').trim();
        var prompt = SUMMARY_GUARDRAIL;
        if (customPrompt) prompt = SUMMARY_GUARDRAIL + '\n\n【摘要口径】\n' + customPrompt;
        var payload = {
            model: model,
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content: lines.join('\n') }
            ],
            /* 抽取型任务，压到 0.1 抑制发散；原来 0.4 足够模型开始自由发挥 */
            temperature: 0.1
        };
        return fetch(baseUrl + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
            body: JSON.stringify(payload)
        })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                var text = sanitizeSummaryText(extractReplyContent(data));
                if (!text) throw new Error('empty_summary');
                /* 区间必须按实际总结到的消息条数收敛，否则卡片区间会和正文对不上 */
                var hitCount = Math.max(0, end - start + 1);
                var sum = aps.replaceOrAddSummary(chatId, sessionId, {
                    id: replaceId || undefined,
                    content: text,
                    startIndex: start,
                    endIndex: Math.max(start, start + hitCount - 1)
                });
                if (!opts.silent && global.miyaOfflineApp && global.miyaOfflineApp.toast) {
                    global.miyaOfflineApp.toast('已生成线下总结');
                }
                return sum;
            });
    }

    function yieldToPaint() {
        return new Promise(function (resolve) {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(function () {
                    requestAnimationFrame(resolve);
                });
            } else {
                setTimeout(resolve, 0);
            }
        });
    }

    /*
     * 本轮生成的生命周期 scope。
     *
     * 必须和 stopAppointment 拼出来的键**完全一致**，否则停止键找不到
     * controller，只能空转。两处都从这一个函数取名，就没有写岔的可能。
     */
    function genScopeFor(chatId, sessionId) {
        return 'offline:' + String(chatId) + '::' + String(sessionId);
    }

    /*
     * 幂等登记生成生命周期，并把 signal 交给 handlers。
     *
     * 为什么需要幂等：
     *   sendAppointment / regenerateAppointment 会先自己 begin 一次
     *   （它们还要负责 finish / fail 的收尾语义），随后回调到
     *   runAppointmentCompletion。如果这里**无条件**再 begin，
     *   lifecycle.begin 内部那句 `stop(key, {silent:true, reason:'supersede'})`
     *   会把前一秒刚建好的 controller 当场 abort 掉 —— signal 立刻变成
     *   aborted，fetch 一发起就死，表现为「发消息秒失败」。
     *
     *   所以：已经有人在管这个 scope 就**复用**它的 controller，
     *   只有在没人管时（界面直连 runAppointmentCompletion 的三条路径）
     *   才由这里接管登记。
     *
     * 返回值 owner：
     *   'outer'  —— controller 由调用方持有，收尾也归调用方
     *   'self'   —— 由本函数登记，收尾由本函数负责
     *   'none'   —— 没有生命周期模块，退化为「不可停止」（不报错）
     */
    function ensureGenerationScope(chatId, sessionId, handlers) {
        var scope = genScopeFor(chatId, sessionId);
        var genLife = global.MiyaGenerationLifecycle;
        if (!genLife || typeof genLife.begin !== 'function') return { scope: scope, owner: 'none' };
        var existing = (typeof genLife.getController === 'function') ? genLife.getController(scope) : null;
        if (existing) {
            if (existing.signal) handlers.signal = existing.signal;
            return { scope: scope, owner: 'outer' };
        }
        var ctl = genLife.begin(scope, { kind: 'offline' });
        if (ctl && ctl.signal) handlers.signal = ctl.signal;
        return { scope: scope, owner: 'self' };
    }

    /* 线下生成收尾：把「本轮真实发送」的 prompt 来源分布快照写进宿主 chat 行。
     *
     * 解决什么：线下（约会/离线会话）走的是本引擎的独立 fetch 链路，
     * 消息落在 MiyaAppointmentStore 自己的 session 里，主 chat store 的
     * chat.lastPromptBreakdown 一次都不会被碰 —— 于是「聊天设置 → 模型高级」
     * 读到的永远是**上一次走线上引擎**的旧快照：时间、字数、token、世界书
     * 命中数全部纹丝不动，看起来像「世界书修复没生效」，其实是面板在回看
     * 几小时前的线上数据。把快照补写进来，面板才是在描述「刚才那次线下生成」。
     *
     * 写入目标：宿主 chatId（与设置面板 state.chatId 同一行），字段与线上
     * sendChat 的 chatPatch 完全同名同构（lastPromptBreakdown / lastTokenUsage），
     * 面板无需感知两条链路的差异。快照多带一个 source: 'offline'，
     * 面板据此标注「（线下）」，避免用户把两条链路的数据混为一谈。
     *
     * 失败必须静默：快照是观测性数据，任何异常都不允许影响线下生成主流程。
     */
    function writeOfflinePromptSnapshot(chatId, built, fullRaw, replyMsg) {
        try {
            var st = global.miyaChatStore;
            var engRef = eng();
            if (!st || typeof st.updateChat !== 'function') return;
            if (!engRef || typeof engRef.buildPromptSourceBreakdown !== 'function') return;
            var bd = engRef.buildPromptSourceBreakdown(
                built && Array.isArray(built.messages) ? built.messages : [],
                (built && built.worldbookMeta) || null
            );
            if (!bd) return;
            bd.replyMsgId = replyMsg && replyMsg.id ? String(replyMsg.id) : '';
            bd.isGroupReply = false;
            /* 线下标记：设置页靠它区分「上次发送」是线上还是线下，
               不带这个字段，用户就会把线下快照的世界书命中误读成线上行为。 */
            bd.source = 'offline';
            /* 【W11 诊断】0 命中时把「为什么」一并落进快照。
               ------------------------------------------------------------------
               此前快照只记 worldbookMatched 一个数字。用户看到 0 时，
               面板不给任何线索，只能靠人肉读代码逐层猜 —— 这个缺陷因此
               在线上多绕了好几轮。这里在命中为 0 时，对每个**启用**条目
               调 matcher.explainEntry，把拒绝原因和当前下发角色的 ID 集合
               一起写进快照，面板直接展示。 */
            try {
                var wbMetaForDiag = (built && built.worldbookMeta) || null;
                if (!wbMetaForDiag || !(Number(wbMetaForDiag.matched) > 0)) {
                    var matcherRef = global.miyaWorldbookMatcher;
                    var wbStoreRef = global.miyaWorldbookStore;
                    if (matcherRef && wbStoreRef && typeof wbStoreRef.listEntries === 'function') {
                        var allRows = wbStoreRef.listEntries() || [];
                        var enabledRows = allRows.filter(function (e) {
                            if (!e || e.enabled === false) return false;
                            return typeof wbStoreRef.isEntryGroupEnabled !== 'function'
                                || wbStoreRef.isEntryGroupEnabled(e);
                        });
                        var wbCtx = String((built && built.worldbookDiagContext) || '');
                        var castRoleIdsForDiag = Array.isArray(built && built.worldbookDiagRoleIds)
                            ? built.worldbookDiagRoleIds
                            : [];
                        var diagCfg = {
                            contextText: wbCtx,
                            promptContext: 'offline',
                            roleId: castRoleIdsForDiag[0] || '',
                            roleIds: castRoleIdsForDiag
                        };
                        var reasons = enabledRows.map(function (e) {
                            var r = null;
                            try {
                                r = typeof matcherRef.explainEntry === 'function'
                                    ? matcherRef.explainEntry(e, diagCfg)
                                    : null;
                            } catch (eExp) { r = null; }
                            return {
                                id: String(e.id || ''),
                                name: String(e.name || e.id || ''),
                                scope: String(e.scope || 'global'),
                                reach: typeof matcherRef.getEntryGlobalReach === 'function'
                                    ? String(matcherRef.getEntryGlobalReach(e) || '')
                                    : String(e.globalReach || ''),
                                bound: Array.isArray(e.boundRoleIds) ? e.boundRoleIds.slice() : [],
                                constant: !!e.constant,
                                hasKeys: typeof matcherRef.hasAnyKeywords === 'function'
                                    ? !!matcherRef.hasAnyKeywords(e)
                                    : false,
                                injected: !!(r && r.injected),
                                reason: r ? String(r.reason || '') : 'explain_unavailable',
                                reasonLabel: r ? String(r.reasonLabel || r.reason || '') : '',
                                detail: r ? String(r.detail || '') : ''
                            };
                        });
                        bd.worldbookZeroDiag = {
                            enabled: enabledRows.length,
                            total: allRows.length,
                            roleIds: castRoleIdsForDiag.slice(),
                            reasons: reasons,
                            updatedAt: Date.now()
                        };
                    }
                }
            } catch (eZeroDiag) { /* 诊断失败绝不拖累快照写入 */ }
            /* 用量与线上 buildLocalTokenUsage 同构：本地按字符粗算，
               API 返回 usage 时如实记录在 completion.data 里（此处沿用本地口径，
               与线上本地兜底一致，避免两条链路数字口径打架）。 */
            var promptChars =
                typeof engRef.countMessagesChars === 'function'
                    ? engRef.countMessagesChars(built && built.messages)
                    : 0;
            var completionChars = String(fullRaw || '').length;
            var totalChars = promptChars + completionChars;
            var patch = {
                lastPromptBreakdown: bd,
                lastTokenUsage: {
                    prompt_chars: promptChars,
                    completion_chars: completionChars,
                    total_chars: totalChars,
                    prompt_tokens: promptChars,
                    completion_tokens: completionChars,
                    total_tokens: totalChars,
                    updatedAt: Date.now(),
                    source: 'local_chars'
                }
            };
            st.updateChat(chatId, patch)
                .then(function () {
                    /* 设置页若开着（线下界面与设置页同屏切换的场景）立即刷新；
                       关着也无妨，下次打开设置页本来就会重新读取。 */
                    var extras = global.miyaChatRoomExtras;
                    if (extras && typeof extras.patchTokenUsageInSettings === 'function') {
                        extras.patchTokenUsageInSettings(chatId);
                    }
                })
                .catch(function () {});
        } catch (eSnap) {}
    }

    function runAppointmentCompletion(chatId, sessionId, handlers) {
        handlers = handlers && typeof handlers === 'object' ? handlers : {};
        var aps = apStore();
        var st = global.miyaChatStore;
        var cfg = getApiConfig();
        var baseUrl = normalizeBaseUrl(cfg.baseUrl);
        var apiKey = String(cfg.apiKey || '').trim();
        var model = String(cfg.model || '').trim();
        if (!baseUrl || !apiKey || !model) {
            return Promise.reject(new Error('api_not_configured'));
        }
        /*
         * 生命周期登记 —— 必须在所有 await 之前同步完成。
         *
         * 这里是线下全部生成路径的**唯一汇聚点**（界面三条路径都直连本函数），
         * 所以登记放这里，界面怎么调都一定能被 stopAppointment 停掉。
         * 放在 sendAppointment / regenerateAppointment 是不够的：那两条
         * 界面根本不走，停止键点下去 controllers 里空空如也。
         */
        var gen = ensureGenerationScope(chatId, sessionId, handlers);
        if (handlers.onStatus) handlers.onStatus('coming');
        /* ST 生成参数在进入异步前读取一次，保证本轮请求参数稳定 */
        var stGen = getStGenerationSettings();
        /*
         * 本轮是不是「重答」，以及是第几次 —— 必须在进入异步前定下来，
         * 否则 await 之后再读 handlers 可能已被下一轮改写。
         */
        var regenRun = !!handlers.replaceLastAssistant;
        var regenAttempt = Math.floor(Number(handlers.regenerateAttempt) || 0);

        /*
         * 统一收尾：只有「本函数登记的」才由本函数清理。
         * 外层（sendAppointment 等）自己登记的情形，收尾归外层 ——
         * 它们还要区分 finish / fail / abort 三种语义，这里代劳会打架。
         */
        function settleGeneration(err, value) {
            if (gen.owner !== 'self') return;
            var life = global.MiyaGenerationLifecycle;
            if (!life) return;
            if (err) {
                if (life.isAbortError && life.isAbortError(err)) {
                    if (life.stop) life.stop(gen.scope, { silent: true, reason: 'abort' });
                } else if (life.fail) {
                    life.fail(gen.scope, err);
                }
            } else if (life.finish) {
                life.finish(gen.scope, value);
            }
        }

        /* 先让「书写中」上屏，再拼 prompt，避免按发送瞬间卡死 */
        return yieldToPaint().then(function () {
            var built = buildApiMessages(chatId, sessionId, '', {
                regenerate: regenRun,
                regenerateAttempt: regenAttempt
            });
            if (built.error) throw new Error(built.error);
            var url = baseUrl + '/chat/completions';
            var headers = {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + apiKey
            };
            var payload = {
                model: model,
                messages: built.messages,
                temperature: appointmentTemperature(cfg, stGen),
            };
            /* 与线上 miya-chat-engine.js 保持一致：把 ST「生成参数」内的
               max_tokens / top_p / 频率惩罚 / 存在惩罚 一并送出。
               v38 修复：此前线下只发 model/messages/temperature，top_p 从未上送，
               网关按默认 top_p=1.0 走全词表采样；在高温下会采样到极低概率尾部，
               表现为正文与思维链「同时」喷出中英俄阿等多语种无意义碎片。
               （换模型/换中转站偶尔转好，只是因为对方默认值恰好兜住了缺失参数，
               并非用户的 Top P 设置真的生效了。） */
            applyStGenerationToPayload(payload, stGen);
            var useStream = appointmentStreamEnabled(cfg);
            var pluginCtx = {
                scope: 'offline',
                chatId: chatId,
                sessionId: sessionId,
                messages: built.messages,
                userText: '',
                options: handlers,
                signal: handlers.signal
            };
            var pluginReady;
            if (global.MiyaMemoryTableApp && typeof global.MiyaMemoryTableApp.beforeGenerate === 'function') {
                pluginReady = Promise.resolve(global.MiyaMemoryTableApp.beforeGenerate(pluginCtx));
            } else {
                pluginReady = Promise.resolve(pluginCtx);
            }
            return pluginReady.then(function (ctxOut) {
            if (ctxOut && Array.isArray(ctxOut.messages)) {
                built.messages = ctxOut.messages;
                payload.messages = ctxOut.messages;
            }
            return fetchAppointmentCompletion(
                url,
                headers,
                payload,
                {
                    onLine: handlers.onLine,
                    onDelta: handlers.onDelta,
                    /* 把 onPartial 透传进流式读取层，
                       断线/空闲超时后能通知上层「这段没写完」。 */
                    onPartial: handlers.onPartial,
                    signal: handlers.signal
                },
                useStream
            ).then(function (completion) {
                var fullRaw =
                    completion && completion.raw != null
                        ? String(completion.raw)
                        : String(completion || '');
                /*
                 * 现实时钟事件：先从回复里摘出 <miyaevent>…</miyaevent> 并落账，
                 * 拿到剥干净的正文再往下走。
                 *
                 * 必须放在所有下游解析之前：记忆表格、状态条、分镜都要拿
                 * 「没有事件标记」的正文，否则标签会顺着 content 写进楼层，
                 * 下一轮又被当成历史送回去，模型开始照着模仿。
                 */
                var teModOff = global.MiyaChatTimeEvents;
                if (
                    teModOff &&
                    typeof teModOff.extractAndStore === 'function' &&
                    chatId
                ) {
                    try {
                        var teExtract = teModOff.extractAndStore(st, chatId, fullRaw);
                        if (teExtract && teExtract.text != null) fullRaw = teExtract.text;
                    } catch (eTeEx) {}
                }
                var mtRawForMsg = '';
                try {
                    var mtEng = global.MiyaMemoryTableEngine;
                    if (mtEng && typeof mtEng.processAssistantReply === 'function') {
                        /*
                         * ⚠️ 这一处**只剥离、不落库**（dryRun）。
                         *
                         * 这一句原本揽着两件事：
                         *   1. 剥离 <tableEdit> 标记 —— 必须无条件做，
                         *      否则标签会顺着 content 写进楼层，下一轮被当历史送回；
                         *   2. 把表格动作落进记忆表 —— 这一步要看「这一版会不会被选走」。
                         *
                         * 早先没分开，于是候选还悬着时（用户还没选定）表格照样落库，
                         * 「延迟写入」形同虚设 —— 真正把候选版写进记忆表的是这里，
                         * 而不是收尾的 afterGenerate。
                         *
                         * 现在：本处只剥离，并把**原始标记**留在 mtRawForMsg 里
                         * 随消息一起落库（见 appointment-store 的 normalizeMessage.mtRaw）。
                         * 落库时机只有两个，二选一：
                         *   · 用户选定这一版（发消息）→ commitConfirmedFloor
                         *   · 本来就是终版（无候选/非末尾）→ 收尾时的 afterGenerate
                         */
                        var mtRes = mtEng.processAssistantReply(chatId, fullRaw, { dryRun: true });
                        if (mtRes && mtRes.text != null) fullRaw = mtRes.text;
                        mtRawForMsg = (mtRes && mtRes.mtRaw) || '';
                    }
                } catch (eMtOff) {}
                var apiData = completion && completion.data != null ? completion.data : null;
                var parsed = parseAppointmentResponse(fullRaw, apiData);
                var thinking = String(parsed.thinking || '').trim();
                var htmlMode = !!built.htmlMode;
                var finalized = finalizeAppointmentAssistantBody(parsed, htmlMode, chatId);
                if (!finalized.lines.length && htmlMode) {
                    finalized = finalizeAppointmentAssistantBody(parsed, false, chatId);
                }
                var lines = finalized.lines || [];
                if (!lines.length) throw new Error('empty_reply');
                var content = finalized.content || lines.join('\n\n');
                var msgFields = { role: 'assistant', content: content };
                if (finalized.renderAsHtml) {
                    msgFields.renderAsHtml = true;
                    msgFields.htmlRaw = finalized.htmlRaw || content;
                }
                if (thinking) msgFields.thinking = thinking;
                /*
                 * 把「这一版原本要写的记忆」随消息一起落库。
                 *
                 * 正文里的 <tableEdit> 已经在前面剥掉了（否则标签会进楼层、
                 * 下一轮被当历史送回），但候选还悬着时我们故意不落库，
                 * 等用户选定再补写 —— 补写需要原文，所以留一份在这里。
                 * 见 appointment-store 的 normalizeMessage.mtRaw。
                 */
                if (mtRawForMsg) msgFields.mtRaw = mtRawForMsg;
                /* 状态栏跟着这条消息一起落库（与线上同构：statusBar.fields / statusBar.tag） */
                if (finalized.statusBar && finalized.statusBar.fields && finalized.statusBar.fields.length) {
                    msgFields.statusBar = {
                        fields: finalized.statusBar.fields,
                        tag: String(finalized.statusBar.tag || '')
                    };
                }
                /*
                 * 剧情走向建议随楼层一起落库。
                 *
                 * 存解析后的字符串数组，而不是原始 <plot> 文本：
                 *   · 渲染层直接取用，不必每帧重解析；
                 *   · 模型换写法（少写一行、前缀不对）只影响一次落库结果，
                 *     不会让卡片在重新渲染时凭空变形。
                 * 空数组也要显式带上 —— 「这一版没有建议」是个有效状态
                 * （比如模型这轮没吐标记），不传的话 normalizeMessage
                 * 会沿用上一版的建议，卡片就会挂着一批对不上剧情的老选项。
                 */
                msgFields.plotHints = Array.isArray(finalized.plotHints) ? finalized.plotHints.slice() : [];
                /* 线下 Swipe：若 handlers.replaceLastAssistant，则把上一层助手回复并入候选 */
                var msg = null;
                if (handlers.replaceLastAssistant && typeof aps.updateMessage === 'function') {
                    /*
                     * ⚠️ 这里原来写的是 aps.getMessages(chatId, sessionId)。
                     * 但 aps 是 MiyaAppointmentStore，它上面根本没有 getMessages
                     * 这个方法（那个名字属于 miyaChatStore）。于是 `aps.getMessages &&`
                     * 永远短路成 undefined，sessMsgs 恒为 []，循环找不到 lastAsst，
                     * 整段「并入候选」的逻辑一次都没执行过 —— 表现就是：
                     *   · 刷新楼层只会在末尾多一条新内容，swipes 从来没被写过
                     *   · offlineSwipeBarHtml 要求 swipes.length >= 2，于是 ‹ › 切换键
                     *     永远不出现，用户看不到自己其实刷出过好几个版本
                     *
                     * 正确的名字是 getSessionMessages(chatId, sessionId)，
                     * 它已经滤掉 deleted 和空内容，正是这里需要的语义。
                     */
                    var sessMsgs =
                        (typeof aps.getSessionMessages === 'function' &&
                            aps.getSessionMessages(chatId, sessionId)) ||
                        [];
                    var lastAsst = null;
                    /*
                     * 优先用调用方显式指定的目标楼层。
                     *
                     * 为什么要这个入口：「重回」的时序是「先软删那一层，再让引擎重答」。
                     * 软删之后 getSessionMessages 会把目标层滤掉，于是下面那段
                     * 「倒着找最后一条 assistant」会一路往上，摸到**更早的、不相干**的
                     * 一层，把新候选合并进那一层 —— 用户看到的是「重答的内容跑到别的楼层去了」。
                     * 所以调用方必须能说清「就是这一层」。
                     */
                    var targetId = String(handlers.replaceTargetId || '').trim();
                    if (targetId) {
                        /*
                         * 显式指定时直接按 id 取，不看 deleted ——
                         * 因为「重回」恰恰要求的就是把内容写回那条已被软删的行。
                         * 用 getSession 直读原始数组，绕开过滤。
                         */
                        var rawSess = aps.getSession(chatId, sessionId);
                        var rawMsgs = (rawSess && rawSess.messages) || [];
                        for (var ti = 0; ti < rawMsgs.length; ti++) {
                            if (rawMsgs[ti] && String(rawMsgs[ti].id) === targetId) {
                                lastAsst = rawMsgs[ti];
                                break;
                            }
                        }
                    }
                    /*
                     * 只在上面的显式指定没命中时，才回退到「倒着找最后一条 assistant」。
                     * 顺序不能反：回退逻辑一旦覆盖掉显式目标，就会重新写错楼层。
                     */
                    if (!lastAsst) {
                        for (var li = sessMsgs.length - 1; li >= 0; li--) {
                            if (sessMsgs[li] && !sessMsgs[li].deleted && sessMsgs[li].role === 'assistant') {
                                lastAsst = sessMsgs[li];
                                break;
                            }
                        }
                    }
                    if (lastAsst) {
                        /*
                         * ── 这一版旧内容，要不要留成候选？──
                         *
                         * 由调用方决定（handlers.keepRegenCandidate）。
                         * 全应用只有一条路径会传 true：
                         *
                         *   · keepRegenCandidate = true ——
                         *     「楼层右下角的 ›」。语义是「多来一版」，
                         *     旧的那一版必须留得住，用户还能用 ‹ 翻回去。
                         *     这是**唯一**允许归档候选的入口。
                         *
                         *   · keepRegenCandidate 缺省 / false ——
                         *     其余所有重生成路径：「重发」「刷新」「重回」之类。
                         *     语义是「这一版不要了，重写」。此时旧内容既不进候选、
                         *     也不再占 swipes 的位，写完就是干干净净的一版。
                         *
                         * ⚠️ 默认值的方向是**刻意**选的：缺省即 false，不是 true。
                         *
                         * 早先写的是 `handlers.keepRegenCandidate !== false` ——
                         * 也就是缺省 true。于是任何一个忘记传参的调用方都会
                         * 悄悄变成「第二个 › 键」。这不是假设，是真实发生过的：
                         * redoFromMessage 的 assistant 分支漏传该参数，
                         * 实测点「重发」后得到 {"content":"第 1 版新内容。",
                         * "swipes":1,"swipeId":0} —— 库里被写进了一份长度为 1
                         * 的候选表（› 键是 swipes:2）。它当时没被测试抓住，
                         * 因为候选指示器要求 swipes.length >= 2 才渲染，
                         * 视觉上看不出差别，但它确实污染了 attempt 计数。
                         *
                         * 改成 `=== true` 之后，漏传参数的代价是「少一个候选项」，
                         * 而不是「凭空多出一个和 › 重复的行为」—— 前者无害，
                         * 后者正是用户反复抓到的那类 bug。
                         *
                         * 为什么这个开关必须落在引擎而不是调用方：
                         *   写 swipes 的动作就发生在这里（下面那几行），
                         *   调用方在调用前根本还没有新内容可以填。
                         *   调用方唯一能做的就是「别把旧内容塞进来」，
                         *   所以开关只能由调用方传、在这里生效。
                         */
                        var keepCand = handlers.keepRegenCandidate === true;
                        var prevSwipes = keepCand && Array.isArray(lastAsst.swipes) ? lastAsst.swipes.slice() : [];
                        /*
                         * 候选各自的记忆标记（与 prevSwipes 平行）。
                         *
                         * 取旧值时用 lastAsst.swipeMtRaw —— 上一轮归档下来
                         * 各候选的标记；当前正显示那一版（就是 lastAsst 自己）
                         * 的标记是 lastAsst.mtRaw。
                         */
                        var prevSwipesMtRaw = Array.isArray(lastAsst.swipeMtRaw)
                            ? lastAsst.swipeMtRaw.slice()
                            : [];
                        /*
                         * 当前正文是否要补成第一个候选。
                         *
                         * 两个条件缺一不可：
                         *   · keepCand —— 不保留就别补；
                         *   · !lastAsst.deleted —— 行没被软删，正文就是「当前正显示的那一版」。
                         *
                         * 第二个条件看着别扭，其实是「推翻旧实验」：
                         * 早先的做法是「不管行是死是活，只要有正文就补成候选」，
                         * 于是从 > 键刷新（那时旧行已软删）也会把旧版留下 ——
                         * 用户点的明明是「不留」，翻 ‹ 却还能看到它。
                         * 反过来说，直接调用引擎（不经过 regenerateAssistantFloor）
                         * 的老路径因为没软删，正文仍在、deleted 仍是 false，
                         * 补候选的行为和以前完全一致，不会退化。
                         *
                         * ⚠️ 正文与标记必须**在同一个分支里一起补**，
                         * 不能各写一个 if。
                         *
                         * 这不是洁癖：早先正文补一条、标记也补一条，标记那句照抄了
                         * 正文的条件（含 `!prevSwipes.length`）—— 可正文那句已经先跑过，
                         * 到标记这一步 prevSwipes.length 早就是 1 了，条件恒假，
                         * 标记**一次都没补上**。表现出来就是「翻回第 1 版再确认，
                         * 写进去的却是最新版的记忆」—— 正是这次要修的串味，
                         * 只是换了个地方。
                         */
                        if (keepCand && !lastAsst.deleted && !prevSwipes.length && lastAsst.content) {
                            prevSwipes.push(String(lastAsst.content));
                            if (!prevSwipesMtRaw.length) {
                                prevSwipesMtRaw.push(String(lastAsst.mtRaw || ''));
                            }
                        }
                        /*
                         * 追加候选并裁剪。
                         *
                         * 上限规则统一收在 pushSwipeCandidate 里 ——
                         * 「重回」和「楼层右下角 ›」两条路径共用同一份实现，
                         * 避免改一处漏一处（见该函数的说明：候选不进 prompt，
                         * 所以按字符总量而非条数来限）。
                         *
                         * ⚠️ keepCand=false 时**连新内容也不进 swipes**。
                         *
                         * 曾经这里是无条件 pushSwipeCandidate(prevSwipes, content)，
                         * 于是「不保留」只做到了「不把旧版塞进来」，
                         * 新写回的正文还是被塞成了 swipes[0] —— 结果楼层
                         * 带着一份长度为 1 的候选表，语义上仍然是「有候选」。
                         * 用户质疑「刷新键怎么会生成出候选内容」时抓的正是这个：
                         * 候选表的产生必须只属于 › 键，刷新键写完就该是干干净净
                         * 的一版（swipes 为空数组，前端不渲染任何候选条）。
                         */
                        var pushRes;
                        if (keepCand) {
                            /*
                             * 被裁掉的那个候选，它那份记忆标记要跟着一起裁 ——
                             * 否则标记数组会比候候选表长/错位，翻看时按
                             * swipeId 取到的就是别的候选的标记（写错记忆）。
                             */
                            pushRes = pushSwipeCandidate(prevSwipes, content);
                            prevSwipes = pushRes.list;
                            prevSwipesMtRaw = alignSwipeMtRaw(
                                prevSwipesMtRaw.concat([mtRawForMsg || '']),
                                pushRes.keepIdx
                            );
                        } else {
                            prevSwipes = [];
                            prevSwipesMtRaw = [];
                        }
                        var swipeId = prevSwipes.length ? prevSwipes.length - 1 : 0;
                        msg = aps.updateMessage(chatId, sessionId, lastAsst.id, {
                            content: content,
                            thinking: thinking || lastAsst.thinking || '',
                            renderAsHtml: !!finalized.renderAsHtml,
                            htmlRaw: finalized.renderAsHtml ? (finalized.htmlRaw || content) : '',
                            swipes: prevSwipes,
                            swipeMtRaw: prevSwipesMtRaw,
                            swipeId: swipeId,
                            /*
                             * 覆盖成**本版**的待落库标记。
                             *
                             * 必须显式带上（哪怕为空串）：候选表里存的是
                             * 各版剥离后的正文，翻到哪一版就对应哪一份标记。
                             * 若这里不传，normalizeMessage 会沿用旧值，
                             * 于是「翻到 A 却写进 B 的记忆」—— 正是要修的那个串味。
                             */
                            mtRaw: mtRawForMsg || '',
                            /*
                             * 必须显式把 deleted 置回 false。
                             *
                             * 「重回」是「先软删那一层、再让引擎重答」，所以这里的
                             * lastAsst 是一条 deleted:true 的行。旧代码没带这个字段，
                             * normalizeMessage 沿用了旧值 true —— 于是内容写进去了、
                             * deleted 还挂着，界面上这一层依然不显示，用户看到的是
                             * 「点重回之后楼层直接消失了」。
                             */
                            deleted: false
                        }) || lastAsst;
                    }
                }
                if (!msg) msg = aps.addMessage(chatId, sessionId, msgFields);
                /* 快照写入放在「msg 落库之后、其余收尾之前」：
                   新增与重答（updateMessage）两条路径在此汇合，一次覆盖。
                   注意 built.messages 是经过插件（记忆表）改写后的最终发送数组，
                   快照描述的就是这次真实发往 API 的内容。 */
                writeOfflinePromptSnapshot(chatId, built, fullRaw, msg);
                var chatRow = st.findChat(chatId);
                var preset = aps.resolvePresetForContact(chatRow && chatRow.contactId);
                var sessAfter = aps.getSession(chatId, sessionId);
                var statusApi = global.MiyaOfflineStatus;
                if (
                    statusApi &&
                    typeof statusApi.isEnabled === 'function' &&
                    statusApi.isEnabled() &&
                    typeof statusApi.parseStatusFromReply === 'function' &&
                    typeof statusApi.appendStatusLog === 'function' &&
                    sessAfter
                ) {
                    var castForStatus = resolveSessionCastContacts(st, sessAfter, built.contact);
                    var pack = statusApi.parseStatusFromReply(fullRaw, castForStatus);
                    statusApi.appendStatusLog(sessAfter, pack);
                }
                maybeAutoSummary(chatId, sessionId, preset);
                var result = { message: msg, lines: lines, raw: fullRaw };
                /*
                 * 记忆写入的**延迟门**。
                 *
                 * 末层还在挑候选（swipes 非空且没被下面的楼层钉住）时先不写，
                 * 等用户选定后再由 MiyaMemoryTableApp.commitConfirmedFloor 补写。
                 * 理由与判据见 shouldDeferMemoryForPendingSwipe 的说明。
                 *
                 * ⚠️ 只包住 afterGenerate 这一句。
                 * 上面三行（状态快照 / 状态栏 / 自动总结）都是与候选无关的
                 * 收尾，一个都不能跟着跳 —— 状态栏跳了就是「状态卡片不更新」，
                 * 自动总结跳了就是「分镜不沉淀」，都是与本次修复无关的新故障。
                 */
                var deferMemory = shouldDeferMemoryForPendingSwipe(sessAfter, msg);
                if (
                    !deferMemory &&
                    global.MiyaMemoryTableApp &&
                    typeof global.MiyaMemoryTableApp.afterGenerate === 'function'
                ) {
                    try {
                        global.MiyaMemoryTableApp.afterGenerate({
                            scope: 'offline',
                            chatId: chatId,
                            result: result
                        });
                    } catch (eMtAfter) {}
                }
                return result;
            });
            }); /* pluginReady offline */
        }).then(function (v) {
            /* 正常收尾：本函数登记的 scope 由本函数 finish */
            settleGeneration(null, v);
            return v;
        }, function (err) {
            /*
             * 失败/中止收尾。
             *
             * 用户点「停止生成」→ stopAppointment → genLife.stop()
             * → ctl.abort() → fetch 抛 AbortError → 走到这里。
             * 必须用 isAbortError 分流，否则一次正常的中止会被记成
             * 「生成故障」，污染 lifecycle 的错误统计与事件订阅方。
             *
             * 另外要显式把 replyInFlight 的忙碌标记清掉：abort 之后
             * 那条 finally（在外层 sendAppointment 里）不一定还有机会跑，
             * 而只要这个标记还在，用户下一句就会被 `busy` 挡回去 ——
             * 「停止之后发不出消息」正是这么来的。
             */
            if (gen.owner === 'self') delete replyInFlight[String(chatId) + '::' + String(sessionId)];
            settleGeneration(err, null);
            throw err;
        });
    }

    function sendAppointment(chatId, sessionId, userText, handlers) {
        handlers = handlers && typeof handlers === 'object' ? handlers : {};
        var text = String(userText || '').trim();
        if (!text) return Promise.reject(new Error('empty_message'));
        var key = String(chatId) + '::' + String(sessionId);
        if (replyInFlight[key]) return Promise.reject(new Error('busy'));

        var aps = apStore();
        var userMsg = aps.addMessage(chatId, sessionId, { role: 'user', content: text });
        if (!userMsg) return Promise.reject(new Error('session_not_found'));

        replyInFlight[key] = true;
        var genLife = global.MiyaGenerationLifecycle;
        var genCtl = genLife && genLife.begin ? genLife.begin('offline:' + key, { kind: 'offline' }) : null;
        if (genCtl && genCtl.signal) handlers.signal = genCtl.signal;
        if (handlers.onStatus) handlers.onStatus('generating');
        return runAppointmentCompletion(chatId, sessionId, handlers).then(function (v) {
            if (genLife && genLife.finish) genLife.finish('offline:' + key, v);
            return v;
        }, function (err) {
            if (genLife && genLife.isAbortError && genLife.isAbortError(err)) {
                if (genLife.stop) genLife.stop('offline:' + key, { silent: true, reason: 'abort' });
            } else if (genLife && genLife.fail) {
                genLife.fail('offline:' + key, err);
            }
            throw err;
        }).finally(function () {
            delete replyInFlight[key];
            if (handlers.onStatus) handlers.onStatus('idle');
        });
    }

    /*
     * 重答最后一场（「重回」/「刷新楼层」）。
     *
     * opts.replaceTargetId：显式指定「要覆盖哪一层」。
     *   调用方（quickRedoLastAssistant）是先软删目标层再调这里，
     *   带上这个 id 引擎才能精确写回那一层，而不是一路往上摸到更早的楼层。
     *   不传也能跑（回退到「找最后一条还活着的 assistant」），但一旦
     *   调用方软删过目标层，就必然写错位置，所以「重回」路径必须传。
     */
    function regenerateAppointment(chatId, sessionId, handlers, opts) {
        handlers = handlers && typeof handlers === 'object' ? handlers : {};
        var regenOpts = opts && typeof opts === 'object' ? opts : {};
        var key = String(chatId) + '::' + String(sessionId);
        if (replyInFlight[key]) return Promise.reject(new Error('busy'));
        replyInFlight[key] = true;
        var genLife = global.MiyaGenerationLifecycle;
        var genCtl = genLife && genLife.begin ? genLife.begin('offline:' + key, { kind: 'offline', regenerate: true }) : null;
        if (genCtl && genCtl.signal) handlers.signal = genCtl.signal;
        handlers.replaceLastAssistant = true;
        var targetId = String(regenOpts.replaceTargetId || handlers.replaceTargetId || '').trim();
        if (targetId) handlers.replaceTargetId = targetId;
        /*
         * 重答次数：调用方可以不传，默认 1。
         *
         * 这个数字只用于给模型一句「这是第 N 次重答，差异再明显一点」，
         * 不进任何持久化数据，也不改变写入目标楼层。
         */
        if (handlers.regenerateAttempt == null) {
            handlers.regenerateAttempt = Math.max(1, Math.floor(Number(regenOpts.attempt) || 1));
        }
        /*
         * 旧版要不要留成候选。
         *
         * 必须显式写进 handlers —— runAppointmentCompletion 只认 handlers，
         * 它看不到这里的 regenOpts。
         *
         * ⚠️ 同向收紧：只有 regenOpts.keepRegenCandidate **显式为 true**
         * 才写 true，其余（缺省、false）一律写 false。
         *
         * 原来这里是 `regenOpts.keepRegenCandidate !== false` —— 只要调用方
         * 传了这个字段（哪怕传的就是缺省语义）都会被归一成 true，
         * 于是「没打算要候选」的调用方反而被这里**主动打开**了候选归档。
         * 上下两处默认值必须同向，否则一处改了、另一处又把缺省拽回 true，
         * 漏洞会从这条转发路径重新漏回来。
         */
        if (regenOpts.keepRegenCandidate != null && handlers.keepRegenCandidate == null) {
            handlers.keepRegenCandidate = regenOpts.keepRegenCandidate === true;
        }
        if (handlers.onStatus) handlers.onStatus('generating');
        return runAppointmentCompletion(chatId, sessionId, handlers).then(function (v) {
            if (genLife && genLife.finish) genLife.finish('offline:' + key, v);
            return v;
        }, function (err) {
            if (genLife && genLife.isAbortError && genLife.isAbortError(err)) {
                if (genLife.stop) genLife.stop('offline:' + key, { silent: true, reason: 'abort' });
            } else if (genLife && genLife.fail) {
                genLife.fail('offline:' + key, err);
            }
            throw err;
        }).finally(function () {
            delete replyInFlight[key];
            if (handlers.onStatus) handlers.onStatus('idle');
        });
    }

    /*
     * 停止线下生成。
     *
     * 返回「有没有真的停到一个在跑的生成」，而不是无脑 true。
     *
     * 旧版无论有没有生成在跑都返回 true，界面据此弹「已停止生成」——
     * 于是「点击 → 提示成功 → 但内容还在往外蹦」被当成偶发 bug 排查了很久。
     * 真实的成因是控制器压根没登记（界面直连 runAppointmentCompletion，
     * 没人调 begin），stop 拿到 undefined 直接跳过，却一样返回 true。
     *
     * 现在登记点已经补上（见 ensureGenerationScope），这里再把「有没有
     * 真的 abort 到东西」如实回传，界面就能区分「停住了」和「本来就没在跑」。
     *
     * scope 键统一走 genScopeFor，和登记处同源，杜绝两处拼写走岔。
     */
    function stopAppointment(chatId, sessionId) {
        var key = String(chatId) + '::' + String(sessionId);
        var scope = genScopeFor(chatId, sessionId);
        var genLife = global.MiyaGenerationLifecycle;
        var ctl = (genLife && typeof genLife.getController === 'function')
            ? genLife.getController(scope) : null;
        if (genLife && genLife.stop) genLife.stop(scope, { reason: 'user' });
        delete replyInFlight[key];
        /*
         * 返回值语义：true = 确实中断了一个在跑的生成。
         * 没有 controller（本来就没在跑）→ false，界面不该弹「已停止」。
         */
        return !!ctl;
    }

    function isBusy(chatId, sessionId) {
        return !!replyInFlight[String(chatId) + '::' + String(sessionId)];
    }

    global.MiyaAppointmentEngine = {
        buildApiMessages: buildApiMessages,
        buildAppointmentSystemPrompt: buildAppointmentSystemPrompt,
        runAppointmentCompletion: runAppointmentCompletion,
        sendAppointment: sendAppointment,
        regenerateAppointment: regenerateAppointment,
        appointmentSummary: appointmentSummary,
        maybeAutoSummary: maybeAutoSummary,
        splitDisplayLines: splitDisplayLines,
        splitDisplayParagraphs: splitDisplayParagraphs,
        parseThinkingPayload: parseThinkingPayload,
        getLastOfflinePromptDebug: function () { return global.__MiyaLastOfflinePrompt || null; },
        fetchAppointmentCompletion: fetchAppointmentCompletion,
        isBusy: isBusy,
        stopAppointment: stopAppointment,
        resolveProfileForContact: resolveProfileForContact,
        resolveProfileForChat: resolveProfileForChat
    };
})(window);
