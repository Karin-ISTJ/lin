/**
 * 线下状态栏：可拖动悬浮球 + Ins 内置 + 自有预设库（保存/读取/导出/导入）。
 * 单人/多人共用；多人时默认展示每位出演角色状态。
 * 展示样式刻意区别于线上心声；字段解析复用 miyaChatEngine.parseHeartVoiceFromReply。
 */
(function (global) {
    'use strict';

    var PRESETS_LS = 'miya-offline-status-presets-v1';
    var STATUS_LOG_MAX = 40;

    var BUILTIN_FIELDS = [
        { name: '心情', requirement: '一两个词概括此刻情绪，克制真实' },
        { name: '状态', requirement: '一句客观现状或处境' },
        { name: '想法', requirement: '一句内心独白，贴合人设与当下' }
    ];

    var panelEl = null;
    var presetsCache = null;
    /* 缓存建立时刻 + 对应的落盘原文指纹。
       旧实现一旦缓存就永不重读 localStorage，多标签页里 A 页保存的预设
       B 页永远看不到，只能靠刷新。改为：短 TTL 兜底 + storage 事件即时失效。 */
    var presetsCacheAt = 0;
    var PRESETS_CACHE_TTL_MS = 5000;
    var presetsCacheRaw = '';
    var viewState = {
        chatId: '',
        sessionId: '',
        contactId: '',
        activeContactId: 'all',
        entryIdx: 0
    };

    function esc(t) {
        return String(t || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function toast(msg) {
        if (global.miyaOfflineApp && typeof global.miyaOfflineApp.toast === 'function') {
            global.miyaOfflineApp.toast(msg);
            return;
        }
        try {
            console.log('[offline-status]', msg);
        } catch (e) {}
    }

    function apStore() {
        return global.MiyaAppointmentStore;
    }

    function chatStore() {
        return global.miyaChatStore;
    }

    function tplMod() {
        return global.MiyaChatHeartVoiceTemplates;
    }

    function engineParse() {
        var eng = global.miyaChatEngine;
        return eng && typeof eng.parseHeartVoiceFromReply === 'function' ? eng : null;
    }

    function getStatusSettings() {
        var st = apStore();
        if (st && typeof st.getStatusBar === 'function') return st.getStatusBar() || {};
        return { enabled: true, presetName: '' };
    }

    function saveStatusSettings(patch) {
        var st = apStore();
        if (st && typeof st.saveStatusBar === 'function') return st.saveStatusBar(patch || {});
        return getStatusSettings();
    }

    function isEnabled() {
        var s = getStatusSettings();
        return !s || s.enabled !== false;
    }

    /* 与心声侧 miya-chat-heartvoice-templates 保持一致的截断上限。
       导入的是外部 JSON，不设上限时超大模板会把 localStorage 直接撑爆；
       而 persistPresets 若静默吞掉 QuotaExceededError，就会出现
       「本次会话看得到、重启后没了」且用户毫无提示的鬼影预设。 */
    var MAX_CUSTOM_PROMPT_LEN = 50000;
    var MAX_HTML_TEMPLATE_LEN = 200000;
    var MAX_PRESET_NAME_LEN = 60;

    function normalizePreset(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var name = String(raw.name || '').trim().slice(0, MAX_PRESET_NAME_LEN);
        if (!name) return null;
        var fields = Array.isArray(raw.fields)
            ? raw.fields
                  .slice(0, 40)
                  .map(function (f) {
                      var n = String((f && f.name) || '').trim().slice(0, 40);
                      if (!n) return null;
                      return {
                          name: n,
                          requirement: String((f && f.requirement) || '')
                              .trim()
                              .slice(0, 4000)
                      };
                  })
                  .filter(Boolean)
            : [];
        if (!fields.length) return null;
        return {
            name: name,
            customPrompt: String(raw.customPrompt || '').trim().slice(0, MAX_CUSTOM_PROMPT_LEN),
            fields: fields,
            htmlTemplate: String(raw.htmlTemplate || '').slice(0, MAX_HTML_TEMPLATE_LEN),
            savedAt: Number(raw.savedAt) || Date.now()
        };
    }

    /** 读取落盘原文（不做解析），用于缓存一致性比对 */
    function readPresetsRaw() {
        try {
            return localStorage.getItem(PRESETS_LS) || '';
        } catch (e) {
            return '';
        }
    }

    /** 主动作废缓存（storage 事件、导入、删除等外部写入后调用） */
    function invalidatePresetsCache() {
        presetsCache = null;
        presetsCacheAt = 0;
        presetsCacheRaw = '';
    }

    function loadPresets() {
        var raw = readPresetsRaw();
        /* 缓存有效条件：存在 + 未过 TTL + 落盘原文未变。
           任一不满足就重读，兼顾性能与多标签页一致性。 */
        if (
            presetsCache &&
            Date.now() - presetsCacheAt < PRESETS_CACHE_TTL_MS &&
            raw === presetsCacheRaw
        ) {
            return presetsCache;
        }
        var list = [];
        try {
            var parsed = JSON.parse(raw || '[]');
            if (Array.isArray(parsed)) {
                list = parsed.map(normalizePreset).filter(Boolean);
            }
        } catch (e) {}
        presetsCache = list;
        presetsCacheAt = Date.now();
        presetsCacheRaw = raw;
        return list;
    }

    /**
     * 落盘预设。成功返回 list，失败返回 null。
     * 关键：不再静默吞配额错误 —— 先写盘、落盘成功后再更新 presetsCache，
     * 避免「内存有、盘上没有」的不一致。配额不足时自动丢弃最旧的自定义预设重试。
     */
    function persistPresets(list) {
        var next = Array.isArray(list) ? list : [];
        var attempt = 0;
        while (true) {
            try {
                var raw = JSON.stringify(next);
                localStorage.setItem(PRESETS_LS, raw);
                presetsCache = next;
                presetsCacheAt = Date.now();
                presetsCacheRaw = raw;
                return next;
            } catch (e) {
                /* 配额不足：优先保留新导入的（在数组前部），从尾部裁掉旧的再试 */
                if (next.length > 1 && attempt < 8) {
                    next = next.slice(0, Math.max(1, next.length - 1));
                    attempt += 1;
                    continue;
                }
                return null;
            }
        }
    }

    function findOfflinePreset(name) {
        var n = String(name || '').trim();
        if (!n) return null;
        var list = loadPresets();
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].name === n) return list[i];
        }
        return null;
    }

    function saveOfflinePreset(name, state) {
        var row = normalizePreset(
            Object.assign({}, state || {}, { name: name, savedAt: Date.now() })
        );
        if (!row) return null;
        var list = loadPresets().filter(function (p) {
            return p.name !== row.name;
        });
        list.unshift(row);
        /* 落盘失败（配额不足且裁无可裁）时返回 null，由调用方给出明确提示，
           不能让用户以为保存成功了却什么都没有。 */
        return persistPresets(list) ? row : null;
    }

    function deleteOfflinePreset(name) {
        var n = String(name || '').trim();
        if (!n) return false;
        var before = loadPresets().length;
        var kept = loadPresets().filter(function (p) {
            return p.name !== n;
        });
        if (before === kept.length) return false;   /* 本来就不存在，别假装删了 */
        if (!persistPresets(kept)) return false;
        var cur = String((getStatusSettings().presetName) || '').trim();
        if (cur === n || cur === 'offline:' + n) {
            saveStatusSettings({ presetName: '' });
        }
        return loadPresets().length < before;
    }

    function parsePresetKey(raw) {
        var s = String(raw || '').trim();
        if (!s) return { source: 'builtin', name: '' };
        if (s.indexOf('offline:') === 0) return { source: 'offline', name: s.slice(8) };
        if (s.indexOf('hv:') === 0) return { source: 'hv', name: s.slice(3) };
        /* 兼容旧值：纯名称优先线下，再心声 */
        if (findOfflinePreset(s)) return { source: 'offline', name: s };
        var mod = tplMod();
        if (mod && typeof mod.findPreset === 'function' && mod.findPreset(s)) {
            return { source: 'hv', name: s };
        }
        return { source: 'offline', name: s };
    }

    function encodePresetKey(source, name) {
        if (!name) return '';
        if (source === 'hv') return 'hv:' + name;
        return 'offline:' + name;
    }

    function resolveStatusPreset() {
        var settings = getStatusSettings();
        var key = parsePresetKey(settings && settings.presetName);
        if (key.source === 'builtin' || !key.name) return null;
        if (key.source === 'offline') return findOfflinePreset(key.name);
        var mod = tplMod();
        if (mod && typeof mod.findPreset === 'function') return mod.findPreset(key.name) || null;
        return null;
    }

    function builtinFieldNames() {
        return BUILTIN_FIELDS.map(function (f) {
            return f.name;
        });
    }

    function resolveFieldNames(preset) {
        if (preset && Array.isArray(preset.fields) && preset.fields.length) {
            return preset.fields
                .map(function (f) {
                    return String((f && f.name) || '').trim();
                })
                .filter(Boolean);
        }
        return builtinFieldNames();
    }

    function buildStatusRulesBlock(castContacts) {
        if (!isEnabled()) return '';
        var list = Array.isArray(castContacts) && castContacts.length ? castContacts : [];
        var names = list
            .map(function (c) {
                return String((c && c.name) || '').trim();
            })
            .filter(Boolean);
        var multi = names.length > 1;
        var preset = resolveStatusPreset();
        var fieldNames = resolveFieldNames(preset);
        var n = fieldNames.length;
        var lines = [
            '【线下格式规则·状态栏】',
            '正文结束后必须完整输出 <miyastatus>...</miyastatus>：开闭标签均必填；禁止写入 <thinking> 或正文。',
            '状态栏只输出纯文本字段行（字段名-内容），禁止输出 HTML/CSS/模板。'
        ];
        if (multi) {
            lines.push(
                '本场为多人线下，须为每一位出演角色各写一套完整状态，不得合并、不得省略任何人。'
            );
            lines.push('出演名单（名称须完全一致）：' + names.join('、') + '。');
            lines.push(
                '格式：每位角色以单独一行「### 角色名」开头，其下紧跟 ' +
                    n +
                    ' 个字段行；下一位角色再写下一个「### 角色名」。'
            );
            lines.push('完整示例：');
            lines.push('<miyastatus>');
            names.forEach(function (nm) {
                lines.push('### ' + nm);
                fieldNames.forEach(function (fn) {
                    lines.push(fn + '-（写' + nm + '的本字段）');
                });
            });
            lines.push('</miyastatus>');
            lines.push('自检：### 标题数量必须等于 ' + String(names.length) + '，且每人字段齐全。');
        } else {
            var rn = names[0] || '角色';
            lines.push('本场角色：' + rn + '。段内须写满以下 ' + n + ' 个字段：');
        }
        if (preset) {
            var customPrompt = String(preset.customPrompt || '').trim();
            if (customPrompt) {
                lines.push('【自定义状态要求·须优先遵守】');
                lines.push(
                    customPrompt
                        .replace(/<miyavoice>/gi, '<miyastatus>')
                        .replace(/<\/miyavoice>/gi, '</miyastatus>')
                        .replace(/miyavoice/gi, 'miyastatus')
                        .replace(/心声/g, '状态')
                );
            }
            lines.push('【字段说明·须全部输出】');
            (preset.fields || []).forEach(function (f) {
                var req = String((f && f.requirement) || '').trim() || '按人设与当下情境填写';
                lines.push(String(f.name) + '-' + req);
            });
        } else {
            lines.push('【字段说明·须全部输出】（内置简约）');
            BUILTIN_FIELDS.forEach(function (f) {
                lines.push(f.name + '-' + f.requirement);
            });
        }
        lines.push('发出前自检：字段是否写满并正确闭合 </miyastatus>；不足则补全。');
        return lines.join('\n');
    }

    function extractStatusBlock(rawText) {
        var src = String(rawText || '');
        var patterns = [
            /<miyastatus>([\s\S]*?)<\/miyastatus\s*>/i,
            /＜miyastatus＞([\s\S]*?)＜\/miyastatus＞/i,
            /<miyavoice>([\s\S]*?)<\/miyav[\w]*\s*>/i,
            /＜miyavoice＞([\s\S]*?)＜\/miyav[\w]*＞/i
        ];
        var i;
        for (i = 0; i < patterns.length; i++) {
            var m = src.match(patterns[i]);
            if (m && m[1] && String(m[1]).trim()) return String(m[1]).trim();
        }
        var tail = src.match(/<miyastatus>([\s\S]*)$/i) || src.match(/＜miyastatus＞([\s\S]*)$/i);
        if (tail && tail[1] && String(tail[1]).trim()) return String(tail[1]).trim();
        return '';
    }

    function stripStatusFromText(rawText) {
        return String(rawText || '')
            .replace(/<miyastatus>[\s\S]*?<\/miyastatus\s*>/gi, '')
            .replace(/＜miyastatus＞[\s\S]*?＜\/miyastatus＞/gi, '')
            .replace(/<miyastatus>[\s\S]*$/gi, '')
            .replace(/＜miyastatus＞[\s\S]*$/gi, '')
            .replace(/<miyavoice>[\s\S]*?<\/miyav[\w]*\s*>/gi, '')
            .replace(/＜miyavoice＞[\s\S]*?＜\/miyav[\w]*＞/gi, '')
            .replace(/<miyavoice>[\s\S]*$/gi, '')
            .replace(/＜miyavoice＞[\s\S]*$/gi, '')
            .trim();
    }

    function splitMultiSections(inner) {
        var src = String(inner || '').trim();
        if (!src) return [];
        var parts = src.split(/(?=^###\s+.+$|^【[^】]+】\s*$)/m);
        if (parts.length <= 1) {
            return [{ name: '', body: src }];
        }
        return parts
            .map(function (chunk) {
                var t = String(chunk || '').trim();
                if (!t) return null;
                var hm = t.match(/^###\s+(.+?)\s*\n([\s\S]*)$/);
                if (hm) return { name: String(hm[1] || '').trim(), body: String(hm[2] || '').trim() };
                var bm = t.match(/^【([^】]+)】\s*\n([\s\S]*)$/);
                if (bm) return { name: String(bm[1] || '').trim(), body: String(bm[2] || '').trim() };
                return { name: '', body: t };
            })
            .filter(Boolean);
    }

    function parseFieldsFromInner(inner, fieldNames) {
        var eng = engineParse();
        if (eng) {
            var wrapped = '<miyavoice>' + String(inner || '') + '</miyavoice>';
            var parsed = eng.parseHeartVoiceFromReply(wrapped, { fieldNames: fieldNames });
            if (parsed && parsed.extractedOk && parsed.extracted) {
                if (parsed.extracted.mode === 'custom' && parsed.extracted.fields) {
                    return parsed.extracted.fields;
                }
                var legacyMap = {
                    好感度: parsed.extracted.affection != null ? String(parsed.extracted.affection) : '',
                    欲望值: parsed.extracted.desire != null ? String(parsed.extracted.desire) : '',
                    行为动作: parsed.extracted.action || '',
                    角色心声: parsed.extracted.monologue || ''
                };
                var out = {};
                var hit = 0;
                fieldNames.forEach(function (n) {
                    if (legacyMap[n]) {
                        out[n] = legacyMap[n];
                        hit += 1;
                    }
                });
                if (hit) return out;
            }
        }
        var fields = {};
        var current = null;
        String(inner || '')
            .split(/\n/)
            .forEach(function (line) {
                var raw = String(line || '').trim();
                if (!raw) return;
                var matched = null;
                fieldNames.some(function (label) {
                    var escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    var re = new RegExp('^' + escaped + '\\s*[-－—：:]\\s*([\\s\\S]+)$');
                    var m = raw.match(re);
                    if (m) {
                        matched = { key: label, value: String(m[1] || '').trim() };
                        return true;
                    }
                    return false;
                });
                if (matched) {
                    current = matched.key;
                    fields[current] = matched.value;
                    return;
                }
                if (current) {
                    fields[current] = (fields[current] ? fields[current] + '\n' : '') + raw;
                }
            });
        return fields;
    }

    /**
     * 角色名归一化：去掉所有空白（含全角空格 \u3000、不换行空格），
     * 全角 ASCII 转半角，并去括号等装饰符，用于容错匹配。
     * 例：「 角色 A 」「角色　A」「角色A（化名）」→ 同一 key。
     */
    function normalizeNameKey(raw) {
        var s = String(raw || '');
        /* 全角 → 半角（U+FF01–U+FF5E 映射到 U+0021–U+007E） */
        s = s.replace(/[\uFF01-\uFF5E]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
        });
        /* 常见的非断行 / 零宽空白统一清掉 */
        s = s.replace(/[\s\u3000\u00a0\u200b-\u200d\ufeff]+/g, '');
        /* 去掉包裹性装饰（括号、书名号、引号）与其内容中的常见修饰标记 */
        s = s.replace(/[（(【\[《<].*?[）)】\]》>]/g, '');
        s = s.replace(/["'“”‘’`·・]+/g, '');
        return s.toLowerCase();
    }

    function matchContactByName(castContacts, name) {
        var n = String(name || '').trim();
        var list = Array.isArray(castContacts) ? castContacts : [];
        if (!n) return list[0] || null;
        var found = null;
        /* 一次精确匹配 */
        list.some(function (c) {
            if (!c) return false;
            if (String(c.name || '').trim() === n) {
                found = c;
                return true;
            }
            return false;
        });
        if (found) return found;
        /* 二次归一化匹配：容忍 AI 输出里的空白 / 全角 / 括号差异。
           旧实现只做精确匹配，多人场里「### 角色 A」与 cast 里的「角色A」
           对不上就把整段静默丢弃并补空槽，用户看不出是 AI 漏写还是解析失败。 */
        var key = normalizeNameKey(n);
        if (!key) return null;
        list.some(function (c) {
            if (!c) return false;
            if (normalizeNameKey(c.name) === key) {
                found = c;
                return true;
            }
            return false;
        });
        return found || null;
    }

    function parseStatusFromReply(rawText, castContacts) {
        var inner = extractStatusBlock(rawText);
        if (!inner) {
            return { ok: false, entries: [], unmatched: [], updatedAt: Date.now() };
        }
        var preset = resolveStatusPreset();
        var fieldNames = resolveFieldNames(preset);
        var sections = splitMultiSections(inner);
        var list = Array.isArray(castContacts) && castContacts.length ? castContacts : [{ id: '', name: '' }];
        var entries = [];
        /* AI 写了段落但没能匹配上任何角色时记录下来，供 UI 提示，
           避免「AI 漏写」与「解析失败」在用户侧无法区分。 */
        var unmatched = [];
        if (sections.length === 1 && !sections[0].name && list.length === 1) {
            entries.push(makeEntry(list[0], parseFieldsFromInner(sections[0].body, fieldNames), preset));
        } else {
            sections.forEach(function (sec) {
                var contact = matchContactByName(list, sec.name);
                if (!contact && list.length === 1) contact = list[0];
                if (!contact) {
                    if (sec.name || (sec.body && sec.body.trim())) {
                        unmatched.push(String(sec.name || '(未命名段落)').trim());
                    }
                    return;
                }
                entries.push(makeEntry(contact, parseFieldsFromInner(sec.body, fieldNames), preset));
            });
            if (!entries.length && list[0]) {
                entries.push(makeEntry(list[0], parseFieldsFromInner(inner, fieldNames), preset));
            }
            /* 多人：补齐未写出状态的角色空槽，方便 UI 仍列出名字 */
            if (list.length > 1) {
                list.forEach(function (c) {
                    var has = entries.some(function (e) {
                        return e && e.contactId === c.id;
                    });
                    if (!has) entries.push(makeEntry(c, {}, preset));
                });
            }
        }
        var ok = entries.some(function (e) {
            return (
                e &&
                e.fields &&
                Object.keys(e.fields).some(function (k) {
                    return String(e.fields[k] || '').trim();
                })
            );
        });
        return { ok: ok, entries: entries, unmatched: unmatched, updatedAt: Date.now() };
    }

    function makeEntry(contact, fields, preset) {
        var map = fields && typeof fields === 'object' ? fields : {};
        var row = {
            contactId: String((contact && (contact.id || contact.contactId)) || '').trim(),
            roleName: String((contact && contact.name) || '').trim(),
            mode: preset ? 'custom' : 'builtin',
            fields: map,
            updatedAt: Date.now()
        };
        if (preset) {
            row.presetName = String(preset.name || '').trim();
            row.htmlTemplate = String(preset.htmlTemplate || '');
        }
        return row;
    }

    function appendStatusLog(sess, pack) {
        if (!sess || !pack) return;
        /* 有段落没匹配上任何角色：明示出来。
           旧实现静默丢弃并补空槽，用户无法区分是 AI 漏写还是解析失败。 */
        if (pack.unmatched && pack.unmatched.length) {
            try {
                toast('状态栏：未匹配到角色 —— ' + pack.unmatched.join('、'));
            } catch (e) {}
        }
        if (!pack.ok || !pack.entries || !pack.entries.length) return;
        var log = Array.isArray(sess.statusLog) ? sess.statusLog.slice() : [];
        log.unshift({
            updatedAt: pack.updatedAt || Date.now(),
            entries: pack.entries
        });
        if (log.length > STATUS_LOG_MAX) log.length = STATUS_LOG_MAX;
        sess.statusLog = log;
        var st = apStore();
        if (st && typeof st._writeSession === 'function') st._writeSession(sess);
    }

    function latestRound(sess) {
        var log = (sess && sess.statusLog) || [];
        return log[0] || null;
    }

    function resolveCastContacts(sess) {
        var st = chatStore();
        var cast =
            sess && Array.isArray(sess.cast) && sess.cast.length
                ? sess.cast
                : [{ contactId: sess && sess.contactId, chatId: sess && sess.chatId }];
        return cast
            .map(function (row) {
                var cid = String((row && row.contactId) || '').trim();
                var contact = st && cid && st.findContact ? st.findContact(cid) : null;
                if (!contact && cid) {
                    return { id: cid, name: cid, avatar: '' };
                }
                if (!contact) return null;
                return {
                    id: contact.id,
                    name: contact.name,
                    avatar: contact.avatar,
                    avatarBlobId: contact.avatarBlobId,
                    characterId: contact.characterId,
                    chronicleId: contact.chronicleId,
                    _contact: contact
                };
            })
            .filter(Boolean);
    }

    function resolveStatusAvatarSync(contact) {
        if (!contact) return '';
        var app = global.miyaOfflineApp;
        if (app && typeof app.findContactsAppAvatar === 'function') {
            var fromCt = app.findContactsAppAvatar(contact._contact || contact);
            if (fromCt) return fromCt;
        }
        if (app && typeof app.contactAvatar === 'function') {
            var url = app.contactAvatar(contact._contact || contact);
            if (url) return url;
        }
        var a = contact.avatar;
        if (typeof a === 'string' && a.trim()) return a.trim();
        if (a && a.url) return a.url;
        return '';
    }

    function avatarUrl(contact) {
        return resolveStatusAvatarSync(contact);
    }

    function hydrateStatusAvatars(root, cast) {
        if (!root) return;
        var app = global.miyaOfflineApp;
        var list = Array.isArray(cast) ? cast : [];
        root.querySelectorAll('img.xw-status__ava[data-xw-status-cid]').forEach(function (img) {
            var cid = img.getAttribute('data-xw-status-cid') || '';
            var contact =
                list.filter(function (c) {
                    return c && c.id === cid;
                })[0] || null;
            if (!contact) return;
            var full = contact._contact || contact;
            var sync = resolveStatusAvatarSync(contact);
            if (sync) {
                img.src = sync;
                img.hidden = false;
            }
            if (app && typeof app.resolveOfflineContactAvatarAsync === 'function') {
                app.resolveOfflineContactAvatarAsync(full).then(function (url) {
                    if (!url || !img.isConnected) return;
                    img.src = url;
                    img.hidden = false;
                    var ph = img.parentElement && img.parentElement.querySelector('.xw-status__ava--ph');
                    if (ph) ph.hidden = true;
                });
            }
        });
    }

    function panelShellHtml() {
        return (
            '<div class="xw-status" id="xw-status-panel" hidden aria-hidden="true">' +
            '<div class="xw-status__backdrop" data-xw-status-close></div>' +
            '<div class="xw-status__sheet" role="dialog" aria-modal="true" aria-labelledby="xw-status-title">' +
            '<header class="xw-status__head">' +
            '<div class="xw-status__head-text">' +
            '<p class="xw-status__kicker">STATUS</p>' +
            '<h2 class="xw-status__title" id="xw-status-title">本轮状态</h2></div>' +
            '<button type="button" class="xw-status__close" data-xw-status-close aria-label="关闭">×</button>' +
            '</header>' +
            '<div class="xw-status__tabs" id="xw-status-tabs" hidden></div>' +
            '<div class="xw-status__body" id="xw-status-body"></div>' +
            '<footer class="xw-status__foot">' +
            '<details class="xw-status__preset-fold">' +
            '<summary class="xw-status__preset-sum">' +
            '<span>状态模版</span>' +
            '<i class="xw-status__preset-chev" aria-hidden="true"></i></summary>' +
            '<div class="xw-status__preset-panel">' +
            '<label class="xw-status__preset-lab" for="xw-status-preset">选择模版</label>' +
            '<select class="xw-status__preset" id="xw-status-preset" aria-label="状态模版"></select>' +
            '<div class="xw-status__preset-actions">' +
            '<button type="button" class="xw-status__mini" data-xw-status-save>保存</button>' +
            '<button type="button" class="xw-status__mini" data-xw-status-del>删除</button>' +
            '<button type="button" class="xw-status__mini" data-xw-status-export>导出</button>' +
            '<button type="button" class="xw-status__mini" data-xw-status-import>导入</button>' +
            '<input type="file" id="xw-status-import-file" accept="application/json,.json" hidden multiple>' +
            '</div>' +
            '<p class="xw-status__hint">单人/多人共用；可保存线下预设，也可读取心声库；导入支持 miyastatus / miyavoice JSON</p>' +
            '</div></details></footer></div></div>'
        );
    }

    function ensurePanel() {
        var app = document.getElementById('miya-offline-app');
        if (!app) return null;
        if (panelEl && panelEl.isConnected && panelEl.querySelector('.xw-status__preset-fold') && panelEl.querySelector('[data-xw-status-save]')) return panelEl;
        if (panelEl && panelEl.isConnected) {
            try {
                panelEl.remove();
            } catch (e) {}
            panelEl = null;
        }
        var wrap = document.createElement('div');
        wrap.innerHTML = panelShellHtml();
        panelEl = wrap.firstChild;
        app.appendChild(panelEl);
        panelEl.addEventListener('click', function (e) {
            if (e.target.closest('[data-xw-status-close]')) {
                closePanel();
                return;
            }
            var tab = e.target.closest('[data-xw-status-tab]');
            if (tab) {
                viewState.activeContactId = tab.getAttribute('data-xw-status-tab') || 'all';
                paintPanel();
                return;
            }
            if (e.target.closest('[data-xw-status-save]')) {
                saveCurrentPresetFlow();
                return;
            }
            if (e.target.closest('[data-xw-status-del]')) {
                deleteCurrentPresetFlow();
                return;
            }
            if (e.target.closest('[data-xw-status-export]')) {
                exportCurrentPresetFlow();
                return;
            }
            if (e.target.closest('[data-xw-status-import]')) {
                var fileInp = panelEl.querySelector('#xw-status-import-file');
                if (fileInp) fileInp.click();
            }
        });
        var sel = panelEl.querySelector('#xw-status-preset');
        if (sel) {
            sel.addEventListener('change', function () {
                saveStatusSettings({ presetName: String(sel.value || '').trim() });
                paintPanel();
            });
        }
        var fileInp2 = panelEl.querySelector('#xw-status-import-file');
        if (fileInp2) {
            fileInp2.addEventListener('change', function () {
                var picked = fileInp2.files;
                fileInp2.value = '';
                if (!picked || !picked.length) return;
                /* 导入的是外部文件，其 htmlTemplate 会以代码形式在 iframe 内执行。
                   模板已被 sandbox 隔离（拿不到本机数据），但仍有网络出口，
                   因此明确告知来源要求，避免用户随意导入群里的陌生 JSON。 */
                var ask = global.miyaDialog && global.miyaDialog.confirm
                    ? global.miyaDialog.confirm({
                          title: '导入预设',
                          message:
                              '预设中的自定义模板会以代码形式运行。\n' +
                              '沙箱已隔离本机数据，但模板仍可联网，请仅导入可信来源的文件。\n\n确定继续导入？'
                      })
                    : Promise.resolve(window.confirm('模板将以代码运行，请仅导入可信来源。继续？'));
                ask.then(function (ok) {
                    if (!ok) return;
                    importPresetFiles(picked);
                });
            });
        }
        return panelEl;
    }

    function fillPresetSelect() {
        if (!panelEl) return;
        var sel = panelEl.querySelector('#xw-status-preset');
        if (!sel) return;
        var cur = String((getStatusSettings().presetName) || '').trim();
        /* 统一先解析成「带来源前缀的 key」，后续 selected 判断只认 key。
           旧实现用 `key === cur || p.name === cur` 双条件，
           当线下与心声库存在同名预设时两个 option 都会被标记 selected ——
           浏览器保留最后一个（心声库），而 parsePresetKey 解析纯名时优先线下，
           于是「UI 显示选中的」与「实际生效的」不是同一个预设。 */
        var parsedCur = parsePresetKey(cur);
        var resolvedKey = encodePresetKey(parsedCur.source, parsedCur.name);
        var opts = '<option value="">内置 · Ins 简约</option>';
        var offline = loadPresets();
        if (offline.length) {
            opts += '<optgroup label="线下预设">';
            offline.forEach(function (p) {
                var key = encodePresetKey('offline', p.name);
                opts +=
                    '<option value="' +
                    esc(key) +
                    '"' +
                    (key === resolvedKey ? ' selected' : '') +
                    '>' +
                    esc(p.name) +
                    '</option>';
            });
            opts += '</optgroup>';
        }
        var mod = tplMod();
        if (mod && typeof mod.loadPresets === 'function') {
            var hv = mod.loadPresets() || [];
            if (hv.length) {
                opts += '<optgroup label="心声库（只读选用）">';
                hv.forEach(function (p) {
                    if (!p || !p.name) return;
                    var key = encodePresetKey('hv', p.name);
                    opts +=
                        '<option value="' +
                        esc(key) +
                        '"' +
                        (key === resolvedKey ? ' selected' : '') +
                        '>' +
                        esc(p.name) +
                        '</option>';
                });
                opts += '</optgroup>';
            }
        }
        sel.innerHTML = opts;
        if (resolvedKey) sel.value = resolvedKey;
        /* 若解析出的来源在 UI 里没有对应项（例如心声库那条被删了），
           退回到唯一存在的同名项，保证「显示的」与「生效的」始终一致。 */
        if (resolvedKey && sel.value !== resolvedKey) {
            var altKey = resolvedKey.indexOf('hv:') === 0
                ? encodePresetKey('offline', resolvedKey.slice(3))
                : encodePresetKey('hv', resolvedKey.slice(8));
            if ([].some.call(sel.options, function (o) { return o.value === altKey; })) sel.value = altKey;
            else sel.value = '';
        }
        if (!cur) sel.value = '';
    }

    function currentSelectedPreset() {
        return resolveStatusPreset();
    }

    function saveCurrentPresetFlow() {
        var preset = currentSelectedPreset();
        if (!preset) {
            toast('内置模版无需保存；请先导入自定义或从心声库选用后再保存到线下');
            return;
        }
        var key = parsePresetKey(getStatusSettings().presetName);
        var defaultName = preset.name || '线下状态';
        var ask =
            global.miyaDialog && global.miyaDialog.prompt
                ? global.miyaDialog.prompt({
                      title: '保存线下状态预设',
                      message: key.source === 'hv' ? '将心声预设另存为线下预设名称' : '预设名称',
                      defaultValue: defaultName
                  })
                : Promise.resolve(window.prompt('预设名称', defaultName));
        ask.then(function (name) {
            if (name == null) return;
            var trimmed = String(name || '').trim();
            if (!trimmed) {
                toast('请输入名称');
                return;
            }
            var row = saveOfflinePreset(trimmed, {
                customPrompt: preset.customPrompt,
                fields: preset.fields,
                htmlTemplate: preset.htmlTemplate
            });
            if (row) {
                saveStatusSettings({ presetName: encodePresetKey('offline', row.name) });
                fillPresetSelect();
                toast('已保存「' + row.name + '」');
            } else toast('保存失败：本地存储空间不足，请先删除部分自定义预设');
        });
    }

    function deleteCurrentPresetFlow() {
        var key = parsePresetKey(getStatusSettings().presetName);
        if (key.source !== 'offline' || !key.name) {
            toast('只能删除线下预设');
            return;
        }
        var ask =
            global.miyaDialog && global.miyaDialog.confirm
                ? global.miyaDialog.confirm({
                      title: '删除预设',
                      message: '确定删除线下状态预设「' + key.name + '」？'
                  })
                : Promise.resolve(window.confirm('删除「' + key.name + '」？'));
        ask.then(function (ok) {
            if (!ok) return;
            if (deleteOfflinePreset(key.name)) {
                fillPresetSelect();
                toast('已删除');
                paintPanel();
            }
        });
    }

    function buildExportPayload(preset) {
        var row = normalizePreset(preset);
        if (!row) return null;
        return {
            format: 'miyastatus',
            name: row.name,
            customPrompt: row.customPrompt,
            fields: row.fields.map(function (f) {
                return { name: f.name, requirement: f.requirement };
            }),
            htmlTemplate: row.htmlTemplate
        };
    }

    function exportCurrentPresetFlow() {
        var preset = currentSelectedPreset();
        if (!preset) {
            toast('内置模版无需导出；请先选择或导入自定义预设');
            return;
        }
        var payload = buildExportPayload(preset);
        if (!payload) {
            toast('导出失败');
            return;
        }
        try {
            var blob = new Blob([JSON.stringify(payload, null, 2)], {
                type: 'application/json;charset=utf-8'
            });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download =
                'miyastatus-' +
                String(payload.name || 'preset')
                    .replace(/[\\/:*?"<>|]+/g, '_')
                    .slice(0, 40) +
                '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () {
                try {
                    URL.revokeObjectURL(url);
                } catch (e) {}
            }, 1200);
            toast('已导出「' + payload.name + '」');
        } catch (e2) {
            toast('导出失败');
        }
    }

    function parseImportPayload(raw, fileName) {
        if (!raw || typeof raw !== 'object') return null;
        var format = String(raw.format || '').trim().toLowerCase();
        if (format && format !== 'miyastatus' && format !== 'miyavoice') return null;
        var name = String(raw.name || '').trim();
        if (!name && fileName) {
            name = String(fileName)
                .replace(/^.*[\\/]/, '')
                .replace(/\.json$/i, '')
                .replace(/^miyastatus[-_\s]*/i, '')
                .replace(/^miyavoice[-_\s]*/i, '')
                .trim();
        }
        return normalizePreset({
            name: name || '导入预设',
            customPrompt: raw.customPrompt,
            fields: raw.fields,
            htmlTemplate: raw.htmlTemplate
        });
    }

    function importPresetFiles(fileList) {
        var files = fileList ? Array.prototype.slice.call(fileList) : [];
        if (!files.length) return;
        var ok = 0;
        var fail = 0;
        var quotaFail = 0;
        var lastName = '';
        var chain = Promise.resolve();
        files.forEach(function (file) {
            chain = chain.then(function () {
                return new Promise(function (resolve) {
                    var reader = new FileReader();
                    reader.onload = function () {
                        try {
                            var raw = JSON.parse(String(reader.result || ''));
                            var row = parseImportPayload(raw, file && file.name);
                            if (!row) {
                                fail += 1;
                            } else if (!saveOfflinePreset(row.name, row)) {
                                /* normalizePreset 通过但落盘失败 → 几乎必然是配额不足 */
                                quotaFail += 1;
                            } else {
                                lastName = row.name;
                                ok += 1;
                            }
                        } catch (e) {
                            fail += 1;
                        }
                        resolve();
                    };
                    reader.onerror = function () {
                        fail += 1;
                        resolve();
                    };
                    reader.readAsText(file);
                });
            });
        });
        chain.then(function () {
            if (ok && lastName) {
                saveStatusSettings({ presetName: encodePresetKey('offline', lastName) });
            }
            fillPresetSelect();
            paintPanel();
            if (quotaFail && !ok && !fail) {
                toast('导入失败：本地存储空间不足，请先删除部分自定义预设');
            } else if (ok && !fail && !quotaFail) {
                toast('导入成功 ' + ok + ' 个');
            } else if (ok || !fail) {
                toast(
                    '导入完成：成功 ' +
                        ok +
                        (quotaFail ? '，空间不足 ' + quotaFail : '') +
                        (fail ? '，格式错误 ' + fail : '')
                );
            } else {
                toast('导入失败，请选择 miyastatus / miyavoice JSON');
            }
        });
    }

    function renderBuiltinCard(entry, contact) {
        var fields = (entry && entry.fields) || {};
        var name = (entry && entry.roleName) || (contact && contact.name) || '角色';
        var ava = avatarUrl(contact);
        var cid = String((contact && contact.id) || (entry && entry.contactId) || '').trim();
        var rows = BUILTIN_FIELDS.map(function (f) {
            var v = String(fields[f.name] || '').trim() || '—';
            return (
                '<div class="xw-status__row">' +
                '<span class="xw-status__lab">' +
                esc(f.name) +
                '</span>' +
                '<p class="xw-status__val">' +
                esc(v) +
                '</p></div>'
            );
        }).join('');
        return (
            '<div class="xw-status__card">' +
            '<div class="xw-status__who">' +
            (ava
                ? '<img class="xw-status__ava" data-xw-status-cid="' +
                  esc(cid) +
                  '" src="' +
                  esc(ava) +
                  '" alt="">'
                : '<span class="xw-status__ava xw-status__ava--ph" aria-hidden="true"></span>' +
                  (cid
                      ? '<img class="xw-status__ava" data-xw-status-cid="' +
                        esc(cid) +
                        '" alt="" hidden>'
                      : '')) +
            '<div><strong>' +
            esc(name) +
            '</strong><span>本轮快照</span></div></div>' +
            rows +
            '</div>'
        );
    }

    function renderEntryCard(entry, contact) {
        var cid = String((contact && contact.id) || (entry && entry.contactId) || '').trim();
        var ava = avatarUrl(contact);
        var whoAva =
            ava
                ? '<img class="xw-status__ava" data-xw-status-cid="' +
                  esc(cid) +
                  '" src="' +
                  esc(ava) +
                  '" alt="">'
                : '<span class="xw-status__ava xw-status__ava--ph" aria-hidden="true"></span>' +
                  (cid
                      ? '<img class="xw-status__ava" data-xw-status-cid="' +
                        esc(cid) +
                        '" alt="" hidden>'
                      : '');
        if (!entry) {
            return (
                '<div class="xw-status__card xw-status__card--empty">' +
                '<div class="xw-status__who">' +
                whoAva +
                '<div><strong>' +
                esc((contact && contact.name) || '角色') +
                '</strong><span>暂无本轮状态</span></div></div></div>'
            );
        }
        if (entry.mode === 'custom') {
            return (
                '<div class="xw-status__card xw-status__card--custom" data-xw-status-entry="' +
                esc(entry.contactId || '') +
                '">' +
                '<div class="xw-status__who">' +
                whoAva +
                '<div><strong>' +
                esc(entry.roleName || (contact && contact.name) || '角色') +
                '</strong><span>自定义模版</span></div></div>' +
                '<div class="xw-status__custom" data-xw-status-mount></div></div>'
            );
        }
        return renderBuiltinCard(entry, contact);
    }

    function mountCustomCards(body, round, cast) {
        var mod = tplMod();
        if (!body || !mod) return;
        body.querySelectorAll('[data-xw-status-entry]').forEach(function (card) {
            var cid = card.getAttribute('data-xw-status-entry') || '';
            var entry =
                round &&
                (round.entries || []).filter(function (e) {
                    return e && e.contactId === cid;
                })[0];
            var contact =
                cast.filter(function (c) {
                    return c.id === cid;
                })[0] || null;
            var mount = card.querySelector('[data-xw-status-mount]');
            if (!entry || !mount) return;
            var tpl = String(entry.htmlTemplate || '').trim();
            if (!tpl && entry.presetName) {
                var p = findOfflinePreset(entry.presetName);
                if (!p && mod.findPreset) p = mod.findPreset(entry.presetName);
                if (p) tpl = String(p.htmlTemplate || '');
            }
            if (tpl && typeof mod.renderTemplate === 'function' && typeof mod.mountInteractiveHtml === 'function') {
                var html = mod.renderTemplate(tpl, entry.fields || {}, {
                    charAvatar: avatarUrl(contact),
                    userAvatar: ''
                });
                if (String(html || '').trim()) {
                    mod.mountInteractiveHtml(mount, html, {
                        frameClass: 'xw-status__iframe',
                        title: '线下状态'
                    });
                    return;
                }
            }
            var keys = Object.keys(entry.fields || {});
            mount.innerHTML = keys.length
                ? keys
                      .map(function (k) {
                          return (
                              '<div class="xw-status__row"><span class="xw-status__lab">' +
                              esc(k) +
                              '</span><p class="xw-status__val">' +
                              esc(String(entry.fields[k] || '')) +
                              '</p></div>'
                          );
                      })
                      .join('')
                : '<p class="xw-status__empty">字段为空</p>';
        });
    }

    function paintPanel() {
        if (!panelEl) return;
        fillPresetSelect();
        var st = apStore();
        var sess =
            st && viewState.chatId && viewState.sessionId
                ? st.getSession(viewState.chatId, viewState.sessionId)
                : null;
        var cast = resolveCastContacts(sess);
        var tabs = panelEl.querySelector('#xw-status-tabs');
        var body = panelEl.querySelector('#xw-status-body');
        var title = panelEl.querySelector('#xw-status-title');
        if (!body) return;
        if (title) {
            title.textContent = cast.length > 1 ? '本轮状态 · ' + cast.length + ' 人' : '本轮状态';
        }
        if (cast.length > 1 && tabs) {
            tabs.hidden = false;
            if (!viewState.activeContactId) viewState.activeContactId = 'all';
            var tabHtml =
                '<button type="button" class="xw-status__tab' +
                (viewState.activeContactId === 'all' ? ' is-on' : '') +
                '" data-xw-status-tab="all">全部</button>';
            cast.forEach(function (c) {
                var on = c.id === viewState.activeContactId;
                tabHtml +=
                    '<button type="button" class="xw-status__tab' +
                    (on ? ' is-on' : '') +
                    '" data-xw-status-tab="' +
                    esc(c.id) +
                    '">' +
                    esc(c.name) +
                    '</button>';
            });
            tabs.innerHTML = tabHtml;
        } else if (tabs) {
            tabs.hidden = true;
            tabs.innerHTML = '';
            viewState.activeContactId = cast[0] ? cast[0].id : 'all';
        }
        var round = latestRound(sess);
        var showAll = cast.length > 1 && viewState.activeContactId === 'all';
        var targets = showAll
            ? cast
            : cast.filter(function (c) {
                  return c.id === viewState.activeContactId;
              });
        if (!targets.length && cast[0]) targets = [cast[0]];
        if (!targets.length) {
            body.innerHTML = '<p class="xw-status__empty">本轮暂无状态</p>';
            return;
        }
        if (!round || !round.entries || !round.entries.length) {
            body.innerHTML =
                '<div class="xw-status__stack">' +
                targets
                    .map(function (c) {
                        return renderEntryCard(null, c);
                    })
                    .join('') +
                '</div>' +
                '<p class="xw-status__empty"><span>角色回复后会出现在这里</span></p>';
            hydrateStatusAvatars(body, cast);
            return;
        }
        body.innerHTML =
            '<div class="xw-status__stack">' +
            targets
                .map(function (c) {
                    var entry =
                        (round.entries || []).filter(function (e) {
                            return e && e.contactId === c.id;
                        })[0] || null;
                    return renderEntryCard(entry, c);
                })
                .join('') +
            '</div>';
        mountCustomCards(body, round, cast);
        hydrateStatusAvatars(body, cast);
    }

    function openPanel(ctx) {
        if (!isEnabled()) {
            toast('状态栏已在调参中关闭');
            return;
        }
        ctx = ctx && typeof ctx === 'object' ? ctx : {};
        viewState.chatId = String(ctx.chatId || '').trim();
        viewState.sessionId = String(ctx.sessionId || '').trim();
        viewState.contactId = String(ctx.contactId || '').trim();
        viewState.activeContactId = 'all';
        ensurePanel();
        if (!panelEl) return;
        paintPanel();
        panelEl.hidden = false;
        panelEl.setAttribute('aria-hidden', 'false');
        panelEl.classList.add('is-open');
    }

    function closePanel() {
        if (!panelEl) return;
        panelEl.classList.remove('is-open');
        panelEl.hidden = true;
        panelEl.setAttribute('aria-hidden', 'true');
    }

    /* 线下状态悬浮圆钮已整体移除（产品决定），这里只保留接口形状，全部 no-op。
       旧实现的问题：CSS 用 !important 把它藏起来、syncFab 也无条件 hidden=true，
       但 ensureFab 仍会被调用方触发 —— 结果往 DOM 里塞了一个看不见的 <button>，
       并给 window 重复挂上 mousemove / touchmove / mouseup / touchend 监听
       （ensureFab 一旦重建节点就会再挂一轮），纯属徒增开销与被误触风险。
       现在不建节点、不绑事件；设置面板里的悬浮球相关 UI 也已同步移除。 */
    var DEFAULT_FAB_ICON =
        '<svg class="xw-status-fab__icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="8.2"/>' +
        '<circle cx="12" cy="12" r="3.2"/>' +
        '</svg>';

    function getFabIconUrl() {
        return '';
    }

    function applyFabAppearance() {
        /* 悬浮球已移除，无外观可应用 */
    }

    function ensureFab() {
        /* 不再创建任何 DOM 节点 */
        return null;
    }

    function syncFab(visible) {
        /* 悬浮球已移除；状态栏本身仍可按原逻辑工作 */
    }

    function hideAll() {
        closePanel();
        syncFab(false);
    }

    /* 多标签页同步：其它页写入预设后本页缓存立即作废。
       storage 事件只在「其它标签页」修改时触发，本页自身写入不会触发，故无回环风险。 */
    try {
        window.addEventListener('storage', function (e) {
            if (!e || e.key !== PRESETS_LS) return;
            invalidatePresetsCache();
        });
    } catch (e) {}

    global.MiyaOfflineStatus = {
        isEnabled: isEnabled,
        buildStatusRulesBlock: buildStatusRulesBlock,
        parseStatusFromReply: parseStatusFromReply,
        stripStatusFromText: stripStatusFromText,
        appendStatusLog: appendStatusLog,
        openPanel: openPanel,
        closePanel: closePanel,
        syncFab: syncFab,
        hideAll: hideAll,
        ensureFab: ensureFab,
        applyFabAppearance: applyFabAppearance,
        getStatusSettings: getStatusSettings,
        resolveStatusPreset: resolveStatusPreset,
        loadPresets: loadPresets,
        invalidatePresetsCache: invalidatePresetsCache,
        saveOfflinePreset: saveOfflinePreset,
        deleteOfflinePreset: deleteOfflinePreset,
        builtinFields: BUILTIN_FIELDS,
        defaultFabIconHtml: DEFAULT_FAB_ICON
    };
})(window);
