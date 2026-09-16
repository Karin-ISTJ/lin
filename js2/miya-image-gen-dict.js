/**
 * miya-image-gen-dict.js — 中文 → Danbooru 标签翻译器（NovelAI 专用）
 *
 * ── 为什么需要这个 ──────────────────────────────────────────────
 *
 * NovelAI 是 Danbooru 标签驱动的模型。它训练时见的是
 * `pink hair, long hair, heterochromia, teary eyes`，
 * 而不是「粉色长发，异色瞳，含泪」。
 *
 * 角色卡里的外貌描述几乎都是中文写的。直接把中文喂给 NovelAI：
 *   · 中文 token 在 Danbooru 语料里几乎没有统计权重 → 提示词近乎失效
 *   · 模型只能靠随机发挥，出图与角色卡设定对不上
 *
 * 所以需要一层翻译：把中文外貌描述里的**可识别特征**抽出来，
 * 转成标准 Danbooru 标签，剩下的中文原样保留（总比丢掉强）。
 *
 * ── 设计原则 ───────────────────────────────────────────────────
 *
 * 1. **宁可漏，不可错**
 *    词表只收「含义明确、一望即知」的词。像「气质」「感觉」这种
 *    主观词一律不收 —— 翻错了比不翻更伤。
 *
 * 2. **长词优先**
 *    词表按**字符串长度降序**排序后逐条替换。
 *    否则「长发」会先把「粉色长发」咬掉一半，
 *    剩个「粉色」再无处可去。
 *
 * 3. **不破坏英文**
 *    输入里如果本来就有英文标签（角色卡作者可能已经写好了），
 *    中文汉字少于 2 个就直接原样返回，一个字都不动。
 *
 * 4. **重入安全**
 *    每个正则都带 `g` 但都需要重置 `lastIndex`。
 *    这里不为省事而复用正则对象 —— 词表在模块加载时构建一次，
 *    每条正则都独立持有，不会互相干扰。
 *
 * ── 用法 ───────────────────────────────────────────────────────
 *
 *   MiyaImageGenDict.translate('粉色长发，异色瞳，含泪')
 *   // → 'pink hair, long hair, heterochromia, teary eyes'
 *
 *   MiyaImageGenDict.hasChinese('粉色长发')
 *   // → true
 *
 * 挂载：global.MiyaImageGenDict
 * 依赖：无（可独立加载，也可以在 miya-image-gen.js 之前或之后加载）
 */
(function (global) {
  'use strict';

  /*
   * ── 词表 ──────────────────────────────────────────────────────
   *
   * 分七组维护，方便后续按需扩充：
   *   hair / eyes / expression / subject / framing / pose / scene / quality
   *
   * 每条是 [中文正则, Danbooru 替换串]。
   * 注意：正则都带 g，且**不要**在词条之间共享正则对象。
   */
  var HAIR = [
    // 颜色 + 长度 + 组合（长词在前，避免被短词截断）
    [/粉色长发/g, 'pink hair, long hair'],
    [/粉色短发/g, 'pink hair, short hair'],
    [/粉色头发/g, 'pink hair'],
    [/粉发/g, 'pink hair'],
    [/粉毛/g, 'pink hair'],
    [/金色长发/g, 'blonde hair, long hair'],
    [/金色短发/g, 'blonde hair, short hair'],
    [/金色头发/g, 'blonde hair'],
    [/金发/g, 'blonde hair'],
    [/银色长发/g, 'silver hair, long hair'],
    [/银色短发/g, 'silver hair, short hair'],
    [/银色头发/g, 'silver hair'],
    [/银发/g, 'silver hair'],
    [/白色长发/g, 'white hair, long hair'],
    [/白色短发/g, 'white hair, short hair'],
    [/白色头发/g, 'white hair'],
    [/白发/g, 'white hair'],
    [/黑色长发/g, 'black hair, long hair'],
    [/黑色短发/g, 'black hair, short hair'],
    [/黑色头发/g, 'black hair'],
    [/黑发/g, 'black hair'],
    [/红色长发/g, 'red hair, long hair'],
    [/红色短发/g, 'red hair, short hair'],
    [/红色头发/g, 'red hair'],
    [/红发/g, 'red hair'],
    [/蓝色长发/g, 'blue hair, long hair'],
    [/蓝色短发/g, 'blue hair, short hair'],
    [/蓝色头发/g, 'blue hair'],
    [/蓝发/g, 'blue hair'],
    [/紫色长发/g, 'purple hair, long hair'],
    [/紫色短发/g, 'purple hair, short hair'],
    [/紫色头发/g, 'purple hair'],
    [/紫发/g, 'purple hair'],
    [/棕色长发/g, 'brown hair, long hair'],
    [/棕色短发/g, 'brown hair, short hair'],
    [/棕色头发/g, 'brown hair'],
    [/棕发/g, 'brown hair'],
    [/褐色长发/g, 'brown hair, long hair'],
    [/褐色短发/g, 'brown hair, short hair'],
    [/褐色头发/g, 'brown hair'],
    [/绿色长发/g, 'green hair, long hair'],
    [/绿色短发/g, 'green hair, short hair'],
    [/绿色头发/g, 'green hair'],
    [/绿发/g, 'green hair'],
    [/橙色长发/g, 'orange hair, long hair'],
    [/橙色短发/g, 'orange hair, short hair'],
    [/橙色头发/g, 'orange hair'],
    [/橙发/g, 'orange hair'],
    [/灰色头发/g, 'grey hair'],
    [/灰发/g, 'grey hair'],
    [/渐变发色/g, 'gradient hair'],
    [/渐变发/g, 'gradient hair'],
    [/挑染/g, 'streaked hair'],
    [/双色发/g, 'two-tone hair'],
    [/彩色头发/g, 'multicolored hair'],

    // 发型
    [/超长发/g, 'very long hair'],
    [/及腰长发/g, 'very long hair'],
    [/长发/g, 'long hair'],
    [/中长发/g, 'medium hair'],
    [/齐肩发/g, 'shoulder-length hair'],
    [/短发/g, 'short hair'],
    [/高马尾/g, 'high ponytail'],
    [/低马尾/g, 'low ponytail'],
    [/单马尾/g, 'ponytail'],
    [/马尾辫/g, 'ponytail'],
    [/马尾/g, 'ponytail'],
    [/双马尾/g, 'twintails'],
    [/双丸子头/g, 'double bun'],
    [/丸子头/g, 'hair bun'],
    [/麻花辫/g, 'braid'],
    [/双辫/g, 'twin braids'],
    [/辫子/g, 'braid'],
    [/编发/g, 'braid'],
    [/披肩发/g, 'hair over shoulder'],
    [/公主切/g, 'hime cut'],
    [/波波头/g, 'bob cut'],
    [/齐刘海/g, 'blunt bangs'],
    [/斜刘海/g, 'side bangs'],
    [/空气刘海/g, 'see-through bangs'],
    [/刘海/g, 'bangs'],
    [/卷发/g, 'curly hair'],
    [/大波浪/g, 'wavy hair, long hair'],
    [/波浪发/g, 'wavy hair'],
    [/直发/g, 'straight hair'],
    [/碎发/g, 'messy hair'],
    [/湿发/g, 'wet hair'],
    [/散发/g, 'hair down'],
    [/盘发/g, 'hair up, updo'],
    [/头发凌乱/g, 'messy hair'],
    [/乱发/g, 'messy hair'],
    [/呆毛/g, 'ahoge'],
    [/兽耳/g, 'animal ears'],
    [/猫耳/g, 'cat ears'],
    [/兔耳/g, 'rabbit ears'],
    [/狐耳/g, 'fox ears'],
    [/天使光环/g, 'halo'],
    [/发带/g, 'hairband'],
    [/发夹/g, 'hair clip'],
    [/蝴蝶结/g, 'hair bow'],
    [/发卡/g, 'hair ornament']
  ];

  var EYES = [
    [/红色眼睛/g, 'red eyes'],
    [/蓝色眼睛/g, 'blue eyes'],
    [/绿色眼睛/g, 'green eyes'],
    [/金色眼睛/g, 'golden eyes'],
    [/紫色眼睛/g, 'purple eyes'],
    [/棕色眼睛/g, 'brown eyes'],
    [/黑色眼睛/g, 'black eyes'],
    [/粉色眼睛/g, 'pink eyes'],
    [/银色眼睛/g, 'silver eyes'],
    [/异色瞳/g, 'heterochromia'],
    [/红瞳/g, 'red eyes'],
    [/蓝瞳/g, 'blue eyes'],
    [/金瞳/g, 'golden eyes'],
    [/绿瞳/g, 'green eyes'],
    [/紫瞳/g, 'purple eyes'],
    [/黑瞳/g, 'black eyes'],
    [/粉瞳/g, 'pink eyes'],
    [/大眼睛/g, 'large eyes'],
    [/丹凤眼/g, 'slanted eyes'],
    [/桃花眼/g, 'tareme'],
    [/星瞳/g, 'star-shaped pupils'],
    [/竖瞳/g, 'slit pupils'],
    [/半闭眼/g, 'half-closed eyes'],
    [/闭眼/g, 'closed eyes'],
    [/眯眼/g, 'squinting'],
    [/眨眼/g, 'winking'],
    [/单眼皮/g, 'single eyelid'],
    [/双眼皮/g, 'double eyelid']
  ];

  var EXPRESSION = [
    [/含泪/g, 'teary eyes'],
    [/泪眼/g, 'teary eyes'],
    [/流泪/g, 'crying, tears'],
    [/哭泣/g, 'crying'],
    [/哭红/g, 'tears'],
    [/红眼眶/g, 'tears'],
    [/眼泪/g, 'tears'],
    [/灿烂的笑/g, 'bright smile'],
    [/灿烂笑容/g, 'bright smile'],
    [/甜美的笑/g, 'sweet smile'],
    [/温柔的笑/g, 'gentle smile'],
    [/腼腆的笑/g, 'shy smile'],
    [/邪魅的笑/g, 'smirk'],
    [/坏笑/g, 'smirk, mischievous'],
    [/微笑/g, 'smile'],
    [/笑容/g, 'smile'],
    [/笑着/g, 'smiling'],
    [/大笑/g, 'laughing, open mouth'],
    [/开心的笑/g, 'happy, smile'],
    [/元气满满/g, 'energetic'],
    [/开心/g, 'happy'],
    [/高兴/g, 'happy'],
    [/害羞/g, 'shy, blush'],
    [/脸红/g, 'blush'],
    [/羞涩/g, 'shy, blush'],
    [/得意/g, 'smug'],
    [/生气/g, 'angry'],
    [/愤怒/g, 'angry'],
    [/恼怒/g, 'annoyed'],
    [/悲伤/g, 'sad'],
    [/难过/g, 'sad'],
    [/忧郁/g, 'melancholy'],
    [/悲伤的表情/g, 'sad'],
    [/冷漠/g, 'expressionless'],
    [/无表情/g, 'expressionless'],
    [/面无表情/g, 'expressionless'],
    [/惊讶/g, 'surprised'],
    [/吃惊/g, 'surprised'],
    [/震惊/g, 'shocked'],
    [/思考/g, 'thinking'],
    [/沉思/g, 'pensive'],
    [/撅嘴/g, 'pout'],
    [/嘟嘴/g, 'pout'],
    [/傲娇/g, 'tsundere, looking away'],
    [/委屈/g, 'teary eyes, frown'],
    [/害怕/g, 'scared'],
    [/恐惧/g, 'scared'],
    [/紧张/g, 'nervous'],
    [/困倦/g, 'sleepy'],
    [/困/g, 'sleepy'],
    [/打哈欠/g, 'yawning'],
    [/叹气/g, 'sigh'],
    [/认真/g, 'serious'],
    [/严肃/g, 'serious'],
    [/温柔/g, 'gentle'],
    [/性感/g, 'seductive'],
    [/挑逗/g, 'seductive'],
    [/妩媚/g, 'alluring'],
    [/清纯/g, 'innocent'],
    [/优雅/g, 'elegant'],
    [/成熟/g, 'mature'],
    [/高冷/g, 'expressionless, cool'],
    [/吐舌头/g, 'tongue out'],
    [/伸舌头/g, 'tongue out'],
    [/舔嘴唇/g, 'licking lips']
  ];

  var SUBJECT = [
    [/两个女孩/g, '2girls'],
    [/两个男孩/g, '2boys'],
    [/两个人/g, '1boy, 1girl'],
    [/一个男孩/g, '1boy'],
    [/一个男生/g, '1boy'],
    [/一个男人/g, '1boy'],
    [/一个女孩/g, '1girl'],
    [/一个女生/g, '1girl'],
    [/一个女人/g, '1girl'],
    [/1个男孩/g, '1boy'],
    [/1个男生/g, '1boy'],
    [/1个男人/g, '1boy'],
    [/1个女孩/g, '1girl'],
    [/1个女生/g, '1girl'],
    [/1个女人/g, '1girl'],
    [/小男孩/g, '1boy, child'],
    [/小女孩/g, '1girl, child'],
    [/美少女/g, 'beautiful girl'],
    [/少女/g, 'girl'],
    [/少年/g, 'boy'],
    [/帅哥/g, 'handsome boy'],
    [/美女/g, 'beautiful girl'],
    [/男生/g, 'boy'],
    [/女生/g, 'girl'],
    [/男人/g, 'man'],
    [/女人/g, 'woman'],
    [/男孩/g, 'boy'],
    [/女孩/g, 'girl'],
    [/男子/g, 'man'],
    [/女子/g, 'woman'],
    [/独身/g, 'solo']
  ];

  var FRAMING = [
    [/脸部特写/g, 'face close-up'],
    [/上半身/g, 'upper body'],
    [/半身像/g, 'upper body'],
    [/半身/g, 'upper body'],
    [/全身像/g, 'full body'],
    [/全身/g, 'full body'],
    [/大头照/g, 'portrait, close-up'],
    [/特写/g, 'close-up'],
    [/自拍/g, 'selfie, looking at viewer, pov'],
    [/正面/g, 'facing viewer'],
    [/侧面/g, 'from side, profile'],
    [/背面/g, 'from behind'],
    [/背影/g, 'from behind'],
    [/俯视/g, 'from above'],
    [/仰视/g, 'from below'],
    [/回头/g, 'looking back'],
    [/看向镜头/g, 'looking at viewer'],
    [/看向别处/g, 'looking away'],
    [/低头/g, 'looking down'],
    [/抬头/g, 'looking up']
  ];

  var POSE = [
    [/坐着/g, 'sitting'],
    [/站着/g, 'standing'],
    [/躺着/g, 'lying down'],
    [/趴着/g, 'lying on stomach'],
    [/趴在床上/g, 'lying on stomach, on bed'],
    [/蹲着/g, 'squatting'],
    [/跪着/g, 'kneeling'],
    [/跑步/g, 'running'],
    [/走路/g, 'walking'],
    [/跳舞/g, 'dancing'],
    [/跳跃/g, 'jumping'],
    [/弯腰/g, 'bending over'],
    [/靠墙/g, 'leaning against wall'],
    [/靠着/g, 'leaning'],
    [/拥抱/g, 'hug'],
    [/牵手/g, 'holding hands'],
    [/叉腰/g, 'hands on hips'],
    [/抱臂/g, 'crossed arms'],
    [/双手合十/g, 'own hands together'],
    [/手托腮/g, 'hand on own cheek'],
    [/撩头发/g, 'hand in own hair'],
    [/比心/g, 'heart hands'],
    [/挥手/g, 'waving'],
    [/敬礼/g, 'salute'],
    [/伸懒腰/g, 'stretching'],
    [/撑伞/g, 'holding umbrella'],
    [/拿手机/g, 'holding phone'],
    [/看书/g, 'reading book'],
    [/弹吉他/g, 'playing guitar'],
    [/弹钢琴/g, 'playing piano'],
    [/喝咖啡/g, 'drinking coffee'],
    [/喝奶茶/g, 'drinking bubble tea'],
    [/吃东西/g, 'eating']
  ];

  /*
   * ── 纯色词 ────────────────────────────────────────────────────
   *
   * 单独出现的颜色词必须独立成条。只写「白色背景」「白色长发」是不够的 ——
   * 描述里「白色连衣裙」「红色外套」这类搭配非常常见，
   * 缺了独立词条就会留下裸的「白色」粘在 dress 前面。
   *
   * 这几条同时摆在 SCENE 之前，靠长度排序自然会排在组合词之后。
   */
  var COLOR = [
    [/白色/g, 'white'],
    [/黑色/g, 'black'],
    [/红色/g, 'red'],
    [/蓝色/g, 'blue'],
    [/绿色/g, 'green'],
    [/黄色/g, 'yellow'],
    [/紫色/g, 'purple'],
    [/粉色/g, 'pink'],
    [/橙色/g, 'orange'],
    [/棕色/g, 'brown'],
    [/褐色/g, 'brown'],
    [/灰色/g, 'grey'],
    [/银色/g, 'silver'],
    [/金色/g, 'golden'],
    [/青色/g, 'cyan'],
    [/米色/g, 'beige']
  ];

  var SCENE = [
    [/简单背景/g, 'simple background'],
    [/纯色背景/g, 'solid color background'],
    [/白色背景/g, 'white background'],
    [/黑色背景/g, 'black background'],
    [/透明背景/g, 'white background, simple background'],
    [/模糊背景/g, 'blurry background, depth of field'],
    [/景深/g, 'depth of field'],
    [/虚化/g, 'bokeh'],
    [/照片/g, 'photo'],
    [/写实/g, 'realistic'],
    [/教室/g, 'classroom'],
    [/学校/g, 'school'],
    [/操场/g, 'playground, school'],
    [/图书馆/g, 'library'],
    [/咖啡馆/g, 'cafe'],
    [/咖啡厅/g, 'cafe'],
    [/餐厅/g, 'restaurant'],
    [/酒吧/g, 'bar'],
    [/厨房/g, 'kitchen'],
    [/客厅/g, 'living room'],
    [/卧室/g, 'bedroom'],
    [/浴室/g, 'bathroom'],
    [/办公室/g, 'office'],
    [/走廊/g, 'hallway'],
    [/楼梯/g, 'stairs'],
    [/阳台/g, 'balcony'],
    [/天台/g, 'rooftop'],
    [/公园/g, 'park'],
    [/街道/g, 'street'],
    [/马路/g, 'road'],
    [/车站/g, 'station'],
    [/地铁/g, 'subway'],
    [/火车/g, 'train'],
    [/公交车/g, 'bus'],
    [/汽车/g, 'car'],
    [/便利店/g, 'convenience store'],
    [/商场/g, 'shopping mall'],
    [/超市/g, 'supermarket'],
    [/医院/g, 'hospital'],
    [/神社/g, 'shinto shrine'],
    [/寺庙/g, 'temple'],
    [/城堡/g, 'castle'],
    [/海边/g, 'beach, ocean'],
    [/沙滩/g, 'beach'],
    [/海/g, 'ocean'],
    [/湖/g, 'lake'],
    [/河/g, 'river'],
    [/瀑布/g, 'waterfall'],
    [/森林/g, 'forest'],
    [/树林/g, 'forest'],
    [/山/g, 'mountain'],
    [/山顶/g, 'mountain, mountain top'],
    [/草原/g, 'grassland'],
    [/花海/g, 'flower field'],
    [/花园/g, 'garden'],
    [/樱花/g, 'cherry blossoms'],
    [/夕阳/g, 'sunset'],
    [/黄昏/g, 'sunset'],
    [/日落/g, 'sunset'],
    [/日出/g, 'sunrise'],
    [/清晨/g, 'morning'],
    [/夜晚/g, 'night'],
    [/夜景/g, 'night, city lights'],
    [/星空/g, 'starry sky'],
    [/月亮/g, 'moon'],
    [/下雨/g, 'rain'],
    [/雨天/g, 'rainy'],
    [/下雪/g, 'snow'],
    [/雪天/g, 'snowy'],
    [/晴天/g, 'sunny'],
    [/阴天/g, 'overcast'],
    [/雾天/g, 'fog'],
    [/樱花树下/g, 'cherry blossoms, tree'],
    [/窗边/g, 'window'],
    [/窗前/g, 'window'],
    [/床上/g, 'on bed'],
    [/沙发上/g, 'on sofa'],
    [/椅子上/g, 'on chair'],
    [/地板上/g, 'on floor'],
    [/浴缸/g, 'bathtub'],
    [/泳池/g, 'swimming pool'],
    [/泳装/g, 'swimsuit'],
    [/浴衣/g, 'yukata'],
    [/和服/g, 'kimono'],
    [/校服/g, 'school uniform'],
    [/制服/g, 'uniform'],
    [/西装/g, 'suit'],
    [/连衣裙/g, 'dress'],
    [/旗袍/g, 'china dress'],
    [/女仆装/g, 'maid'],
    [/白大褂/g, 'labcoat'],
    [/披风/g, 'cape'],
    [/斗篷/g, 'cloak'],
    [/眼镜/g, 'glasses'],
    [/帽子/g, 'hat'],
    [/围巾/g, 'scarf'],
    [/项链/g, 'necklace'],
    [/耳环/g, 'earrings'],
    [/耳机/g, 'headphones'],
    [/翅膀/g, 'wings'],
    [/尾巴/g, 'tail'],
    [/猫尾巴/g, 'cat tail'],
    [/咖啡杯/g, 'coffee cup'],
    [/咖啡/g, 'coffee'],
    [/茶杯/g, 'teacup'],
    [/奶茶/g, 'bubble tea'],
    [/雨伞/g, 'umbrella'],
    [/书/g, 'book'],
    [/花/g, 'flower'],
    [/白玫瑰/g, 'white rose'],
    [/玫瑰/g, 'rose'],
    [/猫/g, 'cat'],
    [/狗/g, 'dog'],
    [/包/g, 'bag'],
    [/背包/g, 'backpack'],
    [/吉他/g, 'guitar'],
    [/钢琴/g, 'piano'],
    [/刀/g, 'sword'],
    [/剑/g, 'sword'],
    [/枪/g, 'gun'],
    [/棒棒糖/g, 'lollipop'],
    [/冰淇淋/g, 'ice cream'],
    [/蛋糕/g, 'cake'],
    [/食物/g, 'food']
  ];

  var QUALITY = [
    [/乱涂/g, 'sketch'],
    [/素描/g, 'sketch'],
    [/线稿/g, 'lineart'],
    [/水彩/g, 'watercolor'],
    [/油画/g, 'oil painting'],
    [/扁平插画/g, 'flat color'],
    [/画风/g, ''],
    [/氛围感/g, 'atmosphere'],
    [/氛围/g, 'atmosphere'],
    [/清新/g, 'fresh'],
    [/梦幻/g, 'dreamy'],
    [/唯美/g, 'beautiful'],
    [/漂亮的/g, 'beautiful'],
    [/可爱的/g, 'cute'],
    [/可爱/g, 'cute'],
    [/帅气/g, 'handsome, cool'],
    [/酷/g, 'cool'],
    [/英俊/g, 'handsome'],
    [/普通/g, 'average'],
    [/简约/g, 'minimalist']
  ];

  /*
   * ── 虚词与残留单字清理 ────────────────────────────────────────
   *
   * 中文描述里必然带这些虚词。翻译完标签后它们会以「的」「在」
   * 这样的孤立汉字留在串里，既是噪声又占 token。
   *
   * ⚠️ 单字清理必须**先补空格**再删，即把「站cherry」变成
   * 「站 cherry」再删掉「站 」，否则「站」和「cherry」之间没有
   * 分隔，删完会得到「cherry」但前面的英文标签可能被粘连。
   * 这里统一用「单字前后补空格 → 删掉带空格的单字」两步走，
   * 保证英文标签之间永远有逗号或空格分隔。
   *
   * 顺序有讲究：先删长词，单字放最后，否则「他的」会被先删掉
   * 「他」和「的」，反而多出一段空白。
   *
   * (?!$) 防止把**整串就是一个虚词**的情况清成空串。
   */
  var FILLER = [
    [/着/g, ' '],
    [/了/g, ' '],
    [/地/g, ' '],
    [/里/g, ' '],
    [/在/g, ' '],
    [/的(?!$)/g, ', '],
    [/我/g, ' '],
    [/你/g, ' '],
    [/他/g, ' '],
    [/她/g, ' '],
    [/它/g, ' '],
    /*
     * 高频残留动词/方位字。
     *
     * 这些字在词表里没有独立英文对应（「站」本身不是 Danbooru 标签，
     * `standing` 才是），但如果以「站在」「坐着」形式出现，
     * 前面的长词条已经处理掉了，剩下的光杆单字会粘在英文上。
     * 与其留着污染标签串，不如删掉 —— 姿态信息已由 POSE 组覆盖。
     */
    [/站/g, ' '],
    [/坐/g, ' '],
    [/躺/g, ' '],
    [/趴/g, ' '],
    [/走/g, ' '],
    [/跑/g, ' '],
    [/穿/g, ' '],
    [/戴/g, ' '],
    [/拿/g, ' '],
    [/抱/g, ' '],
    [/靠/g, ' '],
    [/和/g, ' '],
    [/与/g, ' '],
    [/及/g, ' '],
    [/或/g, ' '],
    [/很/g, ' '],
    [/非/g, ' '],
    [/十/g, ' '],
    [/分/g, ' '],
    [/有/g, ' '],
    [/是/g, ' '],
    [/那/g, ' '],
    [/这/g, ' '],
    [/个/g, ' '],
    [/只/g, ' ']
  ];

  /*
   * ── 标点归一 ──────────────────────────────────────────────────
   *
   * 中文标点在 Danbooru 串里没有意义，统一转成逗号或直接删除，
   * 最后再做一次逗号压缩。
   */
  var PUNCT = [
    [/，/g, ', '],
    [/、/g, ', '],
    [/；/g, ', '],
    [/：/g, ', '],
    [/。/g, ''],
    [/！/g, ''],
    [/？/g, ''],
    [/～/g, ''],
    [/~/g, ''],
    [/…/g, ''],
    [/\.\.\./g, ''],
    [/「/g, ''],
    [/」/g, ''],
    [/【/g, ''],
    [/】/g, ''],
    [/（/g, ''],
    [/）/g, '']
  ];

  /*
   * 词表构建：合并后**按匹配串长度降序**排序。
   *
   * 这一步是正确性的关键。举例：
   *   输入「粉色长发」
   *   若「长发」排在「粉色长发」前面 → 先命中「长发」→ 变成「粉色long hair」
   *   再找「粉色」无处可去 → 结果里残留中文
   *   排好序后「粉色长发」先命中 → 正确得到 pink hair, long hair
   *
   * 长度用正则 source 的长度近似（去掉首尾斜杠与 g 标志后的字符数）。
   */
  function patternLength(re) {
    return String(re.source).length;
  }

  var DICTIONARY = []
    .concat(HAIR, EYES, EXPRESSION, SUBJECT, FRAMING, POSE, SCENE, COLOR, QUALITY)
    .sort(function (a, b) {
      return patternLength(b[0]) - patternLength(a[0]);
    });

  var FILLER_SORTED = FILLER.slice().sort(function (a, b) {
    return patternLength(b[0]) - patternLength(a[0]);
  });

  var PUNCT_SORTED = PUNCT.slice().sort(function (a, b) {
    return patternLength(b[0]) - patternLength(a[0]);
  });

  /* 调试开关：打开后每次翻译都会 console.log 前后对照 */
  var DEBUG = false;

  function setDebug(on) {
    DEBUG = !!on;
  }

  function countChinese(s) {
    var m = String(s || '').match(/[\u4e00-\u9fff]/g);
    return m ? m.length : 0;
  }

  function hasChinese(s) {
    return /[\u4e00-\u9fff]/.test(String(s || ''));
  }

  /*
   * 逐条套用词表。
   *
   * ── 边界标记方案 ──────────────────────────────────────────────
   *
   * 最初的实现直接把替换值写回串里，导致「黑发红瞳」这种连续中文
   * 命中后得到 `black hairred eyes` —— 两个标签粘成一个不可分的词，
   * 之后无论怎么清理都救不回来。
   *
   * 现在的做法：每条替换都用**哨兵字符 \u0002** 把结果包起来。
   *   黑发红瞳  →  \u0002black hair\u0002\u0002red eyes\u0002
   *
   * 哨兵有两个作用：
   *   1. 明确标记「这是一个完整标签的边界」，不会被后面的清理逻辑吃掉
   *   2. 收尾时统一把哨兵替换成 ', '，一次成型，不需要猜哪里该断
   *
   * 用 \u0002 而不是空格，是因为空格在标签内部合法（`black hair`），
   * 无法区分「标签内部的空格」和「标签之间的空格」。哨兵没有这个歧义。
   */
  var SENTINEL = '\u0002';

  function applyRules(text, rules) {
    var out = text;
    for (var i = 0; i < rules.length; i++) {
      var re = rules[i][0];
      var to = rules[i][1];
      re.lastIndex = 0;
      /*
       * 替换值为空串 = 删除语义，直接删掉不留标记。
       * 非空 = 标签语义，用哨兵包住，标出完整边界。
       */
      var replacement = to ? SENTINEL + to + SENTINEL : '';
      out = out.replace(re, replacement);
      re.lastIndex = 0;
    }
    return out;
  }

  /*
   * 把孤立的中文单字连同它周围的粘连带一起清掉。
   *
   * 场景：词表命中「樱花」后，串里剩「站cherry blossoms」——
   * 「站」和英文之间**没有空格**（原文是「站在樱花树下」，
   * 「在」被换成空格后成了「站 cherry」是理想情况，
   * 但如果是「站樱花树下」这种，「站」会直接粘上英文）。
   *
   * 两步处理：
   *   1. 先在所有「中文↔非中文」交界处补空格，把粘连拆开
   *   2. 再删掉长度 ≤2 的纯中文残片
   *
   * 只删长度 ≤2 的残片，是为了保住那些**词表没覆盖但含义完整**
   * 的中文描述（如「水墨画风格」），那是有效信息，不能丢。
   */
  function splitCjkBoundary(s) {
    return String(s || '')
      // 中文后紧跟字母数字 → 中间补空格
      .replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2')
      // 字母数字后紧跟中文 → 中间补空格
      .replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2')
      // 中文后紧跟逗号或空格已经天然分隔，不用管
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function dropShortCjkFragments(s) {
    return String(s || '')
      .split(',')
      .map(function (seg) {
        var t = seg.trim();
        if (!t) return '';
        /*
         * 纯中文且长度 ≤2 → 判定为词表未覆盖的残留单字/碎词，丢弃。
         * 含英文的片段一律保留（那是有价值的标签）。
         */
        if (/^[\u4e00-\u9fff\u3000-\u303f]+$/.test(t) && t.length <= 2) return '';
        // 片段里若只剩孤立的 1-2 字中文 + 空格，也清掉
        t = t.replace(/(^|\s)[\u4e00-\u9fff]{1,2}(?=\s|$)/g, ' ');
        return t.replace(/\s{2,}/g, ' ').trim();
      })
      .filter(Boolean)
      .join(', ');
  }

  /*
   * ── 合并「颜色 + 服饰/物件」为单一标签 ────────────────────────
   *
   * Danbooru 的标准写法里，颜色是**修饰语**，要和名词连成一个标签：
   *   ✅ white dress   ❌ white, dress
   *   ✅ black suit    ❌ black, suit
   *   ✅ red scarf     ❌ red, scarf
   *
   * 拆开虽然模型也能理解，但 `dress` 单独出现会引入「任何颜色的裙子」
   * 的统计噪声，颜色约束被削弱。合并后约束更紧。
   *
   * 只对**明确的服饰与物件**做合并，不做泛化 —— 像 `white, background`
   * 这种就不能合（`white background` 有独立语义），而它本来也在
   * SCENE 组里作为整词收录了，不会走到这条路径。
   */
  var COLOR_WORDS = [
    'white', 'black', 'red', 'blue', 'green', 'yellow',
    'purple', 'pink', 'orange', 'brown', 'grey', 'silver',
    'golden', 'cyan', 'beige'
  ];

  var COMBINABLE_NOUNS = [
    'dress', 'suit', 'scarf', 'coat', 'jacket', 'shirt', 'skirt',
    'pants', 'shoes', 'boots', 'hat', 'cap', 'gloves', 'socks',
    'stockings', 'ribbon', 'bow', 'necklace', 'earrings', 'bracelet',
    'ring', 'glasses', 'sunglasses', 'mask', 'umbrella', 'bag',
    'backpack', 'book', 'flower', 'rose', 'cup', 'teacup', 'hair',
    'eyes', 'skin', 'tail', 'wings', 'horns', 'cape', 'cloak',
    'uniform', 'kimono', 'yukata', 'swimsuit', 'apron', 'sweater',
    'hoodie', 'vest', 'tie', 'apron'
  ];

  function mergeColorNouns(s) {
    var out = String(s || '');
    for (var i = 0; i < COLOR_WORDS.length; i++) {
      for (var j = 0; j < COMBINABLE_NOUNS.length; j++) {
        var color = COLOR_WORDS[i];
        var noun = COMBINABLE_NOUNS[j];
        /*
         * 只匹配「颜色, 名词」这种**被逗号分隔的相邻标签**。
         * 用 \b 保证是完整词 —— 否则 `pink hair` 里的 pink 后面
         * 跟着 hair 也会被误合（虽然结果一样，但要避免
         * `grey hair, eyes` 被合错成 `grey hair eyes`）。
         */
        var re = new RegExp('(^|,\\s*)' + color + ',\\s+' + noun + '\\b', 'g');
        out = out.replace(re, '$1' + color + ' ' + noun);
      }
    }
    return out;
  }

  /*
   * ── 收尾：把哨兵标记还原成逗号分隔 ────────────────────────────
   *
   * 走到这一步，串里是「标签（哨兵包裹）+ 未命中中文 + 标点」的混合体，
   * 例如：
   *   \u0002black hair\u0002\u0002red eyes\u0002 \u0002black\u0002 西装
   *
   * 处理顺序：
   *   1. 连续哨兵之间若**只有空白**，说明是两个相邻标签 → 合并成一个分隔
   *   2. 未命中中文两侧的哨兵 → 说明中文夹在两个标签中间，先按空格断开
   *   3. 所有剩余哨兵 → 逗号
   *   4. 逗号规范化
   */
  function finalize(text) {
    var out = String(text || '');

    // 1) 把「哨兵 + 空白 + 哨兵」压成单个哨兵（相邻标签）
    out = out.replace(new RegExp(SENTINEL + '\\s*' + SENTINEL, 'g'), SENTINEL);

    /*
     * 2) 处理「标签 + 中文 + 标签」的情况。
     *
     * 此时中文两侧各有一个哨兵，形如 `\u0002black\u0002西装\u0002suit\u0002`。
     * 把中间那段中文连同它前面的哨兵一起处理掉 —— 前哨兵换逗号，
     * 中文留给后面的短残片清理决定去留。
     */
    out = out.replace(
      new RegExp(SENTINEL + '([\\u4e00-\\u9fff\\u3000-\\u303f]+)' + SENTINEL, 'g'),
      ', $1'
    );

    /*
     * 3) 剩余哨兵统一变逗号。
     *
     * `\u0002black hair\u0002` → `, black hair,`
     * 首尾多出来的逗号由 cleanupCommas 收掉。
     */
    out = out.split(SENTINEL).join(', ');

    /*
     * 4) 清理未命中中文的粘连。
     *
     * 到这一步，未命中的中文会以 `, 西装, ` 或 `white 羽绒服, ` 的形式存在。
     * 先拆中英粘连，再由 dropShortCjkFragments 决定哪段该丢。
     */
    out = splitCjkBoundary(out);

    return out;
  }

  function cleanupCommas(s) {
    return String(s || '')
      .replace(/\s*,\s*/g, ', ')   // 逗号前后留单空格
      .replace(/(?:,\s*){2,}/g, ', ') // 连续逗号压成一个
      .replace(/^\s*,\s*/g, '')    // 去掉行首逗号
      .replace(/\s*,\s*$/g, '')    // 去掉行尾逗号
      .replace(/\s{2,}/g, ' ')     // 多空格合一
      .trim();
  }

  /**
   * 把中文描述翻译成 Danbooru 标签串。
   *
   * 全流程分五步，顺序不可换：
   *
   *   1. splitCjkBoundary —— 先把中英粘连拆开，为后续替换建立干净边界
   *   2. applyRules(DICTIONARY) —— 特征词 → 英文标签
   *   3. applyRules(PUNCT) —— 中文标点 → 逗号
   *   4. applyRules(FILLER) —— 虚词与残留单字清理
   *   5. dropShortCjkFragments + cleanupCommas —— 收尾
   *
   * @param {string} input 原始描述（可以中英混排）
   * @returns {string} 翻译后的标签串；输入无中文时原样返回
   */
  function translate(input) {
    var src = String(input == null ? '' : input).trim();

    /*
     * 中文少于 2 个汉字 → 认定它已经是标签串（或纯英文/纯符号），
     * 一个字都不动。这条规则防止把作者精心写好的英文标签搅坏。
     */
    if (countChinese(src) < 2) return src;

    /*
     * 第 1 步必须最先做。
     *
     * 「黑发红瞳」这类连续中文，词表命中后会变成 `black hair` + `red eyes`，
     * 两个英文串直接贴上，得到 `black hairred eyes` —— 这就是之前
     * 反复出现的粘连 bug 的根因。事后补救很难做干净，
     * 因为 `hairred` 已经看不出原本是两个词了。
     *
     * 保证边界清晰的办法是**在替换之前**就把可能出现粘连的位置拆开。
     * 但「黑发红瞳」本身是连续中文，拆不动 —— 所以真正的解法是
     * 让每条替换规则**自带前后分隔符**：见 applyRules。
     */
    var out = src;
    out = applyRules(out, DICTIONARY);   // 特征词 → 标签（哨兵包裹）
    out = applyRules(out, PUNCT_SORTED); // 中文标点 → 逗号/删除
    out = applyRules(out, FILLER_SORTED);// 虚词与残留单字清理
    out = finalize(out);                 // 哨兵 → 逗号分隔
    out = mergeColorNouns(out);          // 「白色, 连衣裙」→「white dress」
    out = dropShortCjkFragments(out);    // 丢弃短中文残片
    out = cleanupCommas(out);            // 逗号与空白规范化

    if (DEBUG) {
      console.log('[MiyaImageGenDict] Prompt translated: "' + src + '" → "' + out + '"');
    }
    return out;
  }

  /**
   * 翻译并返回详细信息，便于调试与设置面板预览。
   *
   * @param {string} input
   * @returns {{original:string, translated:string, changed:boolean, chineseCount:number}}
   */
  function translateDetailed(input) {
    var src = String(input == null ? '' : input).trim();
    var out = translate(src);
    return {
      original: src,
      translated: out,
      changed: out !== src,
      chineseCount: countChinese(src)
    };
  }

  /**
   * 统计词表规模，设置面板用来显示「已内置 N 条替换规则」。
   */
  function stats() {
    return {
      total: DICTIONARY.length,
      hair: HAIR.length,
      eyes: EYES.length,
      expression: EXPRESSION.length,
      subject: SUBJECT.length,
      framing: FRAMING.length,
      pose: POSE.length,
      scene: SCENE.length,
      quality: QUALITY.length
    };
  }

  var api = {
    translate: translate,
    translateDetailed: translateDetailed,
    hasChinese: hasChinese,
    countChinese: countChinese,
    setDebug: setDebug,
    stats: stats
  };

  global.MiyaImageGenDict = api;

  /*
   * 兼容：如果 miya-image-gen.js 先加载完成，把翻译器挂到它上面，
   * 方便其它模块从 MiyaImageGen 一个入口就能拿到翻译能力。
   */
  if (global.MiyaImageGen && typeof global.MiyaImageGen === 'object') {
    global.MiyaImageGen.translatePrompt = translate;
    global.MiyaImageGen.dictStats = stats;
  }
})(window);
