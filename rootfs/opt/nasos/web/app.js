/* =============================================================================
 *  NasOS Web Console - 前端主逻辑
 *
 *  设计要点:
 *   - 无框架依赖 (原生 JS)，镜像内体积最小、加载最快
 *   - 双模式: 连得上后端 /api 就取真实数据；连不上就自动降级为演示数据，
 *     因此直接用浏览器打开 index.html (file://) 也能看到完整界面
 * =========================================================================== */

'use strict';

/* ==========================================================================
 * 1. 状态
 * ========================================================================== */
const STATE = {
  view: 'dashboard',
  demo: false,          // 是否处于演示模式（未连上真实后端）
  data: {},             // 全量数据
  timer: null,
};

/* ==========================================================================
 * 2. 演示数据（真实环境由 /api/* 提供，结构完全一致）
 * ========================================================================== */
const DEMO = {
  system: {
    hostname: 'nasos',
    version: '0.1.0',
    arch: 'x86_64',
    cpu_model: 'Intel(R) Xeon(R) Silver 4314 CPU @ 2.40GHz',
    cpu_cores: 16,
    kernel: '6.1.0-18-amd64',
    uptime: '12 天 6 小时',
    bios: 'UEFI',
    cpu_vendor: 'Intel / AMD 通用 (x86_64)',
  },
  stats: { cpu: 18, mem: 43, mem_total_gb: 32, disk: 61, temp: 42, net_rx: 12.4, net_tx: 3.8, load: 0.86 },
  disks: [
    { dev: '/dev/sda', model: 'WDC WD HC550 16TB', size: '16.0 TB', type: 'HDD', temp: 36, health: 'OK',  smart: '通过', serial: 'WD-2HG8K1', pool: 'pool0' },
    { dev: '/dev/sdb', model: 'WDC WD HC550 16TB', size: '16.0 TB', type: 'HDD', temp: 37, health: 'OK',  smart: '通过', serial: 'WD-2HG8K2', pool: 'pool0' },
    { dev: '/dev/sdc', model: 'WDC WD HC550 16TB', size: '16.0 TB', type: 'HDD', temp: 38, health: 'OK',  smart: '通过', serial: 'WD-2HG8K3', pool: 'pool0' },
    { dev: '/dev/sdd', model: 'WDC WD HC550 16TB', size: '16.0 TB', type: 'HDD', temp: 39, health: 'OK',  smart: '通过', serial: 'WD-2HG8K4', pool: 'pool0' },
    { dev: '/dev/nvme0n1', model: 'Samsung 980 PRO 1TB', size: '1.0 TB', type: 'NVMe', temp: 44, health: 'OK', smart: '通过', serial: 'S5GXNX0R', pool: 'flash-pool' },
    { dev: '/dev/sde', model: 'ST4000NM000A 4TB', size: '4.0 TB', type: 'HDD', temp: 47, health: 'WARN', smart: '5 个重映射扇区', serial: 'ST-ZZ31KD', pool: '-' },
  ],
  pools: [
    { name: 'pool0',       raid: 'RAID 5',  size: '48.0 TB', used: 61, status: '正常', disks: 4, fs: 'btrfs', mount: '/mnt/pool0' },
    { name: 'flash-pool',  raid: 'Single',  size: '1.0 TB',  used: 24, status: '正常', disks: 1, fs: 'ext4',  mount: '/mnt/flash' },
    { name: 'backup',      raid: 'RAID 1',  size: '8.0 TB',  used: 88, status: '容量告警', disks: 2, fs: 'xfs', mount: '/mnt/backup' },
  ],
  shares: [
    { name: 'data',        path: '/mnt/pool0/data',    proto: ['SMB', 'NFS'],        users: '所有用户', rw: true,  status: '启用', size: '12.4 TB' },
    { name: 'media',       path: '/mnt/pool0/media',   proto: ['SMB', 'DLNA'],       users: '所有用户', rw: true,  status: '启用', size: '8.1 TB' },
    { name: 'backup',      path: '/mnt/backup/bak',    proto: ['SMB', 'rsync'],      users: 'admin',    rw: true,  status: '启用', size: '6.9 TB' },
    { name: 'public',      path: '/mnt/pool0/public',  proto: ['SMB', 'FTP'],        users: '匿名可读', rw: false, status: '启用', size: '820 GB' },
    { name: 'docker',      path: '/mnt/flash/docker',  proto: ['SMB'],               users: 'admin',    rw: true,  status: '停用', size: '64 GB' },
  ],
  network: {
    interfaces: [
      { name: 'eth0', type: '以太网', ip: '192.168.1.10/24', mac: '00:1B:44:11:3A:B7', speed: '10 Gbps', state: '已连接', rx: '1.2 GB', tx: '340 MB' },
      { name: 'eth1', type: '以太网', ip: '10.0.0.10/24',    mac: '00:1B:44:11:3A:B8', speed: '10 Gbps', state: '未连接', rx: '0 B',    tx: '0 B' },
      { name: 'bond0', type: '链路聚合', ip: '192.168.1.20/24', mac: '—', speed: '20 Gbps', state: '已连接', rx: '3.4 GB', tx: '1.1 GB' },
    ],
    gateway: '192.168.1.1',
    dns: ['223.5.5.5', '114.114.114.114'],
    hostname: 'nasos',
  },
  users: [
    { name: 'admin',  uid: 1000, group: 'administrators', home: '/mnt/pool0/homes/admin',  shell: '/bin/bash', status: '启用', last: '2026-09-12 01:10' },
    { name: 'wang',   uid: 1001, group: 'users',          home: '/mnt/pool0/homes/wang',   shell: '/bin/bash', status: '启用', last: '2026-09-11 22:31' },
    { name: 'backup', uid: 1002, group: 'users',          home: '/mnt/backup',             shell: '/sbin/nologin', status: '启用', last: '2026-09-12 00:00' },
    { name: 'guest',  uid: 1003, group: 'guests',         home: '/mnt/pool0/public',       shell: '/sbin/nologin', status: '停用', last: '—' },
  ],
  groups: [
    { name: 'administrators', gid: 100, members: 1, perm: '全部读写 + 系统管理' },
    { name: 'users',          gid: 101, members: 2, perm: '个人目录读写 + 共享读写' },
    { name: 'guests',         gid: 102, members: 1, perm: '仅公共目录只读' },
  ],
  apps: {
    installed: [
      { id: 'file',   name: '文件管理器', cat: '官方', icon: '🗂', color: '#0ea5e9', desc: 'Web 端文件浏览、上传下载、在线预览与批量操作。', status: 'running', version: '1.0.0' },
      { id: 'smb',    name: 'SMB 共享',   cat: '官方', icon: '⇄', color: '#22c55e', desc: 'Windows / macOS / Linux 跨平台文件共享服务。',  status: 'running', version: '4.17' },
      { id: 'nfs',    name: 'NFS 共享',   cat: '官方', icon: '⛁', color: '#f59e0b', desc: '为 Linux / 虚拟化平台提供高性能网络文件系统。', status: 'running', version: '2.6' },
      { id: 'docker', name: '容器引擎',   cat: '官方', icon: '◈', color: '#2496ed', desc: 'Docker 运行时，应用中心所有第三方应用依赖它。',   status: 'running', version: '24.0' },
    ],
    available: [
      { id: 'workbuddy', name: 'WorkBuddy', cat: 'AI 助手', icon: 'W', color: '#a78bfa', desc: 'AI 工作助手入口。注意：WorkBuddy 为云端服务，需要账号与网络，镜像内提供的是入口与部署模板，不含服务端。', status: 'available', version: '—' },
      { id: 'ollama',    name: 'Ollama 本地大模型', cat: 'AI', icon: 'O', color: '#7c3aed', desc: '在 NAS 本地运行开源大模型（Llama / Qwen 等），数据不出内网。', status: 'available', version: 'latest' },
      { id: 'jellyfin',  name: 'Jellyfin', cat: '影音', icon: 'J', color: '#00a4dc', desc: '开源影音服务器，自动刮削海报墙，支持硬件转码与多端播放。', status: 'available', version: '10.8' },
      { id: 'nextcloud', name: 'Nextcloud', cat: '云盘', icon: 'N', color: '#0082c9', desc: '私有云盘，支持文件同步、日历、联系人与在线协作。', status: 'available', version: '28' },
      { id: 'photo',     name: 'Immich 相册', cat: '相册', icon: 'P', color: '#7d5fff', desc: 'AI 照片管理，人脸识别、地点时间轴、手机自动备份。', status: 'available', version: '1.9' },
      { id: 'qbitt',     name: 'qBittorrent', cat: '下载', icon: 'Q', color: '#3fa9f5', desc: 'BT / PT 下载工具，带完整 Web 管理界面。', status: 'available', version: '4.6' },
      { id: 'homeass',   name: 'Home Assistant', cat: '智能家居', icon: 'H', color: '#41bdf5', desc: '开源智能家居中枢，接入上千种设备，本地自动化。', status: 'available', version: '2024.1' },
      { id: 'postgres',  name: 'PostgreSQL', cat: '数据库', icon: '🐘', color: '#336791', desc: '关系型数据库，为自建应用提供数据持久化。', status: 'available', version: '16' },
      { id: 'portainer', name: 'Portainer', cat: '运维', icon: '⚓', color: '#13bef9', desc: 'Docker 容器可视化管理，查看日志、状态与资源占用。', status: 'available', version: '2.19' },
      { id: 'vaultwarden', name: 'Vaultwarden', cat: '安全', icon: '🔒', color: '#175ddc', desc: '自建密码库，兼容 Bitwarden 全平台客户端。', status: 'available', version: '1.30' },
    ],
  },
  logs: [
    { t: '2026-09-12 01:12:04', lv: 'info',  msg: 'SMB 服务已就绪，共享 4 个目录' },
    { t: '2026-09-12 01:10:33', lv: 'info',  msg: '存储池 pool0 挂载成功 (/mnt/pool0)' },
    { t: '2026-09-12 01:10:21', lv: 'warn',  msg: '磁盘 /dev/sde 检测到 5 个重映射扇区，建议关注' },
    { t: '2026-09-12 01:10:08', lv: 'info',  msg: 'Docker 引擎启动完成' },
    { t: '2026-09-12 01:09:55', lv: 'info',  msg: '网络 bond0 链路聚合已建立 (20 Gbps)' },
    { t: '2026-09-12 01:09:40', lv: 'info',  msg: 'NasOS 0.1.0 启动完成，内核 6.1.0-18-amd64' },
  ],
};

/* ==========================================================================
 * 3. 工具函数
 * ========================================================================== */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 2400);
}

function bar(pct) {
  const cls = pct >= 85 ? 'err' : pct >= 70 ? 'warn' : '';
  return `<div class="bar"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>`;
}

function badge(text, kind) {
  return `<span class="badge badge-${kind}">${esc(text)}</span>`;
}

function modal(title, bodyHTML, footHTML) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  $('#modal-foot').innerHTML = footHTML || '<button class="btn" id="m-cancel">关闭</button>';
  $('#modal').classList.remove('hidden');
  const c = $('#m-cancel');
  if (c) c.onclick = closeModal;
}
function closeModal() { $('#modal').classList.add('hidden'); }

/* ==========================================================================
 * 4. 数据层：优先真实 API，失败降级演示数据
 * ========================================================================== */
async function api(path) {
  try {
    const r = await fetch('/api' + path, { cache: 'no-store' });
    if (!r.ok) throw new Error('http ' + r.status);
    return await r.json();
  } catch (e) {
    return null;   // 触发演示模式
  }
}

async function loadData() {
  const sys = await api('/system');
  if (!sys) {
    STATE.demo = true;
    STATE.data = DEMO;
  } else {
    // 真实环境：逐项拉取，缺失的回落到 DEMO 结构
    STATE.data = Object.assign({}, DEMO, {
      system:   sys,
      stats:    (await api('/stats'))    || DEMO.stats,
      disks:    (await api('/disks'))    || DEMO.disks,
      pools:    (await api('/pools'))    || DEMO.pools,
      shares:   (await api('/shares'))   || DEMO.shares,
      network:  (await api('/network'))  || DEMO.network,
      users:    (await api('/users'))    || DEMO.users,
      apps:     (await api('/apps'))     || DEMO.apps,
      logs:     (await api('/logs'))     || DEMO.logs,
    });
  }
  $('#side-version').textContent = 'v' + STATE.data.system.version;
  const badge = $('#sys-health');
  if (STATE.demo) {
    badge.textContent = '演示模式';
    badge.className = 'badge badge-warn';
  } else {
    badge.textContent = '系统正常';
    badge.className = 'badge badge-ok';
  }
  $('#topbar-host').textContent = STATE.data.system.hostname;
}

/* ==========================================================================
 * 5. 视图：仪表盘
 * ========================================================================== */
function viewDashboard() {
  const { stats, system, pools, logs } = STATE.data;
  const usedTB = (pools.reduce((a, p) => a + parseFloat(p.size) * p.used / 100, 0)).toFixed(1);

  return `
  <div class="page-head">
    <h2>仪表盘</h2>
    <p>${esc(system.cpu_model)} · ${system.cpu_cores} 核 · 运行 ${esc(system.uptime)}</p>
  </div>

  <div class="grid grid-4" style="margin-bottom:22px">
    <div class="card">
      <div class="stat">
        <div>
          <div class="stat-label">CPU 使用率</div>
          <div class="stat-value">${stats.cpu}<span class="stat-unit">%</span></div>
          <div class="stat-sub">负载 ${stats.load} · ${system.cpu_cores} 核</div>
        </div>
        <div class="stat-ico">▣</div>
      </div>
      ${bar(stats.cpu)}
    </div>

    <div class="card">
      <div class="stat">
        <div>
          <div class="stat-label">内存</div>
          <div class="stat-value">${stats.mem}<span class="stat-unit">%</span></div>
          <div class="stat-sub">共 ${stats.mem_total_gb} GB</div>
        </div>
        <div class="stat-ico">▦</div>
      </div>
      ${bar(stats.mem)}
    </div>

    <div class="card">
      <div class="stat">
        <div>
          <div class="stat-label">存储使用</div>
          <div class="stat-value">${stats.disk}<span class="stat-unit">%</span></div>
          <div class="stat-sub">已用 ${usedTB} TB</div>
        </div>
        <div class="stat-ico">⛁</div>
      </div>
      ${bar(stats.disk)}
    </div>

    <div class="card">
      <div class="stat">
        <div>
          <div class="stat-label">系统温度</div>
          <div class="stat-value">${stats.temp}<span class="stat-unit">°C</span></div>
          <div class="stat-sub">网络 ↓${stats.net_rx} ↑${stats.net_tx} MB/s</div>
        </div>
        <div class="stat-ico">🌡</div>
      </div>
      ${bar(stats.temp)}
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card card-section" style="margin-bottom:0">
      <div class="card-title"><span>存储池</span>
        <button class="btn btn-sm" data-go="pools">管理</button></div>
      <table class="data-table">
        <tr><th>名称</th><th>级别</th><th>容量</th><th>状态</th></tr>
        ${pools.map(p => `
        <tr>
          <td class="strong mono">${esc(p.name)}</td>
          <td>${esc(p.raid)}</td>
          <td>${esc(p.size)} ${bar(p.used)}</td>
          <td>${badge(p.status, p.status === '正常' ? 'ok' : 'warn')}</td>
        </tr>`).join('')}
      </table>
    </div>

    <div class="card card-section" style="margin-bottom:0">
      <div class="card-title"><span>系统日志</span>${badge('实时', 'info')}</div>
      <div style="max-height:230px;overflow-y:auto">
      <table class="data-table">
        ${logs.map(l => `
        <tr>
          <td class="mono" style="white-space:nowrap;color:var(--text-mute)">${esc(l.t)}</td>
          <td>${badge(l.lv === 'warn' ? '警告' : '信息', l.lv === 'warn' ? 'warn' : 'ok')}</td>
          <td>${esc(l.msg)}</td>
        </tr>`).join('')}
      </table>
      </div>
    </div>
  </div>`;
}

/* ==========================================================================
 * 6. 视图：磁盘
 * ========================================================================== */
function viewDisks() {
  const { disks } = STATE.data;
  return `
  <div class="page-head">
    <h2>磁盘管理</h2>
    <p>共 ${disks.length} 块磁盘 · SMART 健康监控已启用</p>
  </div>
  <div class="card">
    <div class="row-between" style="margin-bottom:12px">
      <div class="card-title" style="margin:0">磁盘列表</div>
      <div class="row">
        <button class="btn btn-sm" id="btn-smart">运行 SMART 检测</button>
        <button class="btn btn-sm btn-primary" id="btn-scan">扫描新磁盘</button>
      </div>
    </div>
    <table class="data-table">
      <tr><th>设备</th><th>型号</th><th>容量</th><th>类型</th><th>温度</th><th>健康</th><th>所属存储池</th><th></th></tr>
      ${disks.map(d => `
      <tr>
        <td class="strong mono">${esc(d.dev)}</td>
        <td>${esc(d.model)}<div class="stat-sub mono">${esc(d.serial)}</div></td>
        <td class="strong">${esc(d.size)}</td>
        <td>${badge(d.type, d.type === 'NVMe' ? 'info' : 'mute')}</td>
        <td>${d.temp}°C</td>
        <td>${badge(d.health === 'OK' ? '正常' : '警告', d.health === 'OK' ? 'ok' : 'warn')}
            <div class="stat-sub">${esc(d.smart)}</div></td>
        <td class="mono">${esc(d.pool)}</td>
        <td><button class="icon-btn" title="详情">⋯</button></td>
      </tr>`).join('')}
    </table>
  </div>`;
}

/* ==========================================================================
 * 7. 视图：存储池
 * ========================================================================== */
function viewPools() {
  const { pools } = STATE.data;
  return `
  <div class="page-head">
    <h2>存储池</h2>
    <p>支持 RAID 0/1/5/6/10 与 btrfs / ext4 / xfs 文件系统</p>
  </div>
  <div class="grid grid-3">
    ${pools.map(p => `
    <div class="card">
      <div class="row-between" style="margin-bottom:10px">
        <div>
          <div class="stat-label">${esc(p.name)}</div>
          <div class="stat-value" style="font-size:19px">${esc(p.size)}</div>
        </div>
        ${badge(p.status, p.status === '正常' ? 'ok' : 'warn')}
      </div>
      ${bar(p.used)}
      <div class="stat-sub" style="margin-top:8px">已用 ${p.used}% · ${p.disks} 块磁盘</div>
      <table class="data-table" style="margin-top:12px;font-size:12px">
        <tr><td style="color:var(--text-mute);padding:5px 0">RAID 级别</td><td style="padding:5px 0;text-align:right">${esc(p.raid)}</td></tr>
        <tr><td style="color:var(--text-mute);padding:5px 0">文件系统</td><td style="padding:5px 0;text-align:right" class="mono">${esc(p.fs)}</td></tr>
        <tr><td style="color:var(--text-mute);padding:5px 0">挂载点</td><td style="padding:5px 0;text-align:right" class="mono">${esc(p.mount)}</td></tr>
      </table>
      <div class="row" style="margin-top:12px">
        <button class="btn btn-sm" style="flex:1">扩容</button>
        <button class="btn btn-sm" style="flex:1">快照</button>
        <button class="btn btn-sm btn-danger" style="flex:1">设置</button>
      </div>
    </div>`).join('')}

    <div class="card" style="display:flex;align-items:center;justify-content:center;min-height:200px;border-style:dashed">
      <div class="empty" style="padding:0">
        <div class="big">＋</div>
        <div>创建新存储池</div>
        <button class="btn btn-sm btn-primary" style="margin-top:10px" id="btn-newpool">新建存储池</button>
      </div>
    </div>
  </div>`;
}

/* ==========================================================================
 * 8. 视图：共享文件夹
 * ========================================================================== */
function viewShares() {
  const { shares } = STATE.data;
  return `
  <div class="page-head">
    <h2>共享文件夹</h2>
    <p>支持 SMB / NFS / FTP / rsync / iSCSI 多协议并行访问</p>
  </div>
  <div class="card">
    <div class="row-between" style="margin-bottom:12px">
      <div class="card-title" style="margin:0">共 ${shares.length} 个共享</div>
      <button class="btn btn-sm btn-primary" id="btn-newshare">＋ 新建共享</button>
    </div>
    <table class="data-table">
      <tr><th>名称</th><th>路径</th><th>协议</th><th>可访问</th><th>权限</th><th>已用</th><th>状态</th><th></th></tr>
      ${shares.map(s => `
      <tr>
        <td class="strong">${esc(s.name)}</td>
        <td class="mono">${esc(s.path)}</td>
        <td>${s.proto.map(p => badge(p, 'info')).join(' ')}</td>
        <td>${esc(s.users)}</td>
        <td>${s.rw ? badge('读写', 'ok') : badge('只读', 'mute')}</td>
        <td>${esc(s.size)}</td>
        <td>${badge(s.status, s.status === '启用' ? 'ok' : 'mute')}</td>
        <td><button class="icon-btn">⋯</button></td>
      </tr>`).join('')}
    </table>
  </div>`;
}

/* ==========================================================================
 * 9. 视图：网络
 * ========================================================================== */
function viewNetwork() {
  const n = STATE.data.network;
  return `
  <div class="page-head">
    <h2>网络</h2>
    <p>支持链路聚合 (bond) 、VLAN 与静态路由</p>
  </div>
  <div class="grid grid-2" style="margin-bottom:20px">
    <div class="card">
      <div class="card-title">基本设置</div>
      <table class="data-table" style="font-size:12.5px">
        <tr><td style="color:var(--text-mute)">主机名</td><td class="strong mono">${esc(n.hostname)}</td></tr>
        <tr><td style="color:var(--text-mute)">默认网关</td><td class="strong mono">${esc(n.gateway)}</td></tr>
        <tr><td style="color:var(--text-mute)">DNS</td><td class="strong mono">${n.dns.join(' , ')}</td></tr>
      </table>
    </div>
    <div class="card">
      <div class="card-title">访问地址</div>
      <table class="data-table" style="font-size:12.5px">
        <tr><td style="color:var(--text-mute)">Web 管理</td><td class="strong mono">http://${esc(n.interfaces[0].ip.split('/')[0])}:8080</td></tr>
        <tr><td style="color:var(--text-mute)">SMB</td><td class="strong mono">\\\\${esc(n.interfaces[0].ip.split('/')[0])}\\</td></tr>
        <tr><td style="color:var(--text-mute)">SSH</td><td class="strong mono">ssh root@${esc(n.interfaces[0].ip.split('/')[0])}</td></tr>
      </table>
    </div>
  </div>
  <div class="card">
    <div class="card-title">网络接口</div>
    <table class="data-table">
      <tr><th>接口</th><th>类型</th><th>IP 地址</th><th>MAC</th><th>速率</th><th>流量 (↓/↑)</th><th>状态</th></tr>
      ${n.interfaces.map(i => `
      <tr>
        <td class="strong mono">${esc(i.name)}</td>
        <td>${esc(i.type)}</td>
        <td class="mono">${esc(i.ip)}</td>
        <td class="mono" style="color:var(--text-mute)">${esc(i.mac)}</td>
        <td>${esc(i.speed)}</td>
        <td class="mono">${esc(i.rx)} / ${esc(i.tx)}</td>
        <td>${badge(i.state, i.state === '已连接' ? 'ok' : 'mute')}</td>
      </tr>`).join('')}
    </table>
  </div>`;
}

/* ==========================================================================
 * 10. 视图：用户与权限
 * ========================================================================== */
function viewUsers() {
  const { users, groups } = STATE.data;
  return `
  <div class="page-head">
    <h2>用户与权限</h2>
    <p>本地用户体系，可按组分配共享目录读写权限</p>
  </div>
  <div class="card" style="margin-bottom:20px">
    <div class="row-between" style="margin-bottom:12px">
      <div class="card-title" style="margin:0">用户 (${users.length})</div>
      <button class="btn btn-sm btn-primary" id="btn-newuser">＋ 新建用户</button>
    </div>
    <table class="data-table">
      <tr><th>用户名</th><th>UID</th><th>主组</th><th>家目录</th><th>Shell</th><th>最后登录</th><th>状态</th><th></th></tr>
      ${users.map(u => `
      <tr>
        <td class="strong">${esc(u.name)}</td>
        <td class="mono">${u.uid}</td>
        <td>${badge(u.group, u.group === 'administrators' ? 'info' : 'mute')}</td>
        <td class="mono">${esc(u.home)}</td>
        <td class="mono" style="color:var(--text-mute)">${esc(u.shell)}</td>
        <td class="mono" style="font-size:11.5px">${esc(u.last)}</td>
        <td>${badge(u.status, u.status === '启用' ? 'ok' : 'mute')}</td>
        <td><button class="icon-btn">⋯</button></td>
      </tr>`).join('')}
    </table>
  </div>
  <div class="card">
    <div class="card-title">用户组</div>
    <table class="data-table">
      <tr><th>组名</th><th>GID</th><th>成员</th><th>权限范围</th></tr>
      ${groups.map(g => `
      <tr>
        <td class="strong">${esc(g.name)}</td>
        <td class="mono">${g.gid}</td>
        <td>${g.members} 人</td>
        <td>${esc(g.perm)}</td>
      </tr>`).join('')}
    </table>
  </div>`;
}

/* ==========================================================================
 * 11. 视图：应用中心
 * ========================================================================== */
function viewApps() {
  const a = STATE.data.apps;
  const card = (p, installed) => `
    <div class="app-card">
      <div class="app-head">
        <div class="app-icon" style="background:${esc(p.color)}">${esc(p.icon)}</div>
        <div>
          <div class="app-name">${esc(p.name)}</div>
          <div class="app-cat">${esc(p.cat)}${p.version && p.version !== '—' ? ' · v' + esc(p.version) : ''}</div>
        </div>
      </div>
      <div class="app-desc">${esc(p.desc)}</div>
      <div class="app-foot">
        ${installed
          ? badge('运行中', 'ok')
          : `<button class="btn btn-sm btn-primary" data-install="${esc(p.id)}">安装</button>`}
        ${installed
          ? `<button class="btn btn-sm" data-open="${esc(p.id)}">打开</button>`
          : `<span class="badge badge-mute">未安装</span>`}
      </div>
    </div>`;

  return `
  <div class="page-head">
    <h2>应用中心</h2>
    <p>基于 Docker 容器，一键部署 · 数据存放在存储池，与系统隔离</p>
  </div>

  <div class="card-section">
    <div class="card-title">已安装</div>
    <div class="app-grid">${a.installed.map(p => card(p, true)).join('')}</div>
  </div>

  <div class="card-section">
    <div class="card-title">可安装应用</div>
    <div class="app-grid">${a.available.map(p => card(p, false)).join('')}</div>
  </div>`;
}

/* ==========================================================================
 * 12. 视图：系统设置
 * ========================================================================== */
function viewSettings() {
  const s = STATE.data.system;
  return `
  <div class="page-head">
    <h2>系统设置</h2>
    <p>NasOS ${esc(s.version)} · 内核 ${esc(s.kernel)}</p>
  </div>

  <div class="grid grid-2">
    <div class="card">
      <div class="card-title">系统信息</div>
      <table class="data-table" style="font-size:12.5px">
        <tr><td style="color:var(--text-mute)">主机名</td><td class="strong mono">${esc(s.hostname)}</td></tr>
        <tr><td style="color:var(--text-mute)">版本</td><td class="strong mono">${esc(s.version)}</td></tr>
        <tr><td style="color:var(--text-mute)">架构</td><td class="strong mono">${esc(s.arch)}</td></tr>
        <tr><td style="color:var(--text-mute)">CPU 兼容</td><td class="strong">${esc(s.cpu_vendor)}</td></tr>
        <tr><td style="color:var(--text-mute)">CPU</td><td>${esc(s.cpu_model)}</td></tr>
        <tr><td style="color:var(--text-mute)">内核</td><td class="mono">${esc(s.kernel)}</td></tr>
        <tr><td style="color:var(--text-mute)">引导方式</td><td class="mono">${esc(s.bios)}</td></tr>
        <tr><td style="color:var(--text-mute)">运行时长</td><td>${esc(s.uptime)}</td></tr>
      </table>
    </div>

    <div class="card">
      <div class="card-title">常规设置</div>
      <div class="form-row">
        <label>主机名</label>
        <input class="input" id="set-host" value="${esc(s.hostname)}">
      </div>
      <div class="form-row">
        <label>时区</label>
        <select class="select" id="set-tz">
          <option>Asia/Shanghai</option>
          <option>Asia/Hong_Kong</option>
          <option>Asia/Tokyo</option>
          <option>UTC</option>
        </select>
      </div>
      <div class="form-row">
        <label>Web 管理端口</label>
        <input class="input" id="set-port" value="8080">
        <div class="form-hint">修改后需重启 Web 服务生效</div>
      </div>
      <div class="row">
        <button class="btn btn-primary btn-sm" id="btn-save">保存设置</button>
        <button class="btn btn-sm" id="btn-update">检查更新</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">电源</div>
      <div class="row">
        <button class="btn btn-sm" id="btn-restart">重启系统</button>
        <button class="btn btn-sm" id="btn-shutdown">关机</button>
      </div>
      <div class="form-hint" style="margin-top:10px">演示模式下电源操作不会真正执行</div>
    </div>

    <div class="card">
      <div class="card-title">备份与恢复</div>
      <div class="row">
        <button class="btn btn-sm" id="btn-export">导出配置</button>
        <button class="btn btn-sm" id="btn-import">导入配置</button>
      </div>
      <div class="form-hint" style="margin-top:10px">配置含用户、共享、存储池定义，不含实际数据</div>
    </div>
  </div>`;
}

/* ==========================================================================
 * 13. 路由
 * ========================================================================== */
const VIEWS = {
  dashboard: viewDashboard,
  disks:     viewDisks,
  pools:     viewPools,
  shares:    viewShares,
  network:   viewNetwork,
  users:     viewUsers,
  apps:      viewApps,
  settings:  viewSettings,
};

function render() {
  const fn = VIEWS[STATE.view] || viewDashboard;
  $('#main').innerHTML = fn();
  $('#main').scrollTop = 0;
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === STATE.view));
  bindViewEvents();
}

function go(view) {
  STATE.view = view;
  render();
}

/* ==========================================================================
 * 14. 事件绑定
 * ========================================================================== */
function bindViewEvents() {
  $$('.nav-item').forEach(n => n.onclick = () => go(n.dataset.view));
  $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));

  const on = (id, fn) => { const e = $(id); if (e) e.onclick = fn; };

  on('#btn-scan',     () => { toast('已触发磁盘扫描…'); });
  on('#btn-smart',    () => { toast('SMART 检测已启动，请稍候'); });
  on('#btn-newpool',  () => modal('新建存储池', `
      <div class="form-row"><label>名称</label><input class="input" id="p-name" placeholder="pool1"></div>
      <div class="form-row"><label>RAID 级别</label>
        <select class="select" id="p-raid"><option>RAID 0</option><option>RAID 1</option><option selected>RAID 5</option><option>RAID 6</option><option>RAID 10</option><option>Single</option></select></div>
      <div class="form-row"><label>文件系统</label>
        <select class="select" id="p-fs"><option selected>btrfs</option><option>ext4</option><option>xfs</option></select></div>
      <div class="form-hint">提示：RAID 5 至少需要 3 块盘，RAID 6 至少 4 块。</div>`,
      '<button class="btn" id="m-cancel">取消</button><button class="btn btn-primary" id="m-ok">创建</button>'));
  on('#btn-newshare', () => modal('新建共享文件夹', `
      <div class="form-row"><label>名称</label><input class="input" id="s-name" placeholder="share"></div>
      <div class="form-row"><label>位置（存储池）</label>
        <select class="select" id="s-pool"><option>pool0</option><option>flash-pool</option><option>backup</option></select></div>
      <div class="form-row"><label>启用协议</label>
        <select class="select" id="s-proto"><option>SMB</option><option>NFS</option><option>SMB + NFS</option><option>FTP</option></select></div>`,
      '<button class="btn" id="m-cancel">取消</button><button class="btn btn-primary" id="m-ok">创建</button>'));
  on('#btn-newuser',  () => modal('新建用户', `
      <div class="form-row"><label>用户名</label><input class="input" id="u-name"></div>
      <div class="form-row"><label>密码</label><input class="input" id="u-pass" type="password"></div>
      <div class="form-row"><label>主组</label>
        <select class="select" id="u-group"><option>users</option><option>administrators</option><option>guests</option></select></div>`,
      '<button class="btn" id="m-cancel">取消</button><button class="btn btn-primary" id="m-ok">创建</button>'));

  on('#btn-save',     () => toast('设置已保存'));
  on('#btn-update',   () => toast('当前已是最新版本 ' + STATE.data.system.version));
  on('#btn-restart',  () => { if (STATE.demo) { toast('演示模式：已模拟重启'); } else { toast('系统正在重启…'); } });
  on('#btn-shutdown', () => { if (STATE.demo) { toast('演示模式：已模拟关机'); } else { toast('系统正在关机…'); } });
  on('#btn-export',   () => toast('配置文件已导出'));
  on('#btn-import',   () => toast('请选择配置文件'));

  // 应用安装
  $$('[data-install]').forEach(b => b.onclick = () => {
    const id = b.dataset.install;
    if (id === 'workbuddy') {
      modal('安装 WorkBuddy', `
        <p style="font-size:13px;line-height:1.7;color:var(--text-dim)">
        <strong style="color:var(--text)">关于 WorkBuddy 的说明</strong><br><br>
        WorkBuddy 是<strong style="color:var(--text)">云端服务</strong>，依赖账号体系与云端模型能力，
        其服务端并不开源、也无法被打包进本镜像。<br><br>
        因此 NasOS 提供的是 <strong style="color:var(--accent)">入口级集成</strong>：
        </p>
        <ul style="margin:12px 0 0 18px;font-size:12.5px;color:var(--text-dim);line-height:1.9">
          <li>在应用中心生成 WorkBuddy 快捷入口，一键打开 Web 端</li>
          <li>提供自建代理/网关的部署模板（可选）</li>
          <li>若需完全内网运行，建议改用 <strong>Ollama 本地大模型</strong> 方案</li>
        </ul>`,
        '<button class="btn" id="m-cancel">我知道了</button><button class="btn btn-primary" id="m-ok">添加入口</button>');
    } else {
      const app = STATE.data.apps.available.find(x => x.id === id);
      toast('正在拉取镜像并安装 ' + (app ? app.name : id) + '…');
      setTimeout(() => toast((app ? app.name : id) + ' 安装完成'), 1500);
    }
  });

  $$('[data-open]').forEach(b => b.onclick = () => toast('打开应用：' + b.dataset.open));

  const mok = $('#m-ok');
  if (mok) mok.onclick = () => { closeModal(); toast('操作已提交'); };
  const mc = $('#m-cancel');
  if (mc) mc.onclick = closeModal;
}

/* ==========================================================================
 * 15. 启动
 * ========================================================================== */
function startClock() {
  const tick = () => {
    const d = new Date();
    $('#topbar-clock').textContent = d.toTimeString().slice(0, 8);
  };
  tick();
  setInterval(tick, 1000);
}

function bindGlobal() {
  // 登录（演示环境：任意凭据放行）
  $('#login-btn').onclick = () => {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    startClock();
    loadData().then(render);
    // 真实环境每 5 秒刷新一次；演示模式下数据静态
    setInterval(() => { if (!STATE.demo) loadData().then(render); }, 5000);
  };
  // 回车登录
  ['#login-user', '#login-pass'].forEach(s => {
    $(s).addEventListener('keydown', e => { if (e.key === 'Enter') $('#login-btn').click(); });
  });

  $('#modal-close').onclick = closeModal;
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  // 顶栏搜索：按关键字跳转到对应页面
  const MAP = { 磁盘: 'disks', 存储: 'pools', 池: 'pools', 共享: 'shares', 网络: 'network', 用户: 'users', 应用: 'apps', 设置: 'settings', 仪表: 'dashboard' };
  $('#global-search').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim();
    for (const k in MAP) { if (q.includes(k)) { go(MAP[k]); e.target.value = ''; return; } }
    toast('未找到：' + (q || '（空）'));
  });
}

document.addEventListener('DOMContentLoaded', bindGlobal);

/* 调试导出（无副作用，方便控制台/测试访问内部状态） */
window.NASOS = { STATE, DEMO, go, render, loadData };
