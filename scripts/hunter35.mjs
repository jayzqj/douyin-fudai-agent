// hunter35: 常驻高人气直播间，实时监测福袋，发现即处理
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// 📅 本地时区日期（YYYY-MM-DD）。
//    ⚠ 不能用 new Date().toISOString().slice(0,10)——那是 UTC 日期，
//    北京 00:00-08:00 期间 UTC 还停在前一天，会让「今日战果」全部算错。
const localDay = (d = new Date()) => {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
};

// ── 账号支持 ───────────────────────────────────────────────
// 不带 --account 时沿用原路径（向后兼容，现有任务行为完全不变）；
// 带 --account <名字> 时使用 accounts/<名字>/ 下独立的 profile 与工作目录，
// 端口优先取 meta.json 里登记的，多个账号因此不会互相抢端口与 profile 锁。
// 🌍 跨平台适配：所有路径与 Chrome 探测统一走 paths.mjs，
//    这样打包成 Windows exe 后不会因为写死 macOS 路径而全盘失效。
import { APP_ROOT, PATH, findChrome, chromeHint, isPortOpen } from './paths.mjs';
import { withSharedJson, readSharedJson } from './shared-json.mjs';
const ROOT=APP_ROOT;
const _argv=process.argv.slice(2);
const _ai=_argv.indexOf('--account');
const ACCOUNT=(_ai>=0&&_argv[_ai+1])?_argv[_ai+1]:null;
let PORT, W, PROFILE;
if(ACCOUNT){
  const accDir=ROOT+'/accounts/'+ACCOUNT;
  let meta={};
  try{ meta=JSON.parse(fs.readFileSync(accDir+'/meta.json','utf8')); }catch(e){}
  W=accDir+'/work';
  try{ fs.mkdirSync(W,{recursive:true}); }catch(e){}
  PROFILE=accDir+'/profile';
  PORT=Number(process.env.DY_PORT||meta.port||9750);
}else{
  W=ROOT+'/douyin-auto';
  PROFILE=W+'/chrome-profile';
  PORT=Number(process.env.DY_PORT||9750);
}
const CHROME=(()=>{
  const found=findChrome();
  if(!found){ console.error('[FATAL] '+chromeHint()); process.exit(1); }
  return found;
})();
const LOG=W+'/h35.log';
const RES=W+'/h35-results.jsonl';
// ⚠ DATA_DIR 必须在下面两个配置读取之前声明。
//    2026-11-04 实测：之前它写在第 119 行，而 threshold.json / wait-config.json
//    在 54 / 67 行就引用它，触发 TDZ ReferenceError，被 catch 静默吞掉后
//    配置全部回退默认值 —— 门槛因为默认值恰好等于用户要的值而一直没暴露，
//    等待倍率则表现为「改了配置却完全不生效」。
const DATA_DIR=ROOT+'/data';
const RECENT_FILE=W+'/recent-rooms.json';   // 最近常驻过的普通房，用于轮换去重
const FANS_FILE=W+'/fans-only-rooms.json';  // 粉丝团型福袋房间计数，用于降权
const DRY_FILE=W+'/dry-rooms.json';        // 常驻了却没发现福袋的次数，用于降权
// 📌 门槛单一数据源：data/threshold.json（与看板共用）。
//    环境变量仍可覆盖（run-h35.sh 里已不再传，留作应急手段）。
//    2026-11-03 教训：门槛先后在 run-h35.sh / hunter35.mjs / web/server.mjs 三处硬编码，
//    改配置时漏了看板那处，用户看到「门槛没改成功」——实际抓取侧早已生效。
let _THR={day:8000,night:50000,nightStart:19,nightEnd:24,vipExempt:false};
try{ _THR=Object.assign(_THR, JSON.parse(fs.readFileSync(DATA_DIR+'/threshold.json','utf8'))||{}); }catch(e){}
const MIN_ONLINE_DAY=Number(process.env.DY_MIN_ONLINE_DAY||_THR.day);
const MIN_ONLINE_NIGHT=Number(process.env.DY_MIN_ONLINE_NIGHT||_THR.night);
// 📌 2026-11-05 用户要求「按门槛硬卡」：VIP 默认不再豁免 day/night 门槛。
//    true 才恢复旧的「VIP 只卡 500 人底线」策略；配置在 data/threshold.json 的 vipExempt。
const VIP_EXEMPT=!!_THR.vipExempt;
const NIGHT_START=Number(process.env.DY_NIGHT_START||_THR.nightStart);
const NIGHT_END=Number(process.env.DY_NIGHT_END||_THR.nightEnd);
// 🧒 婴童用品过滤（2026-11-11 新增）：只盯指定类型直播间。
//    单一数据源 data/category-filter.json，与看板共用，网页可改。
//    mode='only' 时，只保留标题或主播名含关键词的房间；mode='off' 时不过滤。
//    注意：抖音网页分类页没有可靠的「母婴」分类 ID，所以用标题/主播名关键词过滤，
//    比分类 ID 更可靠。婴童房多为带货，见 roomScore：命中关键词时不扣带货分、反而加分。
const _CATF_DEFAULT={enabled:true,mode:'only',keywords:['母婴','婴童','宝宝','婴儿','奶粉','纸尿裤','尿不湿','童装','童鞋','辅食','婴儿车','儿童','妈妈','宝妈','孕妇','育儿','亲子'],bonus:20,noThreshold:true,preferSmallRooms:true,skipFansGroup:true};
let _CATF={..._CATF_DEFAULT};
let _CATF_MTIME=0;
function loadCategoryFilter(){
  try{
    const st=fs.statSync(DATA_DIR+'/category-filter.json');
    if(st.mtimeMs===_CATF_MTIME) return _CATF;
    _CATF_MTIME=st.mtimeMs;
    const j=JSON.parse(fs.readFileSync(DATA_DIR+'/category-filter.json','utf8'))||{};
    const kws=Array.isArray(j.keywords)?j.keywords.map(x=>String(x||'').trim()).filter(Boolean):[];
    _CATF={enabled:j.enabled!==false, mode:(j.mode==='off'?'off':'only'), keywords:kws.length?kws:_CATF_DEFAULT.keywords, bonus:Math.max(0,Math.min(50,Number(j.bonus)||20)), noThreshold:j.noThreshold!==false, preferSmallRooms:j.preferSmallRooms!==false, skipFansGroup:j.skipFansGroup!==false};
  }catch(e){}
  return _CATF;
}
function matchesCategory(host,title){
  const f=loadCategoryFilter();
  if(!f.enabled || f.mode!=='only') return false;
  // 🧒 排除误伤：主播名含「宝宝」但标题是游戏的（例如「旭旭宝宝」播王者荣耀），
  //    不能算婴童房。标题明确是强游戏类时直接判非婴童。
  if(/金铲铲|王者荣耀|和平精英|三角洲行动|英雄联盟|无畏契约|永劫无间|蛋仔派对|第五人格|原神|崩坏|绝区零/i.test(title||'')) return false;
  const t=((host||'')+' '+(title||'')).toLowerCase();
  return f.keywords.some(k=>k && t.includes(String(k).toLowerCase()));
}
function isCategoryFilterOn(){ const f=loadCategoryFilter(); return !!(f.enabled && f.mode==='only'); }

// ⏱ 等待时间单一数据源：data/wait-config.json（2026-11-04 用户要求「等待发福袋时间砍半」）。
//    scale 统一作用于「常驻时长 / 无福袋提前换房 / 空轮退避」三类等待。
//    ⚠ 抢到福袋后的「守候开奖 waitSec」不受 scale 影响：砍半会提前离开、丢开奖结果。
//      2026-11-05 起它同样由本 json 配置（drawBufferSec / drawMaxSec / drawFallbackSec），
//      按福袋剩余倒计时动态计算，不再写死 +180。
//      实测 117 次守候：64 次检出弹窗全部比倒计时归零提前 11~44s，零延迟；
//      固定 180s 冗余只在 53 次漏检时白等，平均 181s，故收紧到 60s。
let _WAIT={scale:1,drawBufferSec:60,drawMaxSec:1200,drawFallbackSec:900,
           postDrawWaitSec:120,
           perRoomMinMs:120000,perRoomMaxMs:480000,vipMinMs:480000,
           highYieldMs:900000,noFudaiNormalMs:360000,noFudaiVipMinMs:600000,
           emptyRoundStepMs:120000,emptyRoundMaxMs:600000};
try{ _WAIT=Object.assign(_WAIT, JSON.parse(fs.readFileSync(DATA_DIR+'/wait-config.json','utf8'))||{}); }catch(e){}
const WS=Math.max(0.1,Math.min(2,Number(_WAIT.scale)||1));   // 限制在 0.1~2，防误配
const DRAW_BUF=Math.max(0,Math.min(600,Number(_WAIT.drawBufferSec)||0));
const DRAW_MAX=Math.max(60,Math.min(3600,Number(_WAIT.drawMaxSec)||1200));
const DRAW_FALLBACK=Math.max(60,Math.min(3600,Number(_WAIT.drawFallbackSec)||900));
// 🔁 抢完福袋守完开奖后，再留 postDrawWaitSec 秒看有没有新福袋；有就继续抢，如此循环。
//    用户 2026-11-05 定稿「不设轮数上限」：只要每次等待窗口内还有新福袋就一直留在该房间。
//    0 表示关闭该行为（回到「守完开奖立即换房」）。不受 scale 影响。
const POST_DRAW_MS=Math.max(0,Math.min(1800,Number(_WAIT.postDrawWaitSec)||0))*1000;
// 📌 关注策略单一数据源：data/follow-config.json（2026-11-05 用户定稿「抢福袋前都需要先关注主播」）。
//    关注必须在 tryJoin 打开福袋面板「之前」做：面板是全屏遮罩，会挡住左上角关注按钮的
//    elementFromPoint 命中。实测历史 73 次关注 71 次失败（45 no-btn / 26 clicked-unverified），
//    而干净页面实测 3/4 点击成功且刷新后持久，根因就是调用时机被遮罩挡住。
let _FOLLOW={enabled:true,requireFollowBeforeJoin:true,allowInconclusive:true};
try{ _FOLLOW=Object.assign(_FOLLOW, JSON.parse(fs.readFileSync(DATA_DIR+'/follow-config.json','utf8'))||{}); }catch(e){}
const FOLLOW_ENABLED=!!_FOLLOW.enabled;
const FOLLOW_GATE=!!_FOLLOW.requireFollowBeforeJoin;
const FOLLOW_ALLOW_INCONCLUSIVE=!!_FOLLOW.allowInconclusive;
// 🩺 2026-11-05 18:42 事故增补（单一数据源 follow-config.json）：
//    点击关注后的二次验证间隔、参与失败后的短冷却。二者都带上下限钳制，配置异常不会卡死主循环。
const VERIFY_RETRY_MS=Math.max(0,Math.min(20000,Number(_FOLLOW.verifyRetryMs)||0));
const RETRY_COOLDOWN_MS=Math.max(0,Math.min(600000,Number(_FOLLOW.retryCooldownMs)||0));
// 🚫 2026-11-10 09:31 用户定稿「加同房间关注拦截3次则本轮跳过」：
//    背景：main3 的网页会话关注写操作被服务端限制（同房间双账号对照已证实：
//    主号 163→164 落库、main3 2→2 不落库），遇关注型房间必然 fans-panel 拦截，
//    45s 短冷却后在同一房间反复撞墙。实测房间 76892461348 历史发袋 18 次但
//    joinable 仅 1 次，却在 12 次拦截上白耗巡房时间。
//    语义：同一房间累计 need-follow 达 N 次，就把该房间写入 12 分钟长窗跳过，
//    让巡房时间流向真正能抢的房间。N=0 表示完全关闭此跳过行为（回退到旧逻辑）。
//    注意：只影响「关注拦截」这一种结果；joined / packet-skipped 等其它结果不受影响。
// 🎯 2026-11-11 09:31 用户选「维持现状」后的效率优化：
//    main3 的关注写操作被服务端限制（实测关注数长期停在 14），
//    遇到任何未关注主播必然失败。它的「同房间重试 3 次」纯属浪费：
//    实测本次进程 24 次重试 × 45 秒 = 18 分钟白耗，同期抢到 0 个福袋。
//    主号能正常关注（195 个关注、写操作有效），重试有价值，保持 3 不变。
//    故支持按账号覆盖，配置见 follow-config.json 的 maxFailsPerRoomByAccount。
const _failsByAcc = (_FOLLOW.maxFailsPerRoomByAccount && typeof _FOLLOW.maxFailsPerRoomByAccount==='object') ? _FOLLOW.maxFailsPerRoomByAccount : {};
// ⚠ 用 ACCOUNT 而不是 ACCOUNT_TAG：后者在 282 行才定义，此处直接引用会触发 TDZ
const _failsOverride = Number(_failsByAcc[ACCOUNT || 'main']);
const FOLLOW_MAX_FAILS = (_failsOverride > 0)
  ? Math.max(1, Math.min(20, _failsOverride))
  : Math.max(0, Math.min(20, Number(_FOLLOW.maxFailsPerRoom) || 3));
// 🎯 2026-11-10 11:22 用户定稿「main3 只做探测，也可以抢福袋，不用关注，但不抢粉丝团福袋」：
//    背景：main3 的网页端关注写操作被服务端临时限制（昨天 03:51~06:51 曾 9 次成功，
//    今天 0 次），所有关注型福袋必然 fans-panel 拦截白耗巡房时间（实测 11/12 次）。
//    用户决策：该账号不做关注动作，也不抢粉丝团型福袋，只抢「纯评论型」福袋。
//    实现：按账号白名单下发策略，不影响主号（主号仍全抢、仍自动关注）。
//    数据源：data/follow-config.json 的 skipFollowAccounts / skipFansGroupAccounts（数组）。
//    ⚠ 空数组或未配置 = 所有账号保持原行为，零回归风险。
const _skipFollowAcc = Array.isArray(_FOLLOW.skipFollowAccounts) ? _FOLLOW.skipFollowAccounts : [];
const _skipFansAcc   = Array.isArray(_FOLLOW.skipFansGroupAccounts) ? _FOLLOW.skipFansGroupAccounts : [];
// 🕐 2026-11-10 11:41 用户定稿「白天不抢粉丝团福袋，只抢关注型和发弹幕型；晚间规则不变」：
//    与账号白名单 skipFansGroupAccounts 是「或」关系：
//      账号在白名单  → 任何时候都不抢粉丝团
//      daySkipFansGroup=true → 白天时段（非晚间）任何账号都不抢粉丝团
//    晚间时段（nightStart~nightEnd）恢复原行为，主号仍可加团后参与。
//    判定用与门槛同一套 NIGHT_START/NIGHT_END，避免两处时段口径不一致。
const DAY_SKIP_FANS = _FOLLOW.daySkipFansGroup === true;
// 🔗 2026-11-10 11:24 用户定稿「每个号的探测资源都是共享的，main3 就可以主要做探测，主号就可以抢」：
//    现状：vip-cooldown.json / probe-today.json 都在各实例自己的 W 目录下，两号各探各的，
//    同一房间会被两个号重复探测（浪费各自的探测名额，且更容易触发限流）。
//    改为：探测冷却与当日探测计数统一落到 data/ 下的共享文件，
//    任一账号探过的房间，另一个账号直接继承冷却，避免重复；
//    同时 F 值检测用实时在线数，不依赖探测缓存，因此共享不会造成「看不到」。
//    房间档案 anchors.json / room-names.json 本来就是共享的（shared-json 加锁）。
const SHARED_PROBE = _FOLLOW.sharedProbePool !== false;   // 默认开启，可显式设 false 回退
const SHARED_VIP_COOLDOWN = DATA_DIR + '/vip-cooldown-shared.json';
const SHARED_PROBE_TODAY = DATA_DIR + '/probe-today-shared.json';
// 🧧 人气红包策略单一数据源：data/packet-config.json（2026-11-05 20:03 用户定稿「不抢人气红包」）。
//    默认 detectEnabled=true / grabEnabled=false：识别并记真实结果，但不点「抢」、不消耗抖币。
let _PACKET={detectEnabled:true,grabEnabled:false};
try{ _PACKET=Object.assign(_PACKET, JSON.parse(fs.readFileSync(DATA_DIR+'/packet-config.json','utf8'))||{}); }catch(e){}
const PACKET_DETECT=!!_PACKET.detectEnabled;
const PACKET_GRAB=!!_PACKET.grabEnabled;
// 💬 守候期间发弹幕活跃账号（2026-11-09 用户定稿「在等待福袋开奖期间可以在直播间随便发送弹幕，活跃账号」）。
//    单一数据源 data/danmu-config.json，代码只读。这是系统首次「主动公开发送内容」，
//    因此默认只对主实例开放、带开关、带频率上限、带文案白名单，且全部发送都留痕。
//    受控单条实测（2026-11-09 10:05）：contenteditable 输入框 + Input.insertText + Enter
//    可真实发出，编辑器清空、无禁言、开奖检测 found:false 不误判。
let _DANMU={enabled:false,accounts:['main'],minIntervalSec:60,maxIntervalSec:90,maxPerWait:8,texts:[]};
try{ _DANMU=Object.assign(_DANMU, JSON.parse(fs.readFileSync(DATA_DIR+'/danmu-config.json','utf8'))||{}); }catch(e){}
const DANMU_ENABLED=!!_DANMU.enabled;
// 主实例（不带 --account）在配置里登记为 'main'；账号实例用真实账号名。
const DANMU_ACCOUNT=ACCOUNT||'main';
const DANMU_FOR_THIS=Array.isArray(_DANMU.accounts) && _DANMU.accounts.includes(DANMU_ACCOUNT);
const DANMU_MIN=Math.max(30,Math.min(600,Number(_DANMU.minIntervalSec)||60));
const DANMU_MAX=Math.max(DANMU_MIN,Math.min(900,Number(_DANMU.maxIntervalSec)||90));
const DANMU_MAX_PER_WAIT=Math.max(1,Math.min(20,Number(_DANMU.maxPerWait)||8));
// 文案白名单：过滤空串、过长内容，以及任何可能被开奖检测正则误判的词。
//    开奖检测判据见守候循环：/恭喜|中奖|获奖|获得.*奖|奖品|未中奖|很遗憾|没抽中|送你一个好运/
const DANMU_BAD=/恭喜|中奖|获奖|获得.{0,8}(奖|福袋|红包|礼)|奖品|已发放|已放入|背包|未中奖|没有中奖|很遗憾|没抽中|送你一个好运|下次再来|再接再厉/;
  const _cleanTexts=(arr)=>(Array.isArray(arr)?arr:[])
    .map(s=>String(s||'').trim()).filter(s=>s.length>0&&s.length<=20&&!DANMU_BAD.test(s));
  const DANMU_TEXTS=_cleanTexts(_DANMU.texts);
  // 💬 2026-11-11 11:37 用户「弹幕太像人机」→ 全面拟人化，全部参数单一数据源。
  //    按直播间标题/主播名/页面文本推断类型，从对应文案池挑没发过的句子；
  //    分类与关键词都在 data/danmu-config.json，代码只读、不内置任何文案。
  //    ⚠ pickDanmuCategory 是函数声明，虽在 const ev(437行) 之前，但只在守候循环
  //      运行时才被调用，不会触发 TDZ。
  const DANMU_CATS=(Array.isArray(_DANMU.categories)?_DANMU.categories:[])
    .map(c=>({name:String(c.name||''),kw:(Array.isArray(c.kw)?c.kw:[]).map(String),texts:_cleanTexts(c.texts)}))
    .filter(c=>c.kw.length&&c.texts.length);
  const DANMU_SKIP=Math.max(0,Math.min(0.9,Number(_DANMU.skipChance)||0));
  const DANMU_TYPING=!!_DANMU.typingEnabled;
  const _typ=Array.isArray(_DANMU.typingMsPerChar)?_DANMU.typingMsPerChar:[70,190];
  const DANMU_TYPE_MIN=Math.max(20,Math.min(400,Number(_typ[0])||70));
  const DANMU_TYPE_MAX=Math.max(DANMU_TYPE_MIN,Math.min(600,Number(_typ[1])||190));
  // 同房间已发过的句子（进程内即可，跨重启不必持久化——守候本身也是新的一轮）
  const _danmuSentByRoom=new Map();

  /** 从页面推断直播类型，命中关键词最多的分类胜出；全不中返回 null 走通用兜底。 */
  async function pickDanmuCategory(tab){
    try{
      const raw=await ev(tab,`(()=>{
        var t=(document.title||'').replace(/的抖音直播间.*$/,'');
        var m=(document.querySelector('meta[name="description"]')||{}).content||'';
        var b=(document.body&&document.body.innerText||'').slice(0,260);
        return JSON.stringify({s:(t+' '+m+' '+b).slice(0,600)});
      })()`,10000);
      let s=''; try{ s=JSON.parse(raw||'{}').s||''; }catch(e){}
      if(!s) return null;
      let best=null,bestN=0;
      for(const c of DANMU_CATS){
        let n=0; for(const k of c.kw){ if(k && s.includes(k)) n++; }
        if(n>bestN){ bestN=n; best=c; }
      }
      return bestN>0?best:null;
    }catch(e){ return null; }
  }

  /** 挑一句本房间没发过的：优先分类池，用尽后退回通用池，全用尽返回 null（本轮不再发）。*/
  function pickDanmuText(room, cat){
    const used=_danmuSentByRoom.get(String(room))||new Set();
    const pick=(pool)=>{
      const avail=pool.filter(t=>!used.has(t));
      if(!avail.length) return null;
      return avail[Math.floor(Math.random()*avail.length)];
    };
    const t=(cat&&pick(cat.texts))||pick(DANMU_TEXTS);
    if(t){
      used.add(t);
      // 只留最近 40 条，避免长跑内存无限涨
      if(used.size>40) used.delete(used.values().next().value);
      _danmuSentByRoom.set(String(room),used);
    }
    return t;
  }
function getMinOnline(){
  // 🧒 2026-11-11 用户定稿：不分白天晚间、进房间不设门槛。
  //    noThreshold=true 时一律返回 0，入池、进房、福袋出现时的门槛硬卡全部失效。
  if(loadCategoryFilter().noThreshold) return 0;
  const h=new Date().getHours();
  const isNight = (h>=NIGHT_START && h<NIGHT_END);
  return isNight ? MIN_ONLINE_NIGHT : MIN_ONLINE_DAY;
}

// ── 🧠 策略可观测性底座（2026-11-05 21:17）────────────────────────
//    设计目标：让系统「看见自己」，回答三个以前答不了的问题：
//      1. 这次决策发生在哪套参数下？→ policyId / policy 快照
//      2. 这次决策花了多少时间、换来什么？→ decisionId 贯穿 + 耗时字段
//      3. 有没有更优选择被我放弃？→ gateSkipped 记录反事实线索
//    ⚠ 严格只读观测：本段不写任何配置文件、不改任何判定分支、不 return 值给决策逻辑。
//      所有写入用 append + try/catch，写失败绝不影响 7×24 主循环。
const POLICY_SNAPSHOT={
  threshold:{day:MIN_ONLINE_DAY,night:MIN_ONLINE_NIGHT,nightStart:NIGHT_START,nightEnd:NIGHT_END,vipExempt:VIP_EXEMPT},
  wait:{scale:WS,drawBufferSec:DRAW_BUF,drawMaxSec:DRAW_MAX,drawFallbackSec:DRAW_FALLBACK,postDrawWaitSec:POST_DRAW_MS/1000},
  follow:{enabled:FOLLOW_ENABLED,gate:FOLLOW_GATE,allowInconclusive:FOLLOW_ALLOW_INCONCLUSIVE,
          verifyRetryMs:VERIFY_RETRY_MS,retryCooldownMs:RETRY_COOLDOWN_MS},
  packet:{detect:PACKET_DETECT,grab:PACKET_GRAB},
  danmu:{enabled:DANMU_ENABLED,accounts:_DANMU.accounts,minIntervalSec:DANMU_MIN,
         maxIntervalSec:DANMU_MAX,maxPerWait:DANMU_MAX_PER_WAIT,textCount:DANMU_TEXTS.length}
};
// 参数指纹：配置一变 policyId 就变，报告可按它分组对比不同策略期的表现。
// 用 crypto 稳定哈希，不依赖对象键序。
const POLICY_ID=(()=>{
  try{
    const s=JSON.stringify(POLICY_SNAPSHOT);
    let h=2166136261;
    for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); }
    return (h>>>0).toString(16).padStart(8,'0');
  }catch(e){ return 'unknown'; }
})();
let _decisionSeq=0;
const newDecisionId=()=>`${Date.now().toString(36)}-${(++_decisionSeq).toString(36)}-${ACCOUNT_TAG}`;
// gate-skip 去重：roomStayId -> 本次常驻内上次记录的 secLeft。
// ⚠ 2026-11-06 09:28 修复：旧版用「房间+倒计时 cd」做 key，而 cd 每 2 秒变一次，
//    同一个福袋被连续记 56 次（647 条里绝大多数是重复），把报告 C 段撑到失真。
//    改为「secLeft 单调递减 = 同一福袋不重记；回升 = 新福袋才记」，与项目既有
//    「倒计时回升判据」同源。room-exit 时清理该 stayId，避免 7×24 内存泄漏。
const _gateLogged=new Map();
// 唯一写入口。ev 为事件类型，p 为业务字段；公共字段自动补齐。
const recStrategy=(ev,p)=>{
  try{
    fs.appendFileSync(STRATEGY_LOG, JSON.stringify({
      at:new Date().toISOString(), account:ACCOUNT_TAG, ev,
      policyId:POLICY_ID,
      hour:new Date().getHours(),
      ...p
    })+'\n');
  }catch(e){}
};
// 🎯 房间优先级打分：游戏/娱乐类更爱发福袋，带货类几乎不发
const GAME_PAT = /游戏|电竞|金铲铲|王者|和平精英|三角洲|PUBG|LOL|英雄联盟|教学|对局|排位|上分|吃鸡|蛋仔|原神|第五人格|炉石|CSGO|CF|云顶|阵容|主播|李白|韩信|貂蝉|鲁班|妲己|孙悟空|亚索|德玛|无畏契约|瓦罗兰特|APEX|守望|DOTA|星际|魔兽|梦幻西游|西游|三国|传奇|跑跑|飙车|赛车|拳皇|街霸|铁拳|真人快打|任天堂|马里奥|塞尔达|宝可梦|怪物猎人|艾尔登|黑神话|只狼|鬼泣|生化危机|使命召唤|战地|彩虹六号|塔科夫|暗区突围|永劫无间|幻兽帕鲁|米哈游|崩坏|绝区零|鸣潮|明日方舟|碧蓝|fgo|阴阳师|部落冲突|皇室战争|万国觉醒|率土之滨|三国志|少年三国|剑与远征|闪烁之光|石器时代|大话西游|问道|天龙八部|剑网|天涯明月刀|逆水寒|古剑|仙剑|倩女幽魂|完美世界|诛仙|斗罗|斗破|吞噬星空|遮天|完美世界|雪鹰领主|武动乾坤|大主宰|元尊/i;
const GAME_STRONG_PAT = /金铲铲|云顶|王者荣耀|和平精英|三角洲行动|英雄联盟|无畏契约|永劫无间|CSGO|DOTA|APEX|PUBG|蛋仔派对|第五人格|原神|崩坏|绝区零|鸣潮/i;
const SALES_PAT = /专场|破价|品牌|秒杀|福利|优惠|券|双11|双十一|双12|双十二|年货|大促|好物|带货|推荐|折|价|购|商城|旗舰|官方旗舰|直播间专属/i;

function roomScore(host, title, online, isVip){
  let sc = 0;
  const t = (host||'') + ' ' + (title||'');
  const _infant=matchesCategory(host, title);
  if(_infant) sc += loadCategoryFilter().bonus; // 婴童房加分
  // 🧒 2026-11-11 用户定稿：不要游戏和 VIP，分数打低。
  //    游戏类原来 +15/+8，现在反过来扣分；VIP 原来 +12，现在不加分。
  //    婴童/母婴/小孩相关房靠 +20 婴童分 + 小房分排前面，游戏 VIP 房排后面。
  //    注意：采集口已按关键词过滤，游戏房本来就进不了池，这里是给
  //    「名字未知、靠探测进来的历史 VIP 房」兜底用的。
  if(GAME_STRONG_PAT.test(t) && !_infant) sc -= 10;   // 明确游戏类，扣分
  else if(GAME_PAT.test(t) && !_infant) sc -= 5;      // 疑似游戏/娱乐类，扣分
  if(SALES_PAT.test(t) && !_infant) sc -= 10;     // 带货类靠后（婴童房不扣：婴童基本都是带货）
  // if(isVip) sc += 12;  // 已取消：VIP 不再加分

  // 🧒 人数越少越优先（2026-11-11 用户定稿）：同一个福袋中奖名额固定时，
  //    参与人数越少，单人中奖率越高。所以小房加分、大房不加分，取代原来的
  //    「分时段偏好大房」逻辑。注意代价：小房发福袋的频率和奖品通常也更低，
  //    只是单次中奖率更高，不是每小时总收益一定更高。
  if(loadCategoryFilter().preferSmallRooms){
    if(online>=0){
      if(online<100) sc+=15;
      else if(online<500) sc+=12;
      else if(online<1000) sc+=10;
      else if(online<5000) sc+=6;
      else if(online<20000) sc+=2;
    }
    return sc;
  }
  // 原版：分时段偏好大房（preferSmallRooms=false 时恢复）
  const hh = new Date().getHours();
  if(hh >= NIGHT_START && hh < NIGHT_END){
    if(online >= 50000) sc += 5;
    else if(online >= 10000) sc += 3;
  }else if(hh < 6){
    if(online >= 2000 && online < 8000) sc += 5;
    else if(online >= 1000) sc += 2;
  }else{
    if(online >= 50000) sc += 3;
    else if(online >= 10000) sc += 2;
  }
  return sc;
}

// 🚫 官方媒体/政务账号（福袋极小，用户明确不抢）
const OFFICIAL_PAT = /央视|CCTV|CGTN|小央|央广|新华|人民日报|人民网|人民视频|中国日报|光明日报|经济日报|中国新闻网|中新|共青团|政务|政府|宣传部|电视台|广播电台|中国之声|环球时报|中国网/i;
function isOfficial(host){
  if(!host) return false;
  return OFFICIAL_PAT.test(host);
}

function isNightNow(){ const h=new Date().getHours(); return (h>=NIGHT_START && h<NIGHT_END); }
const ROOMS_PER_BATCH=Number(process.env.DY_ROOMS||1);   // 每批常驻几个房间
const BATCH_MIN=Number(process.env.DY_BATCH_MIN||8);     // 每批盯多久（分钟）
const UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const log=(...a)=>{const s=`[${new Date().toTimeString().slice(0,8)}] `+a.join(' ');console.log(s);try{fs.appendFileSync(LOG,s+'\n');}catch{}};
// ── 数据层：所有账号的参与/中奖记录统一落到 data/，便于跨账号统计
//    DATA_DIR 已在文件上方声明（必须在配置读取之前），此处不再重复声明。
const PARTICIPATIONS=DATA_DIR+'/participations.jsonl';
const WINS=DATA_DIR+'/wins.jsonl';
// 未中奖记录（2026-11-04 新增）。原来只记 wins，导致 39 次守候 0 条记录，
// 无法回答「到底中没中」这个最基本的问题。现在中奖/未中奖都留痕。
const LOSSES=DATA_DIR+'/losses.jsonl';
// 🧠 策略可观测性底座（2026-11-05 21:17 用户定稿「学习自己的抢福袋策略」）。
//    纯观测：只追加写 strategy-log.jsonl，不改任何策略参数、不影响决策分支。
//    解决的核心缺口：participations/losses 没有「当时用哪套参数、这次花了多少时间」，
//    所以无法计算「单位时间中奖期望」，也无法归因某个时段/房间/参数是否值得。
//    本文件与 participations 一样属运行时数据，按既有约定不提交 GitHub。
const STRATEGY_LOG=DATA_DIR+'/strategy-log.jsonl';
try{ fs.mkdirSync(DATA_DIR,{recursive:true}); }catch{}
const ACCOUNT_TAG=ACCOUNT||'default';
const rec=(o)=>{
  const now=new Date().toISOString();
  try{ fs.appendFileSync(PARTICIPATIONS, JSON.stringify({...o,account:ACCOUNT_TAG,at:now})+'\n'); }catch{}
  // 每实例结果文件也必须带账号：2026-11-04 前漏写，导致看板实例卡片
  // 无法按账号过滤、只能整文件统计，和全局 participations 口径打架。
  try{ fs.appendFileSync(RES, JSON.stringify({...o,account:ACCOUNT_TAG,at:now})+'\n'); }catch{}
};
// ── 🧒 看板实时状态（2026-11-11 新增，v4 看板用）─────────────────────
//    旧看板只能从日志尾部反查「当前房间」，没有「所有监控过的房间」和
//    「正在发福袋的房间」这两张表。这里在内存里维护一张表，写到
//    data/live-rooms.json（原子写：先写 .tmp 再 rename），看板每 5 秒读一次。
//    福袋内容：SCAN 只能拿到倒计时（cd/sec），拿不到奖品文案；奖品/类型
//    要等 tryJoin 点开面板后才知道，见 tryJoin 里的 panelText 采集。
//    所以 active 表里 content 可能是空的，显示为「待打开面板确认」，
//    不是程序漏写。倒计时用 expiresAt（发现时 sec + 发现时间）算，
//    看板按本地时间每秒递减，即使抓取已换房，倒计时仍准（直到过期）。
const LIVE_FILE=DATA_DIR+'/live-rooms.json';
const _liveRooms=new Map();
let _liveLastWrite=0;
function fudaiTypeLabel(result){
  const m={'joined':'已参与','maybe-joined':'已参与（待确认）','need-follow':'关注型','fans-skip-always':'粉丝团（已跳过）','fans-skip-daytime':'粉丝团（白天跳过）','fans-skip-account':'粉丝团（账号跳过）','fans-no-coins':'粉丝团（抖币不足）','packet-skipped':'人气红包（不抢）','packet-only':'人气红包','no-panel':'未打开面板'};
  return m[result]||result||'待确认';
}
function upsertLiveRoom(room, patch){
  if(!room) return;
  const cur=_liveRooms.get(String(room))||{room:String(room),host:'',title:'',online:-1,score:0,isVip:false,visits:0,fudaiTotal:0,joinable:0,lastSeenAt:'',lastSeenTs:0,status:'monitoring',fudai:null};
  const now=Date.now();
  const next={...cur, ...patch, room:String(room), lastSeenTs: patch.lastSeenTs||now, lastSeenAt: patch.lastSeenAt||new Date().toISOString()};
  if(patch.fudai===null) next.fudai=null;
  if(patch.fudai && typeof patch.fudai==='object') next.fudai={...(cur.fudai||{}), ...patch.fudai};
  _liveRooms.set(String(room), next);
}
function writeLiveState(force){
  try{
    const now=Date.now();
    if(!force && now-_liveLastWrite<3000) return;
    _liveLastWrite=now;
    let anchors={};
    try{ anchors=JSON.parse(fs.readFileSync(DATA_DIR+'/anchors.json','utf8'))||{}; }catch(e){}
    const rooms=[..._liveRooms.values()].map(r=>{
      const a=anchors[r.room]||{};
      return {...r, visits:a.visits??r.visits, fudaiTotal:a.fudaiTotal??r.fudaiTotal, joinable:a.joinable??r.joinable, host:r.host||a.host||''};
    }).sort((a,b)=>(b.lastSeenTs||0)-(a.lastSeenTs||0)).slice(0,200);
    // 正在发福袋：fudai 在且未过期（expiresAt 未到），且 15 分钟内还见过
    const active=rooms.filter(r=>r.fudai && r.fudai.expiresAt && r.fudai.expiresAt>now && (now-(r.lastSeenTs||0))<15*60*1000);
    const out={updatedAt:new Date().toISOString(), updatedTs:now, rooms, active};
    fs.writeFileSync(LIVE_FILE+'.tmp', JSON.stringify(out));
    fs.renameSync(LIVE_FILE+'.tmp', LIVE_FILE);
  }catch(e){}
}

// ── 执行能力真实记账（2026-11-05 14:10）─────────────────────
// 看板原先用日志正则统计「粉丝团/关注成功率」，但日志跨天复用、无日期字段，
// 且 fans-join:joinBtn（参与按钮就位）被当成加入成功，导致 24/28 86% 却 0 钻。
// 改为 append 到 data/exec-actions.jsonl，每条带 at/account/room/action/ok，
// 看板按本地日过滤，只认「真实到位」的事件。文件不存在时视为 0，不补造历史。
const EXEC_ACTIONS=DATA_DIR+'/exec-actions.jsonl';
const recExec=(action, ok, extra={})=>{
  try{
    fs.appendFileSync(EXEC_ACTIONS, JSON.stringify({
      at:new Date().toISOString(), account:ACCOUNT_TAG, action, ok:!!ok, ...extra
    })+'\n');
  }catch{}
};
// ── 主播档案（自主进化的数据基础）──────────────────────────
// 记录每个房间的福袋规律：总次数、可抢/粉丝团比例、按小时的分布。
// 后续策略会据此判断「这个主播在这个时段是否常发福袋」，让选择越来越准。
const NAMES_FILE=DATA_DIR+'/room-names.json';   // 房间号 → 主播昵称
let NAMES={};
try{ NAMES=JSON.parse(fs.readFileSync(NAMES_FILE,'utf8'))||{}; }catch(e){ NAMES={}; }
let namesDirty=false;
function saveName(room,host){
  if(!host||NAMES[room]===host) return;
  NAMES[room]=host; namesDirty=true;
}
async function flushNames(){
  if(!namesDirty) return;
  // 🔒 共享昵称表，多实例并发写需合并而非覆盖：
  //    本进程只补自己新发现的，别人的新昵称要保留。
  try{
    await withSharedJson(NAMES_FILE, cur=>{
      for(const [r,n] of Object.entries(NAMES)) if(!cur[r]) cur[r]=n;
      return cur;
    });
    namesDirty=false;
  }catch(e){}
}
/** 显示用：有昵称则「昵称(房间号)」，否则只显示房间号 */
function disp(room){
  const n=NAMES[room];
  return n ? `${n}(${room})` : String(room);
}

const ANCHORS_FILE=DATA_DIR+'/anchors.json';

// 🚫 2026-11-11 09:42 用户定稿「不发福袋的直播间就加入黑名单，经常发的就要记住
//    且学习分析开播时间，未开播时就不去探测该直播间」。
//    两个数据文件都由 scripts/auto-blacklist.mjs 从 anchors.json 学习生成：
//      data/auto-blacklist.json  访问>=N 次却零福袋的房间（与手写 blacklist-rooms.txt 并行）
//      data/hour-windows.json    每个房间历史上发过福袋的小时（用于「未开播不探测」）
//    ⚠ 阈值只在生成脚本里，这里只读产物；重新学习跑那支脚本即可，不必改代码。
const AUTO_BLACK_FILE = DATA_DIR+'/auto-blacklist.json';
const HOUR_WINDOW_FILE = DATA_DIR+'/hour-windows.json';
let AUTO_BLACK = new Set();
let HOUR_WINDOWS = {};
let _autoMeta = { at:0 };
function loadLearnTables(force){
  // 热更新：文件变了就重读（与关注缓存同样的坑：进程长跑，文件更新了要能感知）
  let mt=0;
  try{ mt=fs.statSync(AUTO_BLACK_FILE).mtimeMs + fs.statSync(HOUR_WINDOW_FILE).mtimeMs; }catch(e){ return; }
  if(!force && mt && mt===_autoMeta.at) return;
  try{
    const ab=JSON.parse(fs.readFileSync(AUTO_BLACK_FILE,'utf8'))||{};
    AUTO_BLACK = new Set((ab.rooms||[]).map(x=>String(x.room)));
  }catch(e){ AUTO_BLACK = new Set(); }
  try{
    const hw=JSON.parse(fs.readFileSync(HOUR_WINDOW_FILE,'utf8'))||{};
    HOUR_WINDOWS = hw.rooms||{};
  }catch(e){ HOUR_WINDOWS = {}; }
  _autoMeta.at=mt;
  log(`  🚫 自动黑名单 ${AUTO_BLACK.size} 个 · 时段画像 ${Object.keys(HOUR_WINDOWS).length} 个`);
}

/** 当前小时是否在该房间的历史发袋时段内（±1 小时容差，跨午夜正确环绕） */
function inHourWindow(room){
  const w=HOUR_WINDOWS[String(room)];
  if(!w || !Array.isArray(w.hours) || !w.hours.length) return true;   // 没学过时段 → 不限制，给它机会
  const h=new Date().getHours();
  for(const raw of w.hours){
    const x=Number(raw);
    if(!Number.isFinite(x)) continue;
    const d=Math.abs(h-x);
    if(d<=1 || d>=23) return true;
  }
  return false;
}

async function updateAnchor(room, host, result, at){
  // 🔒 多账号并行：anchors.json 是共享档案，必须锁保护，
  //    否则实例 B 的整文件覆盖会把实例 A 刚学到的成果抹掉。
  try{
    await withSharedJson(ANCHORS_FILE, a=>{
      const rec=a[room]||{host:'',firstSeen:at,fudaiTotal:0,joinable:0,fans:0,hourly:{},lastFudaiAt:'',visits:0};
      if(host && !rec.host) rec.host=host;
      rec.fudaiTotal++;
      if(result==='joined'||result==='maybe-joined') rec.joinable++;
      else if(result==='skip-fans'||result==='fans-no-coins'||result==='fans-unverified') rec.fans++;
      const h=String(new Date(at).getHours());
      rec.hourly[h]=(rec.hourly[h]||0)+1;
      rec.lastFudaiAt=at;
      a[room]=rec;
      return a;
    });
  }catch(e){}
}

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let dbgCnt=0;   // 采样计数
const HANDLED_TIME=new Map();   // 房间 -> 上次「成功参与」福袋的时间戳（12 分钟内不重复处理）
// ⚠ 2026-11-05 18:42 事故：去重记录原本写在「发现福袋」时，早于参与结果。
//    关注门禁失败后，还在倒计时 6分58秒 的福袋被锁死 12 分钟，日志里 ★★ 福袋 再没出现，
//    但 [f值检查] 一直 candCount=1。改为「参与成功后才锁」，失败只给 RETRY_COOLDOWN_MS 短冷却。
//    清理由同一 Map 的 size>300 分支负责，不新增第二个状态容器。
let _RETRY_AT=new Map();        // 房间 -> 本次尝试失败后允许重试的最早时间戳（短冷却，非去重）
// 🚫 2026-11-10：房间 -> 关注拦截累计次数。达到 FOLLOW_MAX_FAILS 后写长窗跳过本轮。
//    只在 need-follow 时累加；任何一次成功参与都会清零（房间恢复了就该继续抢）。
let _FOLLOW_FAILS=new Map();

class CDP{
  constructor(ws){
    this.ws=ws;this.id=0;this.p=new Map();this.dead=false;this.deadReason='';
    this._rejectAll=(reason)=>{
      this.dead=true;this.deadReason=reason;
      for(const [k,q] of this.p){ try{ q.rej(new Error('ws-dead:'+reason)); }catch(e){} }
      this.p.clear();
    };
    ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const q=this.p.get(m.id);this.p.delete(m.id);m.error?q.rej(new Error(JSON.stringify(m.error))):q.res(m.result);}};
    // 🔴 2026-11-09 20:22 活锁根因：WebSocket 半断开后 ws.send() 不抛错，
    //    Promise 会一直挂到 25s 超时；守候循环因此每次空等 25s、日志近乎停摆
    //    （实测主号 20:07:08 后 5 分钟零推进，而外部新 CDP 连接 evaluate 仅 5ms）。
    //    必须显式监听 close/error 并立刻 reject 所有 pending，让上层能感知并重连。
    ws.onclose=()=>this._rejectAll('closed');
    ws.onerror=()=>this._rejectAll('error');
  }
  send(m,p={},t=25000){
    if(this.dead) return Promise.reject(new Error('ws-dead:'+(this.deadReason||'unknown')));
    const id=++this.id;
    return new Promise((res,rej)=>{
      const tm=setTimeout(()=>{this.p.delete(id);rej(new Error('timeout'));},t);
      this.p.set(id,{res:(v)=>{clearTimeout(tm);res(v);},rej:(e)=>{clearTimeout(tm);rej(e);}});
      try{ this.ws.send(JSON.stringify({id,method:m,params:p})); }
      catch(e){ this.p.delete(id); clearTimeout(tm); rej(new Error('ws-send-fail:'+String(e.message).slice(0,60))); }
    });
  }
  get alive(){ return !this.dead && this.ws && this.ws.readyState===1; }
}
async function conn(u){const ws=new WebSocket(u);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});return new CDP(ws);}
const ev=async(t,e,to=25000)=>{try{const r=await t.cdp.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true},to);return r.exceptionDetails?{__err:r.exceptionDetails.text}:r.result.value;}catch(e2){return{__err:String(e2.message)}}};
const shot=async(t,n)=>{try{const r=await t.cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(W+'/'+n,Buffer.from(r.data,'base64'));}catch{}};
const clickXY=async(t,x,y)=>{await t.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await sleep(250);
  await t.cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await sleep(150);
  await t.cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:1,clickCount:1});};

// 💬 守候开奖期间发中性弹幕活跃账号（2026-11-09 用户定稿）。
//    ⚠ 这是系统首次「主动公开发送内容」，发出不可撤回，因此守卫极严：
//      ① 只在守候循环内调用；② 配置开关 + 账号白名单；③ 页面必须是直播间、
//        未掉线、无开奖弹窗；④ 输入框中心点必须真的命中编辑器（未被遮罩挡住）；
//      ⑤ 只有文本确实进入编辑器才允许发送；⑥ 文案已过滤开奖检测关键词。
//    2026-11-09 10:05 受控单条实测：Input.insertText + Enter 可真实发出，
//    编辑器清空、无禁言提示、开奖检测 found:false 不误判。
async function sendDanmu(tab, room, text){
  if(!DANMU_ENABLED || !DANMU_FOR_THIS || !DANMU_TEXTS.length) return {sent:false,why:'disabled'};
  if(DANMU_BAD.test(text) || !text || text.length>20) return {sent:false,why:'bad-text'};
  try{
    // 前置守卫：页面状态 + 输入框坐标 + 命中判定，一次求值完成
    const pre=await ev(tab,`(()=>{
      var b=document.body&&document.body.innerText||'';
      var inLive=/live\\.douyin\\.com\\/\\d+/.test(location.href);
      var needLogin=/需先登录|请先登录|登录后参与|登录后可参与|登录后才能|登录后可/.test(b);
      var drawPopup=/没抽中|未中奖|恭喜.*(中奖|获得)|中奖通知|送你一个好运|很遗憾/.test(b);
      var ed=document.querySelector('[contenteditable="true"],textarea');
      if(!ed) return JSON.stringify({ok:false,why:'no-editor'});
      var r=ed.getBoundingClientRect();
      if(r.width<20||r.height<8) return JSON.stringify({ok:false,why:'editor-tiny'});
      var x=Math.round(r.x+r.width/2), y=Math.round(r.y+r.height/2);
      var top=null;
      try{var e=document.elementFromPoint(x,y);top=e?(e.tagName+'.'+String(e.className||'').slice(0,30)):null;}catch(err){}
      return JSON.stringify({ok:inLive&&!needLogin&&!drawPopup,why:!inLive?'not-live':(needLogin?'need-login':(drawPopup?'draw-popup':'ok')),
        x:x,y:y,top:top,len:b.length});
    })()`,15000);
    if(!pre || pre.__err) return {sent:false,why:'probe-fail'};
    let g; try{ g=JSON.parse(pre); }catch(e){ return {sent:false,why:'probe-parse'}; }
    if(!g.ok) return {sent:false,why:g.why};
    // 输入框中心必须命中编辑器自身，避免点到高层浮层或礼物/商品卡
    if(!/ace-line|editor|contenteditable|zone-container|INPUT|TEXTAREA/i.test(g.top||''))
      return {sent:false,why:'editor-covered:'+(g.top||'null')};
    // 聚焦 → 输入 → 校验文本确实进入编辑器
    await clickXY(tab, g.x, g.y);
    await sleep(250);
    // 💬 2026-11-11 11:37 拟人化：原来 Input.insertText 一次性把整句灌进输入框，
    //    页面观测到的就是「瞬间出现一整句」，和真人逐字打字差别明显。
    //    改为逐字 Input.insertText + 每字随机停顿（DANMU_TYPING 可一键退回整段注入）。
    //    ⚠ 用 insertText 而非 dispatchKeyEvent：中文字符靠 IME 组合事件才能进
    //      contenteditable，逐条 keyDown 会丢字；insertText 每个字都真实触发 input 事件。
    if(DANMU_TYPING){
      for(const ch of text){
        await tab.cdp.send('Input.insertText',{text:ch},10000);
        await sleep(DANMU_TYPE_MIN+Math.floor(Math.random()*(DANMU_TYPE_MAX-DANMU_TYPE_MIN+1)));
      }
    }else{
      await tab.cdp.send('Input.insertText',{text},10000);
    }
    await sleep(350);
    const typed=await ev(tab,`(()=>{
      var ed=document.querySelector('[contenteditable="true"],textarea');
      return JSON.stringify({t:ed?(ed.innerText||''):''});
    })()`,10000);
    let tv=''; try{ tv=JSON.parse(typed||'{}').t||''; }catch(e){}
     if(!tv.includes(text)){
      // 文本没进编辑器：清干净输入框，绝不按 Enter（避免误发其它内容）。
      //    ⚠ 2026-11-11 11:50 实测：仅发 Esc / Ctrl+A+Backspace 的 keyDown/keyUp
      //      对抖音 contenteditable 清不掉残留（输入框仍留着半句）。逐字输入后
      //      一旦校验失败，残留会污染下一次发送甚至被误发出去。
      //      改用 execCommand 全选删除 + 清空 DOM + 派发 input 事件让 React 同步。
      try{
        await tab.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},8000);
        await tab.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},8000);
        await ev(tab,`(()=>{
          var ed=document.querySelector('[contenteditable="true"],textarea');
          if(!ed) return 0;
          ed.focus();
          try{ document.execCommand('selectAll',false,null); document.execCommand('delete',false,null); }catch(e){}
          if(ed.tagName==='TEXTAREA') ed.value=''; else ed.innerHTML='';
          try{ ed.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null})); }catch(e){}
          return 1;
        })()`,8000);
      }catch(e){}
      return {sent:false,why:'text-not-typed'};
     }
    // 发送：优先点「发送」按钮，扫不到就按 Enter（实测抖音无独立发送按钮）
    const btn=await ev(tab,`(()=>{
      for(const el of document.querySelectorAll('button,div,span')){
        var s=(el.innerText||'').trim(); if(s!=='发送'&&s!=='评论')continue;
        var r=el.getBoundingClientRect(); if(r.width<15||r.width>300)continue;
        return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
      }
      return null;
    })()`,10000);
    let via='Enter';
    if(btn){ try{ const bp=JSON.parse(btn); await clickXY(tab,bp.x,bp.y); via='sendBtn'; }catch(e){} }
    else{
      await tab.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13},10000);
      await sleep(80);
      await tab.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13},10000);
    }
    await sleep(1200);
    // 发送后校验：编辑器清空视为已发出；禁言/风控提示留痕
    const post=await ev(tab,`(()=>{
      var ed=document.querySelector('[contenteditable="true"],textarea');
      var t=ed?(ed.innerText||'').replace(/\\u200b/g,'').trim():'';
      var b=document.body&&document.body.innerText||'';
      return JSON.stringify({cleared:t==='',banned:/禁言|已被限制|发送失败|评论失败|需要登录|请先登录/.test(b)});
    })()`,10000);
    let po={}; try{ po=JSON.parse(post||'{}'); }catch(e){}
    const sent=!!po.cleared;
    // 留痕：日志 + 执行能力记账（看板只认 fans/follow，danmu 不会污染统计）
    if(sent){
      log(`  💬 弹幕已发: ${text} (${via}, 房间 ${room})`);
      recExec('danmu',true,{room,text,via});
    }else{
      log(`  ⚠️ 弹幕未确认发出: ${text} (${via}, 房间 ${room}, banned=${!!po.banned})`);
      recExec('danmu',false,{room,text,via,banned:!!po.banned});
    }
    return {sent,via,banned:!!po.banned};
  }catch(e){
    try{ log(`  ⚠️ 弹幕异常跳过: ${String(e.message).slice(0,80)}`); }catch(_){}
    return {sent:false,why:'exception'};
  }
}

async function pSearch(tab,query){
  try{
    const r=await tab.cdp.send('DOM.performSearch',{query,includeUserAgentShadowDOM:true},20000);
    const sid=r.searchId,cnt=r.resultCount;
    if(!cnt){await tab.cdp.send('DOM.discardSearchResults',{searchId:sid}).catch(()=>{});return{cnt:0,ids:[]};}
    const g=await tab.cdp.send('DOM.getSearchResults',{searchId:sid,fromIndex:0,toIndex:Math.min(cnt,6)},20000);
    await tab.cdp.send('DOM.discardSearchResults',{searchId:sid}).catch(()=>{});
    return{cnt,ids:g.nodeIds||[]};
  }catch(e){return{err:e.message,cnt:0,ids:[]};}
}
// 🔍 2026-11-10 15:18 多候选文案搜索（用户要求持续优化，解决 no-panel 33 次白消耗）：
//    实测今日 33 次失败步骤完全相同：panel@图标中心:fans0/cond1 → cond-follow:ok(already)
//    → 之后连搜 3 次「一键发评论参与福袋/参与福袋」全部 0 命中 → 落到 no-panel。
//    对照成功的 55 次：点开图标直接出现「一键发评论参与福袋」按钮（btn@图标中心）。
//    差异说明失败房间的参与按钮是另一套文案。DOM.performSearch 是子串匹配，
//    一次只能搜一个串，故这里按候选列表依次尝试，命中即返回，语义与 pSearch 一致。
//    候选顺序按「最可能」到「最宽泛」，避免宽泛词误命中弹幕或商品文案。
const JOIN_BTN_QUERIES=[
  '一键发评论参与福袋',
  '发评论参与福袋',
  '一键参与福袋',
  '立即参与福袋',
  '点击参与福袋',
  '参与福袋',
  '立即参与',
  '点击参与',
  '发弹幕参与',
  '评论参与',
  '参与抽奖',
  '立即抽奖'
];
async function pSearchJoin(tab){
  const tried=[];
  for(const q of JOIN_BTN_QUERIES){
    const r=await pSearch(tab,q);
    if(r.cnt>0){ return {cnt:r.cnt, ids:r.ids, via:q, tried}; }
    tried.push(q);
  }
  return {cnt:0, ids:[], via:null, tried};
}

// 🎯 2026-11-10 15:39 粉丝团入口多候选搜索（修 no-panel 真因）：
//    实测截图定位：部分房间的参与方式按钮是「点亮粉丝团（1钻）」，而旧代码只搜
//    「加入粉丝团」这一个精确串 → fans.cnt=0 → 不进粉丝团分支 → 走到 cond 分支
//    再搜 12 个评论类按钮也全落空 → 最终 no-panel。今日 41 次（18.4%）全是这类。
//    「点亮粉丝团 / 点亮粉丝牌 / 加入粉丝团」是同一入口的不同文案版本，统一识别。
const FANS_GATE_QUERIES=['加入粉丝团','点亮粉丝团','点亮粉丝牌','立即加入粉丝团'];
async function pSearchFans(tab){
  const tried=[];
  for(const q of FANS_GATE_QUERIES){
    const r=await pSearch(tab,q);
    if(r.cnt>0){ return {cnt:r.cnt, ids:r.ids, via:q, tried}; }
    tried.push(q);
  }
  return {cnt:0, ids:[], via:null, tried};
}

// 🔑 2026-11-10 16:38 关注列表权威校验（用户批评「参与率太低，巡检没发现」后新增）：
//    实证：今日主号 9 次 fans-panel 拦截，涉及 5 个主播（张森财经/萝卜/觅渡Dzg/贪吃小欣/小屿），
//    用 /following/list 查证**全部在主号 173 个关注里**——是「已关注被误判」，白丢 9 个福袋。
//    但 16:29 事故证明「未关注用户在浮层期，头部也是+加粉丝团」，单看 DOM 无法区分。
//    解法：不去猜 DOM，直接查服务端关注列表（权威数据）。
//      命中 → 确实已关注，放行；
//      未命中 → 保持原严格拦截（不虚报）；
//      查询失败 → 维持原拦截（宁少抢不虚报）。
//    性能：整表缓存 10 分钟，命中/未命中都缓存，避免每个福袋都翻页。
let _followingCache = { at:0, set:null, uid:'' };
// 🔑 2026-11-11 02:18 本地关注列表缓存（解决 uid 提取失败的兜底）
//    实测：fans-panel 触发 8 次关注校验全部失败，日志显示「uid 提取结果: 空」。
//    根因：部分房间 performance 里的 webcast 请求不含 to_user_id，
//    HTML/RENDER_DATA/详情接口也拿不到（详情接口返回 status_code 10011 房间失效）。
//    但我们已经能把关注列表完整拉到本地（主号 300 人、main3 14 人），
//    所以改用「主播名」匹配：head 里和日志里都有主播昵称，直接查本地名单。
let _localFollow = null;   // { main:Set<name>, main3:Set<name> }
let _localFollowMtime = 0; // 上次加载时文件的 mtime
function loadLocalFollow(){
  // 🔴 2026-11-11 07:46 修：原实现懒加载后永久缓存，文件更新了进程也不知道。
  //    实测 hunter 进程 02:18 启动、缓存 07:17 刷新（主号 181→190 人），
  //    进程内一直是旧数据，导致「周周古法健身操/煲小咪/楠楠钢琴演奏/
  //    王子有氧健身操舞/阿新」这 5 个明明在关注列表里的主播被误拦。
  //    改为检查文件 mtime，变了就重新加载（开销极小，一次 stat）。
  let _mt = 0;
  try{ _mt = fs.statSync(DATA_DIR+'/following-cache.json').mtimeMs; }catch(e){}
  if(_localFollow && _mt && _mt === _localFollowMtime) return _localFollow;
  try{
    const raw = JSON.parse(fs.readFileSync(DATA_DIR+'/following-cache.json','utf8'))||{};
    const m = {};
    for(const [acc,v] of Object.entries(raw)){
      if(v && Array.isArray(v.list)) m[acc] = new Set(v.list.map(x=>String(x.name||'').trim()).filter(Boolean));
    }
    _localFollow = m;
    _localFollowMtime = _mt;
    for(const [acc,st] of Object.entries(m)) log(`  📋 本地关注缓存已加载: ${acc} ${st.size} 人`);
    return m;
  }catch(e){ _localFollow = {}; return _localFollow; }
}
/** 用主播名查本地关注名单。命中返回 true，未命中/无数据返回 false */
function isFollowedByName(room){
  try{
    const cache = loadLocalFollow();
    const set = cache[ACCOUNT_TAG] || cache[ACCOUNT_TAG==='main'?'main':ACCOUNT_TAG];
    if(!set || !set.size) return false;
    const name = String(NAMES[room]||'').trim();
    if(!name) return false;
    if(set.has(name)) return true;
    // 宽松匹配：包含关系（昵称可能带后缀如「甜奈¹¹⁰⁵」）
    for(const n of set){ if(n && (name.includes(n)||n.includes(name))) return true; }
    return false;
  }catch(e){ return false; }
}
const FOLLOW_CACHE_MS = 10*60*1000;
async function fetchFollowingSet(tab){
  const now = Date.now();
  if(_followingCache.set && (now-_followingCache.at) < FOLLOW_CACHE_MS) return _followingCache.set;
  try{
    const r = await ev(tab, `(async()=>{try{
      var j=JSON.parse(await (await fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383&_t='+Date.now(),{credentials:'include',cache:'no-store'})).text());
      var u=j.user||{}; if(!u.uid) return JSON.stringify({err:'no-uid'});
      var all=[],off=0,more=true,p=0;
      while(more&&p<15){
        var k=JSON.parse(await (await fetch('/aweme/v1/web/user/following/list/?user_id='+u.uid+'&sec_user_id='+u.sec_uid+'&count=20&offset='+off+'&aid=6383&device_platform=webapp&_t='+Date.now(),{credentials:'include',cache:'no-store'})).text());
        var arr=k.followings||[];
          // 🔑 2026-11-11 10:04 同时收昵称：之前只返 uid，导致「uid 拿不到」时
          //    这套权威数据完全用不上，只能退到可能过期的本地缓存文件。
          all=all.concat(arr.map(function(x){return {uid:String(x.uid),name:String(x.nickname||'')}}));
        more=!!k.has_more; off+=20; p++; if(!arr.length)break;
      }
      return JSON.stringify({uid:u.uid,cnt:u.following_count,list:all});
    }catch(e){return JSON.stringify({err:String(e.message).slice(0,80)})}})()`, 30000);
    const j = JSON.parse(r || '{}');
    if(j.err || !Array.isArray(j.list)) return null;
    _followingCache = { at: now, set: new Set(j.list.map(x=>String(x&&x.uid||'')).filter(Boolean)),
                        names: new Set(j.list.map(x=>String(x&&x.name||'').trim()).filter(Boolean)),
                        uid: String(j.uid||''), cnt: j.cnt,
                        raw: j.list };
      log(`  🔑 关注列表已缓存：${j.cnt} 人（拉到 ${_followingCache.set.size} 个 uid / ${_followingCache.names.size} 个昵称）`);
  }catch(e){ return null; }
}

// 从当前直播间的网络请求里抓主播 uid。
// ⚠ 2026-11-10 16:50 实测发现缺口：部分房间的 webcast 资源项里**完全不含 to_user_id**
//    （601309218434 实测 15 个 webcast 请求全是 CDN/监控，无 uid 参数），
//    performance 路径会返回空 → 校验失效 → 该房间仍被误拦。
//    改为四路兜底，任一路成功即可：
//      ① performance 资源项（已加载的历史请求，最快）
//      ② 页面 HTML 里的 sec_uid / uid 字段
//      ③ 页面 RENDER_DATA / 内联 JSON
//      ④ 主动 fetch 直播间详情接口（最可靠，但有网络开销）
async function getAnchorUid(tab){
  try{
    const r = await ev(tab, `(async function(){
      try{
        // ① performance 资源项
        // ⚠ 2026-11-10 17:18 修时机：ensureFollow 常在刚进房时就调用，
        //    此时 webcast 请求可能还没发出，performance 里查不到 → uid 空 → 校验失效。
        //    先等最多 6 秒让资源出现，再放弃转下一路。
        for(var _w=0;_w<12;_w++){
          var es=performance.getEntriesByType('resource')||[];
          for(var i=es.length-1;i>=0;i--){
            var u=es[i].name||'';
            if(u.indexOf('webcast')<0) continue;
            var m=u.match(/to_user_id=(\d+)/)||u.match(/anchor_id=(\d+)/);
            if(m) return JSON.stringify({uid:m[1],via:'perf'});
          }
          await new Promise(function(r){setTimeout(r,500)});
        }
        // ② 页面 HTML 内联数据
        var html=document.documentElement.innerHTML;
        var m2=html.match(/"owner_uid":"?(\d{8,})"?/)||html.match(/"anchor_uid":"?(\d{8,})"?/)
                ||html.match(/"uid":"?(\d{8,})"?/);
        if(m2) return JSON.stringify({uid:m2[1],via:'html'});
        // ③ RENDER_DATA
        var rd=document.getElementById('RENDER_DATA');
        if(rd && rd.textContent){
          try{
            var txt=decodeURIComponent(rd.textContent);
            var m3=txt.match(/"owner_uid":"?(\d{8,})"?/)||txt.match(/"uid":"?(\d{8,})"?/);
            if(m3) return JSON.stringify({uid:m3[1],via:'render'});
          }catch(e){}
        }
        // ④ 主动查直播间详情（roomId 从 URL 或页面状态拿）
        var roomId='';
        var m4=location.pathname.match(/\/(\d{6,})/);
        if(m4) roomId=m4[1];
        if(roomId){
          try{
            var j=JSON.parse(await (await fetch('/webcast/room/web/enter/?aid=6383&app_name=douyin_web&live_id=1&device_platform=web&room_id='+roomId+'&_t='+Date.now(),{credentials:'include',cache:'no-store'})).text());
            var d=j.data||{};
            var uid=(d.data&&d.data[0]&&d.data[0].owner&&d.data[0].owner.uid)||(d.user&&d.user.uid)||'';
            if(uid) return JSON.stringify({uid:String(uid),via:'api'});
          }catch(e){}
        }
        return JSON.stringify({uid:'',via:'none'});
      }catch(e){ return JSON.stringify({uid:'',via:'err:'+String(e.message).slice(0,40)}) }
    })()`, 20000);
    const j = JSON.parse(r || '{}');
    if(j.via && j.via!=='perf' && j.uid) log(`  🔑 主播 uid 取自 ${j.via}: ${j.uid}`);
    return String(j.uid||'');
  }catch(e){ return ''; }
}
async function ensureDom(tab){try{await tab.cdp.send('DOM.enable',{},15000);const d=await tab.cdp.send('DOM.getDocument',{depth:-1,pierce:true},30000);return d?.root?.nodeId||null;}catch(e){return null;}}
async function getBox(tab,nodeId){
  try{
    const res=await tab.cdp.send('DOM.resolveNode',{nodeId},12000);
    if(!res?.object?.objectId)return null;
    const rc=await tab.cdp.send('Runtime.callFunctionOn',{objectId:res.object.objectId,
      functionDeclaration:`function(){const el=(this.nodeType===3)?this.parentElement:this;if(!el)return null;
        const r=el.getBoundingClientRect();if(!r||r.width<1||r.height<1)return null;
        return {tag:el.tagName,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
          cx:Math.round(r.x+r.width/2),cy:Math.round(r.y+r.height/2),text:(el.innerText||'').slice(0,30)};}`,
      returnByValue:true},15000);
    return rc?.result?.value||null;
  }catch(e){return null;}
}

// 🧧 人气红包面板识别（2026-11-05 19:51 事故修复）。
//    旧版用 `document.body.innerText` 判「人气红包」，但实测红包面板在 iframe 里，
//    主 frame 读不到 → isPacket 恒 false → 6 个点击位置全落空后误报 no-panel。
//    截图证据：19:21 白泽、12:38 ☀️歌小样 的点击后现场都是同一个粉色人气红包面板，
//    且 shortTouch 倒计时仍在走，福袋还活着却被放弃。全历史 243 条记录 packet 步骤 0 条。
//
//    修法用 CDP DOM 域而非 JS：
//      - DOM.performSearch 会遍历 iframe 与 shadow DOM（独立实验：iframe 内「人气红包」cnt=2）
//      - 双判据「人气红包」+「可抢红包」同时命中才算红包面板，避免弹幕提词/普通福袋误判
//      - DOM.getBoxModel 对 iframe 内节点返回「主视口绝对坐标」（实验：iframe 偏移 400,200
//        时内部按钮坐标精确为 520,320），可直接喂给 clickXY；getBox 用的是 getBoundingClientRect，
//        在 iframe 内只给相对坐标，不能用于这里
async function detectPacketPanel(tab){
  if(!PACKET_DETECT) return {found:false,disabled:true};
  try{
    await tab.cdp.send('DOM.getDocument',{depth:-1,pierce:true},30000);
    const search=async(q)=>{
      const r=await tab.cdp.send('DOM.performSearch',{query:q,includeUserAgentShadowDOM:true},20000);
      if(!r.resultCount) return 0;
      await tab.cdp.send('DOM.discardSearchResults',{searchId:r.searchId}).catch(()=>{});
      return r.resultCount;
    };
    const a=await search('人气红包'), b=await search('可抢红包');
    if(!(a>0&&b>0)) return {found:false,hits:{packet:a,grabHint:b}};
    // 找圆形「抢」按钮：DOM.performSearch('抢') 会同时命中「¥47 抢」等商品卡，
    // 用 getBoxModel 的宽高近似正方形 + 主视口居中区域过滤，取最接近圆形的一个。
    const r=await tab.cdp.send('DOM.performSearch',{query:'抢',includeUserAgentShadowDOM:true},20000);
    const g=r.resultCount
      ? await tab.cdp.send('DOM.getSearchResults',{searchId:r.searchId,fromIndex:0,toIndex:Math.min(r.resultCount,12)},20000)
      : {nodeIds:[]};
    if(r.resultCount) await tab.cdp.send('DOM.discardSearchResults',{searchId:r.searchId}).catch(()=>{});
    let best=null;
    for(const nid of g.nodeIds||[]){
      try{
        const bm=await tab.cdp.send('DOM.getBoxModel',{nodeId:nid},12000);
        const q=bm?.model?.content;
        if(!q||q.length<8) continue;
        const w=Math.round(bm.model.width), h=Math.round(bm.model.height);
        const cx=Math.round((q[0]+q[2]+q[4]+q[6])/4), cy=Math.round((q[1]+q[3]+q[5]+q[7])/4);
        if(w<40||h<40||w>220||h>220) continue;             // 商品卡按钮是 60x30，天然排除
        if(cx<250||cx>1050||cy<150||cy>700) continue;       // 居中浮层，排除右侧排行榜/商品卡
        const ratio=Math.abs(w-h)/Math.max(w,h);
        if(!best||ratio<best.ratio) best={x:cx,y:cy,w,h,ratio,nodeId:nid};
      }catch(e){}
    }
    return {found:true,hits:{packet:a,grabHint:b},grab:best};
  }catch(e){ return {found:false,err:String(e.message).slice(0,60)}; }
}

// 🧧 关闭人气红包面板（2026-11-06 10:22 用户纠正后新增）。
//    旧逻辑识别到红包就 return，粉色全屏面板不关，会把同排后面的福袋图标全挡住，
//    导致「福袋和红包同排」时真福袋再也点不开。关闭后才允许继续试下一个候选。
//    红包面板在 iframe 里，关按钮用 DOM.performSearch 跨 frame 找「× / 关闭」，
//    拿 getBoxModel 主视口绝对坐标点击；找不到就退而求其次按 Esc / 点面板外侧。
async function closePacketPanel(tab){
  try{
    await tab.cdp.send('DOM.getDocument',{depth:-1,pierce:true},30000);
    // 先确认红包面板还在；不在就什么都不做，避免误伤页面上的其他 × 按钮
    const chk=await tab.cdp.send('DOM.performSearch',{query:'人气红包',includeUserAgentShadowDOM:true},15000);
    if(chk.resultCount)await tab.cdp.send('DOM.discardSearchResults',{searchId:chk.searchId}).catch(()=>{});
    if(!chk.resultCount) return {closed:true,how:'already-closed'};

    const r=await tab.cdp.send('DOM.performSearch',{query:'×',includeUserAgentShadowDOM:true},20000);
    if(r.resultCount){
      const g=await tab.cdp.send('DOM.getSearchResults',{searchId:r.searchId,fromIndex:0,toIndex:Math.min(r.resultCount,8)},20000);
      await tab.cdp.send('DOM.discardSearchResults',{searchId:r.searchId}).catch(()=>{});
      for(const nid of g.nodeIds||[]){
        try{
          const bm=await tab.cdp.send('DOM.getBoxModel',{nodeId:nid},12000);
          const q=bm?.model?.content; if(!q||q.length<8)continue;
          const w=Math.round(bm.model.width), h=Math.round(bm.model.height);
          // 红包面板的关闭圈实测约 24~40px；商品卡/弹幕的 × 多为 12px 以下或长条形
          if(w<16||w>60||h<16||h>60||Math.abs(w-h)>12)continue;
          const cx=Math.round((q[0]+q[2]+q[4]+q[6])/4), cy=Math.round((q[1]+q[3]+q[5]+q[7])/4);
          // 关闭圈在粉色面板下方居中区域（19:21 截图实测 x≈560,y≈590），排除左上角图标区
          if(cx<300||cx>1000||cy<200||cy>750)continue;
          await clickXY(tab,cx,cy); await sleep(600);
          const a=await tab.cdp.send('DOM.performSearch',{query:'人气红包',includeUserAgentShadowDOM:true},15000);
          if(a.resultCount)await tab.cdp.send('DOM.discardSearchResults',{searchId:a.searchId}).catch(()=>{});
          return {closed:a.resultCount===0,how:'x-btn'};
        }catch(e){}
      }
    }else{
      await tab.cdp.send('DOM.discardSearchResults',{searchId:r.searchId}).catch(()=>{});
    }
    // 兜底只发 Esc，绝不盲点页面中部（会误触礼物/弹幕/商品卡）
    await tab.cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}).catch(()=>{});
    await tab.cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}).catch(()=>{});
    await sleep(400);
    return {closed:false,how:'esc-only'};
  }catch(e){ return {closed:false,how:'err',err:String(e.message).slice(0,50)}; }
}

const SCAN=`(()=>{
  var b=document.body.innerText||'';
  // 在线人数有两种文案：
  //   普通直播间 → 「在线观众 1234」
  //   大型赛事/活动页（KPL 那类）→ 「137.2万人看过」
  // 只认前一种会把大房间解析成 -1，实测 KPL 在线 117 万却显示 -1
  var m=b.match(/在线观众[\\s\\S]{0,10}?([\\d.,]+)\\s*(万)?/);
  if(!m) m=b.match(/([\\d.,]+)\\s*(万)?人看过/);
  var online=-1; if(m)online=Math.round(parseFloat(m[1].replace(/,/g,''))*(m[2]?10000:1));
  var cands=[];
  for(const el of document.querySelectorAll('[class*="LMUtLyr9"]')){
    var img=el.querySelector('[class*="KXLj31kc"]'); if(!img)continue;
    var rr=el.getBoundingClientRect(); if(rr.width<24)continue;
    var cd=el.querySelector('[class*="ycjwPFJI"]'); var cdt=cd?(cd.innerText||'').trim():'';
    var cont=el.parentElement;
    for(var i=0;i<4&&cont;i++){ if(String(cont.className).includes('ShortTouchContainer'))break; cont=cont.parentElement; }
    var cr=cont?cont.getBoundingClientRect():null;
    var sec=-1;
    var mm=cdt.match(/^(\\d{1,2}):(\\d{2})$/);
    if(mm) sec=(+mm[1])*60+(+mm[2]);
    cands.push({x:Math.round(rr.x),y:Math.round(rr.y),w:Math.round(rr.width),h:Math.round(rr.height),
      cd:cdt, sec:sec, cw:cr?Math.round(cr.width):-1, hasCd:(sec>=0)});
  }
  var f=null, fErr=null, fAll=[];
  try{
    if(cands.length){
      // ⚠ 2026-11-06 10:22 用户纠正：「红包和福袋是在一排的，福袋位置也不固定，
      //   重点是识别福袋，红包是不去抢的」。19:21 完整 DOM 实测同排结构为：
      //     ShortTouchContainer > __biz(TLPz67YJ) > div.redpacket   ← 人气红包位（iframe）
      //     ShortTouchContainer > __biz           > LMUtLyr9+倒计时  ← 福袋位
      //   两张历史截图里倒计时一个在左、一个在右，位置确实不固定。
      //   SCAN 只认 LMUtLyr9（福袋位）是对的，不能靠坐标/第几个图标判断。
      //   但旧逻辑优先只留有倒计时的候选，会把「不带倒计时的福袋」整个丢掉，
      //   且只取前 4 个；现改为整排全收，有倒计时的按倒计时升序在前，
      //   无倒计时的排后面但绝不丢弃，由 tryJoin 逐个用「面板文案」验证真伪。
      var wc=cands.filter(function(c){return c.hasCd===true;});
      var nc=cands.filter(function(c){return c.hasCd!==true;});
      wc.sort(function(a,b){return a.sec-b.sec;});
      var pool=wc.concat(nc);
      fAll=pool.slice(0,6);
      f=pool[0]||null;
    }
  }catch(e){ fErr=String(e&&e.message||e); }
  return {online:online, fudai:f, fudaiAll:fAll, cands:cands.slice(0,4), fErr:fErr, candCount:cands.length,
    title:document.title.slice(0,30),
    len:b.length, loading:(b.indexOf('直播加载中')>=0), exited:(b.indexOf('已退出直播间')>=0),
    // 🚩 未开播标志：抖音号形式的直播间在主播未开播时显示主播主页（含"直播已结束"等）
    notLive:(/直播已结束|未开播|暂无直播|主播不在|休息中/.test(b))};
})()`;

// 📌 自动关注主播（2026-11-05 起：抢福袋「之前」调用，页面干净无遮罩）
//    返回值新增 inconclusive：页面尚未加载好，此时不能判定「没关注」，
//    否则会把加载慢误当风控拦截而丢掉福袋。
//    ⚠ 真实记账在下方包装函数 ensureFollow 里统一做：原先看板靠日志正则统计，
//      跨天复用 + 旧探针 no-btn 误判，91 次里大部分是历史噪声。改成 append 到
//      exec-actions.jsonl，带 at/account，看板按本地日过滤，只认真实到位。
// 🔴 2026-11-09 22:23 最终定论（此前 19:30 / 19:45 两轮修法均已实测无效并撤回）：
//    「main3 关注不落库」是服务端会话级限制，不是判据、不是浮层、不是点击方式问题。
//    决定性同房间对照（471576972164，同一网页同一脚本点击）：
//      主号 9750  关注数 163 → 164 ✅ 真落库
//      main3 9752 关注数   2 →   2 ❌ 不落库
//    两者 relation/update 响应完全相同（status_code:0 / follow_status:1），
//    页面也都短暂变「+加粉丝团」——UI 成功但服务端不写，属该账号网页会话受限。
//    用户手机 App 手动可关注，说明账号本身正常，仅网页会话受限，需重扫码才可能恢复。
//    ❌ 已撤回的错误修法：遇 fans-panel 就 reload 重判（实测 6 次触发 0 次挽回；
//       因服务端不落库，reload 后「关注G」必然回来，再判仍是未关注，纯属无效重载）。
//    ✅ 维持 16:29 的严格硬门禁：浮层态一律判 inconclusive 拦截，绝不虚报关注成功。
//       宁可漏抢，也不在未确定关注的情况下参与——这是用户定稿的 allowInconclusive:false。
async function _ensureFollowImpl(tab, room){
  try{
    // 🔑 关注按钮定位：button DOM 直查优先，elementFromPoint 坐标扫描兜底。
    //    🔴 2026-11-09 修复：旧探针只靠坐标扫描，页面头部被活动条占位或 UI 尚未
    //    重建时会漏扫，把「有关注按钮」误判成 no-follow-btn。
    //    ⚠ 抖音「已关注」的真实表现是左上角变成「+加粉丝团 / 加会员」，且不再有
    //    「关注」按钮；页面既不显示「已关注」也不显示「互相关注」。
    const st = await ev(tab, `(()=>{
      var b=document.body&&document.body.innerText||'';
      var bodyLen=b.length;
      // ① 头部区域文本（y<75, x<640）：「+加粉丝团 / 加会员」是已关注态专属组件。
      //    只取这个区域，避免把弹幕、商品卡里的「加粉丝团」文字误算进来。
      var head='';
      for(const el of document.querySelectorAll('button,div,span,a')){
        var r=el.getBoundingClientRect();
        if(r.y>75||r.x>640||r.width<10||r.height<8)continue;
        var h=(el.innerText||'').trim();
        if(h&&h.length<=14) head += h.replace(/\\n/g,'') + '|';
      }
      // ② 关注按钮：DOM 直查优先
      var btn=null, domBtn=false;
      for(const el of document.querySelectorAll('button')){
        var t=(el.innerText||'').trim(), rc=el.getBoundingClientRect();
        if(!/^关注/.test(t) || t.indexOf('加粉丝团')>=0) continue;
        if(rc.y>110||rc.width<30||rc.height<16||rc.width>=160) continue;
        btn={x:Math.round(rc.x+rc.width/2), y:Math.round(rc.y+rc.height/2), w:Math.round(rc.width), t:t.slice(0,8), via:'dom'};
        domBtn=true; break;
      }
      var followedWord=(/关注成功/.test(b) || /已关注|互相关注/.test(head));
      // ⚠ 点击「关注」后会弹「1 钻石加入粉丝团」浮层，浮层期间头部也会出现
      //    「+加粉丝团 / 加会员」，且「关注」按钮被移除。若不加排除，下面的
      //    已关注判据会把「浮层中的未关注态」误判成 already（实测 main3 的
      //    11 次假 btn-gone 就是这么来的）。浮层存在时一律不判已关注。
      var fansPanel=/钻石加入粉丝团|酷炫勋章|专属礼物|进场特效/.test(b);
      // ③ DOM 没找到时，坐标扫描兜底
      if(!btn){
        for(var y=15;y<=70;y+=4){
          for(var x=60;x<=440;x+=5){
            var el2=document.elementFromPoint(x,y); if(!el2)continue;
            var t2=(el2.innerText||el2.textContent||'').trim();
            if(!t2||t2.length>12)continue;
            if(t2.indexOf('已关注')>=0||t2.indexOf('互相关注')>=0){ followedWord=true; continue; }
            if(t2.indexOf('关注')>=0 && t2.indexOf('加粉丝团')<0){
              var rc2=el2.getBoundingClientRect();
              if(rc2.width>=30&&rc2.height>=16&&rc2.width<160){
                btn={x:Math.round(rc2.x+rc2.width/2), y:Math.round(rc2.y+rc2.height/2), w:Math.round(rc2.width), t:t2.slice(0,8), via:'coord'};
              }
            }
          }
          if(btn)break;
        }
      }
      // ④ 确定已关注 = 明确文字，或「页面已渲染 + 无关注按钮 + 头部有已关注态组件」。
      //    🔴 2026-11-09 订正：上午误删了这条判据，导致 54 次已关注房间被判不确定、
      //    55 个福袋被拦下。同房间双账号对照实测：已关注账号头部是「+加粉丝团/加会员」
      //    且无关注按钮，未关注账号头部是「关注G」且无粉丝团入口。
      //    /user/self 的全局关注数不是「该直播间是否关注」的判据，代码从不读它。
      var followed = followedWord || (bodyLen>=200 && !btn && !fansPanel && /加粉丝团|加会员/.test(head));
      return {followed, btn, bodyLen, fansPanel:fansPanel, head:head.slice(0,120), domBtn:domBtn, coordOnly:!!(btn&&!domBtn)};
    })()`, 25000);
    if(!st || st.__err) return {ok:false,inconclusive:true,reason:'probe-fail'};
    // 浮层期间不下结论：既不能判已关注，也不能判「无按钮可点」，交给短冷却重试
    //    ⚠ 2026-11-09 16:29 决定性对照订正：粉丝团浮层是「点击关注后」才弹出的引导，
    //    实测 8 秒不自动消失、只有 reload 才消失。16:05 曾假设它是会自动消失的瞬态、
    //    加「等待复探让它消失」，方向错误且无效（c35cd68），已回滚。
    //    真判据必须落在 reload 后的持久态，见文末 16:29 章节；此处保持严格硬门禁不放松。
    if(st.fansPanel && !st.btn){
      // 🔴 2026-11-09 22:23 撤回 reload 方案：实测 6 次触发 0 次挽回。
      //    根因是 main3 会话的写操作被服务端限制（同房间对照：主号 163→164 成功、
      //    main3 2→2 不落库），reload 后关注按钮必然回来，再判仍是未关注。
      //    浮层期间维持原严格拦截，不改判据、不虚报成功。
      //
      // 🔑 2026-11-10 16:38 增补「关注列表权威校验」（用户批评参与率太低后新增）：
      //    实证：今日主号 9 次 fans-panel 拦截涉及 5 个主播，用 /following/list 查证
      //    **全部已在主号 173 个关注里** —— 纯粹是已关注被误判，白丢 9 个福袋。
      //    而 16:29 事故证明「未关注用户在浮层期头部也是 +加粉丝团」，单看 DOM 无法区分。
      //    解法：查服务端关注列表（权威），命中就放行，未命中/查询失败保持原拦截。
      //    只在 head 已含粉丝团入口时才查，避免无谓开销。
      if(/加粉丝团|加会员/.test(st.head)){
        log('  🔑 进入关注列表校验…');
        try{
          const _auid = await getAnchorUid(tab);
          log(`  🔑 uid 提取结果: ${_auid||'空'}`);
          if(_auid){
            const _set = await fetchFollowingSet(tab);
            if(_set && _set.has(String(_auid))){
              log(`  🔑 关注列表校验：主播 ${_auid} 已关注，放行（服务端权威）`);
              return {ok:true, reason:'already-verified',
                diag:{verifyHow:'already-verified',anchorUid:_auid,bodyLen:st.bodyLen,head:st.head}};
            }
            if(_set && !_set.has(String(_auid))){
              log(`  🔑 关注列表校验：主播 ${_auid} 未关注，保持拦截`);
            }
          }
          // 🔑 2026-11-11 02:18 第三路兜底：uid 拿不到时用主播名查本地关注名单。
          //    实测 8 次校验全因 uid 空而失败，本地名单能补上这个缺口。
          if(!_auid){
            const _byName = isFollowedByName(room);
            if(_byName){
              log(`  🔑 本地名单命中：${NAMES[room]||room} 已关注，放行`);
              return {ok:true, reason:'already-by-name',
                diag:{verifyHow:'already-by-name',room,bodyLen:st.bodyLen,head:st.head}};
            }
            // 🔴 2026-11-11 09:54 用户报「主号也关注不了」的真正根因：
            //    实测主播「颖姐财经」确实在主号关注列表第一页（服务端 197 个关注里第一个），
            //    但本地缓存是 6 小时前的快照（只有 190 人那批），查不到它 →
            //    已关注的房间被判未关注而拦截，表现就像「关注不了」。
            //    本地命中不了时，强制重读一次缓存文件（管他 mtime 有没有变），
            //    因为文件可能是别的进程刚写的；仍不中才认输。
            if(!_byName){
              // ① 先重置缓存重读本地文件（防别的进程刚写完、本进程持旧对象）
              _localFollow = null; _localFollowMtime = 0;
              if(isFollowedByName(room)){
                log(`  🔑 重读缓存后命中：${NAMES[room]||room} 已关注，放行`);
                return {ok:true, reason:'already-by-name-reload',
                  diag:{verifyHow:'already-by-name-reload',room,bodyLen:st.bodyLen,head:st.head}};
              }
              // ② 🔴 2026-11-11 10:04 终极兜底：本地文件也可能是几小时前的快照。
              //    用户 09:53 关注了「颖姐财经」、10:01 关注了「A凝」，
              //    两次都在缓存刷新前就被福袋撞上，白丢福袋。
              //    这里实时拉一次服务端关注列表（fetchFollowingSet 自带 10 分钟内存缓存，
              //    不会每房间都发请求），用昵称比对——服务端有就是真有。
              try{
                await fetchFollowingSet(tab);
                const _srvNames = _followingCache && _followingCache.names;
                const _nm = String(NAMES[room]||'').trim();
                if(_srvNames && _srvNames.size && _nm){
                  let hit=false;
                  if(_srvNames.has(_nm)) hit=true;
                  else { for(const n of _srvNames){ if(n && (n.includes(_nm)||_nm.includes(n))){ hit=true; break; } } }
                  if(hit){
                    // 命中就顺手把这条补进本地缓存，省下次再查
                    try{
                      const p2=DATA_DIR+'/following-cache.json';
                      const raw=JSON.parse(fs.readFileSync(p2,'utf8'))||{};
                      const acc=ACCOUNT_TAG==='main'?'main':ACCOUNT_TAG;
                      raw[acc]=raw[acc]||{nick:'',at:'',list:[]};
                      raw[acc].list=raw[acc].list||[];
                      if(!raw[acc].list.some(x=>String(x.name||'')===_nm)) raw[acc].list.push({uid:'',name:_nm});
                      fs.writeFileSync(p2,JSON.stringify(raw,null,1));
                      _localFollow=null; _localFollowMtime=0;
                    }catch(e){}
                    log(`  🔑 服务端实时命中：${_nm} 已关注，放行`);
                    return {ok:true, reason:'already-by-server',
                      diag:{verifyHow:'already-by-server',room,bodyLen:st.bodyLen,head:st.head}};
                  }
                  log(`  🔑 服务端 ${_srvNames.size} 个昵称里也没有：${_nm}`);
                }
              }catch(e){ log(`  ⚠️ 服务端实时查询失败: ${String(e.message||e).slice(0,60)}`); }
            }
            log(`  🔑 uid 空且本地名单未命中：${NAMES[room]||room}，保持拦截`);
          }
        }catch(e){ log(`  ⚠️ 关注校验异常: ${String(e.message||e).slice(0,100)}`); }
      }
      return {ok:false,inconclusive:true,reason:'fans-panel',
        diag:{verifyHow:'fans-panel',bodyLen:st.bodyLen,head:st.head}};
    }
    if(st.followed){
      // 🔴 2026-11-09 订正：恢复「已关注」判据。抖音已关注态的 DOM 表现就是
      //    「关注」按钮消失 + 头部出现「+加粉丝团 / 加会员」，页面没有「已关注」文字。
      //    上午误删这条判据，导致本轮 54 次已关注房间被判 no-follow-btn(不确定)，
      //    连带 55 个福袋被 need-follow 拦下。同房间双账号对照已验证：
      //    已关注账号无关注按钮且有粉丝团入口，未关注账号有「关注G」且无粉丝团入口。
      //    判据要求 bodyLen>=200（页面真渲染完）+ 无关注按钮 + 头部有专属组件，三者缺一仍拦截。
      return {ok:true,reason:'already',diag:{verifyHow:'already',bodyLen:st.bodyLen,head:st.head,
        domBtn:st.domBtn,coordOnly:st.coordOnly}};
    }
    // 🔴 2026-11-09 订正：只有「页面渲染好 + 无关注按钮 + 头部也没有已关注态组件」
    //    才是真不确定，仍按 allowInconclusive:false 拦截，不放宽用户定稿的硬门禁。
    if(!st.btn){
      return {ok:false,inconclusive:true,reason:'no-follow-btn',
        diag:{verifyHow:'no-follow-btn',bodyLen:st.bodyLen,head:st.head,
          domBtn:st.domBtn,coordOnly:st.coordOnly}};
    }

    const b=st.btn;
    await clickXY(tab, b.x, b.y);
    await sleep(5000);   // 关注请求 + UI 刷新需要时间，3.5s 偏短

    // 🩺 2026-11-05 18:42 事故：这个探针原本只跑一次。页面刚「重建标签后加载成功」
    //    时 UI 还没刷新完，5s 后仍看到「关注」按钮 → clicked-unverified → need-follow，
    //    福袋还剩 6分58秒 却被整轮放弃。现改为同一探针跑两次（只验证、不重复点击），
    //    第二次才成功记 recovered-follow；两次都失败才按真风控交给硬门禁拦截。
    // 🔴 2026-11-09 二次订正：点击「关注」后抖音会弹「1 钻石加入粉丝团」全屏浮层，
    //    浮层期间「关注」按钮会从 DOM 移除，旧探针把这种假消失判成 btn-gone 成功。
    //    实测 main3 11 次 btn-gone 全是浮层假阳性，重载后「关注G」按钮回来、关注数仍 0。
    //    ⚠ 2026-11-09 15:27 副作用订正：曾用 Escape 主动关浮层，实测会让页面多出
    //    一层全局导航（len 744→1194，头部「+加粉丝团/加会员」被「精选|搜索」替换），
    //    验证拿不到已关注组件，新进程前 2 条关注全被 btn-gone-unverified 拦下。
    //    现不再主动操作页面：浮层存在时直接 inconclusive，交给既有 45s 短冷却重试；
    //    重试时浮层已自然消失，真关注成功会被 st 探针判 already，未落库则再次看到
    //    「关注G」按钮重新点击，不虚报成功。
    //    仅「按钮消失」必须同时满足「头部出现 +加粉丝团/加会员」才算确定已关注。
    const verifyExpr = `(()=>{
      var b=document.body&&document.body.innerText||'';
      var len=b.length;
      if(/关注成功/.test(b)) return {done:true, how:'toast', len:len};
      var head='';
      for(const el of document.querySelectorAll('button,div,span,a')){
        var r=el.getBoundingClientRect();
        if(r.y>75||r.x>640||r.width<10||r.height<8)continue;
        var h=(el.innerText||'').trim();
        if(h&&h.length<=14) head += h.replace(/\\n/g,'') + '|';
      }
      if(/已关注|互相关注/.test(head)) return {done:true, how:'followed-text', len:len, head:head.slice(0,80)};
      // 粉丝团浮层还在：此时「关注」按钮的消失是被浮层替换，不能算成功
      var fansPanel=/钻石加入粉丝团|酷炫勋章|专属礼物|进场特效/.test(b);
      // 关注按钮：DOM 直查 + 坐标兜底，与 st 探针同口径
      var still=false;
      for(const el of document.querySelectorAll('button')){
        var t=(el.innerText||'').trim();
        if(!/^关注/.test(t) || t.indexOf('加粉丝团')>=0) continue;
        var r2=el.getBoundingClientRect();
        if(r2.width>=30 && r2.height>=16 && r2.width<160 && r2.y<130){ still=true; break; }
      }
      if(len<200) return {done:false, how:'page-loading', len:len, still:still, fansPanel:fansPanel, head:head.slice(0,80), inconclusive:true};
      if(fansPanel) return {done:false, how:'fans-panel', len:len, still:still, fansPanel:true, head:head.slice(0,80), inconclusive:true};
      if(still) return {done:false, how:'still-there', len:len, still:true, head:head.slice(0,80)};
      // 🔴 按钮消失还不够：必须头部同时出现已关注态专属组件，才敢确定关注成功
      var hasFollowedUi=/加粉丝团|加会员|已关注|互相关注/.test(head);
      if(!hasFollowedUi) return {done:false, how:'btn-gone-unverified', len:len, still:false, head:head.slice(0,80), inconclusive:true};
      return {done:true, how:'btn-gone', len:len, still:false, head:head.slice(0,80)};
    })()`;
    let v = await ev(tab, verifyExpr, 20000);
    let recoveredOnRetry=false;
    if((!v || !v.done) && VERIFY_RETRY_MS>0 && !v.__err){
      await sleep(VERIFY_RETRY_MS);
      const v2 = await ev(tab, verifyExpr, 20000);
      if(v2 && !v2.__err && v2.done){ v=v2; recoveredOnRetry=true; }
      else if(v2 && !v2.__err){ v=v2; }   // 二次仍失败，用最新的 DOM 诊断
    }
    const ok = !!(v && v.done);
    // 无论验证结果都记入已尝试（避免反复点击同一主播）
    try{
      const ff=ROOT+'/scripts/followed-rooms.txt';
      let ex=[]; try{ ex=fs.readFileSync(ff,'utf8').trim().split('\n').filter(Boolean); }catch(e){}
      const tag = ok ? room : (room+':uncertain');
      const base = room;
      if(!ex.includes(base) && !ex.includes(tag)){ ex.unshift(tag); fs.writeFileSync(ff, ex.slice(0,200).join('\n')); }
    }catch(e){}
    // inconclusive：探针异常 / 页面未加载好，不能当作「关注失败」来处理
    const inconclusive = !!(v && v.inconclusive);
    // 诊断字段：verifyHow / still / bodyLen / head 写入 exec-actions.jsonl，
    // 下次能区分「页面没稳、UI 刷新慢」与「关注请求被服务端静默丢弃」，不再靠猜。
    const diag={
      verifyHow:(v&&v.how)||'probe-fail',
      still:(v&&typeof v.still==='boolean')?v.still:null,
      bodyLen:(v&&typeof v.len==='number')?v.len:null,
      head:(v&&v.head)||null,
      retryRecovered:recoveredOnRetry
    };
    return {ok, inconclusive, diag,
      reason: ok?(recoveredOnRetry?'recovered-follow':(v.how||'now-followed')):(inconclusive?((v&&v.how)||'page-loading'):'clicked-unverified'), btn:b};
  }catch(e){ return {ok:false, inconclusive:true, diag:{verifyHow:'exception',err:String(e.message).slice(0,80)}, reason:String(e.message).slice(0,40)}; }
}

// 📊 统一出口记账：所有 return 分支都覆盖，且不改动原返回值。
//    ok=true 记成功；inconclusive 记「不确定」（页面未加载好，不算失败也不算成功）；
//    ok=false 且非不确定才记失败。room 从参数取，天然按账号隔离。
async function ensureFollow(tab, room){
  const r = await _ensureFollowImpl(tab, room);
  recExec('follow', !!r.ok, {
    room,
    state: r.ok ? (r.reason||'ok') : (r.inconclusive ? 'inconclusive' : (r.reason||'fail')),
    ...(r.diag||{})
  });
  return r;
}

/**
 * 加入粉丝团（用于「5 万人在线以上大房间的粉丝团福袋」）
 * 用户 2026-11-02 要求：大房间的粉丝团福袋也要抢，所以先加入粉丝团再参与。
 * 注意：抖音粉丝团通常需要「点亮粉丝牌」（1 抖币），可能产生费用。
 */
async function joinFansGroup(tab, roomArg){
  try{
    // 找「加入粉丝团」按钮
    // ⚠ 实测踩坑（19:10 郭少杰 10 万人房间）：innerText 是会冒泡的——主播昵称
    //   「郭少杰🕊️笑看人间」的容器 div 同样「包含」面板里『加入粉丝团』的文案
    //   （DOM 树上昵称和面板同属一个祖先），于是第一个匹配项是昵称容器，
    //   中心点落在头像上，点了等于没点。修法：找到匹配元素后，沿子树往下钻，
    //   取「仍然包含关键词的最小元素」，中心点才是真按钮。
    const pos=await ev(tab,`(()=>{
      // ⚠ 20:09 阿朱(90000人)截图实测：真按钮文案是「加入粉丝团（1钻）」——带后缀！
      //   旧的 indexOf 宽松匹配会被「昵称容器包含文案」骗到错位元素；
      //   修正：开头匹配（startsWith）既能命中带价签的真按钮，
      //   又不会匹配到「xxx加入粉丝团yyy」这种恰好含关键词的长文案容器。
      const KW=['加入粉丝团','点亮粉丝团','点亮粉丝牌','立即加入粉丝团','立即加入'];
      function drill(el){
        // 沿子树找「以关键词开头」的最小元素（截图证实按钮带（1钻）后缀）
        var best=el;
        var stack=[el];
        while(stack.length){
          var cur=stack.pop();
          var t=(cur.innerText||'').trim();
          var hit=KW.some(function(k){return t.startsWith(k);});
          if(hit){
            var r=cur.getBoundingClientRect();
            if(r.width>10&&r.height>10&&r.width<400&&r.height<120){ best=cur; }
            var kids=cur.children||[];
            for(var i=0;i<kids.length;i++) stack.push(kids[i]);
          }
        }
        return best;
      }
      var cand=null, candIsExact=false;
      for(const el of document.querySelectorAll('div,span,button')){
        var t=(el.innerText||'').trim();
        var exact=KW.some(function(k){return t===k || t.startsWith(k+'（');});  // 「加入粉丝团（1钻）」也算精确
        var loose=KW.some(function(k){return t.indexOf(k)>=0;});
        if(!loose) continue;
        var r=el.getBoundingClientRect();
        if(!(r.width>30 && r.height>16 && r.y<760 && r.width<500)) continue;
        // 精确匹配（文本就是按钮文案或按钮文案+价签）优先级最高，直接用
        if(exact){ cand=el; candIsExact=true; break; }
        if(!cand){ cand=el; }
      }
      if(!cand) return null;
      var target=drill(cand);
      var rc=target.getBoundingClientRect();
      return JSON.stringify({x:Math.round(rc.x+rc.width/2), y:Math.round(rc.y+rc.height/2),
        txt:(target.innerText||'').trim().slice(0,24), exact:candIsExact});
    })()`,15000);
    if(!pos) return {ok:false, why:'no-fans-btn'};
    const p=JSON.parse(pos);
    log(`    加入粉丝团: 点击「${p.txt}」@${p.x},${p.y}${p.exact?' [精确]':' [钻取]'}`);
    await clickXY(tab,p.x,p.y);
    // ⚠ ev() 返回的是「表达式 return 的值」。这些表达式统一用 JSON.stringify(...) 包一层，
    //    所以拿到的是 JSON **字符串**，不是对象。旧代码 settle.done / needPay.__err 当对象读，
    //    恒为 undefined → 轮询 8 次全空转、二次确认弹窗从未被识别（2026-11-06 实测）。
    //    统一用 parseEv()：兼容字符串 / 对象 / __err，返回可判定的布尔字段。
    const parseEv=(v)=>{
      if(!v) return {__err:'empty'};
      if(typeof v==='object') return v.__err ? v : {done:!!v.done,confirm:!!v.confirm,
        hasConfirm:!!v.hasConfirm,hasDone:!!v.hasDone,__ok:true};
      try{ const o=JSON.parse(v); return {done:!!o.done,confirm:!!o.confirm,
        hasConfirm:!!o.hasConfirm,hasDone:!!o.hasDone,__ok:true}; }
      catch(e){ return {__err:'parse:'+String(v).slice(0,40)}; }
    };
    // ⚠ 表达式必须自带 try/catch：弹层切换时 document.body 会被短暂替换，
    //   直接读 innerText 会抛 Uncaught（历史 51 次 __err 全由此来）。
    //   兜底到 document.documentElement.innerText，再兜底空串。
    const panelProbe=`(()=>{try{
      var b=(document.body&&document.body.innerText)||'';
      if(!b && document.documentElement) b=document.documentElement.innerText||'';
      return JSON.stringify({
        done:/已加入粉丝团|粉丝团已加入|已是粉丝团|点亮成功/.test(b),
        confirm:/确认加入|立即加入|确认支付|抖币|钻石/.test(b),
        hasConfirm:/确认加入|立即加入|确认支付|抖币|钻石|礼物/.test(b),
        hasDone:/已加入粉丝团|粉丝团已加入|已是粉丝团/.test(b),
        raw:b.slice(0,120).replace(/\\n/g,'|')
      });
    }catch(e){ return JSON.stringify({__err:String(e.message).slice(0,60)}); }})()`;
    // 固定 sleep 3 秒就验证太早：轮询等弹层出现稳定信号（最多 8 秒）。
    let settle={};
    for(let i=0;i<8;i++){
      await sleep(1000);
      settle=parseEv(await ev(tab,panelProbe,10000));
      if(!settle.__err && (settle.done||settle.confirm||settle.hasConfirm)) break;
    }

    // 可能出现二次确认（礼物/付费弹窗）
    let needPay=parseEv(await ev(tab,panelProbe,12000));
    if(needPay.__err){ await sleep(2000);
      needPay=parseEv(await ev(tab,panelProbe,12000)); }
    log(`    弹窗状态: ${JSON.stringify(needPay)}`);

    // 尝试点确认/加入
    const cpos=await ev(tab,`(()=>{
      var want=['确认加入','立即加入','加入粉丝团','确认','确定'];
      var best=null;
      for(const el of document.querySelectorAll('div,span,button')){
        var t=(el.innerText||'').trim();
        if(want.indexOf(t)<0) continue;   // 必须 exact，防止点到包含「确认」二字的大容器
        var r=el.getBoundingClientRect();
        if(r.width>30 && r.height>16 && r.width<400){
          if(!best || want.indexOf(t)<want.indexOf((best.innerText||'').trim())) best=el;
        }
      }
      if(!best) return null;
      var rb=best.getBoundingClientRect();
      return JSON.stringify({x:Math.round(rb.x+rb.width/2), y:Math.round(rb.y+rb.height/2), txt:(best.innerText||'').trim()});
    })()`,12000);
    if(cpos){
      const c=JSON.parse(cpos);
      log(`    确认弹窗: 点击 ${c.txt}`);
      await clickXY(tab,c.x,c.y);
      await sleep(3500);
    }

    // 验证：与弹窗探针共用同一个带 try/catch 的表达式，杜绝 Uncaught。
    //    __err 时等 2 秒重试一次，并把「已加入」文案与「二次确认已出现」都记下来。
    let probe=parseEv(await ev(tab,panelProbe,12000));
    if(probe.__err){
      await sleep(2000);
      probe=parseEv(await ev(tab,panelProbe,12000));
      log(`    加入结果(重试): ${JSON.stringify(probe)}`);
    }else{
      log(`    加入结果: ${JSON.stringify(probe)}`);
    }
    // ⚠ 真加入判据不能只靠「已加入」文案：抖音加入成功后常把面板重渲染成
    //    「一键发评论参与福袋」，文案里根本没有「已加入」。hasJoinBtn 才是稳定信号。
    let ok=!!(probe.done||probe.hasDone);

    // 💰 19:17 千年(66186758468) 截图复盘：账号抖币余额为 0 时，抖音会弹
    //    「你的钻石余额不足，请充值 ¥6」扫码支付窗，加入粉丝团客观不可能。
    //    旧代码把这种和「验证没确认」混在一起，统一记 skip-fans 后直接放弃，
    //    看板显示「粉丝团跳过」，用户误以为是策略没放开。现在明确区分。
    let noCoins=false;
    try{
      const pay=await ev(tab,`(()=>{var b=document.body.innerText||'';
        return JSON.stringify({no:/钻石余额不足|余额不足|请充值|扫码支付|应付金额/.test(b)});})()`,10000);
      noCoins=!!(pay && !pay.__err && JSON.parse(pay).no);
    }catch(e){}
    if(noCoins) log('    ⚠️ 检测到「钻石余额不足/充值」弹窗：该账号无法加入粉丝团');

    if(!ok){ try{ await shot(tab,`h35-FANSFAIL-${Date.now()}.png`); }catch(e){} }   // 失败留证

    // 🔑 20:20 吕德华截图复盘：加入粉丝团其实成功了——面板条件变「已达成」、
    //    按钮变「一键发评论参与福袋」，但验证 evaluate 撞上面板重渲染返回 __err，
    //    代码就放弃了。教训：**验证失败 ≠ 加入失败**。
    //    修法：失败后再给面板 2 次机会重扫，找到参与按钮就带信号返回，调用方接手。
    let hasJoinBtn=false;
    if(!ok){
      for(let i=0;i<2;i++){
        await sleep(2500);
        const b=await pSearch(tab,'一键发评论参与福袋');
        if(b.cnt>0){
          log('    复扫发现参与按钮（粉丝团实际已加入），交回参与流程');
          hasJoinBtn=true; break;
        }
      }
    }

    // 🚪 验证没通过时，弹窗可能还挡着（充值窗 / 二次确认窗）。
    //    必须关掉再重扫一次面板，否则后面的福袋扫描和换房全被它遮住。
    if(!ok && !hasJoinBtn){
      try{
        const cp=await ev(tab,`(()=>{
          for(const el of document.querySelectorAll('div,span,button')){
            var t=(el.innerText||'').trim();
            if(t!=='×'&&t!=='关闭'&&t!=='取消'&&t!=='知道了'&&t!=='确定') continue;
            var r=el.getBoundingClientRect();
            if(r.width<10||r.height<10||r.width>120) continue;
            return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),t:t});
          }
          return null;
        })()`,10000);
        if(cp){ const c=JSON.parse(cp); await clickXY(tab,c.x,c.y); await sleep(1500);
                log(`    已关闭阻挡弹窗: ${c.t}`); }
      }catch(e){}
      // 关掉弹窗后最后再扫一次：有的房间加入动作其实已完成，只是被弹窗盖住了
      const b=await pSearch(tab,'一键发评论参与福袋');
      if(b.cnt>0){ log('    关弹窗后发现参与按钮，交回参与流程'); hasJoinBtn=true; }
    }

    // 💰 消费记录：用户已授权使用抖币加入粉丝团，每次真实加入都记 1 钻。
    //    ⚠ 2026-11-06 用户报告「钻石消耗记录失败，0 钻」后查实：
    //      旧判据只有 ok（验证读到「已加入」文案）才记账，但该验证表达式
    //      51 次抛 __err:Uncaught、仅 1 次成功；而 52 次加入尝试里 50 次
    //      实际加入成功（参与按钮就位并 joined），今日 16 条 fans-join:joinBtn
    //      记录全部 result=joined。结论：hasJoinBtn 才是「真加入并扣 1 钻」的
    //      可靠信号，ok 只是补充文案判据。旧逻辑把 49 次真实消费全漏记了。
    //    ⚠ noCoins（弹出充值窗）绝不记账：加入客观未发生、没扣钻。
    // ⚠ 2026-11-05 15:57 巡检发现旧写法取 CURRENT_ROOM（在 tryJoin 内部才定义，
    //    本函数作用域取不到）导致 room 恒为空。改为由调用点显式传入 roomArg。
    const room=roomArg||'';
    const reallyJoined=(ok||hasJoinBtn) && !noCoins;
    if(reallyJoined){
      try{
        fs.appendFileSync(DATA_DIR+'/coin-spend.jsonl', JSON.stringify({
          at:new Date().toISOString(), account:ACCOUNT_TAG, room,
          action:'join-fans-group', coins:1,
          note:ok?'加入粉丝团（文案已确认，消耗1抖币）':'加入粉丝团（参与按钮就位，消耗1抖币）'
        })+'\n');
        log(`    💰 已记录加入粉丝团消费: 1 抖币 (${ok?'verified':'joinBtn'})`);
      }catch(e){ log(`    ⚠️ 抖币消费记账失败: ${e.message}`); }
    }
    // 📊 执行能力真实记账：ok / hasJoinBtn 都算真加入（与消费同源），
    //    state 仍保留细粒度用于排查，但不再把 joinBtn 记成 ok=false。
    recExec('fans', reallyJoined, {
      room,
      state: ok ? 'verified' : (hasJoinBtn ? 'joinBtn' : (noCoins ? 'no-coins' : 'unverified'))
    });
    return {ok:reallyJoined, hasJoinBtn, noCoins, why: reallyJoined?'done':(noCoins?'no-coins':'unverified')};
  }catch(e){ return {ok:false, hasJoinBtn:false, noCoins:false, why:String(e.message).slice(0,30)}; }
}

async function tryJoin(tab,f,url,online){
  const out={url,online,cd:f.cd,cw:f.cw,result:null,steps:[]};
  const CURRENT_ROOM=url.split('/').pop();   // 供消费记录使用
  await shot(tab,`h35-${url.split('/').pop()}-${Date.now()}.png`);
  // pointer-events 修复：只修本次要点的那个图标，不再无条件取第一个 LMUtLyr9
  //    （同排有多个福袋时，旧写法修的是别人的 DOM）
  await ev(tab,`(()=>{var all=[...document.querySelectorAll('[class*="LMUtLyr9"]')];
    var el=all.find(function(e){var r=e.getBoundingClientRect();
      return Math.abs(r.x-${f.x})<6&&Math.abs(r.y-${f.y})<6;})||all[0];
    if(!el)return 0; var a=el;
    for(var i=0;i<10&&a;i++){if(getComputedStyle(a).pointerEvents==='none')a.style.pointerEvents='auto';a=a.parentElement;}
    el.style.pointerEvents='auto';return 1;})()`);
  await ensureDom(tab);

  const cy=f.y+Math.round(f.h/2), cx=f.x+Math.round(f.w/2);
  // 🔑 2026-11-06 10:22 用户纠正：福袋和人气红包在同一排、位置不固定。
  //    旧版有「左外扩 x-18」「左上 x-10,y-8」「下方 y+h+6」这三个越界点，
  //    图标靠左时会落到旁边那个 redpacket 红包位上，点开的是红包面板而不是福袋。
  //    现只保留图标矩形内部的点，绝不越界，靠「面板文案」而不是坐标区分福袋/红包。
  const positions = [
    {n:'图标中心',x:cx,         y:cy},
    {n:'图标左',  x:f.x+4,      y:cy},
    {n:'图标右',  x:f.x+f.w-4,  y:cy},
    {n:'图标上',  x:cx,         y:f.y+4},
    {n:'图标下',  x:cx,         y:f.y+f.h-4},
  ];

  let btn={cnt:0,ids:[]};
  for(const pos of positions){
    out.steps.push('try:'+pos.n);
    // hover 展开
    for(const s of [0.3,0.6,0.9,1.0]){
      await tab.cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:Math.round(f.x+f.w*s),y:cy});await sleep(180);
    }
    await sleep(600);
    const targetY=(typeof pos.y==='number')?pos.y:cy;
    await clickXY(tab,pos.x,targetY);
    await sleep(3000);
    btn=await pSearchJoin(tab);
    log(`  [${pos.n}] 搜按钮:${btn.cnt}${btn.via?'('+btn.via+')':''}`);
    if(btn.cnt===0){
      // 点击后没有面板，截一张（仅首次，避免每轮 6 张堆积）
      if(pos.n==='图标中心') await shot(tab,`h35-AFTER-${url.split('/').pop()}-${pos.n}-${Date.now()}.png`);
    }
    if(btn.cnt>0){
      out.steps.push('btn@'+pos.n);
      // 🧒 采集福袋面板文案（奖品/参与条件），看板「福袋内容」用。
      //    只在面板已打开时取一次，失败不影响参与。
      try{
        const pt=await ev(tab,`(()=>{var st=document.querySelector('[class*="ShortTouchContainer"]'); var t=st?(st.innerText||''):''; if(!t) t=document.body.innerText||''; return JSON.stringify(t.slice(0,200));})()`,10000);
        if(pt && !pt.__err){ try{ out.panelText=JSON.parse(pt); }catch(e){ out.panelText=String(pt).slice(0,200); } }
      }catch(e){}
      break;
    }

    // 🧧 人气红包（2026-11-06 10:22 用户纠正后重构，定稿「不抢人气红包」）
    //    用户原话：「红包和福袋是在一排的，福袋位置也不固定，重点是识别福袋，红包是不去抢的」。
    //    红包面板在 iframe 里，用 detectPacketPanel 走 CDP DOM 域双判据识别。
    //
    //    ⚠ 旧逻辑一识别到红包就 `return packet-skipped` 终止整轮，两个致命后果：
    //      1) 粉色全屏面板不关，同排后面的福袋图标全被挡住，再也点不开
    //      2) 主循环拿到 packet-skipped 就写 12 分钟长窗，真福袋被锁死
    //    现改为：**关面板 → 记一次 → continue 到下一个点击位置/下一个福袋候选**，
    //    只有「所有候选都只弹出红包、没有任何福袋面板」才由主循环记 packet-skipped。
    const pk=await detectPacketPanel(tab);
    if(pk.found){
      out.packetSeen=(out.packetSeen||0)+1;
      out.steps.push('packet@'+pos.n);
      out.packetDiag={hits:pk.hits,grab:pk.grab?{x:pk.grab.x,y:pk.grab.y,w:pk.grab.w,h:pk.grab.h}:null};
      // 每个候选只截一次红包留证，避免同排 6 个候选堆 6 张图
      if(out.packetSeen===1) await shot(tab,`h35-PACKET-${url.split('/').pop()}-${Date.now()}.png`);
      if(!PACKET_GRAB){
        out.steps.push('packet-skip:close-and-continue');
        const cl=await closePacketPanel(tab);
        out.steps.push('packet-close:'+cl.how+(cl.closed?'':'!'));
        log(`  🧧 人气红包面板已识别（${JSON.stringify(pk.hits)}），按配置不抢；关面板后继续找同排福袋`);
        continue;                       // 关键：不 return，继续试下一个点/下一个福袋
      }
      if(!pk.grab){
        out.steps.push('packet-grab:no-btn');
        log('  🧧 人气红包已识别但没定位到圆形「抢」按钮，关面板后继续找福袋');
        await closePacketPanel(tab);
        continue;
      }
      log(`    🧧 人气红包: 点击「抢」@${pk.grab.x},${pk.grab.y}（主视口绝对坐标）`);
      await clickXY(tab,pk.grab.x,pk.grab.y);
      await sleep(3500);
      const verify=await (async()=>{
        try{
          await tab.cdp.send('DOM.getDocument',{depth:-1,pierce:true},30000);
          const s=async(q)=>{const r=await tab.cdp.send('DOM.performSearch',{query:q,includeUserAgentShadowDOM:true},20000);
            if(r.resultCount)await tab.cdp.send('DOM.discardSearchResults',{searchId:r.searchId}).catch(()=>{});return r.resultCount;};
          return {packet:await s('人气红包'),done:await s('已抢')+await s('已领取')+await s('抢到了')};
        }catch(e){return {err:String(e.message).slice(0,40)};}
      })();
      out.packetVerify=verify;
      await closePacketPanel(tab);
      if(verify.done>0||(verify.packet===0)){
        out.steps.push('packet-grab:ok');
        out.result='joined';
        log('    🧧 人气红包抢成功');
        return out;
      }
      out.steps.push('packet-grab:unverified');
      continue;
    }

    // 🎯 2026-11-10：粉丝团入口改用多候选（含『点亮粉丝团』），修 no-panel 主因
    const fans=await pSearchFans(tab);
    const cond=await pSearch(tab,'参与条件');
    if(fans.cnt>0||cond.cnt>0){
      out.steps.push(`panel@${pos.n}:fans${fans.cnt}/cond${cond.cnt}`);
      // 🎯 2026-11-10 11:23：账号级「不抢粉丝团福袋」策略（用户定稿 main3）。
      //    该账号遇到粉丝团型福袋直接返回 fans-skip-account，不加入粉丝团、不消耗抖币、
      //    也不在面板上反复试探。主号不在白名单，仍按原逻辑加入粉丝团后参与。
      // 🕐 2026-11-10 11:41 增补：白天时段（非晚间）任何账号都不抢粉丝团福袋，
      //    只抢关注型与发弹幕型；晚间恢复原行为。两者为「或」关系。
      const _dayNoFans = DAY_SKIP_FANS && !isNightNow();
      // 🧒 2026-11-11 用户定稿：不抢要花抖币的粉丝团福袋，只抢关注型和发弹幕型。
      //    skipFansGroup=true 时不分白天晚间、不分账号，一律跳过粉丝团型。
      const _alwaysNoFans = loadCategoryFilter().skipFansGroup === true;
      if(fans.cnt>0 && (_skipFansAcc.includes(ACCOUNT_TAG) || _dayNoFans || _alwaysNoFans)){
        out.steps.push(_alwaysNoFans ? 'fans-skip-always' : (_dayNoFans ? 'fans-skip-daytime' : 'fans-skip-account'));
        out.result = _alwaysNoFans ? 'fans-skip-always' : (_dayNoFans ? 'fans-skip-daytime' : 'fans-skip-account');
        return out;
      }
      if(fans.cnt>0){
        // 🧧 2026-11-04 用户解除限制：「粉丝团福袋都可以抢」。
        //    原来是「5 万人在线以上才加入粉丝团」，现在取消人数门槛，
        //    任何房间的粉丝团型福袋都先尝试加入粉丝团、再参与。
        //    用户已授权使用抖币（加入粉丝团消耗 1 钻），每次加入记入 coin-spend.jsonl。
        out.steps.push(`fans-try(online=${online})`);
        const fj=await joinFansGroup(tab, CURRENT_ROOM);
        out.steps.push('fans-join:'+(fj.ok?'ok':(fj.hasJoinBtn?'joinBtn':'fail:'+fj.why)));
        // ok 或 hasJoinBtn 都继续：hasJoinBtn 表示「加入已成功、参与按钮已就位」，
        // 只是验证没来得及确认（20:20 吕德华 10 万人房间实测路径）。
        // 不论加入是否验证通过，都再找一次参与按钮（用户要求：粉丝团福袋必须尝试参与）。
        // 20:20 吕德华实测：验证 __err 但参与按钮其实已就位，直接放弃会白白错过。
        await sleep(2000);
        // 🔍 2026-11-10 15:19：粉丝团分支同样改用多候选文案搜索（与 cond-follow 一致）
        const b2=await pSearchJoin(tab);
        if(b2.cnt>0){ btn=b2; out.steps.push('fans-then-btn'+(b2.via?'('+b2.via+')':'')); break; }
        // 面板可能被弹窗顶掉：重新点一次福袋图标再扫
        try{
          await clickXY(tab, cx, cy); await sleep(2500);
          const b4=await pSearchJoin(tab);
          if(b4.cnt>0){ btn=b4; out.steps.push('fans-reopen-btn'+(b4.via?'('+b4.via+')':'')); break; }
        }catch(e){}
        out.steps.push(fj.noCoins?'fans-no-coins':'fans-joined-no-btn');
        // ❗ 不再叫 skip-fans：明确区分「账号没抖币」与「加入验证未确认」
        out.result = fj.noCoins ? 'fans-no-coins' : 'fans-unverified';
        return out;
      }
      // 🎯 有参与条件但不是粉丝团 → 大概率是「关注主播」型福袋
      // ⚠ 2026-11-05：抢前已在干净页面关注过（见主循环 pre-follow），此处面板已打开、
      //    全屏遮罩会挡住左上角关注按钮，ensureFollow 必然 no-btn。
      //    旧逻辑 fr.ok=false 就直接 return need-follow 放弃，今日 4 个福袋因此丢失。
      //    修法与粉丝团分支一致：验证失败 ≠ 参与失败，不论如何都重扫参与按钮。
      const room=url.split('/').pop();
      // 🔴 2026-11-10 17:49 用户批评参与率后，用 cond1 快照定位到真因：
      //    快照实证面板打开后「一键发评论参与福袋」按钮明明存在
      //    （@393,448 335x44 class=QOARtY3v），但代码走到 cond1 分支后搜不到。
      //    根因：cond1 分支先调 ensureFollow，而它会尝试点击关注按钮、可能把面板顶掉。
      //    改为「先搜按钮，搜不到才关注」——面板在的时候按钮就在，没必要先关注。
      const b0=await pSearchJoin(tab);
      if(b0.cnt>0){
        btn=b0;
        out.steps.push('cond-pre-btn'+(b0.via?'('+b0.via+')':''));
        break;
      }
      out.steps.push('cond-pre-miss:'+String((b0.tried||[]).length));
      const fr=await ensureFollow(tab, room);
      out.steps.push('cond-follow:'+(fr.ok?'ok('+fr.reason+')':'fail('+fr.reason+')'));
      await sleep(2500);
      // 🔍 2026-11-10 15:19：改用多候选文案搜索。原版只搜「一键发评论参与福袋」
      //    与「参与福袋」两个精确串，实测 33 次全部 0 命中而落到 no-panel；
      //    这里按 12 个候选依次尝试，命中即用，并记录实际命中文案到 steps 便于回溯。
      const b2=await pSearchJoin(tab);
      if(b2.cnt>0){btn=b2;out.steps.push('follow-then-btn'+(b2.via?'('+b2.via+')':''));break;}
      out.steps.push('join-scan-miss:'+String((b2.tried||[]).length));
      // 面板可能被关注动作顶掉：重开一次再扫（同样用多候选）
      try{
        await clickXY(tab, cx, cy); await sleep(2500);
        const b4=await pSearchJoin(tab);
        if(b4.cnt>0){btn=b4;out.steps.push('follow-reopen-btn'+(b4.via?'('+b4.via+')':''));break;}
      }catch(e){}
      if(!fr.ok && !fr.inconclusive){ out.result='need-follow'; return out; }
      break;
    }
  }

  out.btnSearch=btn.cnt;
  if(btn.cnt>0&&btn.ids.length){
    out.steps.push('FOUND-BTN');
    for(const nid of btn.ids){
      const pos=await getBox(tab,nid);
      if(!pos||!pos.cx){out.steps.push('box-null');continue;}
      out.steps.push(`click@${pos.cx},${pos.cy}(${pos.tag})`);
      await clickXY(tab,pos.cx,pos.cy);
      await sleep(3500);
      await shot(tab,`h35-JOINED-${url.split('/').pop()}-${Date.now()}.png`);
      // JS click 兜底
      const still=await pSearch(tab,'一键发评论参与福袋');
      if(still.cnt>0){
        out.steps.push('js-fallback');
        await ev(tab,`(()=>{var cd=[];for(const el of document.querySelectorAll('button,div,span,a')){
          var t=(el.innerText||'').trim(); if(!t||t.length>30)continue;
          if(!/一键发评论参与福袋|一键参与|立即参与/.test(t))continue;
          var r=el.getBoundingClientRect(); if(r.width<40||r.height<20)continue;
          cd.push({el,area:r.width*r.height});}
          if(!cd.length)return 0; cd.sort((a,b)=>a.area-b.area);
          cd[0].el.click();
          for(const ty of ['pointerdown','mousedown','pointerup','mouseup','click']){
            try{cd[0].el.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true}));}catch(e){}}
          return 1;})()`);
        await sleep(3500);
      }
      const joined=await pSearch(tab,'已参与');
      const still2=await pSearch(tab,'一键发评论参与福袋');
      out.joinedTxt=joined.cnt; out.stillBtn=still2.cnt;
      // 按钮消失后补查其它成功文案，提高「真的参与成功」的判定率
      let okHint=joined.cnt;
      if(okHint===0 && still2.cnt===0){
        for(const kw of ['参与成功','已成功参与','参与过']){
          const h=await pSearch(tab,kw);
          if(h.cnt>0){ okHint=h.cnt; out.steps.push('hint:'+kw); break; }
        }
      }
      if(still2.cnt===0&&okHint>0){out.result='joined';out.verified=true;}
      else if(still2.cnt===0){
        // 🔍 二次验证：按钮消失了但没找到成功文案（占历史 90%），
        //    重新点开福袋面板看服务端是否认为已参与。
        //    实测：面板若显示「已参与」或参与按钮不再出现，才算真的成功。
        let ok2=false;
        try{
          await sleep(1500);
          await clickXY(tab, f.x+Math.round(f.w/2), f.y+Math.round(f.h/2));
          await sleep(2800);
          const h2=await pSearch(tab,'已参与');
          const still3=await pSearch(tab,'一键发评论参与福袋');
          out.recheckJoined=h2.cnt; out.recheckStill=still3.cnt;
          if(h2.cnt>0){ out.steps.push('recheck:已参与'); ok2=true; }
          else if(still3.cnt===0){ out.steps.push('recheck:按钮消失'); ok2=true; }
          else { out.steps.push('recheck:按钮仍在'); ok2=false; }
        }catch(e){ out.steps.push('recheck:err'); }
        if(ok2){ out.result='joined'; out.verified=true; }
        else { out.result='maybe-joined'; }
      }
      else out.result='btn-still';
      return out;
    }
  }
  // 🎯 2026-11-10：兜底分支同样用多候选（含『点亮粉丝团』）
  const fans=await pSearchFans(tab);
  if(fans.cnt>0){
    // 🧒 skipFansGroup=true 时兜底分支也不加入粉丝团，直接跳过，不花抖币。
    if(loadCategoryFilter().skipFansGroup === true){ out.steps.push('fans-skip-always'); out.result='fans-skip-always'; return out; }
    // 2026-11-04 解除限制后：这里不再直接跳过，而是尝试加入粉丝团后再参与。
    // （正常路径在循环内已处理，走到这里说明面板没打开但页面有粉丝团入口）
    out.steps.push('fans-fallback');
    const fj=await joinFansGroup(tab, CURRENT_ROOM);
    out.steps.push('fans-fallback-join:'+(fj.ok?'ok':(fj.hasJoinBtn?'joinBtn':'fail:'+fj.why)));
    // 同样不直接放弃：给参与按钮最后一次机会，命中则落到下方统一点击流程
    await sleep(2000);
    const b2=await pSearch(tab,'一键发评论参与福袋');
    if(b2.cnt>0){ btn=b2; out.steps.push('fans-fallback-then-btn'); }
    else{
      const b3=await pSearch(tab,'参与福袋');
      if(b3.cnt>0){ btn=b3; out.steps.push('fans-fallback-then-any'); }
    }
    if(btn.cnt===0){
      out.result = fj.noCoins ? 'fans-no-coins' : 'fans-unverified';
      return out;
    }
  }
  // 🧧 所有点击位置都试完仍没找到「福袋面板」：
  //    若这一轮至少弹过一次人气红包面板，说明这个候选其实是红包位（或红包遮罩挡住了），
  //    返回 packet-only 让主循环继续试同排下一个 LMUtLyr9，而不是立刻写 12 分钟长窗。
  //    只有全部候选都 packet-only / no-panel 时，主循环才统一收敛为 packet-skipped。
  if(out.packetSeen>0 && btn.cnt===0){
    out.result='packet-only';
    out.steps.push('packet-only:try-next-candidate');
    return out;
  }
  out.result='no-panel';
  // 🔍 诊断：记录页面当时的状态，便于分析为什么点不开面板
  try{
    const diag=await ev(tab,`(()=>{
      var b=document.body.innerText||'';
      var cands=document.querySelectorAll('[class*="LMUtLyr9"]').length;
      var st=document.querySelector('[class*="ShortTouchContainer"]');
      return JSON.stringify({
        len:b.length, cands:cands,
        hasShortTouch:!!st,
        shortTouchText: st?(st.innerText||'').slice(0,60):'',
        bodyHasFudai: b.indexOf('福袋')>=0,
        bodyHasJoin: b.indexOf('参与')>=0,
        bodyHasFans: b.indexOf('粉丝团')>=0,
        title:document.title.slice(0,40)
      });
    })()`,20000);
    out.diag=diag;
    log('  🔍 no-panel 诊断:', diag);
  }catch(e){}
  return out;
}

const EXTRACT_ROOMS=`(()=>{
        function parseOnline(txt){
          var parts=txt.split('|').map(s=>s.trim()).filter(Boolean);
          if(!parts.length)return -1;
          // ⚠ 两个来源的字段顺序不同：
          //   首页    → 标题|@主播名|在线数      （在线数在最后）
          //   分类页  → 在线数|标题|主播名        （在线数在最前）
          // 所以从后往前逐个尝试，不能只取最后一个。
          for(var i=parts.length-1;i>=0;i--){
            var m=parts[i].match(/^([\\d.]+)\\s*(万|亿)?\\+?$/);
            if(m){
              var n=parseFloat(m[1]);
              if(m[2]==='万')n*=10000;
              else if(m[2]==='亿')n*=100000000;
              return Math.round(n);
            }
          }
          return -1;
        }
        var out=[], seen=new Set();
        for(const a of document.querySelectorAll('a[href*="live.douyin.com/"]')){
          var h=a.href.split('?')[0];
          if(!/live\\.douyin\\.com\\/\\d{6,}/.test(h))continue;
          var id=h.split('/').pop();
          if(seen.has(id))continue;
          seen.add(id);
          var card=a, txt='';
          for(var k=0;k<6&&card.parentElement;k++){
            card=card.parentElement;
            var t=(card.innerText||'').replace(/\\n/g,'|');
            if(t.length>8){ txt=t; break; }
          }
          // 提取主播名（@后面的部分）
          var host='';
          var hm=txt.match(/@([^|]+)/);
          if(hm) host=hm[1].trim();
          var title='';
          for(const part of txt.split('|').map(x=>x.trim()).filter(Boolean)){
            if(/^@/.test(part)) continue;
            if(/^[\d.]+\s*(万|亿)?\+?$/.test(part)) continue;
            if(part===host) continue;
            title=part; break;
          }
          out.push({id, online:parseOnline(txt), host, title});
        }
        return out;
      })()`;   // 从直播列表页解析：房间ID / 在线数 / 主播名

/**
 * 检测式等待：轮询页面是否已经渲染出房间卡片，出现就立刻返回。
 * 替代原来固定的 sleep(12000)——实测多数情况 6-8 秒就有内容，
 * 固定等 12 秒等于每轮白等 4-6 秒。
 */
async function waitRoomsLoaded(t, maxMs){
  const t0=Date.now();
  let lastN=0, stableCount=0;
  while(Date.now()-t0 < maxMs){
    const n=await ev(t,`document.querySelectorAll('a[href*="live.douyin.com/"]').length`,5000);
    if(typeof n==='number'){
      // 阈值提到 20 个，并且要求连续两次数量稳定（说明首屏渲染完），
      // 否则会过早返回导致采集不充分（实测游戏分类少采 20 个）
      if(n>=20 && n===lastN){ stableCount++; if(stableCount>=2) return Date.now()-t0; }
      else if(n>=20){ stableCount=1; }
      lastN=n;
    }
    await sleep(700);
  }
  return maxMs;
}

/** 关闭并重建一个标签页，用于修复「标签级卡死」（加载直播间永远是 len=20） */
async function recreateTab(oldTab){
  try{ await oldTab.cdp.send('Page.close',{},5000).catch(()=>{}); }catch(e){}
  try{
    const nr=await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`,{method:'PUT'});
    const pg=await nr.json();
    const c=await conn(pg.webSocketDebuggerUrl);
    await c.send('Page.enable'); await c.send('Runtime.enable');
    return {cdp:c};
  }catch(e){ return null; }
}

async function collectRooms(tab, extra, roundNo){
  // 🎯 双源采集：首页推荐流上限 20 个，游戏分类页实测可再拿 30 个，
  //    且游戏类主播发福袋的概率明显高于带货类
  // 🚀 并行：两个来源各用一个标签同时滚动，实测耗时从 ~30 秒降到 ~15 秒
  const map = new Map();
  const grab = async (t, url, maxRounds, label) => {
    try{
      await t.cdp.send('Page.navigate',{url},20000);
      const waited=await waitRoomsLoaded(t, 14000);   // 多数 6-8 秒就绪，最多等 14 秒
      if(waited>=14000) log(label+' 加载偏慢，已等待上限');
      let noNew=0;
      for(let idx=0;idx<maxRounds;idx++){
        const r=await ev(t,EXTRACT_ROOMS,25000);
        let added=0;
        if(Array.isArray(r)){
          for(const x of r){
            if(!map.has(x.id)){ map.set(x.id,{online:x.online, host:x.host||'', title:x.title||''}); added++; }
          }
        }
        if(added===0){ noNew++; if(noNew>=3) break; } else noNew=0;
        await ev(t,'window.scrollBy(0,1600)');
        // 动态等待：本屏有新内容说明滚动有效，短等即可；无新内容多等一会，
        // 避免在加载慢时连续空转。实测一轮 20 次滚动可省 5-6 秒。
        await sleep(added>0 ? 700 : 1100);
      }
      log(label+' 完成后累计 '+map.size+' 个');
    }catch(e){ log(label+' 采集失败:', String(e.message).slice(0,40)); }
  };
  // 🚀 多源并行采集：首页 + 游戏 + 音乐 + 舞蹈，覆盖从 50 个房间扩到 100+ 个。
  //    实测四个分类页都能解析在线数（各 30 个），且并行耗时与单源接近。
  // ⚠ 4 源并行（+音乐/舞蹈）实测会触发抖音限流：接着加载直播间页面直接空白 len=20。
  //    回退到 2 源，音乐和舞蹈改为「按轮次轮换」，既不并发又能覆盖到。
  // 四个分类轮流采集（游戏/音乐/舞蹈/生活），每轮换一个：
  // 不并发所以不会触发标签卡死，但几轮下来所有分类都能覆盖到
  const cats=[
    {id:'4_103', name:'游戏分类'},
    {id:'4_102', name:'音乐分类'},
    {id:'4_103', name:'游戏分类'},   // 游戏加权：用户指定的 6 个常发福袋主播全是游戏类
    {id:'4_105', name:'舞蹈分类'},   //   （金铲铲/三角洲/DNF），实测游戏房福袋密度最高
    {id:'4_107', name:'生活分类'},
    {id:'4_103', name:'游戏分类'},
  ];
  const ci = (typeof roundNo==='number' ? roundNo : 0) % cats.length;
  const catIdx = cats[ci].id;
  const catLabel = cats[ci].name;
  // 🛡 稳定优先：单标签串行采集。
  //    多标签并行会让 Chrome 渲染进程卡死（采集 timeout、直播间永远 len=20），
  //    重启后很快复现。先保证稳定，性能让位于可用性。
  await grab(tab, 'https://live.douyin.com/', 20, '首页');
  await grab(tab, `https://live.douyin.com/categorynew/${catIdx}`, 12, catLabel);
  const list=[];
  for(const [room,info] of map.entries()) list.push({room, online:info.online, host:info.host||'', title:info.title||''});
  // 把采集到的主播昵称记进映射表，供日志/看板/报表显示
  for(const r of list) if(r.host) saveName(r.room, r.host);
  await flushNames();
  log('合计采集', list.length, '个直播间（含在线数）');
  // 🧒 婴童过滤（采集口）：只留标题/主播名含关键词的房间
  let _filtered=list;
  if(isCategoryFilterOn()){
    const _cf=loadCategoryFilter();
    _filtered=list.filter(r=>matchesCategory(r.host, r.title));
    log('🧒 婴童过滤：' + list.length + ' → ' + _filtered.length + ' 间（关键词：' + _cf.keywords.join('、') + '）');
  }

  // 🧊 采集后冷却：连续导航多个页面后，紧接着加载直播间会卡在「直播加载中」，
  //    页面 innerText 只有 20 字（实测连续 8 次失败）。等 20 秒让抖音缓过来。
  //    手动验证：单独导航同一个房间 16 秒后能正常加载（len=668）。
  await sleep(20000);
  return _filtered;
}

// ⚠ 等待 24 秒（原 16 秒）：实测 22 点主力房 660292215268 在 16 秒时页面还没渲染完，
//   返回 null 后被判「未在播」冷却 30 分钟，正好错过它 22 点发福袋最密集的时段。
async function checkOnline(tab,room){
  try{
    await tab.cdp.send('Page.navigate',{url:`https://live.douyin.com/${room}`},20000);
  }catch(e){}
  for(let k=0;k<12;k++){
    await sleep(2000);
    const d=await ev(tab,SCAN,20000);
    if(d && !d.__err && d.len>150 && !d.loading) return d;
  }
  return null;
}

// 启动 Chrome
// ⚠ 2026-11-05 08:04 实测：首版带来的 '--enable-unsafe-swiftshader --use-angle=swiftshader'
//    在 headless=new 下让 GPU 进程用 CPU 软件光栅化，两个实例各持续吃 260~377% CPU，
//    load 冲到 13.3、空闲内存掉到 36MB。降载 CSS 只停页面动画，停不了 SwiftShader 合成循环。
//    受控对照（同一 Chrome、同一分类页，页面均正常渲染 31/32 张房间卡片）：
//      swiftshader 512% CPU ／ --disable-gpu 19% CPU ／ 默认无参数 33% CPU。
//    故改用 --disable-gpu：渲染与 DOM 检测能力无损，福袋识别靠 DOM 而非像素。
try{fs.rmSync(PROFILE+'/SingletonLock',{force:true});}catch(e){}
// ⚠ 2026-11-09 18:15 决定性对照：DSH 会话被 macOS seatbelt 限制后（同时表现为
//    /bin/ps 报 Operation not permitted、node 被换成别的版本），Chrome 自带沙箱无法初始化：
//    stderr "sandbox initialization failed: Operation not permitted" + 主进程 SIGTRAP，
//    渲染器全挂 → 页面操作 20s 超时 → hunter35 每约 25s 一次 "FATAL timeout" 无限重启，
//    双实例与看板全停。对照：加 --no-sandbox 后 CDP 2s 就绪、抖音分类页
//    len=1918 / cards=120 / needLogin=false 稳定渲染。故默认带 --no-sandbox
//    （headless 自动化浏览器通用做法，只访问抖音、不涉及账号门禁）；会话恢复正常且
//    需要强隔离时设 DY_CHROME_NO_SANDBOX=0 关闭。
const CHROME_ARGS=['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,
 '--no-first-run','--no-default-browser-check','--disable-gpu',
 '--disable-dev-shm-usage','--window-size=1440,900','--mute-audio','--disable-blink-features=AutomationControlled',
 `--user-agent=${UA}`,'--lang=zh-CN','about:blank'];
if(process.env.DY_CHROME_NO_SANDBOX!=='0') CHROME_ARGS.push('--no-sandbox');
const chrome=spawn(CHROME,CHROME_ARGS,{stdio:'ignore'});

(async()=>{
  try{
    let portOk=false;
    for(let i=0;i<120;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok){portOk=true;break;}}catch{}await sleep(500);}
    if(!portOk){ log('Chrome CDP 未就绪'); process.exit(1); }
    log(`=== hunter35 常驻高人气直播间${ACCOUNT?' ['+ACCOUNT+']':''} | 每批${ROOMS_PER_BATCH}房×${BATCH_MIN}分钟 ===`);
    const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for(const t of l.filter(x=>x.type==='page')){try{await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);}catch(e){}}
    const nr=await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`,{method:'PUT'});
    const pg=await nr.json();
    const cdp=await conn(pg.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    let tab={cdp};   // 允许重建（标签级卡死时自动换新）

    // 🧹 单标签模式：不再创建额外采集标签。
    //    多标签会让 Chrome 渲染进程更易卡死（实测），且标签本身会占 200MB+ 内存。
    const extra=[];

    // 轮次跨进程累计：每轮写回文件，重启后接着数，便于长期统计「跑了多少轮」
    const ROUND_FILE=W+'/round-counter.txt';
    let round=0;
    try{ round=Number(fs.readFileSync(ROUND_FILE,'utf8'))||0; }catch(e){ round=0; }
    const START_TS=Date.now();
    let blankFail=0;     // 标签连续空白次数（用于触发标签重建）
    let emptyRounds=0;   // 连续「没有达标房间」的轮数，用于退避，避免晚上门槛升高后高频采集
    while(true){
      // ⏰ 长跑内存回收：Chrome 系进程实测刚启动就占 1.9G，连跑多天会持续累积。
      //    每 8 小时主动退出一次，由 run-h35.sh 的 while 循环重新拉起（中断约 20 秒）。
      // 改为 6 小时：双源采集每轮多加载一个页面，Chrome 内存增长更快
      if(Date.now()-START_TS > 6*3600*1000){
        log('⏰ 已连续运行 6 小时，主动退出以释放 Chrome 内存');
        break;
      }
      round++;
      try{ fs.writeFileSync(ROUND_FILE, String(round)); }catch(e){}
      log(`\n--- 第 ${round} 轮：采集高人气直播间 ---`);
      const rooms=await collectRooms(tab, extra, round);
      log('采集到', rooms.length, '个候选');
      // 🧒 看板：采集到的房间全部记进 live 表（监控过的房间）
      for(const r of rooms) upsertLiveRoom(r.room, {host:r.host||'', title:r.title||'', online:r.online, status:'monitoring'});
      writeLiveState(true);

      // 🎯 VIP 房间无条件优先（即使不在首页采集中）
      const VIP_FILE=ROOT+'/scripts/known-fudai-hosts.txt';
      let vip=[];
      try{ vip=fs.readFileSync(VIP_FILE,'utf8').trim().split('\n').filter(Boolean); }catch(e){}
      // 🚫 读取黑名单（粉丝团型为主的房间）
      let blacklist=[];
      try{ blacklist=fs.readFileSync(ROOT+'/scripts/blacklist-rooms.txt','utf8').trim().split('\n').filter(Boolean); }catch(e){}
      // 🚫 2026-11-11 09:42 并入自动黑名单（访问够多却零福袋的房间）。
      //    每次重读是为了让新学出来的黑名单立即生效，不必重启进程。
      loadLearnTables();
      if(AUTO_BLACK.size){
        const _before=blacklist.length;
        blacklist=[...new Set([...blacklist, ...AUTO_BLACK])];
        if(blacklist.length>_before) log(`  🚫 自动黑名单并入 ${AUTO_BLACK.size} 个（合计 ${blacklist.length}）`);
      }
      const ordered=[...vip.filter(v=>!blacklist.includes(v)), ...rooms.filter(r=>!vip.includes(r)&&!blacklist.includes(r))];
      if(blacklist.length) log('黑名单房间:', blacklist.length, '个');
      if(vip.length) log('VIP房间优先:', vip.length, '个');
      let consecutiveFail=0;
      const good=[];
      const minOnline=getMinOnline();
      log(`当前门槛: ${minOnline} 人（${isNightNow()?'晚间':'白天'}）`);

      // 🎯 直接用首页在线数筛选（不打开未验证的房间，彻底避免限流）
      const roomOnline=new Map();
      for(const r of rooms) roomOnline.set(r.room, r.online);

      // VIP 中只在首页列表出现的才算活跃 VIP（已下播的房间不硬探测）
      const aliveVip=vip.filter(v=>roomOnline.has(v));
      const deadVip=vip.filter(v=>!roomOnline.has(v));
      if(deadVip.length) log('VIP不在首页(暂跳过):', deadVip.length, '个');
      if(aliveVip.length) log('VIP活跃:', aliveVip.join(' '));

      // 🔍 主动探测高频 VIP 房：历史数据显示 92% 的成功参与集中在少数几间房，
      //    而它们常年不在首页推荐流里。不主动探就永远碰不到。
      //    限流保护：每轮最多探 2 个，探不到就冷却 30 分钟不再打扰。
      // 🔗 2026-11-10：探测冷却改为共享（两号互不重复探同一房），可回退见 SHARED_PROBE
      const COOLDOWN_FILE = SHARED_PROBE ? SHARED_VIP_COOLDOWN : (W+'/vip-cooldown.json');
      // 🧬 自主进化：记录每个 VIP 房探测失败次数，失败多的排到后面，
      //    避免已失效的直播间（如 354892492946）每轮都占用一个探测名额
      const FAIL_FILE=W+'/vip-fail-count.json';
      let failCount={};
      try{ failCount=JSON.parse(fs.readFileSync(FAIL_FILE,'utf8'))||{}; }catch(e){}
      let cooldown={};
      try{ cooldown=JSON.parse(fs.readFileSync(COOLDOWN_FILE,'utf8'))||{}; if(typeof cooldown!=='object'||Array.isArray(cooldown)) cooldown={}; }catch(e){}
      const nowTs=Date.now();
      // 晚上候选房少（达标房间可能只剩 3-5 个），VIP 房重新开播的价值更高，
      // 所以晚间把冷却从 30 分钟缩到 15 分钟，更快发现高价值房间回来
      const coolMs = 30*60*1000; // 🧒 不分白天晚间：探测冷却统一 30 分钟
      // 🎯 探测优先级改为「最近真的发过福袋」优先（2026-11-02 数据驱动）：
      //    数字房间号是「某一场直播」的唯一 ID，主播下播后该房间永久失效，探测只会
      //    持续返回 null（实测 660292215268 连续失败 9 次，再 6 次就会被自动淘汰出池）。
      //    而 354892492946 最近 16 小时前、660292215268 23 小时前都真的发过福袋 → 值得探；
      //    16015225873 已 69 小时没动静，探它等于白占每轮仅有的 3 个名额。
      let probeAnchors={};
      try{ probeAnchors=JSON.parse(fs.readFileSync(ANCHORS_FILE,'utf8'))||{}; }catch(e){ probeAnchors={}; }
      const lastFudaiTs=(v)=>{
        const a=probeAnchors[v];
        if(!a||!a.lastFudaiAt) return 0;
        const t=new Date(a.lastFudaiAt).getTime();
        return isNaN(t)?0:t;
      };
      // 📌 用户亲自指定的常发福袋主播 + 开播时间表（来源：关注主播名单.md）。
      //    这些房间因为「系统还没在里面抓到过福袋」而 lastFudaiAt 为空，
      //    若只按最近发袋排序会永远排在队尾，而每轮只探 3 个 → 永远轮不到，
      //    等于把用户最想要盯的主播彻底排除。故单独给它们最高优先级。
      // 🔑 2026-11-03 重构：把「用户指定主播」拆成两种，区别对待
      //
      //   tier='pinned'：用户明确说「完全可以常驻」。只在开播时段内探测与常驻，
      //                  开播时段内保留最高优先级（不被历史空手惩罚压下去）。
      //   tier='follow'：全天都在播、但实测长期零产出——琦儿 374806133859 一天被
      //                  常驻 25 次 × 480 秒 = 3 小时 20 分，发现福袋 0 个。
      //                  这类按 effScore 的产出说话，只保留成本很低的探测。
      //
      // 用户原话：「这几个主播完全可以常驻，但是不要 24 小时探测，在开播时间探测，
      // 探测一段时间都没开播那就当当他今天没有开播就不要去探测他了」。
      const PIN_MAX_PROBE=5;   // 开播时段内最多探 5 次（配合 30 分钟冷却 ≈ 2.5 小时覆盖）
      // 📌 用户指定主播名单的来源：data/pinned-hosts.json（单一数据源）
      //    ⚠ 2026-11-03 教训：这份名单原来在 hunter35.mjs 和 web/server.mjs 各硬编码一份，
      //    拉黑琦儿时只改了抓取侧，看板上她还在「指定主播」卡片里显示——用户直接质问
      //    「为什么这个还在」。凡是同一份配置在两个地方维护，就一定会不同步。
      let USER_PINNED={};
      try{
        USER_PINNED=JSON.parse(fs.readFileSync(DATA_DIR+'/pinned-hosts.json','utf8'))||{};
      }catch(e){ USER_PINNED={}; }
      if(!Object.keys(USER_PINNED).length){
        log('⚠️ data/pinned-hosts.json 读取失败或为空，本轮不盯任何指定主播');
      }
      const curH=new Date().getHours();
      // 探测窗口 = 开播小时 + 往后一小时（2026-11-03 用户明确要求）
      //
      // 原实现是 `curH || curH+1`，即「开播前一小时就开探」，理由是提前蹲守别错过。
      // 用户要求改成往后推：主播既然给了开播时间，就该按这个时间点去探，
      // 提前那一小时探到的必然是「未开播」，纯浪费配额。
      //
      // 新窗口举例（dehua66888 开播 20 点）：
      //   19 点 → 不探（提前一小时不再探）
      //   20 点 → 探（开播小时）
      //   21 点 → 探（往后一小时，覆盖主播晚开播/正在播）
      //   22 点 → 不探
      //
      // 跨天处理：xiaoqingrou3 的 0 点 → 窗口是 0 点和 1 点；keyis153 的 23 点
      // → 窗口是 23 点和次日 0 点，用 (curH-1+24)%24 计算上一小时。
      const dueNow=(v)=>{ const e=USER_PINNED[v]; if(!e) return 0;
                          const hrs=e.hours||[];
                          return (hrs.includes(curH)||hrs.includes((curH-1+24)%24))?1:0; };
      // 📅 当天探测账本：开播时段内探了几次、有没有见到开播。
      //    没有它，「今天压根没播」的主播会被 24 小时轮着探（每次 5-24 秒），
      //    一天上百次纯浪费——这些时间本该用来盯真正在发福袋的房间。
      //    落盘保存，进程重启后不丢账。
      // 🔗 2026-11-10：当日探测账本改为共享（两号合并计数，避免重复探测同一房）
      const PROBE_TODAY_FILE = SHARED_PROBE ? SHARED_PROBE_TODAY : (W+'/probe-today.json');
      let probeToday={date:'',rooms:{}};
      try{ probeToday=JSON.parse(fs.readFileSync(PROBE_TODAY_FILE,'utf8'))||{}; }catch(e){ probeToday={date:'',rooms:{}}; }
      const _todayStr=localDay();
      if(probeToday.date!==_todayStr) probeToday={date:_todayStr, rooms:{}};
      if(!probeToday.rooms) probeToday.rooms={};
      const pRec=(room)=>{ if(!probeToday.rooms[room]) probeToday.rooms[room]={n:0,ok:false};
                           return probeToday.rooms[room]; };
      // 🔗 共享模式下必须加锁合并写：两个实例同时跑，直接 writeFileSync 会互相覆盖。
      //    非共享模式（SHARED_PROBE=false）保持原样，零回归。
      const saveProbeToday=()=>{
        try{
          if(!SHARED_PROBE){ fs.writeFileSync(PROBE_TODAY_FILE, JSON.stringify(probeToday)); return; }
          const cur=readSharedJson(PROBE_TODAY_FILE,{date:'',rooms:{}})||{};
          if(cur.date===probeToday.date){
            Object.assign(cur.rooms||{}, probeToday.rooms||{});
            fs.writeFileSync(PROBE_TODAY_FILE+'.merge', JSON.stringify(cur));
          }else{
            fs.writeFileSync(PROBE_TODAY_FILE+'.merge', JSON.stringify(probeToday));
          }
          fs.renameSync(PROBE_TODAY_FILE+'.merge', PROBE_TODAY_FILE);
        }catch(e){}
      };
      // ⚠ 关键：候选必须来自 USER_PINNED 全集，不能从 deadVip 过滤。
      //    deadVip 只含 known-fudai-hosts.txt 里的房间，那些不在该文件里的指定主播
      //    会被整轮跳过（2026-11-02 实测某主播当天被探测 0 次）。
      const pinnedNow=Object.keys(USER_PINNED).filter(v=>{
        if(blacklist.includes(v)) return false;
        // 🕐 「未开播时就不去探测」：有历史时段画像且当前小时不在窗口内 → 跳过。
        //    ⚠ 只在探测阶段过滤，不拉黑——换个时段它还会被探到。
        if(!inHourWindow(v)) return false;
        if((nowTs-(cooldown[v]||0))<=coolMs) return false;
        const e=USER_PINNED[v];
        // 常驻型只在开播时段探测：时段外他大概率没开播，探了也是白探
        if(e.tier==='pinned' && !dueNow(v)) return false;
        // 当天已探满 PIN_MAX_PROBE 次且一次都没见到开播 → 当今天没播，不再打扰
        const r=pRec(v);
        if(e.tier==='pinned' && !r.ok && r.n>=PIN_MAX_PROBE) return false;
        return true;
      });
      const otherNow =deadVip.filter(v=>!(v in USER_PINNED) && !blacklist.includes(v) && (nowTs-(cooldown[v]||0))>coolMs);
      // 排序：正在开播时段的用户指定主播 → 其他用户指定主播 → 最近真发过福袋的
      pinnedNow.sort((a,b)=> dueNow(b)-dueNow(a) || lastFudaiTs(b)-lastFudaiTs(a));
      // 🔑 综合排序：只看「最近发袋时间」会让金矿被埋没——
      //    359765653648 今天 11:03 发过 1 次，354892492946 今天 06:33 发过但历史共 45 次
      //    且 45 次全部可抢。纯按时间排，前者永远压后者一头，而后者价值高一个数量级。
      //    改为：30 小时内有动静的先入选，组内按「历史可抢次数」×10 加权，再减去已过小时数。
      // 🔑 综合排序（2026-11-03 凌晨补强）：
      //    只看「最近发袋时间」会误杀「特定时段活跃」的房间——实测 16015225873 在 1 点
      //    历史发过 7 次，只因最近 70 小时没出现就被判 -1 永久沉底，而凌晨本就房间稀缺。
      //    改为叠加「当前小时历史发袋次数」权重：时段契合度比「最近有没有出现」更可靠。
      const curHourNow=new Date().getHours();
      const probeScoreOf=(v)=>{
        const a=probeAnchors[v]||{};
        const j=a.joinable||0;
        const hourCnt=(a.hourly||{})[curHourNow]||0;
        const t=lastFudaiTs(v);
        const ageH=t?(Date.now()-t)/3600000:9999;
        // 当前小时发过 >=4 次 → 强信号；>=2 次 → 弱信号
        const hourBoost = hourCnt>=4 ? 800 : (hourCnt>=2 ? 400 : 0);
        // 久未出现(>72h)但时段契合的房间仍给机会，否则才彻底沉底
        if(ageH>72) return hourBoost>0 ? hourBoost-50 : -1;
        return (ageH<30?1000:0) + hourBoost + j*10 - ageH;
      };
      otherNow.sort((a,b)=> probeScoreOf(b)-probeScoreOf(a));
      // 名额分配：2 个给用户指定（保证到点的主播必被探），1 个给历史高价值房
      // 名额分配：2 个给用户指定主播，2 个给历史高价值房。
      // ⚠ 原本 otherNow 只给 1 个，实测被 359765653648 长期占死——它反复技术失败、
      //    3 分钟后按 lastFudai 又排第一，导致金矿 354892492946（45 次全可抢）
      //    从 22:29 到 23:16 一次都没被探测到。故给 2 个名额。
      // 每轮 5 个：2 个用户指定 + 3 个历史房。
      // 凌晨时段达标房间只有 14 个左右、VIP 房更是稀缺，多探 1 个的代价（约 24 秒）
      // 远小于错过一个正在发福袋的房间。白天房间多时 pinnedNow 用不满 2 个也无妨。
      // ⚖️ 2026-11-10 11:32 用户定稿「把资源重点倾向于主号」：
      //    主号能关注、能加粉丝团，是真正能把福袋变成收益的号；
      //    main3 已设为免关注 + 不抢粉丝团，遇到关注型/粉丝团型福袋只能跳过。
      //    因此探测名额按账号差异化：主号多探（默认 2+3=5），受限账号少探，
      //    把探测时间让给主号常驻更多房间。配置见 wait-config.json 的 probeQuota。
      const _pq = (_WAIT && _WAIT.probeQuota) || {};
      const _q  = (_pq[ACCOUNT_TAG] && typeof _pq[ACCOUNT_TAG]==='object') ? _pq[ACCOUNT_TAG] : {pinned:2,other:3};
      const _qPin = Math.max(0, Math.min(5, Number(_q.pinned)||0));
      const _qOth = Math.max(0, Math.min(6, Number(_q.other)||0));
      let probeList=[...pinnedNow.slice(0,_qPin), ...otherNow.slice(0,_qOth)];
      // 🧒 婴童过滤（探测口）：指定主播按名字过滤，非婴童指定主播不探。
      //    历史 VIP 房名字未知，探测时先放行，入池时再按主播名/标题过滤（见 pool 段）。
      if(isCategoryFilterOn()){
        const _bp=probeList.length;
        probeList=probeList.filter(v=>{
          const nm=USER_PINNED[v] ? (USER_PINNED[v].name||'') : (NAMES[v]||'');
          if(!nm) return true;
          return matchesCategory(nm,'');
        });
        if(probeList.length!==_bp) log('🧒 婴童过滤：探测名单 ' + _bp + ' → ' + probeList.length + ' 间（非婴童指定主播已跳过）');
      }
      if(pinnedNow.length) log(`📌 指定主播待探 ${pinnedNow.length} 个（当前 ${curH} 点，按时段优先）`);
      for(const v of probeList){
        log(`🔍 主动探测 VIP 房 ${v}`);
        const d=await checkOnline(tab,v);
        // 判定在播：能解析到在线人数就是活房间，比页面长度更可靠
        // 之前只看 len>400，实测 416921329528 在播 online=3465 但 len 只有 358，被误判
        // 🚩 未开播的主页也可能 len>400（抖音号形式的直播间必须用 notLive 排除）
        const live=d && !d.__err && !d.exited && !d.loading && !d.notLive &&
                   ((d.len||0)>400 || (d.candCount||0)>0 || (typeof d.online==='number' && d.online>=0));
        if(live){
          const ol=(typeof d.online==='number')?d.online:-1;
          roomOnline.set(v,ol);
          aliveVip.push(v);
          delete cooldown[v];
          if(failCount[v]){ delete failCount[v]; try{ fs.writeFileSync(FAIL_FILE, JSON.stringify(failCount)); }catch(e){} }   // 探到了就清零，说明它恢复了
          // VIP 房不在首页列表里，拿不到主播名，从页面标题提取
          if(!NAMES[v] && d.title){
            const t=String(d.title).replace(/的抖音直播间.*$/,'').replace(/ - 抖音直播.*$/,'').trim();
            if(t && t.length<=24 && !/^抖音/.test(t)){ saveName(v,t); await flushNames(); }
          }
          log(`  ✅ 在播，在线 ${ol}`);
          pRec(v).ok=true;   // 今天见到了开播，不再受「探 3 次就放弃」的限制
          saveProbeToday();
        }else{
          // 🚩 区分「真下播」与「探测失败」（2026-11-02 实测踩坑）：
          //    len=537 + notLive → 拿到主播主页 → 真未开播，正常冷却
          //    d===null / __err / loading → 页面没渲染出来 → 技术失败，不等于下播
          //    实测 22 点主力房 660292215268（历史 22 点发过 21 次福袋）探测返回 null，
          //    被误判未在播而冷却 30 分钟，正好错过它发福袋最密集的时段。
          //    技术失败只等 3 分钟重试，且不计入失败次数（否则会被自动淘汰误杀）。
          const techFail = !d || !!d.__err || !!d.loading;
          if(techFail){
            // 8 分钟而非 3 分钟：实测 359765653648 连续技术失败，3 分钟太短，
            // 它会反复抢占探测名额，把真正在播的房间挤掉。
            cooldown[v]=nowTs-coolMs+8*60*1000;   // 8 分钟后即可重探
            log(`  ⚠️ 探测失败（${d?(d.__err||"loading"):"null"}，非下播），8 分钟后重试`);
            try{ if(SHARED_PROBE){ const _c=readSharedJson(COOLDOWN_FILE,{})||{}; Object.assign(_c,cooldown); fs.writeFileSync(COOLDOWN_FILE+'.merge',JSON.stringify(_c)); fs.renameSync(COOLDOWN_FILE+'.merge',COOLDOWN_FILE); } else { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldown)); } }catch(e){}
            await sleep(1500);
            continue;
          }
          cooldown[v]=nowTs;
          failCount[v]=(failCount[v]||0)+1;
          // 只有「真未开播」才计入当天探测账本（技术失败不代表主播没开播，
          // 那是我们自己的页面问题，不该因此今天就放弃他）。
          //
          // 探测窗口已经改成「开播小时 + 往后一小时」，窗口内探到的失败都算数——
          // 现在不存在「提前蹲守白耗配额」的问题了，窗口本身就是有效的判断时间。
          // （旧的 _strictDue 只认严格开播小时，那会让 20 点开播的主播在 21 点
          //   这个窗口小时的失败不计数，配额永远用不完、一直探到 22 点。）
          const _pinE=USER_PINNED[v];
          if(_pinE){ pRec(v).n++; saveProbeToday(); }

          // 🧬 自主进化·自动淘汰：连续探测失败达 15 次的房间移出探测队列。
          //    它们大概率已关闭（实测多间页面加载不出任何内容）。
          //    不删除档案，只移出 VIP 池，若日后恢复可用 watch 命令加回。
          if(failCount[v]>=15){
            try{
              const vf=ROOT+'/scripts/known-fudai-hosts.txt';
              let ex=[];
              try{ ex=fs.readFileSync(vf,'utf8').trim().split('\n').filter(Boolean); }catch(e){ ex=[]; }
              if(ex.includes(v)){
                fs.writeFileSync(vf, ex.filter(x=>x!==v).join('\n'));
                log(`🗑 自动淘汰 ${disp(v)}（连续探测失败 ${failCount[v]} 次，已移出 VIP 池）`);
                // 记入退役清单，便于日后追溯
                try{
                  const retired=DATA_DIR+'/retired-rooms.json';
                  let rd={};
                  try{ rd=JSON.parse(fs.readFileSync(retired,'utf8'))||{}; }catch(e){ rd={}; }
                  rd[v]={retiredAt:new Date().toISOString(), failCount:failCount[v]};
                  fs.writeFileSync(retired, JSON.stringify(rd,null,1));
                }catch(e){}
              }
            }catch(e){}
          }
          // 立即落盘：若等到轮末才写，中途重启会丢失计数（2026-11-02 实际踩过）
          try{ fs.writeFileSync(FAIL_FILE, JSON.stringify(failCount)); }catch(e){}
          try{ if(SHARED_PROBE){ const _c=readSharedJson(COOLDOWN_FILE,{})||{}; Object.assign(_c,cooldown); fs.writeFileSync(COOLDOWN_FILE+'.merge',JSON.stringify(_c)); fs.renameSync(COOLDOWN_FILE+'.merge',COOLDOWN_FILE); } else { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldown)); } }catch(e){}
          const diag=d?`len=${d.len||0} exited=${!!d.exited} loading=${!!d.loading} online=${d.online}`:'null';
          log(`  ❌ 未在播（${diag}），冷却 ${Math.round(coolMs/60000)} 分钟`);
        }
        await sleep(1500);
      }
      if(probeList.length){
        try{ if(SHARED_PROBE){ const _c=readSharedJson(COOLDOWN_FILE,{})||{}; Object.assign(_c,cooldown); fs.writeFileSync(COOLDOWN_FILE+'.merge',JSON.stringify(_c)); fs.renameSync(COOLDOWN_FILE+'.merge',COOLDOWN_FILE); } else { fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldown)); } }catch(e){}
        try{ fs.writeFileSync(FAIL_FILE, JSON.stringify(failCount)); }catch(e){}
      }

      // 📌 VIP 永久记录：不删除，只按当前是否在首页决定优先级（下播再上播能自动恢复）
      try{
        // ⚠ 读单独 try：文件不存在时 readFileSync 抛 ENOENT 会让整个块跳过，VIP 记录将永远建不起来
        let known=[];
        try{ known=fs.readFileSync(ROOT+'/scripts/known-fudai-hosts.txt','utf8').trim().split('\n').filter(Boolean); }catch(e){ known=[]; }
        // 已知会发福袋的房间若重新出现在首页，自动补进活跃 VIP
        for(const k of known){
          if(roomOnline.has(k) && !aliveVip.includes(k)){
            aliveVip.push(k);
            log(`🔄 VIP重新上线: ${k}`);
          }
        }
        // 把活跃 VIP 合并进永久记录
        if(aliveVip.length){
          const merged=Array.from(new Set([...known, ...aliveVip]));
          fs.writeFileSync(ROOT+'/scripts/known-fudai-hosts.txt', merged.join('\n'));
        }
      }catch(e){}

      // 优先活跃 VIP，再普通房间
      const ordered2=[...aliveVip, ...rooms.filter(r=>!vip.includes(r.room)&&!blacklist.includes(r.room)).map(r=>r.room)];

      // 候选数从 8 提到 12：房间池 123 个，每轮只看 8 个的话，
      // 一个房间要 20 轮才能轮一遍（7 小时），学习样本积累极慢。
      // 提到 12 个配合更短停留，同样时间能覆盖更多房间。
      const CANDIDATES=12;
      const pool=[];
      let _unknownOnline=0;   // ol<0 的探路名额计数（2026-11-10 19:16）
      for(const room of ordered2){
        const isVip=aliveVip.includes(room);
        const ol=roomOnline.has(room) ? roomOnline.get(room) : -1;
        // 主动探测到的 VIP 房可能拿不到在线数，同样要纳入候选
        if(ol<0 && !isVip) continue;
        const info = rooms.find(x=>x.room===room);
        const host = info ? (info.host||'') : (NAMES[room]||'');
        const title = info ? (info.title||'') : '';
        if(isOfficial(host)){ log(`  ⛔ ${room} 官方媒体(${host})，跳过`); continue; }
        // 🧒 婴童过滤（入池口）：采集来的房间必须含关键词；VIP 房若主播名/标题已知且不含关键词也跳过，
        //    名字未知（仅靠探测进来的历史 VIP）的放行，最多 3 个探路名额，不会淹没婴童池。
        if(isCategoryFilterOn() && !matchesCategory(host, title)){
          if(!isVip){ log(`  🧒 ${room} 非婴童（${host||title||'无标题'}），跳过`); continue; }
          if(host||title){ log(`  🧒 ${room} VIP 非婴童（${host||title}），跳过`); continue; }
        }
        // 🎯 2026-11-05 用户要求「按门槛硬卡」：VIP 不再享受 500 人底线豁免，
        //    一律按 day/night 门槛。是否放宽由 threshold.json 的 vipExempt 控制。
        //    ol<0 是「探测时拿不到在线数」：VIP 仍可进候选（进房后实时值在 F 值检测硬卡），
        //    因为在线数往往进房才解析得到，直接砍会误杀刚开播的大房。
        const VIP_FLOOR=500;
        const vipExempt = VIP_EXEMPT && isVip && ol>=VIP_FLOOR;
        if(ol>=0 && ol<minOnline && !vipExempt) continue;
        // 🔴 2026-11-10 19:16 用户指着看板质问「你还说没问题」后修：
        //    旧逻辑 ol<0（拿不到在线数）一律进池，理由是「进房才能解析到在线数」。
        //    但晚间门槛 50000 时，60 个房间只有 3 个真达标，其余全是 ol=-1，
        //    结果一轮常驻 17 次、11 次撞「门槛硬卡跳过」，纯白跑。
        //    实测 log：达标 3/60 间，却常驻了 775263084570(10000)、158465078330(8169)、
        //    金美希(-1)、阿伟走山村(-1) 等一堆不达标房。
        //    改为：ol<0 的房间限额进池（最多 3 个，且只给 VIP），
        //    既不放弃「可能刚开播的大房」，也不让满池未知房间淹没真正达标的。
        if(ol<0){
          if(!isVip) continue;                     // 非 VIP 拿不到人数，直接不进池
          if(_unknownOnline >= 3) continue;         // VIP 也最多 3 个探路名额
          _unknownOnline++;
        }
        pool.push({room, online:ol, isVip, host, title, score:roomScore(host,title,ol,isVip)});
      }
      // 🎯 按优先级排序：游戏/娱乐类 + VIP 优先，带货类靠后
      // 🎯 排序：VIP 优先 → 最近没去过的普通房优先 → 分数
      // 否则分数最高的那几间会每轮重复被选中，其余房间永远轮不到
      let recent=[];
      try{ recent=JSON.parse(fs.readFileSync(RECENT_FILE,'utf8')); if(!Array.isArray(recent)) recent=[]; }catch(e){}
      // 🚫 粉丝团型房间降权：连续发粉丝团福袋的房间去了也抢不到，排在后面
      let fansMap={};
      try{ fansMap=JSON.parse(fs.readFileSync(FANS_FILE,'utf8'))||{}; if(typeof fansMap!=='object'||Array.isArray(fansMap)) fansMap={}; }catch(e){}
      // 🥀 空手次数降权：常住了却没福袋的房间反复被选会白耗时间
      let dryMap={};
      try{ dryMap=JSON.parse(fs.readFileSync(DRY_FILE,'utf8'))||{}; if(typeof dryMap!=='object'||Array.isArray(dryMap)) dryMap={}; }catch(e){}
      // 🎯 有效分 = 质量分 − 惩罚分
      // 原来的分档排序有个致命问题：「没去过」是最高优先级，会把 0 分的带货房
      // 顶到 17 分的游戏房前面。改成扣分制后，高质量房即使刚去过也仍可能排在前面。
      // 🧬 主播习惯：读档案，按当前小时判断这间房「这个点」是否常发可抢福袋
      let anchors={};
      try{ anchors=JSON.parse(fs.readFileSync(ANCHORS_FILE,'utf8'))||{}; }catch(e){ anchors={}; }
      // 🧠 自适应策略：先算全局「掌握度」（多少房间样本足够），
      //    再据此刻的策略强度 —— 掌握度低时激进学习，高时收紧、专注已知会发福袋的房间。
      //    策略不写死，随学习进展自我调节（用户明确要求）。
      const allRooms=Object.values(anchors);
      const masteredN=allRooms.filter(v=>(v.visits||0)>=3).length;
      const mastery=allRooms.length ? masteredN/allRooms.length : 0;
      const LEARN_BOOST = mastery<0.20 ? -14 : (mastery<0.50 ? -8 : -3);
      const IDLE_BOOST  = mastery<0.20 ? -10 : (mastery<0.50 ? -6 : -2);
      log(`🧠 掌握度 ${(mastery*100).toFixed(0)}%（${masteredN}/${allRooms.length}）：学习 ${LEARN_BOOST} 闲置 ${IDLE_BOOST}`);

      const curHour=String(new Date().getHours());
      const effScore=(x)=>{
        let p=0;
        if(recent.includes(x.room)) p+=10;          // 刚去过，降权
        if((dryMap[x.room]||0)>=2) p+=15;           // 多次常驻却空手
        if((fansMap[x.room]||0)>=2) p+=30;          // 以粉丝团型福袋为主，抢不到

        // 🧬 时段契合：历史在这个小时发过福袋才加分，且可抢率越高加得越多
        const a=anchors[x.room];
        if(a){
          // 🏆 历史金矿基础奖励（2026-11-02 补，重要）：
          //    实测 354892492946 历史发过 45 次福袋、45 次全部可抢，是凌晨时段的绝对主力，
          //    但它的 visits=0（visits 是后加字段，历史房间都没这个计数）。
          //    原逻辑只在 rate>0.6 时才加分，而 visits=0 时 rate 根本算不出来，
          //    于是「确实会发福袋」的金矿和历史从没发过的房间待遇完全相同。
          //    改为按「可抢次数」给基础奖励——用 joinable 而不是 fudaiTotal，
          //    因为纯粉丝团房（joinable=0）抢不到，不该因此靠前。
          const goldN=a.joinable||0;
          if(goldN>0) p -= Math.min(28, 8 + goldN*0.6);
          // 🕐 2026-11-11 09:42 时段权重：当前小时不在该房间的历史发袋窗口内 → 大幅降权。
          //    降权而不是排除：hourly 只是历史观测，「这小时没见过」≠「不发」，
          //    直接排除会永久错过没被观测到的时段。降 25 分足以让它排到后面。
          if(!inHourWindow(x.room)) p += 25;
          const cnt=(a.hourly||{})[curHour]||0;
          if(cnt>0){
            const rate=a.fudaiTotal ? (a.joinable||0)/a.fudaiTotal : 0;
            const bonus=Math.min(25, cnt*1.5)*rate;   // 纯粉丝团房 rate=0，加分为 0
            if(bonus>0) p-=bonus;                     // p 是惩罚，减 p 即加分
          }
          // 纯粉丝团房（发过 >=5 次且一次可抢都没有）重罚，别再浪费时段
          if((a.fudaiTotal||0)>=5 && (a.joinable||0)===0) p+=40;

          // 📊 发福袋率：被访问很多次却一次福袋都没见到的主播，说明人气高但不发福袋。
          //    访问 >= 4 次且福袋数为 0 → 重罚；访问 >= 4 次但福袋很少 → 轻罚。
          const visits=a.visits||0;
          const fudaiN=a.fudaiTotal||0;

          // 🧬 学习加速：访问 1-2 次的房间还不足以判断「发不发福袋」，
          //    给一点奖励让它们尽快凑够样本（实测 95 个房间只有 2 个到 3 次，
          //    学习速度严重不足）。只奖 1-2 次，3 次以上交给下面的判断。
          if(visits>=1 && visits<=2) p+=LEARN_BOOST;

          // 🔄 最久未访问优先：让轮换更均匀，避免少数房间反复被选中、
          //    大多数房间一直学不到样本。超过 2 小时没访问的给奖励。
          if(a.lastVisit){
            const idleMin=(Date.now()-new Date(a.lastVisit).getTime())/60000;
            if(idleMin>120) p+=IDLE_BOOST;
            else if(idleMin>60) p+=Math.round(IDLE_BOOST/2);
          }

          if(visits>=2){
            const rate=fudaiN/visits;
            if(fudaiN===0){
              // 分档：访问越多还没福袋，越可信「这间房不发福袋」
              if(visits>=6) p+=45;      // 6 次以上从没发过 → 基本可以放弃
              else if(visits>=4) p+=30; // 4-5 次 → 重罚
              else p+=12;               // 2-3 次 → 轻罚（可能是偶然）
            }
            else if(rate<0.25) p+=20;   // 发得很少，降权
            else if(rate>0.6) p-=15;    // 经常发，加分
          }
        }
        // 🎯 VIP 保护（2026-11-03 修正：原实现让学习机制彻底失效）
        //    原写法 `p = Math.min(p, 20)` 把扣分封顶，配合下面排序里的「VIP 无条件优先」，
        //    结果是「用户指定的主播」完全绕过学习机制：
        //    实测琦儿 374806133859 一天被常驻 **25 次 × 480 秒 = 3 小时 20 分，产出 0 个福袋**，
        //    而它的档案 visits=25 / fudaiTotal=0 / dry=15 明明全是空手记录，却一分都扣不进去。
        //    用户当场质问：「访问很多次都没有福袋，他的分不应该降低吗」——这个质疑是对的。
        //
        //    错在把「用户指定」理解成「无条件常驻」。用户给的是开播时间，不是「保证发福袋」
        //    的承诺。琦儿这场是「双11草本初色品牌专场」带货直播，福袋大概率是粉丝团型，
        //    按用户规则本来就不该抢。
        //
        //    正确拆法：
        //    · 优先**探测**（5-24 秒一次，便宜）→ 保留，保证开播不漏
        //    · 优先**常驻**（480 秒一次，昂贵）→ 取消，必须靠历史产出说话
        //    这里改成「VIP 基础信任 -12 分」：默认比普通房靠前一点，
        //    但 25 次空手的惩罚（dry 15 + 零产出 45）能真实把它压到队尾。
        if(x.isVip){
          const recentPen = recent.includes(x.room) ? 10 : 0;
          const _pin=USER_PINNED[x.room];
          if(_pin && _pin.tier==='pinned'){
            // 用户明确说「完全可以常驻」的 5 个主播：保留扣分封顶。
            // 它们发袋不规律、样本还没攒够，让自动学习的空手惩罚把优先级压掉
            // 会违背用户的明确指令。（但常驻仍受「只在开播时段」约束。）
            p = Math.min(p, 20) + recentPen;
          }else{
            // follow 型（全天播但长期零产出）：不封顶，让产出说话。
            // 不能加 Math.max(0,...) 下限：金矿房 goldN 奖励会把 p 压成负数，
            // 归零等于抹掉「历史抢到过 45 次」的优势，把它们和普通房拉平。
            p = p + recentPen;  // 🧒 2026-11-11：VIP 基础信任 -12 已取消，VIP 不再加分
          }
        }
        return x.score - p;
      };
      // 🎯 排序只看有效分（2026-11-03 修正，与上面的 VIP 扣分封顶是一对）
      //    原来 `if(a.isVip!==b.isVip) return a.isVip?-1:1` 让 VIP 无条件排最前，
      //    与 effScore 完全脱钩——哪怕它已经被证明 25 次常驻零产出。
      //    VIP 的优势现在只体现在 effScore 的 -12 基础信任里，排序回归单一标准。
      pool.sort((a,b)=>{
        // 用户指定的「常驻型」主播在开播时段内排最前——用户明确要求它们可以常驻。
        // 其余一律按有效分排（含 follow 型，它已不再享受排序插队）。
        const aR=USER_PINNED[a.room], bR=USER_PINNED[b.room];
        const aPin=!!(aR && aR.tier==='pinned' && dueNow(a.room));
        const bPin=!!(bR && bR.tier==='pinned' && dueNow(b.room));
        if(aPin!==bPin) return aPin?-1:1;
        return effScore(b)-effScore(a);
      });
      // 🌙 低谷期加速：如果池里最高分都 <=0（没有任何游戏/娱乐类房间，
      //    说明当前时段只有普通生活类在线），就只盯 4 个房间快速轮转，
      //    而不是用 8 个低质量房间把一轮拖到 24 分钟
        // 🌙 凌晨候选精简（2026-11-03 数据驱动，重要）：
        //    实测凌晨 0-6 点共 68 次福袋、**全部只来自 3 个房间**：
        //      354892492946 锦一电台 43 次（63%，全部可抢，已在 VIP）
        //      214495728391 16 次（0 次可抢，已拉黑）
        //      16015225873  9 次（2 次可抢，但已 71 小时没出现）
        //    其余普通房凌晨贡献 0 次。而一轮 12 个候选的构成常常是
        //    「1 个锦一电台 + 11 个普通房」，那 11 个 × 120 秒 = 22 分钟纯陪跑，
        //    把锦一电台的复查间隔拖到 37 分钟——而它每小时能发 5-8 次。
        //    凌晨压到 6 个：900(锦一) + 5×120 = 25 分钟一轮，轮转快 12 分钟。
        const deepNight = new Date().getHours() < 7;   // 凌晨 0-6 点
        const baseLimit = (pool.length>0&&pool[0].score<=0)?Math.min(4,pool.length):CANDIDATES;
        // 🌙 凌晨候选数：自适应，不再固定砍到 6。
        //    2026-11-03 整夜教训：锦一电台（占凌晨可抢福袋 63%）整夜在线却不发袋，
        //    而当时固定只盯 6 个候选，等于把「发现别的房间也在发」的机会一起砍掉了，
        //    结果 0-6 点历史预期 68 次、实际 0 次。
        //    改为：主金矿房连续 3 轮颗粒无收 → 判定它今天可能不发，候选扩到 10 个去扫新房间；
        //    只要它正常发袋就维持 6 个（轮转快、覆盖深）。
        // 统计「有历史发袋记录但最近连续空手」的轮数（只看凌晨/夜间的主金矿房）
        let goldDryRounds=0;
        try{
          const juicy=pool.filter(x=>x.isVip && ((anchors[x.room]||{}).joinable||0)>=10);
          if(juicy.length){
            goldDryRounds=juicy.every(x=>{
              const a=anchors[x.room]||{};
              const n=(dryMap[x.room]||0);
              return n>=3;   // 连续 3 次空手
            }) ? 3 : 0;
          }
        }catch(e){}
        const nightLimit = goldDryRounds>=3 ? 10 : 6;   // 金矿空手 → 扩大扫描范围
        // ⚖️ 2026-11-10 11:33 用户定稿「把资源重点倾向于主号」：
        //    主号是唯一能关注/加团、能把福袋变收益的号；受限账号遇到关注型/粉丝团型
        //    只能跳过。因此每轮盯的候选数按账号差异化：主号多盯、受限账号少盯，
        //    让主号的常驻覆盖率更高。配置见 wait-config.json 的 probeQuota.candLimit。
        const _cl = ((_WAIT && _WAIT.probeQuota) || {})[ACCOUNT_TAG];
        const _clN = (_cl && Number(_cl.candLimit)>0) ? Number(_cl.candLimit) : 0;
        const candLimit = _clN>0 ? _clN : (deepNight ? Math.min(baseLimit, nightLimit) : baseLimit);
      for(const p of pool){
        if(good.length>=candLimit) break;
        good.push(p);
        log(`  ✓ ${disp(p.room)} 在线${p.online}${p.isVip?' [VIP]':''} (分${p.score}→有效${effScore(p).toFixed(0)})`);
      }
      if(!good.length){
        // 一次采集要滚动加载约 12 秒。晚上门槛升到 1 万后很可能整轮没有达标房间，
        // 若只等 20 秒就重采，会变成每 32 秒采集一次首页，极易触发限流。
        emptyRounds++;
        const waitMs=Math.round(WS*Math.min(_WAIT.emptyRoundMaxMs, _WAIT.emptyRoundStepMs*emptyRounds));
        log(`本轮无合适房间（连续第 ${emptyRounds} 次），退避 ${waitMs/60000} 分钟`);
        await sleep(waitMs);
        continue;
      }
      emptyRounds=0;
      // 记录本轮选中的所有房间（含 VIP）：VIP 也要轮换，否则会连续几轮死盯同一间
      try{
        const add=good.map(g=>g.room);
        if(add.length){
          // 只保留最近 12 个（约 1.5 轮）。首页房间池只有 20 个左右，
          // 上限若设成 40 会在一两轮后把所有房间都标成「去过」，轮换直接失效
          recent=[...add, ...recent.filter(r=>!add.includes(r))].slice(0,12);
          fs.writeFileSync(RECENT_FILE, JSON.stringify(recent));
        }
      }catch(e){}
      // 📊 候选质量指标：曾出现「8 个候选全是 0-3 分带货房」的隐性退化，
      //    打一行均分/最高分/游戏类数量，抬头看一眼日志就能发现质量下滑
      if(good.length){
        const avg=(good.reduce((t,x)=>t+x.score,0)/good.length).toFixed(1);
        const top=Math.max(...good.map(x=>x.score));
        const strong=good.filter(x=>x.score>=8).length;
        log(`📊 候选质量 均分 ${avg}，最高 ${top}，强相关房间 ${strong} 个 ｜ 达标 ${pool.length}/${rooms.length} 间 ｜ 本轮盯 ${good.length} 个`);
      }
      log(`选定 ${good.length} 个候选，依次尝试常驻`);
      // 🧠 策略观测：本轮选房结果。用于回答「选房策略有没有把时间花在高产房」。
      //    poolAll/poolPass 记录候选池与门槛通过数，是「门槛该不该调」的反事实线索。
      // 本轮选房是集合级事件，不属于任何房间，故不带 decisionId；
      // 用 policyId + hour + at 已足够定位，避免被当成「孤儿房间引用」。
      recStrategy('candidates',{
        minOnline:getMinOnline(),
        poolAll:rooms.length, poolPass:pool.length, picked:good.length,
        avgScore:good.length?Number((good.reduce((t,x)=>t+x.score,0)/good.length).toFixed(1)):0,
        topScore:good.length?Math.max(...good.map(x=>x.score)):0,
        strongN:good.filter(x=>x.score>=8).length,
        vipN:good.filter(x=>x.isVip).length,
        rooms:good.map(x=>({room:x.room,online:x.online,score:x.score,isVip:!!x.isVip}))
      });

      // 依次常驻：VIP 房（已验证发福袋）多等，普通房快扫换人
      // 提高覆盖密度——原来固定 10 分钟/房，一轮 5 房要 50 分钟，太慢
      // 上限 8 分钟：晚上门槛升到 1 万后可能只筛出 1-2 个房间，
      // 若不设上限，1 个候选会被算成 12 分钟，白白困在同一间房
      // 停留下限从 180 秒降到 120 秒：福袋倒计时通常 5-10 分钟，
      // 120 秒足以检测到并处理；每个房间少待 60 秒，一轮能多覆盖几个房间。
      const perMsBase=Math.round(WS*Math.min(_WAIT.perRoomMaxMs, Math.max(_WAIT.perRoomMinMs, Math.floor(BATCH_MIN*60000/good.length))));
      for(const g of good){
        // 🏆 高频金矿房长常驻（2026-11-02 数据驱动）：
        //    锦一电台 354892492946 历史发过 45 次福袋、45 次全部可抢，全部集中在 0-6 点，
        //    约合每 23 分钟一个。原来 VIP 房只待 480 秒，遇到福袋的概率仅约 23%，
        //    等于在这间金矿房里瞎逛。对「当前小时历史发袋次数 >= 4」的 VIP 房，
        //    常驻提到 900 秒（15 分钟），遇到福袋概率提到约 48%，是这笔时间该花的地方。
        const hourTbl=(anchors[g.room]||{}).hourly||{};
        const thisHourCnt=hourTbl[new Date().getHours()]||0;
        const highYield=g.isVip && thisHourCnt>=4;
        const perMsRaw=highYield ? Math.round(WS*_WAIT.highYieldMs) : (g.isVip ? Math.round(WS*Math.max(_WAIT.vipMinMs, perMsBase/WS)) : perMsBase);
        // ⚖️ 2026-11-10 11:33 资源倾斜：账号级常驻倍率。
        //    主号给 >1（待更久、更容易撞上开奖），受限账号给 <1（快速换房、多探多看）。
        //    配置 wait-config.json 的 probeQuota.<账号>.perMsScale，未配置默认 1（零变化）。
        const _ps = ((_WAIT && _WAIT.probeQuota) || {})[ACCOUNT_TAG];
        const _psN = (_ps && Number(_ps.perMsScale)>0) ? Math.max(0.3, Math.min(3, Number(_ps.perMsScale))) : 1;
        const perMs = Math.round(perMsRaw * _psN);
        log('');
        log(`=== 常驻 ${disp(g.room)}（在线${g.online}${g.isVip?' VIP':''}${highYield?` 🏆高频发袋(${new Date().getHours()}点历史${thisHourCnt}次)`:''}）${perMs/1000}秒 ===`);
        // 🧠 策略观测：房间时间投入的起点。roomStayId 与结束事件配对，
        //    得到「在这间房花了多少秒」，是单位时间中奖期望的分母。
        const roomStayId=newDecisionId();
        const roomT0=Date.now();
        recStrategy('room-enter',{
          decisionId:roomStayId, room:g.room, online:g.online,
          score:g.score, isVip:!!g.isVip, highYield:!!highYield,
          plannedStaySec:Math.round(perMs/1000), minOnline:getMinOnline(),
          hourHistFudai:thisHourCnt, visits:(anchors[g.room]||{}).visits||0
        });

        // 📊 记录访问次数：用于计算「发福袋率 = 发现福袋次数 / 被访问次数」。
        //    有些主播人气很高但从不发福袋，只有把它和真正发福袋的主播区分开，
        //    选择才会越来越准（用户明确提出的需求）
        try{
          await withSharedJson(ANCHORS_FILE, am=>{
            const ar=am[g.room]||{host:'',firstSeen:new Date().toISOString(),fudaiTotal:0,joinable:0,fans:0,hourly:{},lastFudaiAt:'',visits:0};
            ar.visits=(ar.visits||0)+1;
            ar.lastVisit=new Date().toISOString();   // 供「最久未访问优先」轮换使用
            am[g.room]=ar;
            return am;
          });
        }catch(e){}

        let fansStreak=0;   // 连续粉丝团型计数
        let navOk=false, lastLen=0;
        const NAV_WAIT=20000;   // 单次加载最长等待（实测部分房间要 12-15 秒才出内容）
        try{ await tab.cdp.send('Page.navigate',{url:`https://live.douyin.com/${g.room}`},20000); }catch(e){}
        // 🔑 严格判定：必须页面内容充实（len>400 或有福袋图标），否则视为加载失败
        for(let k=0;k<7;k++){
          await sleep(2500);
          const d=await ev(tab,SCAN,20000);
          if(d&&!d.__err){
            lastLen=d.len||0;
            // 判定标准必须与 VIP 主动探测保持一致：能解析到在线人数就算页面有效
            // 否则会出现「探测说在播、选进候选后又说加载失败」的矛盾（416921329528 len=368 实测）
            const onlineOk=(typeof d.online==='number' && d.online>=0);
            if(!d.loading && !d.notLive && (d.len>400 || (d.candCount||0)>0 || onlineOk)){ navOk=true; break; }
          }
        }
        if(!navOk && lastLen<100){
          // 🩺 标签级卡死自愈：实测这个标签坏了以后，同一个房间用新标签完全正常
          //    （len=330），但坏标签无论重试多少次都是 len=20。所以直接重建标签。
          log(`页面空白(len=${lastLen})，重建标签后重试`);
          const fresh=await recreateTab(tab);
          if(fresh){
            const oldTab=tab;
            tab=fresh;
            // 重置断线缓存
            try{ if(oldTab!==fresh){ blankFail=0; } }catch(e){}
            try{ await tab.cdp.send('Page.navigate',{url:`https://live.douyin.com/${g.room}`},20000); }catch(e){}
            await sleep(12000);
            const d2=await ev(tab,SCAN,25000);
            if(d2 && !d2.__err && (d2.len>100 || (d2.candCount||0)>0 || d2.online>=0)){
              navOk=true; lastLen=d2.len; log('  ✅ 重建后加载成功');
            }else{ log(`重建后仍失败(len=${lastLen})，换下一个候选`); continue; }
          }else{ log('标签重建失败，换下一个候选'); continue; }
        }
        if(!navOk){
          // 🩺 标签级卡死自愈：同一标签连续 2 次加载出 len<100 的空白页，
          //    说明这个标签的渲染进程坏了（实测新标签加载同一房间完全正常）。
          //    直接重建标签，而不是继续在坏标签上重试。
          blankFail=(lastLen<100)?(blankFail+1):0;
          if(blankFail>=2){
            log(`🩺 标签连续 ${blankFail} 次空白，重建标签`);
            const fresh=await recreateTab(tab);
            if(fresh){ tab=fresh; blankFail=0; log('  ✅ 标签已重建'); }
          }
          log(`加载失败(len=${lastLen})，换下一个候选`);
          continue;
        }
        blankFail=0;

        // 🔋 降载三连：暂停视频 + 暂停所有动画 + 视频画面透明化。
        //    实测单靠「暂停视频」不够：抓取 Chrome 仍吃 154% CPU（渲染进程 53.8%），
        //    主要来自弹幕滚动、礼物特效、点赞动画这些持续重绘。
        //    加上「暂停动画 + 视频透明」后实测从 64.7% 降到 31.3%（省 52%）。
        //    ⚠ 只影响渲染，不动 DOM：福袋检测靠 querySelectorAll，坐标点击靠元素的
        //    getBoundingClientRect，两者都不受 opacity/animation 影响。
        try{
          await ev(tab,`(()=>{
            let n=0;
            document.querySelectorAll('video').forEach(v=>{try{if(!v.paused){v.pause();n++;}v.muted=true;}catch(e){}});
            if(!document.getElementById('__h35_lowcpu')){
              const s=document.createElement('style'); s.id='__h35_lowcpu';
                // ⚠ 必须排除福袋相关元素：SCAN 用 getBoundingClientRect().width<24 过滤候选，
                //   若福袋图标带入场缩放动画（scale 0→1），全局暂停动画会把它卡在 0 尺寸，
                //   导致永久 candCount=0 而页面看起来完全正常——这种静默失效最难查。
                s.textContent='*,*::before,*::after{animation-play-state:paused !important;transition:none !important;}'
                            + '[class*="LMUtLyr9"],[class*="ShortTouch"],[class*="KXLj31kc"],[class*="ycjwPFJI"]{animation-play-state:running !important;}'
                            + 'video{opacity:0 !important;}';
              document.head.appendChild(s);
            }
            // 🔴 2026-11-10 15:29 修复 no-panel 真因（实测截图定位）：
            //    因为 Chrome 带 --mute-audio 启动，抖音直播播放器会在屏幕中部（实测 y≈377）
            //    渲染一个「因浏览器限制静音，按 P 或 点击打开声音」的黑色覆层。
            //    福袋面板弹出时，「参与条件/按钮区」正好被这个覆层压住，
            //    DOM.performSearch 能搜到按钮节点但点不到/被遮挡，表现为 panel 已开却取不到按钮
            //    → 今日 35 次 no-panel（占 18.4%）全是这个原因。
            //    修法：移除该覆层（实测移除后 hasMute 立刻变 false，页面内容反而更完整）。
            //    只移除「含静音文案且文本很短」的覆层，不碰播放器主体与福袋元素。
            let _muteN=0;
            try{
              document.querySelectorAll('[class*="Wn6sF12t"],[class*="fBv9dwfC"],[class*="RntNeJeO"]').forEach(function(el){
                var t=(el.innerText||'');
                if(t.length<80 && /浏览器限制静音|点击打开声音|按 P 或/.test(t)){
                  el.style.display='none'; el.remove(); _muteN++;
                }
              });
            }catch(e){}
            return n+_muteN*100;
          })()`,10000);
        }catch(e){}
        // 📌 关注挪到「发现福袋」之后做——只关注真正发福袋的主播，不扫街式关注
        // 🔁 2026-11-05 用户定稿「抢完福袋守完开奖后，再等 2 分钟看有没有新福袋，有就继续抢，不设轮数上限」。
        //    实现：把「房间停留预算」做成可重置的。守候开奖是嵌套在 while 里的长等待（245~660s），
        //    若不重置 t0，守候一结束 elapsed 必然远超 perMs(60s)，while 立即退出换房，根本没机会再等。
        //    守完开奖后把 t0 重置为当前、预算设为 POST_DRAW_MS，循环即可继续留在本房间扫福袋；
        //    再命中新福袋就再抢再守再重置，如此循环。d.exited（下播）与 SCAN 持续报错都能让 while 自然退出，
        //    所以「不设轮数上限」不等于死循环。POST_DRAW_MS=0 可一键回到「守完开奖立即换房」。
        let t0=Date.now();
        let stayBudget=perMs;
        let postDrawRound=0;       // 开奖后蹲守轮数（仅日志可观测）
        let postDrawUnlockPending=false;  // 守完开奖，等旧福袋图标消失后再解锁去重
        let handled=false, nextDiag=30000;
        while(Date.now()-t0<stayBudget){
          const d=await ev(tab,SCAN,20000);
          if(!d||d.__err){ await sleep(2000); continue; }
          if(d.exited){ log('已退出'); break; }
          // 🧒 看板：每次扫描都更新该房间的在线数和福袋状态
          try{
            if(d.fudai){
              const sec=(typeof d.fudai.sec==='number' && d.fudai.sec>=0) ? d.fudai.sec : -1;
              upsertLiveRoom(g.room, {online:d.online, title:d.title||g.title||'', status:'fudai',
                fudai:{cd:d.fudai.cd||'', sec, expiresAt: sec>=0 ? Date.now()+sec*1000 : 0, type:'待确认', content:''}});
            }else{
              upsertLiveRoom(g.room, {online:d.online, title:d.title||g.title||'', status:'monitoring'});
            }
            writeLiveState(false);
          }catch(e){}
          // 🔁 守完开奖后，只有观察到旧福袋图标确实消失 candCount===0 才解锁去重。
          //    不做「超时兜底解锁」：若旧图标赖着不消失，超时解锁会把同一个旧福袋再抢一次，
          //    重复抢比漏一轮更糟。真出现「无缝衔接」时本轮自然到期换房，下一轮重进仍会扫到新福袋。
          if(postDrawUnlockPending && (d.candCount||0)===0){
            HANDLED_TIME.delete(g.room);
            _RETRY_AT.delete(g.room);   // 同步清短冷却，否则上一轮的残留会挡住新一轮福袋
            postDrawUnlockPending=false;
            log('  🔁 旧福袋图标已消失，去重已解锁，等待新一轮福袋');
          }
          // 🔍 每10次采样输出一次 f 的原始值
          dbgCnt++;
          if(dbgCnt%10===1){
            log(`  [f值检查] f=${JSON.stringify(d.fudai)} candCount=${d.candCount} fErr=${d.fErr} online=${d.online}`);
          }
          // 🎯 2026-11-05 用户要求「按门槛硬卡」：只有实时在线数达到门槛才参与。
          //    候选池用首页快照 ol（VIP 主动探测常拿不到在线数 ol=-1，允许进房取实时值），
          //    这里用进房后实时 d.online，是可信判据，两者口径不同是有意为之。
          //    硬卡时 d.online<0（解析不到在线数）按「未达标」处理，不再靠 VIP 身份放行。
          //    VIP_EXEMPT=true 可一键恢复旧策略（VIP 不受门槛、500 人底线）。
          const onlineOK = VIP_EXEMPT
            ? (d.online<0 || d.online>=getMinOnline() || g.isVip)
            : (typeof d.online==='number' && d.online>=getMinOnline());
          if(d.fudai && !onlineOK){
            // 硬卡拦截留痕：否则「看见了福袋却不参与」和「根本没福袋」在日志里长得一样，
            // 又变成 11-03 那种「看不见和没有表现一样」的排查黑洞。每 10 次采样打印一次。
            if(dbgCnt%10===1) log(`  ⛔ 门槛硬卡跳过福袋: 在线${d.online} < ${getMinOnline()} ${g.isVip?'[VIP]':''} ${disp(g.room)}`);
            // 🧠 策略观测：被门槛拦下的福袋是评估「门槛是否过高」的直接反事实证据。
            //    ⚠ 去重判据用 secLeft 而不是 cd：福袋倒计时每 2 秒递减，
            //    「房间+cd」会让同一个福袋每轮扫描都记一条（实测 56 条/福袋）。
            //    只有 secLeft 相对上次记录回升才说明是**新福袋**，否则一律不重记。
            const _sec=(d.fudai||{}).sec;
            const _prev=_gateLogged.get(roomStayId);
            // ⚠ _prev 存的是「上一次采样看到的 secLeft」，不是「首次记录值」：
            //    新福袋倒计时从 09:55 重新开始，若拿它跟上一轮首次的 09:56 比，
            //    因为 595<596 会永远判不出回升（09:56 修复时实测踩过）。
            //    同一福袋 secLeft 单调递减 → 永不 > _prev；新福袋回升 → 必 > _prev。
            const _isNew=(typeof _sec!=='number'||_sec<0)
              ? _prev===undefined                     // 解析不到倒计时时，每次常驻最多记 1 条
              : (_prev===undefined || _sec>_prev);
            if(_isNew){
              recStrategy('gate-skip',{
                decisionId:roomStayId, room:g.room, online:d.online,
                minOnline:getMinOnline(), isVip:!!g.isVip,
                cd:(d.fudai||{}).cd||'', secLeft:_sec??-1,
                reason:'online-below-threshold'
              });
            }
            // 无论是否写事件，都要更新参照值到本次采样（关键：不能只在写事件时更新）
            if(typeof _sec==='number'&&_sec>=0) _gateLogged.set(roomStayId,_sec);
            else if(_prev===undefined) _gateLogged.set(roomStayId,-1);
          }
          if(d.fudai && onlineOK){
            // 🔑 只在倒计时充足时尝试（实测剩余不足180秒的福袋点不开面板）
            var secLeft=(typeof d.fudai.sec==='number')?d.fudai.sec:-1;
            if(secLeft>=0 && secLeft<180){ await sleep(2000); continue; }
            // ⚠ 去重必须按时间窗，不能用倒计时做 key。
            //   倒计时每秒都在变（09:56 → 09:44 → 09:25…），拿它当 key 会让同一个福袋
            //   被反复处理：实测 8199758142 的同一个福袋被处理 21 次，统计虚高 20 倍。
            //   改为「同一房间时间窗内只处理一次」，窗口见下方说明。
            // 窗口 12 分钟：福袋倒计时实测最长 10 分钟，6 分钟会漏判同一福袋
            // （今日 8199758142 的同一福袋横跨 6 分 53 秒仍被记录多次）。
            // 🔁 2026-11-05：守候开奖已走完时会先 delete 本房间的 HANDLED_TIME 记录，
            //    所以这里天然能处理「开奖后 12 分钟内又发的新福袋」。历史 95 个同房间间隔里
            //    5 个 <12 分钟，旧逻辑会把它们全部静默吞掉。
            //    用「开奖完成」而不是「倒计时回升」作分界：新一轮福袋倒计时可能更短，
            //    「回升」判据会漏掉它；而开奖后旧福袋的 DOM 已消失，不会重复抢同一个。
            // 🔒 2026-11-05 18:42 事故修复：12 分钟去重只在「成功参与」后写（见下方 joined 分支）。
            //    这里只查两道闸：成功参与后的 12 分钟长窗、以及本次失败后的短冷却。
            //    失败不再锁死还在倒计时的福袋，冷却到期即可重试同一个福袋。
            const lastTs=HANDLED_TIME.get(g.room)||0;
            if(Date.now()-lastTs < 12*60*1000){
              await sleep(2000); continue;
            }
            const retryAt=_RETRY_AT.get(g.room)||0;
            if(Date.now()<retryAt){
              await sleep(2000); continue;
            }
            // 清理过期的房间记录（HANDLED_TIME 与短冷却一起收，避免无界增长）
            if(HANDLED_TIME.size>300){
              const nowTs=Date.now();
              for(const [k,v] of HANDLED_TIME){ if(nowTs-v>15*60*1000) HANDLED_TIME.delete(k); }
              for(const [k,v] of _RETRY_AT){ if(nowTs>v) _RETRY_AT.delete(k); }
              // 关注拦截计数随长窗一起收：房间已从长窗移除，计数也就没有意义了
              for(const k of _FOLLOW_FAILS.keys()){ if(!HANDLED_TIME.has(k)) _FOLLOW_FAILS.delete(k); }
            }
            log(`★★ 福袋! 在线${d.online} ${disp(g.room)} ${JSON.stringify(d.fudai)}`);
            // 📸 福袋 DOM 快照：每次识别到福袋就把真实结构存档。
            //    用途：抖音改版后选择器可能静默失效（页面照常加载、candCount 恒为 0），
            //    有成功样本才能对比出到底哪个 class 变了。这是自主进化的依据，不可省。
            try{
              const snap=await ev(tab,`(()=>{
                const icons=[...document.querySelectorAll('[class*="LMUtLyr9"]')].map(e=>({cls:String(e.className),html:e.outerHTML.slice(0,500)}));
                const st=document.querySelector('[class*="ShortTouchContainer"]');
                const rp=document.querySelector('[class="redpacket"]');
                return JSON.stringify({
                  at:new Date().toISOString(),
                  room:location.href.split('/').pop(),
                  iconCnt:icons.length,
                  imgCnt:document.querySelectorAll('[class*="KXLj31kc"]').length,
                  cdCnt:document.querySelectorAll('[class*="ycjwPFJI"]').length,
                  icons:icons,
                  shortTouch: st?st.innerHTML.slice(0,1500):null,
                  redpacket: rp?rp.outerHTML.slice(0,800):null
                });
              })()`,15000);
              if(snap && !snap.__err) fs.appendFileSync(W+'/fudai-dom-samples.jsonl', snap+'\n');
            }catch(e){}
            // 记录到 VIP 列表（该房间会发福袋）
            try{
              const vf=ROOT+'/scripts/known-fudai-hosts.txt';
              let ex=[]; try{ ex=fs.readFileSync(vf,'utf8').trim().split('\n').filter(Boolean); }catch(e){}
              if(!ex.includes(g.room)){ ex.unshift(g.room); fs.writeFileSync(vf, ex.slice(0,20).join('\n')); }
            }catch(e){}
            let r=null;   // ⚠ 必须在抢前关注门禁之前声明：门禁分支会写 r，
                          //    若声明在后面会触发 TDZ ReferenceError，被外层 catch 吞掉丢掉整轮福袋。
            // 📌 2026-11-05 用户定稿「抢福袋前都需要先关注主播」。
            //    关注必须放在 tryJoin「之前」：福袋面板是全屏遮罩，打开后左上角
            //    关注按钮被遮住，elementFromPoint 命中不到 → 历史 73 次关注 71 次失败。
            //    此刻刚识别到福袋、面板还没开、页面干净，实测 3/4 能点上且持久。
            //    门禁由 data/follow-config.json 控制：关注成功或已关注才允许抢；
            //    2026-11-09 起 allowInconclusive=false：页面未加载好 / 找不到关注按钮
            //    的 inconclusive 一律拦截，宁可少抢也不虚报关注数。
            //    关注状态一律看当前页面 DOM，不读全局 followed-rooms.txt（天然按账号正确）。
            let _followPass=true;
            // 🎯 2026-11-10 11:23：账号级「不做关注动作」策略（用户定稿 main3 免关注）。
            //    该账号不调 ensureFollow、不写关注记录、也不因关注失败拦截，
            //    直接把福袋交给 tryJoin —— 关注型福袋会由面板文案自然判为 need-follow，
            //    纯评论型福袋则能正常参与。主号不在白名单，行为完全不变。
            if(_skipFollowAcc.includes(ACCOUNT_TAG)){
              log(`  📌 关注主播: ⏭️跳过（账号 ${ACCOUNT_TAG} 已配置免关注策略）`);
            }else if(FOLLOW_ENABLED){
              const _fr=await ensureFollow(tab,g.room);
              // ⚠ 保留「关注主播:」字样：web/server.mjs 的 followTry/followOk 靠这个正则统计，
              //    改日志文案会让看板「关注能力」卡片归零。
              log(`  📌 关注主播: ${_fr.ok?'✅'+_fr.reason:'❌'+_fr.reason}${_fr.inconclusive?'(不确定)':''} (抢前)`);
              if(!_fr.ok && FOLLOW_GATE){
                _followPass = _fr.inconclusive && FOLLOW_ALLOW_INCONCLUSIVE;
                if(!_followPass){
                  // 复用现有 need-follow 结果，看板/报表/CSV 映射无需改动。
                  // ⚠ rec 必须在这里调（统一出口只做 updateAnchor / log，不调 rec）；
                  //    但 updateAnchor 与 log 只在下方统一出口做一次，以前这里重复写，
                  //    导致同一福袋出现两行「结果: need-follow」和两次档案更新。
                  r={url:`https://live.douyin.com/${g.room}`,online:d.online,cd:(d.fudai||{}).cd,
                     result:'need-follow',steps:['pre-follow:'+(_fr.reason||'fail')],
                     followDiag:_fr.diag||null};
                  rec(r);
                }
              }
            }
            // 同排多个图标依次尝试（2026-11-06 10:22 用户纠正：福袋和红包同一排、位置不固定）
            // 先试有倒计时的、按剩余时间升序；无倒计时的排后面也要试。
            // ⚠ 判据是「点开后面板文案」，不是坐标、不是第几个图标：
            //   红包面板 → tryJoin 关面板并返回 packet-only → 继续试下一个候选；
            //   福袋面板 → joined / need-follow / fans-* 等 → 按原逻辑处理。
            //   只有所有候选都没弹出福袋面板、且至少见过一次红包，才收敛成 packet-skipped。
            const _all=(Array.isArray(d.fudaiAll)&&d.fudaiAll.length)?d.fudaiAll:[d.fudai];
            let _packetOnly=0;
            if(_followPass) for(let _i=0;_i<_all.length;_i++){
              const _f=_all[_i];
              if(_i>0) log(`  ↪ 尝试同排第 ${_i+1} 个图标（${_f.hasCd?'剩余 '+_f.sec+'s':'无倒计时'}）`);
              r=await tryJoin(tab,_f,`https://live.douyin.com/${g.room}`,d.online);
              // packet-only 是「这个位置是红包」的中间态，不写参与记录、不写长窗，
              //   继续找同排的福袋；否则一条 packet-only 会污染统计并锁死真福袋。
              if(r.result==='packet-only'){ _packetOnly++; r=null; continue; }
              // 🧒 看板：把这次福袋的类型/内容/结果写进 live 表
              try{
                const _f=d.fudai;
                upsertLiveRoom(g.room, {status: (r.result==='joined'||r.result==='maybe-joined')?'joined':'fudai',
                  fudai: _f ? {cd:_f.cd||'', sec:_f.sec??-1, expiresAt: (typeof _f.sec==='number'&&_f.sec>=0)?Date.now()+_f.sec*1000:0, type:fudaiTypeLabel(r.result), content:(r.panelText||'').replace(/\n/g,' ').slice(0,120), result:r.result} : null});
                writeLiveState(true);
              }catch(e){}
              rec(r);
              if(r.result==='joined'||r.result==='maybe-joined') break;
            }
            if(!r && _packetOnly>0){
              r={result:'packet-skipped',steps:['all-candidates-packet-only:'+_packetOnly],
                 url:`https://live.douyin.com/${g.room}`,online:d.online};
              rec(r);
              log(`  🧧 同排 ${_all.length} 个候选均为人气红包，按配置不抢`);
            }
            if(!r) r={result:'no-panel',steps:['no-candidate']};
            // 更新主播档案（记忆：这间房什么时候发过什么类型的福袋）
            await updateAnchor(g.room, (rooms.find(x=>x.room===g.room)||{}).host||'', r.result, new Date().toISOString());
            log('结果:',r.result,'|',JSON.stringify(r.steps));
            // 🧠 策略观测：参与结果与本次决策配对。joinMs 是「从进房到出结果」的耗时，
            //    与开奖结果一起构成「单位时间中奖期望」的分子与分母。
            recStrategy('join-result',{
              decisionId:roomStayId, room:g.room, online:d.online,
              result:r.result, steps:r.steps||[],
              secLeft:(d.fudai||{}).sec??-1, cd:(d.fudai||{}).cd||'',
              isVip:!!g.isVip, score:g.score, minOnline:getMinOnline(),
              joinMs:Date.now()-roomT0,
              followGate:FOLLOW_GATE, packetGrab:PACKET_GRAB
            });
            // 🔒 去重状态收敛到唯一出口（2026-11-05 18:42 事故修复）：
            //    - joined/maybe-joined：写 12 分钟长窗，清掉短冷却
            //    - packet-skipped：用户定稿「不抢人气红包」，这是终态而非参与失败，
            //      同样写 12 分钟长窗。否则 45s 短冷却会让同一个还在倒计时的红包被
            //      反复识别、反复截图、反复记 packet-skipped，污染统计并堆积截图。
            //    - 其余结果：不写长窗，只给 RETRY_COOLDOWN_MS 短冷却，让还活着的福袋能重试
            //    旧版在「发现福袋」时就写长窗，关注门禁一失败就把剩余 6分58秒 的福袋锁死 12 分钟。
            if(r.result==='joined'||r.result==='maybe-joined'||r.result==='packet-skipped'
               || r.result==='fans-skip-account' || r.result==='fans-skip-daytime'){
              // 🔴 2026-11-10 11:42：粉丝团跳过（账号策略/白天策略）也是「终态」——
              //    用户在白天明确不抢粉丝团，45s 短冷却只会让同一间房的粉丝团福袋
              //    被反复识别、反复开面板、反复跳过，纯属浪费巡房时间。
              //    故与 packet-skipped 同级处理：写 12 分钟长窗。
              HANDLED_TIME.set(g.room, Date.now());
              _RETRY_AT.delete(g.room);
              // 房间能抢到（或终态），说明关注链路对它有效，计数器清零重新计
              if(FOLLOW_MAX_FAILS>0) _FOLLOW_FAILS.delete(g.room);
            }else if(r.result==='need-follow' && FOLLOW_MAX_FAILS>0){
              // 🚫 2026-11-10 用户定稿：同房间关注拦截累计达 N 次 → 本轮跳过，不再 45s 撞墙。
              //    只对 need-follow 累加；换房间后该房间记录保留到长窗过期。
              const _n=(_FOLLOW_FAILS.get(g.room)||0)+1;
              _FOLLOW_FAILS.set(g.room, _n);
              if(_n>=FOLLOW_MAX_FAILS){
                // 达到阈值：写 12 分钟长窗（与「已参与」同级的跳过语义），清短冷却
                HANDLED_TIME.set(g.room, Date.now());
                _RETRY_AT.delete(g.room);
                log(`  🚫 关注拦截已达 ${_n}/${FOLLOW_MAX_FAILS} 次，本轮跳过该房间（12 分钟后再试）`);
              }else{
                _RETRY_AT.set(g.room, Date.now()+RETRY_COOLDOWN_MS);
                log(`  ⏳ 参与未成，${RETRY_COOLDOWN_MS/1000}s 后重试（关注拦截 ${_n}/${FOLLOW_MAX_FAILS}）`);
              }
            }else if(RETRY_COOLDOWN_MS>0){
              _RETRY_AT.set(g.room, Date.now()+RETRY_COOLDOWN_MS);
            }
            // 📌 待关注清单只在真正「需要关注而抢不到」时写，且文案按真实结果。
            //    旧版这里无条件写「参与成功」，实测 18:42:36 明明是 need-follow，
            //    should-follow.md 却记成参与成功，属数据不真实，已删除。

            // 📌 2026-11-05 起「参与成功后关注」已删除：
            //    关注改为抢福袋「之前」在主循环做（pre-follow），此处再做一次纯属冗余；
            //    且它读全局 followed-rooms.txt 会跨账号误判、面板遮罩下必然失败，
            //    历史上正是那 71 次失败日志的来源。
            // 🚪 连续粉丝团型 ≥5 次 → 该房间偏好粉丝团，提前换房
            if(r.result==='skip-fans'){
              fansStreak++;
              // 记录该房间发粉丝团型，累计≥2次后续排序降权
              // ⚠ 读写必须分开 try：文件不存在时 readFileSync 抛 ENOENT，
              //   以前两者同在一个 try 里会被 catch 吞掉，该文件永远建不出来、降权彻底失效
              let fm={};
              try{ fm=JSON.parse(fs.readFileSync(FANS_FILE,'utf8'))||{}; }catch(e){ fm={}; }
              fm[g.room]=(fm[g.room]||0)+1;
              try{ fs.writeFileSync(FANS_FILE, JSON.stringify(fm)); }catch(e){}
              if(fansStreak>=5){
                log(`🚪 该房间连续${fansStreak}次粉丝团型福袋，提前换房`);
                break;
              }
            } else {
              fansStreak=0;
            }
            // 关注型福袋抢不到时记进待关注清单，手动关注后下次就能抢了
            if(r.result==='need-follow'){
              try{
                const sf=W+'/should-follow.md';
                let txt='';
                try{ txt=fs.readFileSync(sf,'utf8'); }catch(e){ txt=''; }
                if(!txt.includes(g.room)){
                  if(!txt) txt='# 待手动关注的主播\n\n这些是需要关注才能参与、但自动关注未验证通过的直播间，建议在抖音 App 里手动关注。\n\n';
                  txt += `- [ ] ${disp(g.room)}  —  ${new Date().toLocaleString('zh-CN')} 关注未验证通过，未参与\n`;
                  fs.writeFileSync(sf, txt);
                }
              }catch(e){}
              // ⚠ 不再硬编码「被平台风控拦截」：本次并未观测服务端响应，
              //    真实原因可能是页面刚重建 UI 未刷新完。诊断字段在 exec-actions.jsonl。
              const _how=(r.followDiag&&r.followDiag.verifyHow)||'unknown';
              log(`📌 ${disp(g.room)} 关注未验证通过(${_how})，本轮未参与；已加入待关注清单，${RETRY_COOLDOWN_MS/1000}s 后可重试`);
            }
            if(r.result==='joined'||r.result==='maybe-joined'){
              log(`✅✅ 参与成功(${r.result})！守候开奖`);
              // 该房间发过可抢型福袋，清除粉丝团惩罚
              try{
                const fm=JSON.parse(fs.readFileSync(FANS_FILE,'utf8'))||{};
                if(fm[g.room]){ delete fm[g.room]; fs.writeFileSync(FANS_FILE, JSON.stringify(fm)); }
              }catch(e){}
              try{
                let dm={}; try{ dm=JSON.parse(fs.readFileSync(DRY_FILE,'utf8'))||{}; }catch(e){ dm={}; }
                if(dm[g.room]){ delete dm[g.room]; fs.writeFileSync(DRY_FILE, JSON.stringify(dm)); }
              }catch(e){}
              // 🔑 严格检测开奖：只看居中浮层（弹窗），排除聊天区弹幕
              // 守候时长按福袋剩余倒计时动态算（wait-config.json 的 draw* 三项），不受 scale 影响。
              // 2026-11-05 实测：64 次检出弹窗全部比倒计时归零提前 11~44s，零延迟；
              // 旧的固定 +180 冗余只在漏检时白等（53 次平均 181s），收紧到 drawBufferSec=60。
              // 检出弹窗立即 break，所以冗余只影响「检测漏判」时的巡房频率，不影响正常开奖。
              const waitSec=(typeof secLeft==='number'&&secLeft>0)
                ? Math.min(DRAW_MAX,secLeft+DRAW_BUF) : DRAW_FALLBACK;
              const waitLoops=Math.max(24,Math.ceil(waitSec/5));
              log(`  守候开奖 ${waitLoops*5}s（福袋剩余 ${secLeft}s，冗余 ${DRAW_BUF}s）`);
              // 💬 弹幕调度（2026-11-11 11:37 拟人化，用户「太像人机」后定稿）。
              //    旧版固定 60~90 秒准点从 8 个通用短句里纯随机抽，同房间反复发同一个词、
              //    整段瞬间灌入，一眼机器人。现在四点改法：
              //      ① 首次延迟与间隔都按配置的 min/max 随机，不再写死 60 秒起；
              //      ② 到期点按 skipChance 概率跳过——真人不会每个间隔都准点说话；
              //      ③ 按直播间类型挑相关短句，且同房间发过的不再重复（_danmuSentByRoom）；
              //      ④ 文案池用尽就停发本轮，不硬凑。
              //    仍只在开奖检测之前发、检出弹窗立即 break，弹幕随之自然停止。
              let _danmuDue=DANMU_MIN+Math.floor(Math.random()*(DANMU_MAX-DANMU_MIN+1));
              let _danmuCount=0;
              let _danmuCat=null, _danmuCatPicked=false, _danmuExhausted=false;
              for(let i=0;i<waitLoops;i++){
                // 先发弹幕再检测开奖：文案已过滤开奖关键词，实测不会触发误判
                const _elapsed=(i+1)*5;
                if(DANMU_ENABLED && DANMU_FOR_THIS && !_danmuExhausted
                   && _danmuCount<DANMU_MAX_PER_WAIT && _elapsed>=_danmuDue){
                  if(Math.random()<DANMU_SKIP){
                    log(`  💬 弹幕到期但跳过（拟人节奏，skipChance=${DANMU_SKIP}）`);
                  }else{
                    // 分类每轮守候只推断一次，避免每 5 秒都发一次 CDP 求值
                    if(!_danmuCatPicked){ _danmuCatPicked=true; _danmuCat=await pickDanmuCategory(tab); }
                    const _txt=pickDanmuText(g.room,_danmuCat);
                    if(_txt){
                      const _catTag=_danmuCat?_danmuCat.name:'通用';
                      const _d=await sendDanmu(tab,g.room,_txt);
                      if(_d.sent){ _danmuCount++; log(`  💬 弹幕类型: ${_catTag}`); }
                    }else{
                      _danmuExhausted=true;
                      log(`  💬 该房间文案已用尽，本轮不再发弹幕`);
                    }
                  }
                  _danmuDue=_elapsed+DANMU_MIN+Math.floor(Math.random()*(DANMU_MAX-DANMU_MIN+1));
                }
                await sleep(5000);
                let dr=await ev(tab,`(()=>{
                  // 🎯 开奖结果识别（2026-11-04 第二次修复，根因是几何筛选而非文案）
                  //    实测截图：抖音开奖弹窗是「全屏遮罩 fixed（宽约 1120）+ 内部 static 白框」，
                  //    旧实现只扫 position:fixed/absolute 的 div 且要求 width<=950，
                  //    于是遮罩超宽被跳过、白框 static 被跳过 → 39 次守候 0 条记录。
                  //    独立 Chrome 交叉验证：仅保留该结构时旧版 found:false，放宽版 found:true。
                  //    现在改为「文案命中优先」：先找含开奖文案且位于屏幕中部的元素，
                  //    几何只做排除聊天区的辅助条件，不再卡 position / z-index / 宽度上限。
                  for(const d of document.querySelectorAll('div,section,aside')){
                    try{
                      var t=(d.innerText||'').trim();
                      if(!t||t.length>400)continue;
                      // ⚠ 本段整体包在模板字符串里，任何裸的反斜杠 n 都会被先解释成真实换行，
                      //    导致正则或注释断裂、Runtime.evaluate 抛 SyntaxError、ev 返回 __err。
                      //    2026-11-04 实测 39 次守候 0 记录即此因。故这里一律写双反斜杠。
                      var isWin = /恭喜[^。\\n]{0,10}(中奖|获得)|中奖通知|已中奖|恭喜你.{0,6}奖|获得.{0,8}(福袋|奖励|红包)/.test(t);
                      var isLose = /没抽中|未中奖|没有中奖|很遗憾|送你一个好运|下次再来|再接再厉/.test(t);
                      if(!(isWin||isLose))continue;
                      var r=d.getBoundingClientRect();
                      if(r.width<120||r.height<60)continue;
                      var cx=r.x+r.width/2;
                      // 屏幕中部：排除右侧聊天区，但允许全屏遮罩（cx 可能偏左）
                      if(cx<window.innerWidth*0.15||cx>window.innerWidth*0.85)continue;
                      // 命中即返回：外层遮罩也会包含这段文案，但它同样是有效信号，
                      // 记录与关弹窗都不依赖具体是哪一层。
                      return {found:true, win:isWin, lose:isLose,
                              w:Math.round(r.width), h:Math.round(r.height),
                              text:t.split('\\n').join('|').slice(0,200)};
                    }catch(e){}
                  }
                  return {found:false};
                })()`,25000);
                // 🔴 2026-11-09 20:22 活锁自愈：CDP WebSocket 半断开时 ev 会一路超时，
                //    守候循环看似在跑实则零推进（实测主号 5 分钟无日志）。
                //    检测到连接已死就重连当前 tab 并立刻重试本次检测，不再空等到超时。
                if(dr && dr.__err && /ws-dead|ws-send-fail/.test(String(dr.__err))){
                  try{
                    log(`  🔌 开奖检测连接已断(${String(dr.__err).slice(0,40)})，重连中…`);
                    const pages=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
                    const pg=pages.find(x=>x.type==='page'&&/live\.douyin\.com/.test(x.url||''));
                    if(pg && pg.webSocketDebuggerUrl){
                      tab.cdp=await conn(pg.webSocketDebuggerUrl);
                      log(`  ✅ 已重连 CDP，继续守候`);
                      dr=await ev(tab,`(()=>{var b=document.body&&document.body.innerText||'';return {found:false,len:b.length}})()`,15000);
                    }
                  }catch(e){ log(`  ⚠️ 重连失败: ${String(e.message).slice(0,60)}`); }
                }
                // 表达式本身报错时必须留痕，否则又是「静默漏判 39 次」那种黑盒
                if(dr && dr.__err && i%12===0) log(`  ⚠️ 开奖检测表达式异常: ${String(dr.__err).slice(0,120)}`);
                if(dr && dr.found){
                  const _win=!!dr.win;
                  log(_win?'🏆 中奖弹窗:':'📭 未中奖弹窗:', JSON.stringify(dr).slice(0,220));
                  const _rec={account:ACCOUNT_TAG, room:g.room, win:_win,
                              text:(dr.text||'').slice(0,200), at:new Date().toISOString(),
                              decisionId:roomStayId, waitedSec:i*5, plannedWaitSec:waitLoops*5};
                  try{
                    fs.appendFileSync(_win?WINS:LOSSES, JSON.stringify(_rec)+'\n');
                  }catch{}
                  // 🎉 2026-11-10 16:17 用户定稿「如果中奖了，就要通过server酱给我发消息」：
                  //    只在真中奖（_win=true）时推送，未中奖不打扰。
                  //    推送是旁路：spawn 独立进程、stdio 忽略、unref 脱离，
                  //    失败也不影响抓取主流程（异常只记日志）。
                  if(_win){
                    try{
                      const _p=spawn(process.execPath,[
                        ROOT+'/scripts/notify-serverchan.mjs','--win',
                        '--room',String(g.room),
                        '--text',String((dr.text||'').slice(0,300))
                      ],{detached:true,stdio:'ignore'});
                      _p.unref();
                      log('  📱 中奖推送已发起（Server酱）');
                    }catch(e){
                      log('  ⚠️ 中奖推送失败: '+String(e.message).slice(0,80));
                    }
                  }
                  // 🧠 策略观测：开奖结果是「单位时间中奖期望」的分子。
                  //    decisionId 与 room-enter / join-result 串联，可算出
                  //    「这间房这次投入了多少秒、换回一次中奖/未中奖」。
                  recStrategy('draw-result',{
                    decisionId:roomStayId, room:g.room, win:_win,
                    waitedSec:i*5, plannedWaitSec:waitLoops*5,
                    secLeft, online:d.online, isVip:!!g.isVip,
                    totalStaySec:Math.round((Date.now()-roomT0)/1000)
                  });
                  if(_win) await shot(tab,`h35-DRAW-${Date.now()}.png`);
                  // 🔴 必须关掉弹窗：实测「没抽中福袋」弹窗会一直挡在屏幕中央，
                  //    不关的话后续换房检测、福袋扫描都会被它遮住。
                  try{
                    const cpos=await ev(tab,`(()=>{
                      for(const el of document.querySelectorAll('div,span,button')){
                        var t=(el.innerText||'').trim();
                        if(t!=='知道了' && t!=='确定' && t!=='关闭') continue;
                        var r=el.getBoundingClientRect();
                        if(r.width<40||r.height<20||r.width>320) continue;
                        return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),t:t});
                      }
                      return null;
                    })()`,10000);
                    if(cpos){ const cp=JSON.parse(cpos); await clickXY(tab,cp.x,cp.y); await sleep(1200); }
                  }catch(e){}
                  break;
                }
                if(i%12===0 && i>0) log(`  守候开奖中 ${i*5}s`);
              }
              // 📸 守候结束必截图（无论是否检测到弹窗）。
              //    这是可观测性兜底：中奖检测靠文案匹配，一旦文案改版就会静默漏判，
              //    有了这张图至少能事后人工核对「到底中没中」。
              try{ await shot(tab,`h35-DRAWEND-${g.room}-${Date.now()}.png`); }catch(e){}
              // 🔁 守完开奖后重置停留预算：继续留在本房间等下一个福袋（用户定稿不设轮数上限）。
              //    不重置的话 elapsed 已含守候的 245~660s，远超 perMs(60s)，while 会立即退出换房。
              //    每抢一轮就重置一次，只要 POST_DRAW_MS 窗口内还有新福袋就一直循环。
              if(POST_DRAW_MS>0){
                postDrawRound++;
                t0=Date.now(); stayBudget=POST_DRAW_MS; nextDiag=30000;
                // ⚠ 不在这里立刻 delete 去重记录：实测开奖弹窗比倒计时归零提前 11~44s，
                //    此刻旧福袋图标可能仍在页面上，立刻解锁会把同一个旧福袋再抢一次。
                //    改为置标志位，等下面 SCAN 观察到 candCount===0（旧图标消失）后再解锁。
                postDrawUnlockPending=true;
                log(`  🔁 开奖后再蹲 ${POST_DRAW_MS/1000}s 看有没有新福袋（第 ${postDrawRound} 轮，不设上限）`);
              }
            }
            handled=true;
            await sleep(5000);
          } else {
            await sleep(2000);
          }
          const elapsed=Date.now()-t0;

          // 🚪 人气跌破门槛一半 → 房间已冷，提前换（实测采集时 5546 人，
          //    12 分钟内跌到 869，继续守只是浪费时间）
          // 🚪 进房后人数远低于采集值 → 立即换房（采集快照已过时）
          //    实测 192 个样本里 7 个（4%）进房后人数不足采集值一半，
          //    最极端的 805985783749 采集显示 1 万、进房实际只有 24 人——
          //    若还按原来的 60 秒门槛判断，会在这种空房里白白守着。
          //    用 30% 作为阈值（跌七成以上才算异常），避免把正常波动误判。
          //    vipExempt=false（硬卡）时低人气 VIP 同样立即换房，不白等一整轮常驻。
          if(!handled && !(VIP_EXEMPT && g.isVip) && elapsed>20000 && typeof d.online==='number' && d.online>=0
             && g.online>0 && d.online < g.online*0.3){
            log(`🚪 进房实际${d.online}人，远低于采集值${g.online}（跌${Math.round((1-d.online/g.online)*100)}%），立即换房`);
            break;
          }

          //    ⚠ 2026-11-05 硬卡：跌破门槛一半就走，VIP 不再豁免。
          //    ⚠ 2026-11-05 循环蹲守：守完开奖后 handled 恒为 true，若不把 postDrawRound>0
          //       纳入判据，房间冷到门槛一半以下仍会一直死守到 2 分钟窗口结束。
          if((!handled || postDrawRound>0) && !(VIP_EXEMPT && g.isVip) && elapsed>60000 && typeof d.online==='number' && d.online>=0
             && d.online < getMinOnline()*0.5){
            log(`🚪 在线${d.online}已跌破门槛${getMinOnline()}的一半，提前换房`);
            break;
          }

          // 🚪 无福袋提前换房：基准值来自 wait-config.json，再乘 scale。
          //    ⚠ 配置时需保证乘完的阈值 >= 常驻时长，否则循环会自然到期换房，
          //      本分支主要用于「常驻时长因故被拉长」的场景，属兜底。
            const _proven=((anchors[g.room]||{}).joinable||0)>0;
            const noFudaiMs = Math.round(WS*((g.isVip && _proven) ? Math.max(_WAIT.noFudaiVipMinMs, perMs/WS) : _WAIT.noFudaiNormalMs));
          if(!handled && elapsed>noFudaiMs && (d.candCount||0)===0){
              log(`🚪 常驻${Math.floor(elapsed/1000)}s无福袋，提前换房`);
            break;
          }
          // 每 30 秒输出诊断
          const el2=Date.now()-t0;
          if(el2>=nextDiag){
            nextDiag=el2+30000;
            log(`  [诊断${Math.floor(el2/1000)}s] ${disp(g.room)} 在线${d.online} candCount=${d.candCount} fErr=${d.fErr} 长度=${d.len} ${d.loading?'loading':''}`);
          }
        }
        if(!handled){
          log(`${g.room} 时段内无福袋`);
          try{
            let dm={}; try{ dm=JSON.parse(fs.readFileSync(DRY_FILE,'utf8'))||{}; }catch(e){ dm={}; }
            dm[g.room]=(dm[g.room]||0)+1;
            fs.writeFileSync(DRY_FILE, JSON.stringify(dm));
          }catch(e){}
        }
        // 🧠 策略观测：房间常驻结束。这是「单位时间」分母的另一端。
        //    空手房间没有 join-result / draw-result，只有这条能证明「时间花在哪、有没有回报」。
        //    postDrawRound 记录开奖后循环蹲了几轮，用于评估 postDrawWaitSec 的真实收益。
        recStrategy('room-exit',{
          decisionId:roomStayId, room:g.room, online:g.online,
          isVip:!!g.isVip, score:g.score, minOnline:getMinOnline(),
          stayedSec:Math.round((Date.now()-roomT0)/1000),
          hadFudai:!!handled, postDrawRound,
          plannedStaySec:Math.round(perMs/1000)
        });
        _gateLogged.delete(roomStayId);   // 清掉本次常驻的去重状态，避免 7×24 Map 泄漏
      }
    }
  }catch(e){log('FATAL',e.message);}
  finally{try{chrome.kill('SIGKILL');}catch{} process.exit(0);}
})();
