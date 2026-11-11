#!/usr/bin/env node
/**
 * 抖音福袋 · 本地看板
 *
 * 启动：node web/server.mjs [端口]     默认 8899
 * 访问：http://127.0.0.1:8899
 *
 * 零依赖，只用 Node 内置 http。页面每 15 秒自动刷新。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

// 📅 本地时区日期（YYYY-MM-DD）。
//    ⚠ 不能用 new Date().toISOString().slice(0,10)——那是 UTC 日期，
//    北京 00:00-08:00 期间 UTC 还停在前一天，会导致「今日战果」全部算错。
//    2026-11-04 00:57 实际踩过：北京已 04 号凌晨，统计却还在算 03 号。
const localDay = (d = new Date()) => {
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return t.toISOString().slice(0, 10);
};

// 📅 判断一条记录的 at 时间戳是否属于「本地某一天」。
//    ⚠ 数据里的 at 是 UTC ISO 字符串（2026-11-03T16:09Z），直接 startsWith('2026-11-04')
//    会漏掉北京时间 0-8 点的记录——它们 UTC 日期还是前一天。
//    2026-11-04 00:59 实际踩过：0点抢到的 4 个福袋一个都没算进「今日」。
const isLocalDay = (isoStr, day = localDay()) => {
  if (!isoStr) return false;
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return false;
  return localDay(d) === day;
};

// 🌍 跨平台：路径统一走 paths.mjs（打包后 ROOT 是 exe 所在目录）
import { APP_ROOT } from '../scripts/paths.mjs';
const ROOT = APP_ROOT;
// ⚠ 端口解析容错（2026-11-04）：绿色版通过 `app.mjs web` 启动，
//    此时 process.argv[2] 是字符串 'web'，Number('web')=NaN 会让 listen 直接失败。
//    只有「正的有限数字」才认作端口，其余一律回退 8899。
const _argvPort = Number(process.argv[2]);
const PORT = Number(process.env.DY_WEB_PORT) ||
  (Number.isFinite(_argvPort) && _argvPort > 0 ? _argvPort : 8899);

const PATHS = {
  accounts: path.join(ROOT, 'accounts'),
  data: path.join(ROOT, 'data'),
  participations: path.join(ROOT, 'data', 'participations.jsonl'),
  wins: path.join(ROOT, 'data', 'wins.jsonl'),
  legacy: path.join(ROOT, 'douyin-auto', 'h35-results.jsonl'),
  // 🔴 2026-11-10 19:18 用户指着看板质问「日志时间不对」后修：
  //    主实例改用 `--account main` 后日志写到 accounts/main/work/h35.log，
  //    而这里仍指向 douyin-auto/h35.log —— 那个文件从 10:31 起就冻结了
  //    （尾部还是 cache-cleaner 的 SKIP 行），
  //    于是看板「最近日志」一直显示上午 09:56 的旧内容，与真实时间差 9 小时。
  //    改为 getter：每次访问都按 mtime 选最新的那个日志，新旧布局都兼容。
  get log() {
    const _cands = [
      path.join(ROOT, 'accounts', 'main', 'work', 'h35.log'),
      path.join(ROOT, 'accounts', 'main3', 'work', 'h35.log'),
      path.join(ROOT, 'douyin-auto', 'h35.log'),
    ];
    let _best = _cands[2], _m = -1;
    for (const c of _cands) {
      try { const st = fs.statSync(c); if (st.mtimeMs > _m) { _m = st.mtimeMs; _best = c; } } catch {}
    }
    return _best;
  },
  roundCounter: path.join(ROOT, 'douyin-auto', 'round-counter.txt'),
};

// 🧒 婴童过滤 + 门槛 + 指定主播：网页设置用，单一数据源与抓取侧共用。
function readLive(){
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live-rooms.json'), 'utf8')) || {};
    return { updatedAt: j.updatedAt || '', updatedTs: j.updatedTs || 0, rooms: Array.isArray(j.rooms) ? j.rooms : [], active: Array.isArray(j.active) ? j.active : [] };
  } catch { return { updatedAt: '', updatedTs: 0, rooms: [], active: [] }; }
}
function readJsonFile(p, fallback){
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) || fallback; } catch { return fallback; }
}
function writeJsonFile(p, obj){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}
function readConfig(){
  const categoryFilter = readJsonFile(path.join(ROOT, 'data', 'category-filter.json'), { enabled: true, mode: 'only', keywords: ['母婴','婴童','宝宝','婴儿','奶粉','纸尿裤','尿不湿','童装','童鞋','辅食','婴儿车','儿童','妈妈','宝妈','孕妇','育儿','亲子'], bonus: 20, noThreshold: true, preferSmallRooms: true, skipFansGroup: true });
  const threshold = readJsonFile(path.join(ROOT, 'data', 'threshold.json'), { day: 8000, night: 50000, nightStart: 19, nightEnd: 24 });
  const pinned = readJsonFile(path.join(ROOT, 'data', 'pinned-hosts.json'), {});
  return { categoryFilter, threshold, pinned };
}
function writeConfig(body){
  if (body.categoryFilter) {
    const cf = body.categoryFilter;
    const keywords = Array.isArray(cf.keywords) ? cf.keywords.map(x => String(x || '').trim()).filter(Boolean)
      : String(cf.keywords || '').split(/[,，、\n]/).map(x => x.trim()).filter(Boolean);
    if (!keywords.length) throw new Error('关键词不能为空，至少填一个');
    if (keywords.length > 40) throw new Error('关键词最多 40 个');
    writeJsonFile(path.join(ROOT, 'data', 'category-filter.json'), {
      enabled: cf.enabled !== false,
      mode: cf.mode === 'off' ? 'off' : 'only',
      keywords,
      bonus: Math.max(0, Math.min(50, Number(cf.bonus) || 20)),
      noThreshold: cf.noThreshold !== false,
      preferSmallRooms: cf.preferSmallRooms !== false,
      skipFansGroup: cf.skipFansGroup !== false,
    });
  }
  if (body.threshold) {
    const t = body.threshold;
    const day = Number(t.day), night = Number(t.night);
    if (!Number.isFinite(day) || day < 0 || !Number.isFinite(night) || night < 0) throw new Error('门槛必须是大于等于 0 的数字');
    const cur = readJsonFile(path.join(ROOT, 'data', 'threshold.json'), {});
    writeJsonFile(path.join(ROOT, 'data', 'threshold.json'), { ...cur, day, night, nightStart: Number(t.nightStart) || 19, nightEnd: Number(t.nightEnd) || 24 });
  }
  if (body.pinned) {
    // 前端传两种格式都认：对象 {抖音号:{name,hours,tier}} 或文本行 "抖音号,名字,20,21"
    let pinned = {};
    if (typeof body.pinned === 'string') {
      for (const line of body.pinned.split('\n')) {
        const parts = line.split(',').map(x => x.trim()).filter(Boolean);
        if (parts.length < 2) continue;
        const hours = parts.slice(2).map(x => Number(x)).filter(x => Number.isFinite(x) && x >= 0 && x < 24);
        pinned[parts[0]] = { name: parts[1], hours, tier: 'pinned' };
      }
    } else if (body.pinned && typeof body.pinned === 'object') {
      pinned = body.pinned;
    }
    writeJsonFile(path.join(ROOT, 'data', 'pinned-hosts.json'), pinned);
  }
  return readConfig();
}

function readJsonl(p) {
  const out = [];
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

const IS_WIN = process.platform === 'win32';

function procInfo() {
  // Windows 没有 `ps`/`grep`：用 tasklist 拿 node.exe 进程，标注为 default。
  // 拿不到就返回空数组，看板会显示「未检测到抓取进程」而不是整个 API 500。
  // 🔴 2026-11-09 20:15：本机 TCC 限制后 `ps` 变成 `Operation not permitted`，
  //    `|| true` 把错误吞成空字符串 → procInfo 返回 [] → 看板把两个明明在跑的
  //    实例标成「已停止」，而抓取与端口都正常。加 pgrep 兜底（本环境实测可用）。
  try {
    const cmd = IS_WIN
      ? 'tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH'
      : "ps -eo pid,etime,args | grep -F 'node hunter35.mjs' | grep -v grep 2>/dev/null || true";
    let out = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    if (!out && !IS_WIN) {
      // ps 被系统拒绝或返回空：改用 pgrep，输出格式 "PID args"
      try {
        out = execSync("pgrep -fl 'node hunter35.mjs' 2>/dev/null || true",
          { encoding: 'utf8', timeout: 5000 }).trim();
      } catch { out = ''; }
    }
    if (!out) return [];
    if (IS_WIN) {
      return out.split('\n').filter((l) => /"node\.exe"/i.test(l)).map((l) => {
        const cells = l.split('","');
        return { pid: (cells[1] || '').replace(/"/g, ''), uptime: '-', account: 'default' };
      });
    }
    return out.split('\n').map((l) => {
      const parts = l.trim().split(/\s+/);
      // ps 输出首列 PID、次列 etime；pgrep -fl 首列 PID 后直接是 args
      const isPs = /^\d+\s+\S+:\S+/.test(l.trim()) || /^\d+\s+\d+-\d+:/.test(l.trim());
      const pid = parts[0];
      const etime = isPs ? parts[1] : '-';
      const accMatch = l.match(/--account\s+(\S+)/);
      return { pid, uptime: etime, account: accMatch ? accMatch[1] : 'default' };
    });
  } catch { return []; }
}

function chromePorts() {
  try {
    // ⚠ 必须限定本项目的调试端口范围：主实例 9750，账号实例 9751-9769。
    //   不加范围会把外部 Chrome 也算进来——实测验证看板布局时临时起的截图
    //   Chrome（9770）被误算成系统端口，顶部徽章凭空显示「9750,9770」。
    // 🔴 2026-11-09 20:23：`ps` 在本机已成 `Operation not permitted`，
    //    `|| true` 吞成空串 → ports=[] → 顶部徽章显示「端口 无」。
    //    改为优先 ps，无结果时用 lsof 直接探测 9750-9769 监听端口。
    let out = IS_WIN
      ? ''   // Windows 没有 ps；端口徽章留空，不影响看板主体
      : execSync("ps -eo args | grep -F 'remote-debugging-port=' | grep -v grep 2>/dev/null || true").toString();
    let ports = [...out.matchAll(/remote-debugging-port=(\d+)/g)].map((m) => Number(m[1]));
    if (!ports.length && !IS_WIN) {
      try {
        const lw = execSync('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || true',
          { encoding: 'utf8', timeout: 6000 });
        ports = [...lw.matchAll(/:(\d{4})\s+\(LISTEN\)/g)].map((m) => Number(m[1]));
      } catch {}
    }
    return ports
      .filter((v) => v >= 9750 && v <= 9769)
      .filter((v, i, a) => a.indexOf(v) === i).sort();
  } catch { return []; }
}

function accountsInfo() {
  if (!fs.existsSync(PATHS.accounts)) return [];
  return fs.readdirSync(PATHS.accounts, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(PATHS.accounts, d.name, 'meta.json'), 'utf8')); } catch {}
      return {
        name: d.name,
        displayName: meta.displayName || d.name,
        nickname: meta.nickname || '',
        douyinId: meta.douyinId || '',
        loginOk: meta.loginOk !== false,   // 由 account-manager 登录成功后写入
        port: meta.port || null,
        lastLogin: meta.lastLogin || null,
        hasProfile: fs.existsSync(path.join(PATHS.accounts, d.name, 'profile')),
      };
    });
}

/**
 * 账号显示名统一映射（2026-11-04 多账号「数据混乱」修复）。
 *
 * 根因：同一个主账号在数据里叫 default、在实例列表里叫 main、在 UI 里叫「主实例」，
 * 三套代号并存，用户根本无法把一条参与记录对应到具体抖音号。
 * 统一规则：内部 key 保持不动（不改动历史数据），只在展示层翻译成
 * 「昵称」+「抖音号后 4 位」，例如 主播A(1234) / 主播B(5678)。
 */
function accountLabels(accs) {
  const map = {};
  for (const a of accs) {
    const id = a.douyinId || '';
    const tail = id.length >= 4 ? id.slice(-4) : '';
    const label = (a.nickname || a.displayName || a.name) + (tail ? '(' + tail + ')' : '');
    map[a.name] = { label, nickname: a.nickname || a.displayName || a.name, douyinId: id, color: '' };
  }
  // 两个号用不同颜色，避免同房间两条记录看起来一样
  const colors = ['#4f9cf9', '#f0a03c', '#59c98a', '#c58af9'];
  let i = 0;
  for (const k of Object.keys(map)) map[k].color = colors[i++ % colors.length];
  // 主实例在数据里叫 default，但它实际就是 accounts/main 这个号：
  // 同一个号必须共用同一个标签和同一种颜色，不能出现两个样子
  if (map.main) map.default = map.main;
  return map;
}

function labelOfAccount(acc, labels) {
  const k = acc || 'default';
  const v = labels[k];
  return v ? v.label : (k === 'default' ? '主实例' : k);
}

/**
 * 从日志尾部反查「当前房间 + 在线人数」。
 *
 * 2026-11-04 修复：VIP 房主动探测阶段常拿到 online=-1，常驻行就写成
 * 「=== 常驻 132810378938（在线-1 VIP）」，但常驻后的诊断/福袋行里有真实值
 * （如「★★ 福袋! 在线20000」）。原来一匹配到 -1 就停，卡片显示「在线 -」。
 * 现在初判为 -1 时，继续在同一房间的后续行里找最新有效在线数回填。
 */
function parseCurrentRoom(lines) {
  const tail = lines.slice(-80);
  let room = null, online = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    let m = line.match(/=== 常驻 .*?\((\d{6,})\)（在线(-?\d+)/)
         || line.match(/=== 常驻 (\d{6,})（在线(-?\d+)/);
    if (m) { room = m[1]; online = Number(m[2]); break; }
    m = line.match(/诊断\d+s\] .*?\((\d{6,})\) 在线(-?\d+)/)
      || line.match(/诊断\d+s\] (\d{6,}) 在线(-?\d+)/);
    if (m) { room = m[1]; online = Number(m[2]); break; }
  }
  if (room !== null && (online === null || online < 0)) {
    // 只在该房间相关的行里找，且从最新往前，避免拿错别的房间的人数
    for (let i = tail.length - 1; i >= 0; i--) {
      const line = tail[i];
      if (!line.includes(room)) continue;
      const m = line.match(/在线\s*(\d+(?:\.\d+)?)\s*(万)?/);
      if (m) {
        const n = Number(m[1]) * (m[2] === '万' ? 10000 : 1);
        if (n >= 0) { online = Math.round(n); break; }
      }
    }
  }
  return { room, online };
}

/**
 * 多实例状态聚合：默认实例（douyin-auto）+ 每个启用账号的实例（accounts/<名字>/work）。
 *
 * 为什么必须单独做：账号模式把日志与结果写到 accounts/<名字>/work，
 * 而看板主视图只读 douyin-auto/。第二个账号跑起来后在主视图里完全隐形，
 * 用户加了账号却看不到它在盯哪个房间、今天参与了几次，等于白加。
 */
function instancesInfo(procs, todayRowsByAcc) {
  const list = [];
  const add = (key, label, account, port, workDir) => {
    const log = path.join(workDir, 'h35.log');
    let logAgeSec = null, currentRoom = null, currentOnline = null, lastLine = '', linesN = 0;
    try {
      logAgeSec = Math.round((Date.now() - fs.statSync(log).mtimeMs) / 1000);
      const all = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      linesN = all.length;
      const parsed = parseCurrentRoom(all);
      currentRoom = parsed.room;
      currentOnline = parsed.online;
      lastLine = all.slice(-1)[0] || '';
    } catch {}
    // ⚠ 2026-11-04「数据混乱」修复：实例卡片原读各自的 h35-results.jsonl，
    //    那份文件写入时没带 account，且和全局 participations.jsonl 口径不一致，
    //    导致实例卡片数字与主统计打架（56+10 vs 66）。现在统一用全局权威数据源按账号过滤。
    const rows = todayRowsByAcc[account] || [];
    const joinedN = rows.filter((r) => r.result === 'joined' || r.result === 'maybe-joined').length;
    // 主实例可能与 --account main 是同一个账号的两种启动方式，两种都算它
    const matchAcc = key === 'default' ? ['default', 'main'] : [account];
    const p = procs.find((x) => matchAcc.includes(x.account));
    list.push({
      key, label, account, port,
      running: !!p,
      pid: p ? p.pid : null,
      uptime: p ? p.uptime : null,
      logAgeSec, currentRoom, currentOnline,
      lastLine: String(lastLine).slice(0, 180),
      logLines: linesN,
      today: rows.length,
      todayJoined: joinedN,
    });
  };

  add('default', '主实例', 'main', 9750, path.join(ROOT, 'douyin-auto'));
  if (fs.existsSync(PATHS.accounts)) {
    for (const d of fs.readdirSync(PATHS.accounts, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const name = d.name;
      if (name === 'main') continue;   // 主账号由 default 实例代表，避免重复
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(PATHS.accounts, name, 'meta.json'), 'utf8')); } catch {}
      if (meta.enabled === false) continue;
      add('acc:' + name, meta.nickname || name, name, meta.port || null, path.join(PATHS.accounts, name, 'work'));
    }
  }
  return list;
}

/**
 * 执行能力统计：粉丝团加入、关注主播的「今日真实到位」次数。
 *
 * 2026-11-05 14:10 口径重构（用户指出「数据不真实、要真实到位」）：
 *   旧版用日志正则统计，但 h35.log 跨天复用、149 次启动、无日期字段，
 *   且 fans-join:joinBtn（参与按钮就位、加入未确认）被当成成功 →
 *   显示 24/28 86% 却 0 钻，自相矛盾；关注 19/91 是历史累计而非今日。
 *   改为读 data/exec-actions.jsonl（每条带 at/account/action/ok），按本地日过滤。
 *   文件不存在时全部为 0，不补造历史 —— 0 就是 0，真实优先于好看。
 *
 * 口径：今日 00:00 起（本地时区），粉丝团只认 ok=true（验证通过才算真加入）。
 */
function execStats() {
  const out = { fansTry:0, fansOk:0, fansFail:0, followTry:0, followOk:0, followFail:0,
                followUnknown:0, coins:0, wins:0, losses:0 };
  const today = localDay();
  const rows = (file) => {
    try {
      const p = path.join(ROOT, 'data', file);
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  };

  // 粉丝团 / 关注：只认带 at 的真实记账
  //    ⚠ 2026-11-06 修：历史 joinBtn 记录写的是 ok=false，但参与按钮就位即代表
  //      真加入成功（49 次对应 participations 全部 result=joined，且已补记 1 钻消费）。
  //      写账时把 ok 判错的是旧验证表达式（51 次 __err），不是执行本身失败。
  //      这里按 state 折算，**不改写 exec-actions.jsonl 任何一行**，原始观测完整保留。
  const fansRealOk = (r) => !!r.ok || r.state === 'joinBtn';
  for (const r of rows('exec-actions.jsonl')) {
    if (!isLocalDay(r.at, today)) continue;
    if (r.action === 'fans') {
      out.fansTry++;
      if (fansRealOk(r)) out.fansOk++; else out.fansFail++;
    } else if (r.action === 'follow') {
      out.followTry++;
      if (r.ok) out.followOk++;
      else if (r.state === 'inconclusive') out.followUnknown++;
      else out.followFail++;
    }
  }

  // 开奖结果：同样改今日口径，避免与「今日战绩」混用两套时间范围
  out.wins   = rows('wins.jsonl').filter((r) => isLocalDay(r.at, today)).length;
  out.losses = rows('losses.jsonl').filter((r) => isLocalDay(r.at, today)).length;

  // 抖币消耗：按记录里的 coins 求和（不是数行数），与真实加入成功同源。
  //    ⚠ 2026-11-06 修：旧写法数「行数」，若一条记录 coins=2 会少算；
  //    且 coin-spend.jsonl 曾因记账判据 bug 从未生成，文件不存在就是 0，不补造。
  out.coins = rows('coin-spend.jsonl')
    .filter((r) => isLocalDay(r.at, today))
    .reduce((n, r) => n + (Number(r.coins) || 0), 0);
  return out;
}

function loadNames() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'room-names.json'), 'utf8')) || {}; } catch { return {}; }
}

/** 按「房间 + 6 分钟窗口」去重（旧逻辑同一福袋会重复记录） */
// 🎯 去重：按「房间 + 12 分钟滑动窗口」判定是否为同一个福袋。
//    旧实现用 Math.floor(t/360000) 固定 6 分钟桶，桶边界会把同一个福袋切成两个：
//    实测 8199758142 的同一个福袋横跨 02:14:32-02:21:36（7 分钟），
//    正好跨过 02:18 的桶边界，被算成 2 个福袋，让「今日遭遇」虚高。
//    福袋倒计时最长 10 分钟，12 分钟滑动窗口能完整覆盖；
//    而福袋实际间隔 30-60 分钟，也不会把两个真福袋误并成一个。
function dedupRows(rows) {
  const WIN = 12 * 60 * 1000;
  // 🔑 key 必须含账号：多账号并行时，两个号在同一间房各抢一次是两次真实参与，
  //    只按「房间+12分钟」去重会把第二个号的记录吃掉，看板系统性低估战绩。
  //    2026-11-04 实测 main2 09:37 与 default 09:33 同房间相隔 4 分钟，被误合并。
  const last = new Map();          // 房间+账号 -> 上次保留的时间戳
  const out = [];
  // 必须先按时间升序，滑动窗口才成立
  const sorted = [...rows].sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());
  for (const r of sorted) {
    const room = (r.url || '').split('/').pop() || '';
    const t = new Date(r.at || 0).getTime();
    if (!t) { out.push(r); continue; }
    const key = room + '|' + (r.account || 'default');
    const prev = last.get(key);
    if (prev !== undefined && Math.abs(t - prev) < WIN) continue;   // 窗口内视为同一个福袋
    last.set(key, t);
    out.push(r);
  }
  return out;
}

/**
 * 🎯 事件流水专用去重（与统计口径 dedupRows 分开，不要混用）
 *
 * 背景：dedupRows 的「房间+账号+12 分钟滑动窗口」是为「今日遭遇」等统计设计的，
 *   它假设 12 分钟内同一个房间只会有一次福袋遭遇。但 2026-11-05 起开启
 *   「开奖后循环蹲守 postDrawWaitSec=120」后，同一房间会在一次常驻里连抢多个
 *   **不同**福袋，间隔常小于 12 分钟，被统计去重整批吃掉 —— 用户看到的是
 *   「福袋事件没跟上，同一个房间抢的福袋事件不显示」。
 *
 * 判据：participations.jsonl 每条都带 cd（福袋倒计时 MM:SS，实测 297/297 覆盖）。
 *   同一福袋的 cd 只会递减；**cd 回升 = 旧福袋已开奖、新一轮福袋开始**。
 *   因此只在「同房间+同账号+12 分钟内 且 cd 未回升」时折叠，回升/缺失则保留。
 *   2026-11-06 实测被旧口径丢掉的 23 条里，20 条是 cd 回升的新福袋，3 条是重复记录。
 *
 * ⚠ 统计卡片（stats / byAccount / byRoom / hourBuckets）仍用 dedupRows，
 *   保持保守口径不虚高；只有 recentEvents / recentJoins 用本函数。
 */
function dedupEventRows(rows) {
  const WIN = 12 * 60 * 1000;
  const cdSec = (cd) => {
    if (typeof cd !== 'string' || !/^\d{1,2}:\d{2}$/.test(cd)) return -1;
    const [m, s] = cd.split(':').map(Number);
    return m * 60 + s;
  };
  const last = new Map();       // 房间+账号 -> { t, cd, nearZero } 上一轮福袋
  const out = [];
  const sorted = [...rows].sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());
  for (const r of sorted) {
    const room = (r.url || '').split('/').pop() || '';
    const t = new Date(r.at || 0).getTime();
    if (!t) { out.push(r); continue; }
    const key = room + '|' + (r.account || 'default');
    const cd = cdSec(r.cd);
    const prev = last.get(key);
    // 上一轮已出现接近归零的 cd（旧福袋快开奖/已开奖），之后再来大 cd 必是新一轮。
    // 这堵住「09:59 → 03:00 → 09:57」这类：后半段看似递减、实为新福袋的边界。
    const resetByNearZero = prev && prev.nearZero && cd > 300;
    // 同一福袋：时间在窗口内、两次 cd 都有效、新 cd 未回升，且不是新一轮
    const sameFudai = !resetByNearZero && prev && Math.abs(t - prev.t) < WIN
                   && cd >= 0 && prev.cd >= 0 && cd <= prev.cd;
    if (sameFudai) {
      // 折叠也要推进基准，让后续判断基于最新采样，而不是停留在新福袋刚弹出的高 cd
      last.set(key, { t: prev.t, cd, nearZero: prev.nearZero || (cd >= 0 && cd < 120) });
      continue;
    }
    last.set(key, { t, cd, nearZero: cd >= 0 && cd < 120 });
    out.push(r);
  }
  return out;
}

function buildStatus() {
  const NAMES = loadNames();
  const dispRoom = (room) => {
    if (!room) return '';
    const n = NAMES[room];
    return n ? n + '(' + room + ')' : String(room);
  };
  const procs = procInfo();
  const ports = chromePorts();
  const accs = accountsInfo();

  // 统计口径：保守去重（今日遭遇/参与率/分账号战绩等）
  const rows = dedupRows([...readJsonl(PATHS.participations), ...readJsonl(PATHS.legacy).map((r) => ({ ...r, account: 'default' }))]);
  // 事件流水口径：按「cd 回升 = 新福袋」细粒度去重，保证同房间连抢的每次福袋都显示
  const eventRows = dedupEventRows([...readJsonl(PATHS.participations), ...readJsonl(PATHS.legacy).map((r) => ({ ...r, account: 'default' }))]);
  const wins = readJsonl(PATHS.wins);
  const today = localDay();
  const accLabels = accountLabels(accs);

  const todayRows = rows.filter((r) => isLocalDay(r.at, today));
  const joined = todayRows.filter((r) => r.result === 'joined' || r.result === 'maybe-joined');
  const byResult = {};
  for (const r of todayRows) byResult[r.result || 'unknown'] = (byResult[r.result || 'unknown'] || 0) + 1;

  const byRoom = {};
  for (const r of todayRows) {
    const room = (r.url || '').split('/').pop();
    if (!room) continue;
    byRoom[room] = byRoom[room] || { total: 0, joined: 0 };
    byRoom[room].total++;
    if (r.result === 'joined' || r.result === 'maybe-joined') byRoom[room].joined++;
  }

  let logTail = '';
  let logTailFull = '';
  try {
    const lines = fs.readFileSync(PATHS.log, 'utf8').split('\n').filter(Boolean);
    logTail = lines.slice(-8).join('\n');
    logTailFull = lines.slice(-40).join('\n');
  } catch {}

  let roundCount = null;
  try { roundCount = fs.readFileSync(PATHS.roundCounter, 'utf8').trim(); } catch {}

  // 卡死检测：日志多久没更新（抓取正常时每几秒就会写一行）
  // 当前正在监控的房间（从日志尾部反查）
  let currentRoom = null, currentOnline = null;
  try {
    const lines = fs.readFileSync(PATHS.log, 'utf8').split('\n').filter(Boolean);
    const parsed = parseCurrentRoom(lines);
    currentRoom = parsed.room;
    currentOnline = parsed.online;
  } catch {}

  let logAgeSec = null;
  try {
    const st = fs.statSync(PATHS.log);
    logAgeSec = Math.round((Date.now() - st.mtimeMs) / 1000);
  } catch {}

  return {
    now: new Date().toISOString(),
    live: readLive(),
    procs, ports,
    instances: instancesInfo(procs, (() => {
      const m = {};
      for (const r of todayRows) {
        let k = r.account || 'default';
        if (k === 'default') k = 'main';       // 主实例在数据里叫 default，实例卡片叫 main
        (m[k] = m[k] || []).push(r);
      }
      return m;
    })()),
    exec: execStats(),
    accountLabels: accLabels,
    // 🎯 分账号今日战绩：直接回答「哪个号抢了多少」，不再让用户从混在一起的明细里数
    //    ⚠ 2026-11-05 00:57 跨天后暴露：只列有数据的账号时，某个号今日 0 战绩就整行消失，
    //      用户会误以为它没在跑。改为「所有已注册账号都占位」，0 也显示，避免误判。
    byAccount: (() => {
      const m = {};
      const ensure = (k) => {
        if (!m[k]) m[k] = { account: k, label: labelOfAccount(k, accLabels), total: 0, joined: 0 };
        return m[k];
      };
      // 先给所有已注册账号占位：meta.json 里是 main / main2，数据里主号叫 default
      // 🔴 2026-11-10 10:53：主号归一化。历史约定「数据里主号叫 default」，
      //    但改用 `--account main` 启动后写入的是 `main`，而占位用 `default`，
      //    导致 byAccount 出现 main=5 与 default=0 两行同一账号。
      //    改为双向归一：main 与 default 视为同一账号，统一用 `default` 作为 key。
      const normAcc = (k) => (!k || k === 'main') ? 'default' : k;
      for (const a of accs) ensure(normAcc(a.name));
      for (const r of todayRows) {
        const e = ensure(normAcc(r.account));
        e.total++;
        if (r.result === 'joined' || r.result === 'maybe-joined') e.joined++;
      }
      return Object.values(m).sort((a, b) => b.joined - a.joined);
    })(),
    accounts: accs.map((a) => ({
      ...a,
      // 运行判定要兼容两种情况：带 --account 起的进程，以及用主 profile 起的默认进程
      // （2026-11-03 起抓取默认走 douyin-auto/chrome-profile，登录态是复制过去的，
      //  进程没有 --account 参数，account 会是 'default'，不能因此显示未运行）
      running: procs.some((p) => p.account === a.name)
            || (a.name === 'main' && procs.some((p) => p.account === 'default')),
    })),
    stats: {
      todayTotal: todayRows.length,
      todayJoined: joined.length,
      rate: todayRows.length ? ((joined.length / todayRows.length) * 100).toFixed(1) : '0.0',
      wins: wins.filter((w) => isLocalDay(w.at, today)).length,
      allTotal: rows.length,
      allJoined: rows.filter((r) => r.result === 'joined' || r.result === 'maybe-joined').length,
      allWins: wins.length,
    },
    // 📊 历史总数据（2026-11-06 用户要求：把「主播档案（累计）」卡片换成全局累计）
    //    ⚠ 口径与 stats.allTotal/allJoined 完全一致：都用 dedupRows 后的 rows，
    //      避免同一房间 12 分钟内重复采样把「历史」算虚高。
    //    ⚠ 分账号含已删除账号的历史记录（main2 27 条），这是真实发生过的战绩，不能抹掉。
    history: (() => {
      const isJoined = (r) => r.result === 'joined' || r.result === 'maybe-joined';
      const total = rows.length;
      const joinedN = rows.filter(isJoined).length;

      // 运行天数：按本地日去重（不能直接用 UTC 日期，凌晨 0-8 点会错位）
      const daySet = new Set();
      let firstAt = null, lastAt = null;
      for (const r of rows) {
        if (!r.at) continue;
        const d = new Date(r.at);
        if (Number.isNaN(d.getTime())) continue;
        if (!firstAt || r.at < firstAt) firstAt = r.at;
        if (!lastAt || r.at > lastAt) lastAt = r.at;
        const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
        daySet.add(local.toISOString().slice(0, 10));
      }

      // 分账号累计：沿用 accountLabels 的昵称映射，与今日战绩标签一致
      const accMap = {};
      for (const r of rows) {
        const k = r.account || 'default';
        const e = accMap[k] || (accMap[k] = { account: k, label: labelOfAccount(k, accLabels), total: 0, joined: 0 });
        e.total++;
        if (isJoined(r)) e.joined++;
      }
      const byAcc = Object.values(accMap).sort((a, b) => b.joined - a.joined)
        .map((e) => ({ ...e, rate: e.total ? Math.round(e.joined / e.total * 100) : 0 }));

      // 结果分布（累计）：与今日 byResult 同口径，直接给真实标签便于对照
      const byRes = {};
      for (const r of rows) {
        const k = r.result || 'unknown';
        byRes[k] = (byRes[k] || 0) + 1;
      }

      // 开奖与执行能力累计：文件不存在视为 0，不补造历史
      const readAll = (f) => {
        try { return readJsonl(path.join(ROOT, 'data', f)); } catch { return []; }
      };
      const lossesN = readAll('losses.jsonl').length;
      const acts = readAll('exec-actions.jsonl');
      const followOk = acts.filter((r) => r.action === 'follow' && r.ok).length;
      const fansOk = acts.filter((r) => r.action === 'fans' && r.ok).length;

      // 主播档案规模：从 anchors.json 取全局计数，不再展示逐房间明细
      let anchorTotal = 0, anchorKnown = 0;
      try {
        const an = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'anchors.json'), 'utf8')) || {};
        const av = Object.values(an);
        anchorTotal = av.length;
        anchorKnown = av.filter((v) => (v.fudaiTotal || 0) > 0).length;
      } catch {}

      // 累计轮次：主实例 + 各账号实例，都从各自 work 目录读
      let rounds = 0;
      try { rounds += Number(fs.readFileSync(PATHS.roundCounter, 'utf8').trim()) || 0; } catch {}
      try {
        const accRoot = path.join(ROOT, 'accounts');
        for (const n of fs.readdirSync(accRoot)) {
          const f = path.join(accRoot, n, 'work', 'round-counter.txt');
          try { rounds += Number(fs.readFileSync(f, 'utf8').trim()) || 0; } catch {}
        }
      } catch {}

      return {
        total, joined: joinedN,
        rate: total ? (joinedN / total * 100).toFixed(1) : '0.0',
        wins: wins.length, losses: lossesN,
        draws: wins.length + lossesN,
        days: daySet.size, firstAt, lastAt,
        followOk, followTotal: acts.filter((r) => r.action === 'follow').length,
        fansOk, fansTotal: acts.filter((r) => r.action === 'fans').length,
        anchorTotal, anchorKnown, rounds,
        byAcc,
        byResult: Object.entries(byRes)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => ({ key: k, n: v })),
      };
    })(),
    byResult,
    roomRank: Object.entries(byRoom)
      .filter(([, v]) => v.joined > 0)
      .sort((a, b) => b[1].joined - a[1].joined)
      .slice(0, 8)
      .map(([room, v]) => ({ room, roomName: dispRoom(room), joined: v.joined, total: v.total })),
    recentWins: wins.slice(-5).reverse(),
    learning: (() => {
      try {
        const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'anchors.json'), 'utf8'));
        const all = Object.values(a);
        const visited = all.filter(v => (v.visits || 0) > 0);
        const mastered = all.filter(v => (v.visits || 0) >= 3);   // 样本足够，判断可信
        const known = all.filter(v => (v.fudaiTotal || 0) > 0);   // 已知会发福袋
        const silent = all.filter(v => (v.fudaiTotal || 0) === 0 && (v.visits || 0) >= 3); // 访问多次无福袋
        return {
          total: all.length,
          visited: visited.length,
          mastered: mastered.length,
          known: known.length,
          silent: silent.length,
          masteryRate: all.length ? Math.round(mastered.length / all.length * 100) : 0,
        };
      } catch { return null; }
    })(),
    bootCount: (() => {
      try {
        const txt = fs.readFileSync(PATHS.log, 'utf8');
        return (txt.match(/hunter35 常驻高人气直播间/g) || []).length;
      } catch { return null; }
    })(),
    lastRound: (() => {
      try {
        const lines = fs.readFileSync(PATHS.log, 'utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/合计采集 (\d+) 个直播间/);
          if (m) return Number(m[1]);
        }
      } catch {}
      return null;
    })(),
    logTail,
    logTailFull,
    roundCount,
    logAgeSec,
    // 门槛与抓取侧共用 data/threshold.json（单一数据源）。
    //    2026-11-03 踩坑：这里曾硬编码 3000/10000，抓取侧已改成 8000/50000，
    //    看板仍显示旧值，用户以为「门槛没改成功」。
    threshold: (() => {
      let thr={day:8000,night:50000,nightStart:19,nightEnd:24};
      try{ thr=Object.assign(thr, JSON.parse(fs.readFileSync(path.join(ROOT,'data','threshold.json'),'utf8'))||{}); }catch(e){}
      const h = new Date().getHours();
      const night = (h >= thr.nightStart && h < thr.nightEnd);
      return { value: night ? thr.night : thr.day, night, hour: h };
    })(),
    currentRoom,
    currentRoomName: dispRoom(currentRoom),
    currentOnline,
    // 📌 用户指定的常发福袋主播状态（来源：关注主播名单.md）
    //    这块是用户最关心的信息：我指定的主播现在在播吗？盯了多久？为什么没抢到？
    //    数据来自 vip-cooldown.json（冷却）、anchors.json（档案）和日志尾部（最近探测结果）。
    pinned: (() => {
      // 📌 与抓取侧共用 data/pinned-hosts.json（单一数据源）。
      //    原来这里硬编码一份同样的名单，拉黑主播时只改抓取侧，看板照旧显示，
      //    用户当场质疑「为什么这个还在」。
      const hoursText = (h) => {
        if (!h || !h.length) return '';
        if (h.length >= 20) return '几乎全天';
        return h.map(x => String(x).padStart(2, '0') + ':00').join(',');
      };
      let PINNED = [];
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pinned-hosts.json'), 'utf8')) || {};
        PINNED = Object.entries(cfg).map(([id, v]) => [id, v.name || id, hoursText(v.hours)]);
      } catch { PINNED = []; }
      let cd = {}, an = {};
      try { cd = JSON.parse(fs.readFileSync(path.join(ROOT,'douyin-auto','vip-cooldown.json'),'utf8')) || {}; } catch {}
      try { an = JSON.parse(fs.readFileSync(path.join(ROOT,'data','anchors.json'),'utf8')) || {}; } catch {}
      // 从日志尾部 60KB 提取每个主播最近一次探测结果，避免整文件读取
      const probe = {};
      try {
        const lp = path.join(ROOT,'douyin-auto','h35.log');
        const st = fs.statSync(lp);
        const start = Math.max(0, st.size - 60000);
        const fd = fs.openSync(lp, 'r');
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const tail = buf.toString('utf8').split('\n');
        for (let i = 0; i < tail.length; i++) {
          const m = tail[i].match(/主动探测 VIP 房 (\S+)/);
          if (!m) continue;
          const id = m[1];
          const at = (tail[i].match(/^\[(\d\d:\d\d:\d\d)\]/) || [])[1] || '';
          for (let j = i + 1; j < Math.min(i + 4, tail.length); j++) {
            const live = tail[j].match(/✅ 在播，在线 (\d+)/);
            if (live) { probe[id] = { state: 'live', online: +live[1], at }; break; }
            if (/❌ 未在播/.test(tail[j])) { probe[id] = { state: 'offline', at }; break; }
            if (/⚠️ 探测失败/.test(tail[j])) { probe[id] = { state: 'fail', at }; break; }
          }
        }
      } catch {}
      const now = Date.now();
      return PINNED.map(([id, fallback, hour]) => {
        const a = an[id] || {};
        const cdTs = cd[id] || 0;
        const coolMin = cdTs ? Math.max(0, Math.round((15*60*1000 - (now - cdTs)) / 60000)) : 0;
        const pr = probe[id] || {};
        return {
          id,
          name: NAMES[id] || a.host || fallback,
          hour,
          state: pr.state || '',
          online: pr.online ?? null,
          probedAt: pr.at || '',
          coolMin,
          visits: a.visits || 0,
          fudaiTotal: a.fudaiTotal || 0,
          joinable: a.joinable || 0,
        };
      });
    })(),
    hourly: (() => {
      const h = new Array(24).fill(null).map(() => ({ total: 0, joined: 0 }));
      const t0 = new Date(); t0.setHours(0,0,0,0);
      for (const r of rows) {
        const d = new Date(r.at);
        if (d < t0) continue;
        const hh = d.getHours();
        h[hh].total++;
        if (r.result === 'joined' || r.result === 'maybe-joined') h[hh].joined++;
      }
      return h.map((v, i) => ({ hour: i, total: v.total, joined: v.joined }));
    })(),
    recentEvents: eventRows
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 15)
      .map((r) => ({
        room: (r.url || '').split('/').pop() || '?',
        roomName: dispRoom((r.url || '').split('/').pop()),
        at: r.at,
        online: r.online,
        result: r.result,
        account: r.account || 'default',
        accountLabel: labelOfAccount(r.account, accLabels),
        // 事件行空间有限，徽标只放昵称；完整身份放 title，鼠标悬停可见
        accountShort: (accLabels[r.account || 'default'] || {}).nickname
                      || (r.account === 'default' ? '主实例' : (r.account || 'default')),
      })),
    recentJoins: eventRows
      .filter((r) => r.result === 'joined' || r.result === 'maybe-joined')
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 12)
      .map((r) => ({
        room: (r.url || '').split('/').pop() || '?',
        roomName: dispRoom((r.url || '').split('/').pop()),
        at: r.at,
        online: r.online,
        result: r.result,
        account: r.account || 'default',
        accountLabel: labelOfAccount(r.account, accLabels),
      })),
    lastJoined: (() => {
      const js = rows.filter((r) => r.result === 'joined' || r.result === 'maybe-joined')
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return js.length ? js[0].at : null;
    })(),
  };
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="福袋">
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icon.svg">
<title>抖音福袋 · 看板</title>
<style>
  :root { --bg:#0f1115; --card:#181b22; --line:#2a2f3a; --txt:#e6e9ef; --dim:#8b93a3; --ok:#3ddc84; --warn:#ffc857; --bad:#ff6b6b; --accent:#4f9cf9; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.6 -apple-system,"PingFang SC","Helvetica Neue",sans-serif; padding:20px; }
  h1 { font-size:18px; margin:0 0 4px; font-weight:600; }
  .sub { color:var(--dim); font-size:12px; margin-bottom:18px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:14px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  .card h2 { font-size:13px; margin:0 0 12px; color:var(--dim); font-weight:500; letter-spacing:.5px; }
  .kv { display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px dashed rgba(255,255,255,.05); }
  .kv:last-child { border-bottom:none; }
  .kv span:last-child { font-variant-numeric:tabular-nums; font-weight:600; }
  .big { font-size:26px; font-weight:700; color:var(--accent); }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); } .dim { color:var(--dim); }
  .acc { display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px dashed rgba(255,255,255,.05); }
  .acc:last-child { border-bottom:none; }
  .dot { width:8px; height:8px; border-radius:50%; background:#555; flex:none; }
  .dot.on { background:var(--ok); box-shadow:0 0 6px var(--ok); }
  pre { background:#0b0d11; border:1px solid var(--line); border-radius:8px; padding:10px; overflow:auto; font-size:12px; line-height:1.5; max-height:280px; margin:0; }
  .tag { display:inline-block; padding:1px 7px; border-radius:4px; background:rgba(79,156,249,.15); color:var(--accent); font-size:11px; }
  /* 账号徽标：每个号一种颜色，同房间两条记录一眼可分 */
  .acc-badge { display:inline-block; padding:0 5px; margin-right:2px; border:1px solid; border-radius:4px;
               font-size:10px; font-weight:600; line-height:1.5; white-space:nowrap; }
  ul { margin:0; padding-left:18px; color:var(--dim); font-size:12px; }
  li { margin:3px 0; }
  .full { grid-column:1/-1; }
  .btn { background:#232833; color:var(--txt); border:1px solid var(--line); border-radius:8px;
         padding:9px 16px; font-size:13px; cursor:pointer; font-family:inherit; white-space:nowrap; }
  .btn:hover { background:#2c323f; border-color:#3a4250; }
  .btn:active { transform:translateY(1px); }
  .btn[disabled] { opacity:.5; cursor:not-allowed; }
  .tl-wrap { display:flex; flex-direction:column; gap:0; }
  .timeline { display:grid; grid-template-columns:repeat(24,1fr); gap:2px; align-items:end; height:72px; }
  .tl-col { display:flex; align-items:flex-end; height:100%; }
  .tl-bar { width:100%; background:#1c2029; border-radius:2px 2px 0 0; min-height:3px; transition:background .2s; }
  .tl-bar.has { background:var(--accent); }
  .tl-bar.joined { background:var(--ok); }
  .tl-labels { display:grid; grid-template-columns:repeat(24,1fr); gap:2px; margin-top:6px; }
  .tl-labels span { font-size:9px; color:var(--dim); text-align:center; }
  #log { max-height:220px; overflow-y:auto; }
  .two-col { display:flex; gap:20px; flex-wrap:wrap; }
  .two-col > div { min-width:180px; }
  @media (max-width: 560px) {
    body { padding:12px; padding-bottom:calc(12px + env(safe-area-inset-bottom)); font-size:13px; }
    .two-col { flex-direction:column; gap:14px; }
    .two-col > div { min-width:0; }
    .grid { grid-template-columns:1fr; gap:10px; }
    .card { padding:13px; }
    .big { font-size:22px; }
    pre { max-height:200px; font-size:11px; }
    /* 手机窄屏下「学习/执行结果」双列会挤成一团文字，改单列 */
    .split2 { grid-template-columns:minmax(0,1fr); }
  }
  @media (display-mode: standalone) {
    body { padding-top:calc(12px + env(safe-area-inset-top)); }
  }

  /* ═══ 单屏布局（2026-11-03）═══
     目标：在 1440×900 的普通笔记本屏幕上一屏看完，不滚动。
     做法：整页锁定视口高度，纵向 flex；中间 3×2 网格各卡片内部滚动。
     关键点：所有可伸缩容器都要 min-height:0，否则 grid/flex 子项会被内容撑破，
     overflow 不生效——这是 CSS 里最容易踩的一个坑。 */
  html, body { height:100%; }
  body { overflow:hidden; display:flex; flex-direction:column; padding:10px 12px; gap:8px; }
  .topbar { flex:none; display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; }
  .topbar h1 { font-size:15px; margin:0; }
  .topbar .sub { margin:0; font-size:11px; }
  .badges { margin-left:auto; display:flex; gap:6px; flex-wrap:wrap; }
  .badge { font-size:11px; padding:1px 8px; border-radius:20px; background:#181b22;
           border:1px solid var(--line); color:var(--dim); white-space:nowrap; }
  .badge b { color:var(--txt); font-weight:600; font-variant-numeric:tabular-nums; }

  .kpi { flex:none; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)) 2.2fr; gap:8px; }
  .kpi > div { background:var(--card); border:1px solid var(--line); border-radius:8px;
               padding:7px 11px; min-height:0; }
  .kpi .num { font-size:21px; font-weight:700; line-height:1.15; font-variant-numeric:tabular-nums; }
  .kpi .lbl { font-size:10px; color:var(--dim); }
  .kpi .lines { font-size:11px; color:var(--dim); line-height:1.5; }
  .kpi .lines b { color:var(--txt); font-weight:600; }

  /* ⚠ 每个 fr 都必须包 minmax(0,...)：grid 轨道默认 min-width:auto，
     内容（长房间名 + white-space:nowrap）会把轨道撑到 500px，
     把第三列压成 100px，文字全被挤断行。实测踩过两次。 */
  .main { flex:1; min-height:0; min-width:0; display:grid; gap:8px;
          grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr);
          grid-template-rows:1fr 1fr; }
  .main .card { min-height:0; min-width:0; display:flex; flex-direction:column; padding:9px 11px; border-radius:8px; }
  .main .card h2 { font-size:11px; margin:0 0 6px; flex:none; }
  .scroll { flex:1; min-height:0; overflow-y:auto; overflow-x:hidden; }
  .scroll::-webkit-scrollbar { width:5px; }
  .scroll::-webkit-scrollbar-thumb { background:#2c323f; border-radius:3px; }

  .row { display:flex; justify-content:space-between; align-items:baseline; gap:6px;
         padding:2px 0; border-bottom:1px dashed rgba(255,255,255,.05); font-size:12px; }
  .row:last-child { border-bottom:none; }
  /* ⚠ 两列并排后列宽只有 150-200px，文字必须强制单行 + 省略号，
     否则「主播档案 275 个」会被挤成一字一行（实测踩过）。 */
  .row > span { white-space:nowrap; }
  .row > span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .row > span:last-child { flex:none; font-variant-numeric:tabular-nums; }
  .kv > span { white-space:nowrap; }
  .kv > span:first-child { min-width:0; overflow:hidden; text-overflow:ellipsis; }

  .mini { font-size:11px; line-height:1.45; padding:4px 0; border-bottom:1px dashed rgba(255,255,255,.05); }
  .mini:last-child { border-bottom:none; }

  /* ⚠ 必须用 minmax(0,1fr) 而不是 1fr：grid 子项默认 min-width:auto，
     内容（长房间名）会把列撑开、把另一列压成一条缝。这是 CSS Grid 最常见的坑。 */
  .split2 { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);
            gap:0 10px; align-content:start; }
  .split2 > div { min-width:0; }

  .bottom { flex:none; display:flex; gap:8px; align-items:stretch; flex-wrap:wrap; }
  .bottom .card { padding:5px 11px; border-radius:8px; display:flex; align-items:center; gap:10px;
                  min-width:0; white-space:nowrap; }
  .bottom .tl-card { flex:1 1 320px; max-width:52%; }
  .timeline { height:34px; }
  .tl-labels { margin-top:2px; }
  .tl-labels span { font-size:8px; }
  .ctl { display:flex; gap:6px; }
  .ctl .btn { padding:5px 12px; font-size:12px; }
  #log { max-height:none; height:100%; border:none; background:transparent; padding:0; font-size:11px; line-height:1.45; }

  /* ⚠ 1362px 逻辑宽度下三列每列只剩 ~300px，塞不下「主播档案 275 个」这种行，
     所以提前在 1400px 就切成两列。
     必须用 grid-template-areas 显式指定每个卡片的位置——之前用
     nth-child(3) + grid-column:2 硬掰，会和 auto-placement 打架，
     结果 6 个卡片只排进 3 个格子，其余被压成 20px 高的空条（实测踩过）。 */
  @media (max-width:1100px){
    .main {
      grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);
      grid-template-rows:1fr 1fr 1fr;
      grid-template-areas:"events pinned" "log account" "learn history";
    }
    .main > .card:nth-child(1){ grid-area:events; }
    .main > .card:nth-child(2){ grid-area:pinned; }
    .main > .card:nth-child(3){ grid-area:account; }
    .main > .card:nth-child(4){ grid-area:log; }
    .main > .card:nth-child(5){ grid-area:learn; }
    .main > .card:nth-child(6){ grid-area:history; }
  }
  @media (max-width:900px){
    /* ⚠ 单列轨道必须 minmax(0,1fr)：裸 1fr 的 min-width:auto 会被
       white-space:nowrap 的长文本撑到 887px，手机上产生横向溢出。 */
    .main { grid-template-columns:minmax(0,1fr); grid-template-rows:none;
            grid-template-areas:none; }
    /* ⚠ 必须把 1100px 断点里给每张卡片指定的 grid-area 复位，
       否则命名区域被 grid-template-areas:none 取消后，6 张卡片仍各自
       grid-area:events/pinned/...，全部被丢进同一个隐式格子重叠在一起，
       手机上就只剩最后绘制的「主播档案」一张（2026-11-06 实测踩过）。 */
    .main > .card { grid-area:auto !important; max-height:300px; }
  }
  @media (max-width:700px){
    body { overflow:auto; height:auto; overflow-x:hidden; }
    .main { grid-template-columns:minmax(0,1fr); grid-template-rows:none; }
    .main .card { max-height:none; }
    .main > .card { grid-area:auto !important; }
    .scroll { overflow:visible; overflow-x:hidden; }
    .kpi { grid-template-columns:repeat(2,minmax(0,1fr)); }
    /* 手机上历史总数据指标较多，整张卡片过高会把后面内容顶到屏幕外，
       限高并交给卡片内部滚动，用户仍可上下滑看完整数据。 */
    .main > .card:last-child { max-height:360px; }
    .main > .card:last-child .scroll { overflow-y:auto; }
  }
</style>
</head>
<body>
<div class="topbar">
  <h1>抖音福袋 · 看板</h1>
  <div class="sub">每 15 秒刷新 · <span id="ts">加载中</span></div>
  <div class="badges">
    <span class="badge" id="b-login">登录</span>
    <span class="badge" id="b-run">进程</span>
    <span class="badge" id="b-age">日志</span>
    <span class="badge" id="b-port">端口</span>
  </div>
</div>

<div class="kpi">
  <div><div class="num" id="s-total">-</div><div class="lbl">今日遭遇</div></div>
  <div><div class="num ok" id="s-joined">-</div><div class="lbl">参与成功</div></div>
  <div><div class="num" id="s-wins" style="color:var(--warn)">-</div><div class="lbl">中奖</div></div>
  <div><div class="num" id="s-rate" style="color:var(--accent)">-</div><div class="lbl">参与率</div></div>
  <div>
    <div class="lbl" style="margin-bottom:2px">当前监控</div>
    <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
         id="cur-room">-</div>
    <div class="lines">
      在线 <b id="cur-online">-</b> · 门槛 <b id="threshold">-</b>
      · 上轮 <b id="last-round">-</b> · 最近参与 <b id="last-join">-</b>
    </div>
  </div>
</div>

<div class="main">
  <div class="card">
    <h2>福袋事件</h2>
    <div class="scroll" id="joins"><div class="dim">暂无记录</div></div>
  </div>

  <div class="card">
    <h2>指定主播</h2>
    <div class="scroll" id="pinned"></div>
  </div>

  <div class="card">
    <h2>账号 · 今日战绩 · 运行实例</h2>
    <div class="scroll">
      <div id="by-account-box"><div class="dim">加载中…</div></div>
      <div id="accounts-box"><div class="dim">加载中…</div></div>
      <div style="border-top:1px solid rgba(255,255,255,.07);margin-top:6px;padding-top:5px">
        <div id="instances-box"><div class="dim">加载中…</div></div>
      </div>
    </div>
    <div style="flex:none;margin-top:5px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <button class="btn" id="btn-acc-add" style="padding:3px 10px;font-size:11px">添加账号</button>
      <span id="acc-msg" class="dim" style="font-size:11px"></span>
    </div>
  </div>

  <div class="card">
    <h2>最近日志</h2>
    <pre class="scroll" id="log">加载中...</pre>
  </div>

  <div class="card">
    <h2>学习(累计) · 执行结果(今日) · 房间排行</h2>
    <div class="scroll split2">
      <div id="learning"></div>
      <div>
        <div id="exec"></div>
        <div id="results" style="margin-top:4px"></div>
        <div id="rooms" style="margin-top:4px"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>历史总数据</h2>
    <div class="scroll" id="history"><div class="dim">加载中…</div></div>
  </div>
</div>

<div class="card" style="margin-top:10px">
  <h2>设置 · 只盯婴童用品</h2>
  <div style="font-size:12px;color:var(--dim);margin-bottom:8px">只保留标题或主播名含关键词的直播间；改完点保存，再点下面的“重启”让抓取生效。关键词用逗号分隔。</div>
  <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
    <label style="font-size:12px">只盯婴童 <input type="checkbox" id="cfg-enabled" checked style="width:auto"></label>
    <label style="font-size:12px">无门槛（不分白天晚间） <input type="checkbox" id="cfg-no-threshold" checked style="width:auto"></label>
    <label style="font-size:12px">人数越少越优先 <input type="checkbox" id="cfg-small" checked style="width:auto"></label>
    <label style="font-size:12px">只抢关注/弹幕型（跳过粉丝团） <input type="checkbox" id="cfg-skip-fans" checked style="width:auto"></label>
    <label style="font-size:12px">加分 <input id="cfg-bonus" type="number" value="20" min="0" max="50" style="width:64px"></label>
    <label style="font-size:12px">白天门槛 <input id="cfg-day" type="number" value="8000" style="width:80px"></label>
    <label style="font-size:12px">晚间门槛 <input id="cfg-night" type="number" value="50000" style="width:80px"></label>
  </div>
  <div style="margin-top:8px;font-size:12px">关键词</div>
  <textarea id="cfg-keywords" rows="2" style="width:100%;box-sizing:border-box">母婴,婴童,宝宝,婴儿,奶粉,纸尿裤,尿不湿,童装,童鞋,辅食,婴儿车,儿童,妈妈,宝妈,孕妇,育儿,亲子</textarea>
  <div style="margin-top:8px;font-size:12px">指定主播（每行一个：抖音号,名字,开播小时…，例如 dehua66888,吕德华,20）</div>
  <textarea id="cfg-pinned" rows="3" style="width:100%;box-sizing:border-box"></textarea>
  <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
    <button class="btn" id="btn-cfg-save">保存设置</button>
    <button class="btn" id="btn-cfg-reload">重新读取</button>
    <span id="cfg-msg" class="dim" style="font-size:11px"></span>
  </div>
</div>

<div class="bottom">
  <div class="card tl-card">
    <div style="flex:1;min-width:0">
      <div class="lbl" style="font-size:10px;color:var(--dim);margin-bottom:1px">今日时间线</div>
      <div id="timeline" class="timeline"></div>
    </div>
  </div>
  <div class="card ctl">
    <button class="btn" data-act="start">启动</button>
    <button class="btn" data-act="stop">停止</button>
    <button class="btn" data-act="restart">重启</button>
  </div>
  <div class="card">
    <span id="act-msg" class="dim" style="font-size:11px">就绪</span>
    <span class="dim" style="font-size:11px;margin-left:auto">历史 <b id="a-total" style="color:var(--txt)">-</b>/<b id="a-joined" style="color:var(--txt)">-</b> · 中奖 <b id="a-wins" style="color:var(--ok)">-</b> · 轮次 <b id="rounds" style="color:var(--txt)">-</b></span>
  </div>
</div>

<script>
const LABEL = {
  'maybe-joined':'参与成功(待确认)','joined':'参与成功(已确认)',
  // 2026-11-04 起粉丝团不再直接跳过，而是尝试加入（成功变 joined），
  // 仍是 skip-fans 说明「加入了但没抢到」或「加入失败」，标签要准确反映。
  'skip-fans':'粉丝团未加入','fans-no-coins':'抖币不足·需充值','fans-unverified':'粉丝团加入未确认','no-panel':'未找到面板',
  // 🕐 2026-11-10 11:42：按账号/时段跳过粉丝团福袋（用户定稿：白天只抢关注型与发弹幕型）
  'fans-skip-daytime':'粉丝团·白天不抢','fans-skip-account':'粉丝团·该账号不抢',
  'packet-skipped':'人气红包·按配置不抢','need-follow':'需要关注(抢不到)','btn-still':'按钮未消失'
};
async function tick(){
  try{
    const r = await fetch('/api/status');
    const d = await r.json();
    document.getElementById('ts').textContent = new Date(d.now).toLocaleString('zh-CN');
    const s = d.stats;
    document.getElementById('s-total').textContent = s.todayTotal;
    document.getElementById('s-joined').textContent = s.todayJoined;
    document.getElementById('s-rate').textContent = s.rate + '%';
    document.getElementById('s-wins').textContent = s.wins;
    document.getElementById('a-total').textContent = s.allTotal;
    document.getElementById('a-joined').textContent = s.allJoined;
    document.getElementById('a-wins').textContent = s.allWins;
    document.getElementById('rounds').textContent = d.roundCount ?? '-';
    // ── 顶部状态徽章（单屏布局把原来的「进程与端口」卡片压成了 4 个徽章）──
    {
      const on = d.procs.length > 0;
      const be = document.getElementById('b-run');
      if (be) { be.innerHTML = '进程 <b class="' + (on?'ok':'bad') + '">'
        + (on ? '运行 ' + d.procs.map(p=>p.uptime).join(',') : '无') + '</b>'; }
    }
    {
      const up = d.ports.length > 0;
      const be = document.getElementById('b-port');
      if (be) { be.innerHTML = '端口 <b class="' + (up?'ok':'bad') + '">'
        + (up ? d.ports.join(',') : '无') + '</b>'; }
    }
    {
      const a = d.logAgeSec;
      const be = document.getElementById('b-age');
      if (be) {
        let txt, cls;
        if (a === null) { txt = '无日志'; cls = 'bad'; }
        else if (a < 120) { txt = a + ' 秒前'; cls = 'ok'; }
        else if (a < 600) { txt = Math.round(a/60) + ' 分钟前'; cls = 'warn'; }
        else { txt = Math.round(a/60) + ' 分钟前卡住?'; cls = 'bad'; }
        be.innerHTML = '日志 <b class="' + cls + '">' + txt + '</b>';
      }
    }
    {
      // 登录态：所有账号都登录成功才算 OK，任一失效就标红（这是最关键的告警）
      const be = document.getElementById('b-login');
      if (be) {
        const bad = (d.accounts || []).filter(a => a.loginOk === false).length;
        const n = (d.accounts || []).length;
        be.innerHTML = '登录 <b class="' + (bad ? 'bad' : (n ? 'ok' : 'warn')) + '">'
          + (n === 0 ? '无账号' : (bad ? bad + '/' + n + ' 失效' : n + ' 个正常')) + '</b>';
      }
    }

    // 🎯 分账号今日战绩：每个号各遭遇/参与多少次，一眼看清，不再混在一起数
    {
      const box = document.getElementById('by-account-box');
      const LBL = d.accountLabels || {};
      const list = d.byAccount || [];
      if (box) {
        box.innerHTML = list.length ? list.map(function (a) {
          const v = LBL[a.account] || {};
          const color = v.color || 'var(--accent)';
          const rate = a.total ? ((a.joined / a.total) * 100).toFixed(0) : 0;
          return '<div class="kv"><span><span class="acc-badge" style="color:'+color+
                 ';border-color:'+color+'55;background:'+color+'18">'+a.label+'</span></span>' +
                 '<span>' + a.total + '遭 / <b class="ok">' + a.joined + '参</b> ' +
                 '<span class="dim" style="font-size:11px">' + rate + '%</span></span></div>';
        }).join('') : '<div class="dim" style="font-size:11px">今日暂无记录</div>';
      }
    }

    // 账号卡片：昵称、抖音号、登录态、是否在跑，并给出「使用」按钮
    const accBox = document.getElementById('accounts-box');
    if (accBox && d.accounts) {
      if (!d.accounts.length) {
        accBox.innerHTML = '<div class="dim">还没有账号，点下面「添加账号」扫码登录</div>';
      } else {
        accBox.innerHTML = d.accounts.map(function (a) {
          const okCls = a.loginOk === false ? 'bad' : 'ok';
          const okTxt = a.loginOk === false ? '● 未登录' : '● 已登录';
          const runTxt = a.running ? '<span class="ok">运行中</span>' : '<span class="dim">未运行</span>';
          const sub = [];
          if (a.douyinId) sub.push('抖音号 ' + a.douyinId);
          if (a.lastLogin) sub.push('登录于 ' + String(a.lastLogin).slice(5, 16).replace('T', ' '));
          const useBtn = a.running ? '<span class="dim" style="font-size:11px">使用中</span>'
            : '<button class="btn" data-use-account="' + a.name + '" style="padding:2px 10px;font-size:11px">切换到此账号</button>';
          return '<div class="kv"><span>' + (a.nickname || a.displayName || a.name) +
                 '<span class="dim" style="font-size:11px"> ' + a.name + '</span></span>' +
                 '<span class="' + okCls + '">' + okTxt + '</span></div>' +
                 '<div class="dim" style="font-size:11px;margin:-2px 0 6px 0;display:flex;justify-content:space-between;align-items:center;gap:8px">' +
                 '<span>' + (sub.length ? sub.join(' · ') + ' · ' : '') + runTxt + '</span>' + useBtn + '</div>';
        }).join('');
      }
    }

    // 运行实例：每个账号一个抓取实例，显示它此刻在盯哪个房间、日志是否还在动。
    // 没有这块，多账号并行时用户完全看不出第二个账号在干什么。
    {
      const box = document.getElementById('instances-box');
      if (box) {
        const insts = d.instances || [];
        box.innerHTML = insts.length ? insts.map(function (it) {
          const age = it.logAgeSec;
          const ageTxt = (age === null || age === undefined) ? '无日志'
            : (age < 60 ? age + ' 秒前' : (age < 3600 ? Math.round(age / 60) + ' 分钟前' : Math.round(age / 3600) + ' 小时前'));
          const ageCls = age === null ? 'bad' : (age < 120 ? 'ok' : (age < 900 ? 'warn' : 'bad'));
          const runCls = it.running ? 'ok' : 'bad';
          const runTxt = it.running ? '● 运行中' : '● 已停止';
          const hasOnline = typeof it.currentOnline === 'number' && it.currentOnline >= 0;
          // 未运行的实例读到的只是它上次退出时的日志残留，标成「上次」以免被误读成正在盯
          const roomPrefix = it.running ? '房间 ' : '上次 ';
          const room = it.currentRoom ? (roomPrefix + it.currentRoom + (hasOnline ? ' · ' + it.currentOnline.toLocaleString() + ' 人' : '')) : (it.running ? '未常驻' : '无记录');
          return '<div class="kv"><span>' + it.label +
                 '<span class="dim" style="font-size:11px"> ' + it.account + ' · ' + (it.port || '-') + '</span></span>' +
                 '<span class="' + runCls + '">' + runTxt + '</span></div>' +
                 '<div class="dim" style="font-size:11px;margin:-2px 0 7px 0;line-height:1.5;'+
                 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="'+(it.lastLine||'')+'">' +
                 room +
                 ' ｜ ' + it.today + '遭/' + it.todayJoined + '参' +
                 ' ｜ <span class="' + ageCls + '">' + ageTxt + '</span>' +
                 '</div>';
        }).join('') : '<div class="dim">暂无实例</div>';
      }
    }

    // 执行能力：粉丝团加入 + 关注主播（用户明确要求的两件事，必须可见）
    {
      const el = document.getElementById('exec');
      if (el && d.exec) {
        const e = d.exec;
        const fansRate = e.fansTry ? Math.round(e.fansOk / e.fansTry * 100) : null;
        const folRate  = e.followTry ? Math.round(e.followOk / e.followTry * 100) : null;
        const cls = (r) => r === null ? 'dim' : (r >= 70 ? 'ok' : (r >= 30 ? 'warn' : 'bad'));
        el.innerHTML =
          '<div class="row"><span>💎 粉丝团</span><span>' +
            '<span class="' + cls(fansRate) + '">' + e.fansOk + '/' + e.fansTry + '</span>' +
            (fansRate !== null ? '<span class="dim"> ' + fansRate + '%</span>' : '') + '</span></div>' +
          '<div class="row"><span>⭐ 关注</span><span>' +
            '<span class="' + cls(folRate) + '">' + e.followOk + '/' + e.followTry + '</span>' +
            (folRate !== null ? '<span class="dim"> ' + folRate + '%</span>' : '') +
            (e.followUnknown ? '<span class="dim"> · 未确认 ' + e.followUnknown + '</span>' : '') + '</span></div>' +
          '<div class="row"><span>🎲 开奖结果</span><span>' +
            '<span class="ok">中 ' + (e.wins||0) + '</span>' +
            '<span class="dim"> / 未中 ' + (e.losses||0) + '</span></span></div>' +
          '<div class="row"><span>抖币消耗</span><span class="' + (e.coins ? 'warn' : 'dim') + '">' +
            e.coins + ' 钻</span></div>' +
          '<div class="row" style="opacity:.6;font-size:10px"><span>以上为今日真实到位</span><span></span></div>';
      }
    }

    const resEl = document.getElementById('results');
    const keys = Object.keys(d.byResult);
    resEl.innerHTML = keys.length
      ? keys.map(k=>'<div class="row"><span>'+(LABEL[k]||k)+'</span><span>'+d.byResult[k]+'</span></div>').join('')
      : '<div class="dim">今日暂无</div>';

    // 房间排行：两列布局里横向空间只有一半，房间名必须截断，
    // 否则「金铲铲泽神（阵容教学天花板）(416921329528)」这种长名会换行，
    // 把整列行高撑乱。完整名放到 title 里悬浮显示。
    const roomEl = document.getElementById('rooms');
    const shortName = (r) => {
      let nm = String(r.roomName || r.room || '');
      nm = nm.replace(/\(\d{6,}\)\s*$/, '').trim();   // 去掉尾部的 (房间号)
      return nm.length > 12 ? nm.slice(0, 12) + '…' : nm;
    };
    // 只显示前 3 个房间：右列还要放执行能力和结果分布，全列出来会把卡片撑爆截断
    const rankTop = d.roomRank.slice(0, 3);
    roomEl.innerHTML = rankTop.length
      ? rankTop.map(r=>'<div class="row"><span title="'+(r.roomName||r.room)+'">'+
          shortName(r)+'</span><span class="ok">'+r.joined+'</span></div>').join('')
        + (d.roomRank.length > 3 ? '<div class="dim" style="font-size:10px;padding-top:2px">…还有 ' + (d.roomRank.length-3) + ' 个</div>' : '')
      : '<div class="dim">暂无</div>';

    // 当前监控房间
    document.getElementById('cur-room').textContent = d.currentRoomName || d.currentRoom || '采集中/切换中';
    document.getElementById('cur-online').textContent =
      (d.currentOnline !== null && d.currentOnline >= 0) ? d.currentOnline.toLocaleString() : '-';

    {
      const el = document.getElementById('last-join');
      if (!d.lastJoined) { el.textContent = '暂无'; el.className = 'dim'; }
      else {
        const mins = Math.round((Date.now() - new Date(d.lastJoined).getTime()) / 60000);
        el.textContent = mins < 60 ? mins + ' 分钟前' : Math.round(mins/60) + ' 小时前';
        el.className = mins < 60 ? 'ok' : (mins < 240 ? 'warn' : 'bad');
      }
    }

    // 今日时间线
    {
      const el = document.getElementById('timeline');
      if (!d.hourly) { el.innerHTML = ''; }
      else {
        const max = Math.max(1, ...d.hourly.map(x => x.total));
        let bars = '', labels = '';
        for (const h of d.hourly) {
          const pct = h.total > 0 ? Math.max(12, Math.round(h.total / max * 100)) : 0;
          const cls = h.joined > 0 ? 'joined' : (h.total > 0 ? 'has' : '');
          const tip = h.hour + ' 点：' + h.total + ' 个' + (h.joined ? '，参与 ' + h.joined : '');
          bars += '<div class="tl-col" title="' + tip + '"><div class="tl-bar ' + cls + '" style="height:' + pct + '%"></div></div>';
          labels += '<span>' + (h.hour % 3 === 0 ? h.hour : '') + '</span>';
        }
        el.innerHTML = '<div class="tl-wrap"><div class="timeline">' + bars + '</div><div class="tl-labels">' + labels + '</div></div>';
      }
    }

    // 参与记录明细
    {
      const el = document.getElementById('joins');
      const evs = d.recentEvents || [];
      if (!evs.length) {
        el.innerHTML = '<div class="dim">暂无记录</div>';
      } else {
        const RES = {
          'maybe-joined': ['参与成功', 'ok'],
          'joined': ['参与成功', 'ok'],
          'skip-fans': ['粉丝团跳过', 'dim'],
          'fans-skip-daytime': ['粉丝团·白天不抢', 'dim'],
          'fans-skip-account': ['粉丝团·该号不抢', 'dim'],
          'fans-no-coins': ['抖币不足·需充值', 'warn'],
          'fans-unverified': ['粉丝团加入未确认', 'warn'],
          'need-follow': ['需关注', 'warn'],
          'no-panel': ['未找到面板', 'dim'],
          'packet-skipped': ['人气红包·不抢', 'dim'],
        };
        const LBL = d.accountLabels || {};
        el.innerHTML = evs.map(j=>{
          const t = new Date(j.at);
          const hh = String(t.getHours()).padStart(2,'0')+':'+String(t.getMinutes()).padStart(2,'0');
          const onl = (j.online !== undefined && j.online !== null && j.online >= 0) ? j.online.toLocaleString() : '-';
          const [label, cls] = RES[j.result] || [j.result || '?', 'dim'];
          // 🎯 账号徽标：多账号并行时两个号可能同秒抢同一间房，
          //    没有这个标记就出现两行一模一样的记录，用户分不清是谁抢的。
          const a = LBL[j.account || 'default'] || {};
          const color = a.color || 'var(--accent)';
          const badge = '<span class="acc-badge" title="'+(j.accountLabel||'')+'" style="color:'+color+
                        ';border-color:'+color+'55;background:'+color+'18">' +
                        (j.accountShort || j.accountLabel || j.account || '主实例') + '</span>';
          return '<div class="kv"><span>'+hh+' '+badge+' <span class="tag">'+(j.roomName||j.room)+'</span></span>'+
                 '<span class="'+cls+'">'+label+' · 在线 '+onl+'</span></div>';
        }).join('');
      }
    }

    // 📊 历史总数据（2026-11-06 用户要求，替代原「主播档案（累计）」逐房间列表）
    //    口径与底部「历史 X/Y」一致：都用后端 dedupRows 后的全局累计，不虚高、不打架。
    {
      const el = document.getElementById('history');
      if (el) {
        if (!d.history) { el.innerHTML = '<div class="dim">暂无数据</div>'; }
        else {
          const H = d.history;
          const sec = (t) => '<div class="dim" style="font-size:10px;margin:7px 0 2px;border-bottom:1px solid rgba(255,255,255,.06);padding-bottom:2px">' + t + '</div>';
          const kv = (k, v, cls) => '<div class="kv"><span>' + k + '</span><span' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</span></div>';
          const day = (iso) => { try { const x = new Date(iso); return (x.getMonth()+1) + '/' + x.getDate(); } catch { return '-'; } };

          let html = '';
          html += sec('战绩总览');
          html += kv('累计遭遇', H.total);
          html += kv('累计参与成功', '<b>' + H.joined + '</b>', 'ok');
          html += kv('累计参与率', H.rate + '%', Number(H.rate) >= 60 ? 'ok' : (Number(H.rate) >= 30 ? 'warn' : 'bad'));
          html += kv('统计跨度', H.days + ' 天 · ' + day(H.firstAt) + '—' + day(H.lastAt));
          html += kv('累计巡房轮次', H.rounds);

          html += sec('开奖结果');
          html += kv('中奖', H.wins, H.wins > 0 ? 'ok' : 'dim');
          html += kv('未中奖', H.losses);
          html += kv('开奖合计', H.draws);

          html += sec('执行能力 · 累计');
          html += kv('关注主播', H.followOk + '/' + H.followTotal + ' 真实到位');
          html += kv('加入粉丝团', H.fansOk + '/' + H.fansTotal + ' 验证通过');
          html += kv('主播档案', H.anchorTotal + ' 个 · 会发袋 ' + H.anchorKnown + ' 个');

          html += sec('分账号累计 · 含已删除账号历史');
          html += H.byAcc.map((a) => kv(a.label, a.total + '遭 / <b class="ok">' + a.joined + '参</b> · ' + a.rate + '%')).join('');

          html += sec('结果分布 · 累计');
          html += H.byResult.map((r) => kv(LABEL[r.key] || r.key, r.n)).join('');

          el.innerHTML = html;
        }
      }
    }

    // 学习进度
    {
      const el = document.getElementById('learning');
      if (el && d.learning) {
        const L = d.learning;
        const cls = L.masteryRate >= 60 ? 'ok' : (L.masteryRate >= 30 ? 'warn' : 'bad');
        el.innerHTML =
          '<div class="kv"><span>主播档案</span><span>' + L.total + ' 个</span></div>' +
          '<div class="kv"><span>已访问</span><span>' + L.visited + ' 个</span></div>' +
          '<div class="kv"><span>样本充足(≥3次)</span><span class="' + cls + '">' + L.mastered + ' 个 · ' + L.masteryRate + '%</span></div>' +
          '<div class="kv"><span>确认会发福袋</span><span class="ok">' + L.known + ' 个</span></div>' +
          '<div class="kv"><span>访问多次无福袋</span><span class="bad">' + L.silent + ' 个</span></div>' +
          '<div class="kv"><span>掌握度</span><span class="' + cls + '">' +
            (L.masteryRate >= 60 ? '良好' : (L.masteryRate >= 30 ? '积累中' : '样本不足')) + '</span></div>';
      }
    }

    // 📌 指定主播状态：用户最关心「我让你盯的主播现在在播吗」
    {
      const el = document.getElementById('pinned');
      if (el && d.pinned) {
        const badge = (p) => {
          if (p.state === 'live')   return '<span class="ok">● 在播 ' + (p.online != null ? p.online + ' 人' : '') + '</span>';
          if (p.state === 'offline')return '<span class="dim">○ 未开播</span>';
          if (p.state === 'fail')   return '<span class="warn">◍ 探测超时</span>';
          return '<span class="dim">· 待探测</span>';
        };
        el.innerHTML = d.pinned.map(function (p) {
          var sub = [];
          if (p.hour) sub.push('开播 ' + p.hour);
          if (p.coolMin > 0) sub.push(p.coolMin + ' 分钟后重探');
          if (p.visits) sub.push('盯过 ' + p.visits + ' 次');
          if (p.fudaiTotal) sub.push('曾发 ' + p.fudaiTotal + ' 次');
          if (p.probedAt) sub.push('探测于 ' + p.probedAt);
          return '<div class="kv"><span>' + p.name + '<span class="dim" style="font-size:11px"> ' + p.id + '</span></span>' +
                 '<span>' + badge(p) + '</span></div>' +
                 '<div class="dim" style="font-size:11px;margin:-2px 0 6px 0">' + sub.join(' · ') + '</div>';
        }).join('');
      }
    }

    // 当前门槛
    {
      const el = document.getElementById('threshold');
      if (d.threshold) {
        el.textContent = d.threshold.value.toLocaleString() + ' 人（' + (d.threshold.night ? '晚间' : '白天') + '）';
        el.style.color = d.threshold.night ? 'var(--warn)' : 'var(--ok)';
      }
    }

    // 上轮采集数
    {
      const el = document.getElementById('last-round');
      if (el) el.textContent = (d.lastRound != null) ? (d.lastRound + ' 个房间') : '-';
    }

    // 日志默认 8 行，点击可展开全部 40 行
    {
      const el = document.getElementById('log');
      el.textContent = (window.__logExpanded ? d.logTailFull : d.logTail) || '(无日志)';
      el.style.cursor = 'pointer';
      el.title = '点击展开/收起';
      el.onclick = () => { window.__logExpanded = !window.__logExpanded; el.textContent = (window.__logExpanded ? d.logTailFull : d.logTail) || '(无日志)'; };
    }

  }catch(e){
    document.getElementById('ts').textContent = '连接失败: ' + e.message;
  }
}
document.querySelectorAll('.btn').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    const act = btn.dataset.act;
    if (!act) return;   // 「添加账号」等自有按钮不走这里的 confirm 流程
    const name = {'start':'启动抓取','stop':'停止抓取','restart':'重启抓取'}[act] || act;
    if(!confirm('确认要「'+name+'」吗？')) return;
    const msg = document.getElementById('act-msg');
    msg.textContent = '执行中...';
    document.querySelectorAll('.btn').forEach(b=>b.disabled=true);
    try{
      const r = await fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:act})});
      const d = await r.json();
      msg.textContent = (d.ok?'✅ ':'❌ ') + (d.output || d.error || '');
      msg.style.color = d.ok ? 'var(--ok)' : 'var(--bad)';
    }catch(e){
      msg.textContent = '❌ ' + e.message;
      msg.style.color = 'var(--bad)';
    }
    document.querySelectorAll('.btn').forEach(b=>b.disabled=false);
    setTimeout(tick, 1500);
  });
});

// 「切换到此账号」：把该账号的登录态同步到主 profile 并重启抓取（事件委托，因为按钮是动态生成的）
document.getElementById('accounts-box').addEventListener('click', async function (ev) {
  const btn = ev.target.closest('[data-use-account]');
  if (!btn) return;
  const name = btn.getAttribute('data-use-account');
  if (!confirm('确认切换到账号「' + name + '」？会停止抓取、同步登录态、再重新启动。')) return;
  const msg = document.getElementById('acc-msg');
  msg.textContent = '正在切换（约 30-60 秒）…';
  msg.style.color = 'var(--dim)';
  btn.disabled = true;
  try {
    const r = await fetch('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'account-use', arg: name })
    });
    const d = await r.json();
    msg.textContent = (d.ok ? '✅ ' : '❌ ') + (d.output || d.error || '');
    msg.style.color = d.ok ? 'var(--ok)' : 'var(--bad)';
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.style.color = 'var(--bad)';
  }
  btn.disabled = false;
  setTimeout(tick, 1500);
});

// 「添加账号」：弹输入框 → 后台启动有头 Chrome 扫码
document.getElementById('btn-acc-add').addEventListener('click', async function () {
  const name = prompt('新账号名字（中英文/数字/下划线，例如 main2）：', 'main2');
  if (!name) return;
  const msg = document.getElementById('acc-msg');
  msg.textContent = '正在启动扫码窗口…';
  msg.style.color = 'var(--dim)';
  try {
    const r = await fetch('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'account-add', arg: name })
    });
    const d = await r.json();
    msg.textContent = (d.ok ? '✅ ' : '❌ ') + (d.output || d.error || '');
    msg.style.color = d.ok ? 'var(--ok)' : 'var(--bad)';
  } catch (e) {
    msg.textContent = '❌ ' + e.message;
    msg.style.color = 'var(--bad)';
  }
});

async function loadCfg(){
  try{
    const r = await fetch('/api/config');
    const d = await r.json();
    document.getElementById('cfg-enabled').checked = d.categoryFilter.enabled !== false;
    document.getElementById('cfg-no-threshold').checked = d.categoryFilter.noThreshold !== false;
    document.getElementById('cfg-small').checked = d.categoryFilter.preferSmallRooms !== false;
    document.getElementById('cfg-skip-fans').checked = d.categoryFilter.skipFansGroup !== false;
    document.getElementById('cfg-bonus').value = d.categoryFilter.bonus || 20;
    document.getElementById('cfg-keywords').value = (d.categoryFilter.keywords || []).join(',');
    document.getElementById('cfg-day').value = d.threshold.day;
    document.getElementById('cfg-night').value = d.threshold.night;
    const pinned = d.pinned || {};
    document.getElementById('cfg-pinned').value = Object.entries(pinned).map(function(e){ return e[0] + ',' + (e[1].name || '') + ',' + ((e[1].hours || []).join(',')); }).join('\n');
  }catch(e){ document.getElementById('cfg-msg').textContent = '读取设置失败'; }
}
document.getElementById('btn-cfg-reload').addEventListener('click', loadCfg);
document.getElementById('btn-cfg-save').addEventListener('click', async function(){
  const msg = document.getElementById('cfg-msg');
  msg.textContent = '保存中…';
  try{
    const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      categoryFilter: { enabled: document.getElementById('cfg-enabled').checked, mode: document.getElementById('cfg-enabled').checked ? 'only' : 'off', keywords: document.getElementById('cfg-keywords').value, bonus: Number(document.getElementById('cfg-bonus').value) || 20, noThreshold: document.getElementById('cfg-no-threshold').checked, preferSmallRooms: document.getElementById('cfg-small').checked, skipFansGroup: document.getElementById('cfg-skip-fans').checked },
      threshold: { day: Number(document.getElementById('cfg-day').value), night: Number(document.getElementById('cfg-night').value) },
      pinned: document.getElementById('cfg-pinned').value
    })});
    const d = await r.json();
    if(!d.ok){ msg.textContent = '保存失败：' + (d.error || ''); return; }
    msg.textContent = '已保存，点下面“重启”让抓取生效';
  }catch(e){ msg.textContent = '保存失败：' + e.message; }
});
loadCfg();
tick();
setInterval(tick, 15000);
</script>
</body>
</html>`;

const MANIFEST = {
  name: '抖音福袋看板',
  short_name: '福袋',
  description: '抖音福袋自动参与系统的状态看板',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0f1115',
  theme_color: '#0f1115',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
  ],
};

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">
<rect width="192" height="192" rx="42" fill="#0f1115"/>
<rect x="46" y="62" width="100" height="78" rx="14" fill="none" stroke="#4f9cf9" stroke-width="7"/>
<path d="M46 84h100" stroke="#4f9cf9" stroke-width="7"/>
<circle cx="96" cy="120" r="17" fill="none" stroke="#3ddc84" stroke-width="7"/>
<path d="M96 111v16M90 118h12" stroke="#3ddc84" stroke-width="5" stroke-linecap="round"/>
</svg>`;

/** 白名单动作：只允许启停，绝不放任意命令 */
function doAction(action, arg) {
  // 添加账号：必须在后台跑，因为扫码可能要等几分钟，不能卡住看板请求
  if (action === 'account-add') {
    const name = String(arg || '').trim();
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{1,20}$/.test(name)) {
      return { ok: false, error: '账号名只能用中英文、数字、下划线、短横线，1-20 个字符' };
    }
    const dir = path.join(PATHS.accounts, name);
    if (fs.existsSync(dir)) return { ok: false, error: `账号「${name}」已存在` };
    try {
      execSync(
        `cd ${JSON.stringify(ROOT)} && nohup node scripts/account-manager.mjs add ${JSON.stringify(name)} > /tmp/account-add-${name}.log 2>&1 &`,
        { timeout: 5000, shell: '/bin/bash' }
      );
      return { ok: true, action, output: `已启动「${name}」的扫码窗口，请在弹出的 Chrome 里完成登录；成功后点「重启抓取」让它生效。` };
    } catch (e) {
      return { ok: false, error: String(e.message).slice(0, 200) };
    }
  }
  // 切换账号：把 accounts/<name>/profile 的登录态同步到主 profile，再重启抓取。
  // 必须这么做——抓取默认用 douyin-auto/chrome-profile，不复制过去等于没切换。
  if (action === 'account-use') {
    const name = String(arg || '').trim();
    if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{1,20}$/.test(name)) return { ok: false, error: '账号名非法' };
    const srcDir = path.join(PATHS.accounts, name, 'profile', 'Default');
    const dstDir = path.join(ROOT, 'douyin-auto', 'chrome-profile', 'Default');
    if (!fs.existsSync(srcDir)) return { ok: false, error: `账号「${name}」没有登录数据` };
    try {
      execSync('bash ' + path.join(ROOT, 'scripts', 'fudai.sh') + ' stop', { timeout: 60000, encoding: 'utf8' });
    } catch {}
    let copied = [];
    for (const f of ['Cookies', 'Local Storage', 'Session Storage', 'Preferences']) {
      const src = path.join(srcDir, f);
      if (!fs.existsSync(src)) continue;
      try {
        fs.cpSync(src, path.join(dstDir, f), { recursive: true, force: true });
        copied.push(f);
      } catch (e) { return { ok: false, error: '复制 ' + f + ' 失败: ' + String(e.message).slice(0, 120) }; }
    }
    let out = '';
    try { out = execSync('bash ' + path.join(ROOT, 'scripts', 'fudai.sh') + ' start', { timeout: 90000, encoding: 'utf8' }); } catch (e) {}
    return { ok: true, action, output: `已切换到「${name}」（同步 ${copied.length} 项登录数据）并重启抓取。${String(out).trim()}` };
  }
  const map = {
    start:   'bash ' + path.join(ROOT, 'scripts', 'fudai.sh') + ' start',
    stop:    'bash ' + path.join(ROOT, 'scripts', 'fudai.sh') + ' stop',
    restart: 'bash ' + path.join(ROOT, 'scripts', 'fudai.sh') + ' restart',
    web:     'bash ' + path.join(ROOT, 'scripts', 'fudai.sh') + ' web',
  };
  const cmd = map[action];
  if (!cmd) return { ok: false, error: '不支持的操作: ' + action };
  try {
    const out = execSync(cmd, { timeout: 60000, encoding: 'utf8' });
    return { ok: true, action, output: out.trim() };
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 200), output: (e.stdout || '').trim() };
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    res.end(JSON.stringify(MANIFEST));
    return;
  }
  if (req.url === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'max-age=86400' });
    res.end(ICON_SVG);
    return;
  }
  if (req.url === '/api/live') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(readLive()));
    return;
  }
  if (req.url === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(readConfig()));
    return;
  }
  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const cfg = writeConfig(j);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...cfg, note: '已保存，重启抓取后生效（看板点“重启”即可）' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    });
    return;
  }
  if (req.url === '/api/action' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let action = null, arg = null;
      try { const j = JSON.parse(body); action = j.action; arg = j.arg; } catch {}
      const result = doAction(action, arg);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  if (req.url === '/api/status') {
    try {
      const body = JSON.stringify(buildStatus());
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e.message) }));
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  try {
    const dash = fs.readFileSync(path.join(ROOT, 'web', 'dashboard.html'), 'utf8');
    res.end(dash);
  } catch { res.end(HTML); }
});

// 监听 0.0.0.0：手机需要在同一局域网内访问
server.listen(PORT, '0.0.0.0', () => {
  console.log(`抖音福袋看板已启动: http://127.0.0.1:${PORT}`);
  console.log('手机访问地址（需与电脑连同一 WiFi）:');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('\n手机浏览器打开后，点「分享 → 添加到主屏幕」即可像 App 一样使用。');
});
