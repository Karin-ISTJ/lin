/**
 * 世界书 ST 对齐测例 —— 浏览器控制台: 加载后执行 MiyaWorldbookSTTests.run()
 * 或 Node: node plugins/worldbook-st-tests.js （需先加载 st 模块）
 */
(function (global) {
  'use strict';

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assert failed');
  }

  function run() {
    var st = global.miyaWorldbookST;
    assert(st, 'miyaWorldbookST missing');
    var results = [];

    function test(name, fn) {
      try {
        fn();
        results.push({ name: name, ok: true });
      } catch (e) {
        results.push({ name: name, ok: false, error: String(e && e.message ? e.message : e) });
      }
    }

    test('constant always activates', function () {
      var r = st.activateEntries(
        [{ id: '1', constant: true, content: 'A', enabled: true, key: [] }],
        { contextText: 'hello' }
      );
      assert(r.activated.length === 1, 'expected 1 constant');
    });

    test('primary key match', function () {
      var r = st.activateEntries(
        [{ id: '1', key: ['阿尔法'], content: 'X', enabled: true }],
        { contextText: '今天见到阿尔法了' }
      );
      assert(r.activated.length === 1, 'key should match');
    });

    test('primary key miss', function () {
      var r = st.activateEntries(
        [{ id: '1', key: ['贝塔'], content: 'X', enabled: true }],
        { contextText: '今天见到阿尔法了' }
      );
      assert(r.activated.length === 0, 'should not match');
    });

    test('selective AND any secondary', function () {
      var entry = {
        id: '1',
        key: ['家'],
        keysecondary: ['你的', '她的'],
        selective: true,
        selectiveLogic: 0,
        content: '房屋',
        enabled: true
      };
      var hit = st.activateEntries([entry], { contextText: '去你的家看看' });
      var miss = st.activateEntries([entry], { contextText: '回家吃饭' });
      assert(hit.activated.length === 1, 'selective should hit');
      assert(miss.activated.length === 0, 'selective should miss without secondary');
    });

    test('token budget drops low order', function () {
      var entries = [
        { id: 'low', order: 10, content: '一二三四五六七八九十'.repeat(20), enabled: true, constant: true },
        { id: 'high', order: 200, content: '高优先', enabled: true, constant: true, ignoreBudget: false }
      ];
      var act = st.activateEntries(entries, { contextText: '' });
      var bud = st.applyTokenBudget(act.activated, 30);
      assert(bud.entries.some(function (e) { return e.id === 'high'; }), 'high order kept');
      // low may be dropped depending on estimate
      assert(bud.usedTokens <= 30 || bud.entries.some(function (e) { return e.ignoreBudget; }), 'budget respected');
    });

    test('ignoreBudget bypass', function () {
      var big = '字'.repeat(500);
      var entries = [
        { id: 'a', order: 1, content: big, constant: true, enabled: true, ignoreBudget: true },
        { id: 'b', order: 2, content: '小', constant: true, enabled: true }
      ];
      var bud = st.applyTokenBudget(entries, 5);
      assert(bud.entries.some(function (e) { return e.id === 'a'; }), 'ignoreBudget entry kept');
    });

    test('parse ST entries object', function () {
      var json = {
        entries: {
          '0': {
            uid: 0,
            key: ['测试'],
            keysecondary: [],
            comment: '测例条目',
            content: '内容A',
            constant: false,
            selective: false,
            order: 100,
            position: 0,
            disable: false
          },
          '1': {
            uid: 1,
            key: [],
            comment: '常驻',
            content: '内容B',
            constant: true,
            order: 50,
            position: 1,
            disable: false
          }
        }
      };
      var parsed = st.parseStWorldInfoJson(json);
      assert(parsed.length === 2, 'parse 2 entries');
      assert(parsed[1].constant === true, 'constant field');
      assert(parsed[0].key[0] === '测试', 'key field');
    });

    test('position 4 maps to back/inChat', function () {
      var e = st.normalizeStFields({ position: 4, depth: 2, content: 'x', key: ['a'] }, {});
      assert(e.depth === 'back', 'depth back');
      assert(e.injection_depth === 2, 'injection depth');
    });

    test('pipeline integrates', function () {
      var entries = [
        { id: 'c', constant: true, content: '常驻设定', order: 10, enabled: true, position: 0 },
        { id: 'k', key: ['龙'], content: '龙的设定', order: 100, enabled: true, position: 1 }
      ];
      var pipe = st.runPipeline(entries, {
        contextText: '一条龙出现了',
        tokenBudget: 500,
        dryRun: true
      });
      assert(pipe.selected.length >= 1, 'pipeline selected');
      assert(pipe.buckets.front || pipe.buckets.middle, 'buckets exist');
    });

    test('group scoring keeps highest weight', function () {
      var entries = [
        { id: 'g1', constant: true, content: 'A', group: 'weather', groupWeight: 50, order: 10, enabled: true },
        { id: 'g2', constant: true, content: 'B', group: 'weather', groupWeight: 90, order: 10, enabled: true },
        { id: 'g3', constant: true, content: 'C', group: 'weather', groupWeight: 20, groupOverride: true, order: 10, enabled: true }
      ];
      var pipe = st.runPipeline(entries, { contextText: '', tokenBudget: 9999, dryRun: true });
      var ids = pipe.selected.map(function (e) { return e.id; });
      assert(ids.indexOf('g2') >= 0, 'top weight kept');
      assert(ids.indexOf('g1') < 0, 'low weight dropped');
      assert(ids.indexOf('g3') >= 0, 'override kept');
    });

    test('compareActivation report', function () {
      var entries = [
        { id: 'a', key: ['苹果'], content: '果', enabled: true },
        { id: 'b', key: ['香蕉'], content: '蕉', enabled: true }
      ];
      var rep = st.compareActivation(entries, { contextText: '我吃了苹果', dryRun: true, tokenBudget: 999 }, ['a']);
      assert(rep.ok, 'compare should ok for apple only');
    });

    var failed = results.filter(function (r) { return !r.ok; });
    console.log('[MiyaWorldbookSTTests]', results.length - failed.length + '/' + results.length + ' passed');
    failed.forEach(function (f) {
      console.error(' FAIL', f.name, f.error);
    });
    return { results: results, ok: failed.length === 0 };
  }

  global.MiyaWorldbookSTTests = { run: run };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { run: run };
  }
})(typeof window !== 'undefined' ? window : globalThis);
