'use strict';
/**
 * 存储层：内存驱动（开发/测试）与 SQLite 驱动（开发持久化/小规模生产）双实现。
 * 两种驱动对外接口完全一致，域逻辑不感知存储实现；生产可平滑替换为 MySQL（表结构对照 Table 定义）。
 * 所有幂等键唯一约束；审计日志 append-only（持久化驱动下落盘，重启不丢）。
 */
const fs = require('fs');
const path = require('path');

class Table {
  constructor(name, idKey = 'id') {
    this.name = name;
    this.idKey = idKey;
    this.rows = new Map();
    this._seq = 0;
    this._ver = 0; // 写入版本号：insert/update/delete 自增，供上层做聚合缓存失效判定（P3-1）
  }
  /** 从既有行恢复自增序列（持久化重启后避免主键冲突） */
  _recoverSeq() {
    let max = 0;
    for (const id of this.rows.keys()) {
      const n = /^\d+$/.test(id) ? parseInt(id, 10) : parseInt(String(id).split('_').pop(), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    this._seq = max;
  }
  nextId(prefix) {
    this._seq += 1;
    return prefix ? `${prefix}_${this._seq}` : this._seq;
  }
  insert(row) {
    if (row[this.idKey] == null) row[this.idKey] = this.nextId();
    row[this.idKey] = String(row[this.idKey]); // ID 统一为字符串，避免 JSON 传输后类型不匹配
    if (this.rows.has(row[this.idKey])) throw new Error(`dup id ${row[this.idKey]} in ${this.name}`);
    this.rows.set(row[this.idKey], row);
    this._ver++;
    return row;
  }
  get(id) { return this.rows.get(String(id)) || null; }
  /** 全部行快照（按写入版本号缓存，避免每次 where() 都重建数组；行对象本身是同一引用，字段变更实时可见）
   *  返回的是**只读视图**：数组本身被冻结，调用方需排序/截取时先自行复制（[...arr] / arr.slice()） */
  all() {
    if (this._allCache && this._allCacheVer === this._ver) return this._allCache;
    const rows = Object.freeze([...this.rows.values()]);
    this._allCache = rows; this._allCacheVer = this._ver;
    return rows;
  }
  where(fn) { return this.all().filter(fn); }
  update(id, patch) {
    const row = this.rows.get(id);
    if (!row) throw new Error(`not found ${id} in ${this.name}`);
    Object.assign(row, patch);
    this._ver++;
    return row;
  }
  delete(id) { const ok = this.rows.delete(String(id)); this._ver++; return ok; }
}

/** SQLite 持久化表：与 Table 同接口，行以 JSON blob 落盘。
 *  行对象经 Proxy 包装：任何属性变更自动落盘（域代码大量直接改行字段，如 p.done += 1）。
 *  仅拦截顶层属性变更（与现有域代码的写入方式一致）；嵌套对象变更请改用 update()。 */
class SqliteTable extends Table {
  constructor(db, name, idKey = 'id') {
    super(name, idKey);
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    const load = db.prepare(`SELECT id, data FROM "${name}"`);
    this._raw = new Map(); // id -> 原始行
    this._proxies = new Map(); // id -> Proxy（保持对象身份稳定）
    for (const r of load.iterate()) {
      const row = JSON.parse(r.data);
      row[this.idKey] = r.id;
      this._raw.set(r.id, row);
    }
    this._recoverSeq();
    this._ins = db.prepare(`INSERT INTO "${name}" (id, data) VALUES (?, ?)`);
    this._upd = db.prepare(`UPDATE "${name}" SET data = ? WHERE id = ?`);
    this._del = db.prepare(`DELETE FROM "${name}" WHERE id = ?`);
  }
  _recoverSeq() {
    let max = 0;
    for (const id of this._raw.keys()) {
      const n = /^\d+$/.test(id) ? parseInt(id, 10) : parseInt(String(id).split('_').pop(), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    this._seq = max;
  }
  _persist(id) {
    this._upd.run(JSON.stringify(this._raw.get(id)), id);
  }
  _wrap(id) {
    if (this._proxies.has(id)) return this._proxies.get(id);
    const self = this;
    const proxy = new Proxy(this._raw.get(id), {
      set(target, prop, value) {
        target[prop] = value;
        self._persist(id);
        self._ver++; // 直接改行字段也算写入：聚合缓存（P3-1）需随之失效
        return true;
      },
      deleteProperty(target, prop) {
        delete target[prop];
        self._persist(id);
        self._ver++;
        return true;
      },
    });
    this._proxies.set(id, proxy);
    return proxy;
  }
  delete(id) {
    const key = String(id);
    this._proxies.delete(key);
    if (this._raw.has(key)) {
      this._raw.delete(key);
      if (this._del) this._del.run(key);
    }
    this._ver++;
    return this.rows.delete(key);
  }
  insert(row) {
    if (row[this.idKey] == null) row[this.idKey] = this.nextId();
    row[this.idKey] = String(row[this.idKey]);
    if (this._raw.has(row[this.idKey])) throw new Error(`dup id ${row[this.idKey]} in ${this.name}`);
    this._ins.run(row[this.idKey], JSON.stringify(row));
    this._raw.set(row[this.idKey], row);
    this.rows.set(row[this.idKey], this._wrap(row[this.idKey]));
    this._ver++;
    return this.rows.get(row[this.idKey]);
  }
  get(id) {
    const key = String(id);
    if (!this._raw.has(key)) return null;
    if (!this.rows.has(key)) this.rows.set(key, this._wrap(key));
    return this.rows.get(key);
  }
  /** 全部行快照（按写入版本号缓存；行对象为稳定 Proxy，字段变更实时可见） */
  all() {
    if (this._allCache && this._allCacheVer === this._ver) return this._allCache;
    const rows = Object.freeze([...this._raw.keys()].map((k) => this.get(k)));
    this._allCache = rows; this._allCacheVer = this._ver;
    return rows;
  }
  where(fn) { return this.all().filter(fn); }
  update(id, patch) {
    const key = String(id);
    if (!this._raw.has(key)) throw new Error(`not found ${id} in ${this.name}`);
    Object.assign(this._raw.get(key), patch);
    this._persist(key);
    this._ver++;
    return this.get(key);
  }
}

/** 开关持久化：Map 行为一致，set/delete 同步落盘 */
class SwitchMap extends Map {
  constructor(db) {
    super();
    this._db = db;
    db.exec('CREATE TABLE IF NOT EXISTS switches (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this._ins = db.prepare('INSERT OR REPLACE INTO switches (key, value) VALUES (?, ?)');
    this._del = db.prepare('DELETE FROM switches WHERE key = ?');
    // 用 all() 一次性取回：iterate() 期间临时 statement 可能被 GC 回收导致 ERR_INVALID_STATE
    for (const r of db.prepare('SELECT key, value FROM switches').all()) {
      super.set(r.key, JSON.parse(r.value));
    }
  }
  set(key, value) {
    this._ins.run(key, JSON.stringify(value));
    return super.set(key, value);
  }
  delete(key) {
    this._del.run(key);
    return super.delete(key);
  }
}

/** 审计日志：append-only，持久化驱动下落盘 */
class AuditLog {
  constructor(db) {
    this.items = [];
    this._db = db;
    if (db) {
      db.exec('CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)');
      this._ins = db.prepare('INSERT INTO audit (data) VALUES (?)');
      for (const r of db.prepare('SELECT data FROM audit ORDER BY seq').all()) this.items.push(JSON.parse(r.data));
    }
  }
  push(entry) {
    if (this._ins) this._ins.run(JSON.stringify(entry));
    this.items.push(entry);
    return this;
  }
  slice(start, end) { return this.items.slice(start, end); }
  get length() { return this.items.length; }
}

/** 幂等键：持久化驱动下落盘（重启后回调重放仍幂等） */
class Idempotency {
  constructor(db) {
    this.keys = new Map();
    this._db = db;
    if (db) {
      db.exec('CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      this._ins = db.prepare('INSERT OR REPLACE INTO idempotency (key, value) VALUES (?, ?)');
      for (const r of db.prepare('SELECT key, value FROM idempotency').all()) {
        this.keys.set(r.key, JSON.parse(r.value).v);
      }
    }
  }
  run(key, fn) {
    if (this.keys.has(key)) return { replay: true, value: this.keys.get(key) };
    const value = fn();
    if (this._ins) {
      try {
        this._ins.run(key, JSON.stringify({ v: value }));
      } catch (e) { /* 不可序列化的返回值仅保留在内存 */ }
    }
    this.keys.set(key, value);
    return { replay: false, value };
  }
}

const TABLE_DEFS = [
  ['users'], ['categories'], ['products'], ['orders'], ['snapshots'], ['progress'],
  ['commissionRecords'], ['earnings'], ['earningFlows'], ['dividendPoolFlows'], ['platformFlows'], ['queueSlots'],
  ['dividendPayouts'], ['activitySnapshots'], ['reserveFlows'], ['quarterEligibility'],
  ['contributions'], ['contributionFlows'], ['messages'], ['taskRecords'],
  ['withdrawRequests'], ['withdrawTransfers'], ['merchants'], ['coupons'], ['couponClaims'], ['allianceOrders'], ['couponRedemptions'],
  ['adSlots'], ['adBookings'], ['adEvents'], ['leaderPoolFlows'], ['quarterPayouts'],
  ['merchantApplications'], // 商家入驻申请（资质审核：pending_review -> approved/rejected）
  ['adminAccounts'], ['adminSessions'], // 管理后台账号（scrypt 摘要）与登录会话
  ['adminUsers'], ['adminUserSessions'], // 子管理员账号（总账号创建/授权）与会话（V4.1）
  ['blacklist'], ['appeals'], ['riskAlerts'],
  ['userSessions'], ['addressBook'], // 风控：黑名单/用户申诉/循环免单预警
  ['ruleConfirmations'], // 规则版本确认留档（V3.17 §5.2-1：用户确认过的规则版本 + 时间）
  ['uploadQuota'], // 上传每日配额计数（P0-3：按主体/IP/全局落库，重启不重置）
  ['opsSlides'],   // 首页运营轮播帧（后台可配：标题/副标题/按钮/跳转/图/排序/上下线）
  ['content'],     // 文案配置（key → 正文，前端拉取 + 本地兜底；改文案不用发版）
  ['adVideos'], ['adRewardRecords'], ['cashLedger'], ['rewardWithdrawals'], // 广告激励 V4.0（视频广告+完播奖励+提现）
  // 广告中心 V4.2：效果埋点 / 结算单 / 商家广告额度 / 额度流水
  ['adVideoEvents'], ['adVideoSettlements'], ['merchantAdQuota'], ['adQuotaFlows'],
  ['merchantFeeBills'], // 联盟服务费应收台账（核销即挂账，后台收款后才算平台实收）
];

function createStore(options = {}) {
  const useSqlite = !!options.sqlitePath;
  let sqlite = null;
  if (useSqlite) {
    fs.mkdirSync(path.dirname(options.sqlitePath), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    sqlite = new DatabaseSync(options.sqlitePath);
    sqlite.exec('PRAGMA journal_mode = WAL;');
  }
  const mk = (name, idKey) => (useSqlite ? new SqliteTable(sqlite, name, idKey) : new Table(name, idKey));
  const db = {
    _driver: useSqlite ? 'sqlite' : 'memory',
    users: mk('users'),
    categories: mk('categories'), // 含 r/n/步长配置
    products: mk('products'),
    orders: mk('orders'),          // pay_type: WX_PAY | FREE
    snapshots: mk('snapshots'),    // 阶梯价快照
    progress: mk('progress'),      // 复购进度（按 user+category）
    commissionRecords: mk('commissionRecords'), // 分佣记录（冻结/结算/回滚）
    earnings: mk('earnings'),      // 收益账户（余额/冻结）
    earningFlows: mk('earningFlows'),
    dividendPoolFlows: mk('dividendPoolFlows'), // 分红池流水
    platformFlows: mk('platformFlows'), // 平台留存流水（未归属分佣份额 / 周期留存），只增不改，供对账
    queueSlots: mk('queueSlots'),  // 排队队位
    dividendPayouts: mk('dividendPayouts'),
    activitySnapshots: mk('activitySnapshots'), // 用户活跃 T-1 快照
    reserveFlows: mk('reserveFlows'),  // 储备专户流水
    quarterEligibility: mk('quarterEligibility'), // 季度分红资格快照
    contributions: mk('contributions'), // 贡献值账户（只记权重，无兑付）
    contributionFlows: mk('contributionFlows'),
    messages: mk('messages'),
    taskRecords: mk('taskRecords'),
    withdrawRequests: mk('withdrawRequests'),  // 提现申请（审核→拆笔发放）
    withdrawTransfers: mk('withdrawTransfers'), // 商家转账批次（单笔≤500、日≤2000、待确认收款/超时退回）
    merchants: mk('merchants'),                // 商家（异业联盟）
    coupons: mk('coupons'),                    // 商家券模板（满减/折扣/次卡）
    couponClaims: mk('couponClaims'),          // 用户领取的券（一券一码，核销码）
    allianceOrders: mk('allianceOrders'),      // 联盟服务单（券核销/次卡核销，计服务费 + 方案 B 分佣）
    couponRedemptions: mk('couponRedemptions'), // 历史券核销记录（旧链路兼容）
    adSlots: mk('adSlots'),                    // 商家广告位
    adBookings: mk('adBookings'),              // 广告位投放（素材 + 审核 + 曝光/点击计数）
    adEvents: mk('adEvents'),                  // 广告事件明细（曝光/点击，按天去重）
    leaderPoolFlows: mk('leaderPoolFlows'),    // 团队长辅导分红池流水（in/out，按团队长归属）
    quarterPayouts: mk('quarterPayouts'),      // 季度分红发放批次（幂等，每季度一次）
    adminAccounts: mk('adminAccounts'),        // 管理后台账号（username + scrypt 摘要，永不存明文）
    adminSessions: mk('adminSessions'),        // 管理后台登录会话（token）
    adminUsers: mk('adminUsers'),              // 子管理员账号（总账号创建；权限按模块勾选；可停用）
    adminUserSessions: mk('adminUserSessions'), // 子管理员登录会话（token → username）
    blacklist: mk('blacklist'),                // 风控黑名单（登录/下单拦截）
    appeals: mk('appeals'),                    // 用户申诉
    riskAlerts: mk('riskAlerts'),              // 循环免单等风险预警（不自动处置）
    userSessions: mk('userSessions'),          // 用户登录会话（token → userId，下单强制登录态）
    addressBook: mk('addressBook'),            // 收货地址簿（下单需选择，订单快照收货信息）
    merchantApplications: mk('merchantApplications'), // 商家入驻资质申请
    ruleConfirmations: mk('ruleConfirmations'), // 规则版本确认留档（V3.17 §5.2-1：用户确认过的规则版本 + 时间）
    uploadQuota: mk('uploadQuota'),         // 上传每日配额计数（P0-3：id = 日期|作用域）
    opsSlides: mk('opsSlides'),            // 首页运营轮播帧（后台可配，替代前端写死的 OPS_SLIDES）
    content: mk('content'),                // 文案配置（key → 正文；规则/协议/合规声明等）
    adVideos: mk('adVideos'),              // 广告激励：视频广告计划（计费参数联动 + IP 进度）
    adRewardRecords: mk('adRewardRecords'),// 广告激励：完播发放流水（用户/IP 双去重）
    cashLedger: mk('cashLedger'),          // 广告激励：用户现金余额账本（发放/冻结/回退）
    rewardWithdrawals: mk('rewardWithdrawals'), // 广告激励：用户奖励提现单（审核→打款）
    adVideoEvents: mk('adVideoEvents'),         // 广告中心：曝光/点击/开始/完播/跳商品 埋点
    adVideoSettlements: mk('adVideoSettlements'), // 广告中心：计划结算单（剩余预算退商家）
    merchantAdQuota: mk('merchantAdQuota'),     // 广告中心：商家广告额度（总后台审批发放）
    adQuotaFlows: mk('adQuotaFlows'),           // 广告中心：额度增减流水（不可篡改账本）
    merchantFeeBills: mk('merchantFeeBills'),   // 联盟服务费应收单（due -> paid；收款后才划储备专户）
    refundAnomalies: mk('refundAnomalies'),     // 退款异常队列（失败/关闭/长期处理中；后台可见并重试）
    switches: useSqlite ? new SwitchMap(sqlite) : new Map(Object.entries(require('./domain/config').DEFAULTS)),
    auditLogs: new AuditLog(useSqlite ? sqlite : null), // append-only
    idempotency: new Idempotency(useSqlite ? sqlite : null),
  };
  if (useSqlite) {
    // 开关：库内已有值优先，缺省项补默认值（新增开关自动生效）
    for (const [k, v] of Object.entries(require('./domain/config').DEFAULTS)) {
      if (!db.switches.has(k)) db.switches.set(k, v);
    }
  }
  return db;
}

/**
 * 审计日志（append-only，永不覆盖/删除）。
 * actor 支持两种形态：
 * - 字符串：兼容既有调用（actor 即展示名，actorId 留空）；
 * - { id, name }：管理员操作建议传此形态，actor 存用户名、actorId 存不可变账号 ID，
 *   避免「删除后重建同名账号」导致审计无法区分操作人。
 */
function audit(db, actor, action, detail) {
  const isObj = actor && typeof actor === 'object';
  const actorId = isObj && actor.id != null ? String(actor.id) : '';
  const actorName = isObj ? String(actor.name != null ? actor.name : actor.id ?? '') : String(actor);
  db.auditLogs.push({
    ts: new Date().toISOString(),
    actor: actorName,
    actorId,
    action,
    detail: JSON.stringify(detail),
  });
}

module.exports = { createStore, Table, Idempotency, audit };
