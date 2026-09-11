/* NasOS Web 前端 DOM 桩集成测试（Node 运行，无浏览器）
   注意：不要加 'use strict' —— 需要非严格 eval 泄漏 app.js 的函数声明 */

const fs = require('fs');
const path = require('path');
const WEB = path.join(__dirname, 'rootfs', 'opt', 'nasos', 'web');

/* ---------------- 极简 DOM 桩 ---------------- */
function makeEl(tag) {
  return {
    tagName: tag, id: '', className: '', textContent: '', innerHTML: '',
    style: {}, dataset: {}, value: '', placeholder: '', type: '',
    children: [], _handlers: {}, _listeners: {},
    classList: {
      add(...c) { c.forEach(x => { if (!el.className.includes(x)) el.className += ' ' + x; }); },
      remove(...c) { c.forEach(x => { el.className = el.className.replace(x, '').trim(); }); },
      toggle(c, f) { f ? this.add(c) : this.remove(c); },
      contains(c) { return el.className.includes(c); },
    },
    addEventListener(ev, fn) { (el._listeners[ev] = el._listeners[ev] || []).push(fn); },
    removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    append(...cs) { el.children.push(...cs); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    get textContent2() { return el.textContent; },
  };
  var el; // hoist trick
}

const elems = {};
function getEl(sel) {
  if (!elems[sel]) elems[sel] = makeEl('div');
  return elems[sel];
}

global.document = {
  querySelector: (s) => getEl(s),
  querySelectorAll: (s) => [],
  getElementById: (id) => getEl('#' + id),
  createElement: (t) => makeEl(t),
  addEventListener(ev, fn) { (this._l = this._l || {})[ev] = fn; },
};
global.window = global;
global.fetch = () => Promise.reject(new Error('offline')); // 强制演示模式
global.setInterval = () => 0;
global.setTimeout = (fn) => { fn && fn(); return 0; };
global.clearTimeout = () => {};

/* classList.add 依赖 el 闭包，重新实现为独立对象 */
function freshEl() {
  const el = {
    tagName: 'div', id: '', className: '', textContent: '', innerHTML: '',
    style: {}, dataset: {}, value: '', placeholder: '', type: '',
    children: [], _listeners: {},
  };
  el.classList = {
    add: (...c) => { c.forEach(x => { if (!el.className.split(/\s+/).includes(x)) el.className = (el.className + ' ' + x).trim(); }); },
    remove: (...c) => { el.className = el.className.split(/\s+/).filter(x => !c.includes(x)).join(' '); },
    toggle: (c, f) => { (f === undefined ? !el.classList.contains(c) : f) ? el.classList.add(c) : el.classList.remove(c); },
    contains: (c) => el.className.split(/\s+/).includes(c),
  };
  el.addEventListener = (ev, fn) => { (el._listeners[ev] = el._listeners[ev] || []).push(fn); };
  el.appendChild = (c) => (el.children.push(c), c);
  el.append = (...cs) => el.children.push(...cs);
  el.querySelector = () => null;
  el.querySelectorAll = () => [];
  return el;
}

/* 重建 elems 用 freshEl */
Object.keys(elems).forEach(k => delete elems[k]);
const cache = {};
global.document.querySelector = (s) => (cache[s] = cache[s] || freshEl());
global.document.querySelectorAll = () => [];
global.document.getElementById = (id) => (cache['#' + id] = cache['#' + id] || freshEl());
global.document.createElement = (t) => freshEl();

/* ---------------- 加载 app.js ---------------- */
let code = fs.readFileSync(path.join(WEB, 'app.js'), 'utf-8');
code = code.replace(/^'use strict';?/m, '');   // eval 桩需要非严格模式泄漏函数声明
eval(code);

/* ---------------- 测试 ---------------- */
let pass = 0, fail = 0;
function T(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ FAIL: ' + name); }
}

console.log('== 1. 数据层 ==');
(async () => {
  await loadData();
  T('演示模式激活（fetch 失败降级）', NASOS.STATE.demo === true);
  T('系统数据加载', NASOS.STATE.data.system && NASOS.STATE.data.system.version === '0.1.0');
  T('词库/磁盘数据存在', Array.isArray(NASOS.STATE.data.disks) && NASOS.STATE.data.disks.length >= 5);

  console.log('== 2. 八个视图渲染 ==');
  const views = ['dashboard', 'disks', 'pools', 'shares', 'network', 'users', 'apps', 'settings'];
  for (const v of views) {
    NASOS.STATE.view = v;
    render();
    const html = cache['#main'].innerHTML;
    T('视图渲染: ' + v + ' (' + html.length + ' 字符)', html.length > 300 && !html.includes('undefined'));
  }

  console.log('== 3. 仪表盘内容抽查 ==');
  NASOS.STATE.view = 'dashboard'; render();
  const dash = cache['#main'].innerHTML;
  T('包含 CPU 指标', dash.includes('CPU'));
  T('包含存储池表格', dash.includes('pool0'));
  T('包含系统日志', dash.includes('重映射扇区'));

  console.log('== 4. 应用中心 ==');
  NASOS.STATE.view = 'apps'; render();
  const apps = cache['#main'].innerHTML;
  T('WorkBuddy 在可安装列表', apps.includes('WorkBuddy'));
  T('Ollama 本地大模型在列', apps.includes('Ollama'));
  T('已安装区含容器引擎', apps.includes('容器引擎'));

  console.log('== 5. 系统设置（Intel/AMD 兼容标注）==');
  NASOS.STATE.view = 'settings'; render();
  const set = cache['#main'].innerHTML;
  T('显示 CPU 兼容说明', set.includes('Intel / AMD'));

  console.log('== 6. 登录流程 ==');
  bindGlobal();
  T('登录按钮已绑定', !!cache['#login-btn'].onclick);
  cache['#login-btn'].onclick();
  T('登录后主界面显示', cache['#app'].classList.contains('hidden') === false);

  console.log('== 7. 导航 ==');
  go('disks');
  T('切换到磁盘页', NASOS.STATE.view === 'disks' && cache['#main'].innerHTML.includes('/dev/sda'));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
