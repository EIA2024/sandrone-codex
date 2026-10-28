// This function is serialized into a trusted main window. Keep it self-contained.
exports.installControls = function installControls(prefix, state, contract) {
  const key = '__SANDRONE_NATIVE_CONTROLS__';
  if (window[key]) { window[key].update(state, prefix); return true; }
  const host = document.createElement('div');
  host.id = 'sandrone-native-controls';
  host.style.cssText = 'position:fixed;z-index:2147483200;top:5px;right:260px;-webkit-app-region:no-drag;';
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host{font:12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif;color:#e7e5df}
    *{box-sizing:border-box}button{font:inherit;cursor:pointer;-webkit-app-region:no-drag}
    .trigger{height:26px;padding:0 10px;border:1px solid #8c82684d;border-radius:6px;background:#24272bf5;color:#e7e5df;display:flex;align-items:center;gap:6px}
    .trigger:hover{background:#424449}button:focus-visible{outline:2px solid #c9ad77;outline-offset:2px}
    .dot{width:6px;height:6px;border-radius:50%;background:#8a8c91}.dot.on{background:#dfb86e}
    .panel{position:absolute;right:0;top:33px;width:222px;padding:7px;background:#202329;color:#e7e5df;border:1px solid #77736677;border-radius:9px;box-shadow:0 8px 30px #0006}
    [hidden]{display:none!important}.item{display:flex;align-items:center;gap:9px;width:100%;padding:8px;border:0;border-radius:5px;background:transparent;color:inherit;text-align:left}
    .item:hover{background:#ffffff12}.mark{width:14px;text-align:center;color:#d8b876}.item:disabled{opacity:.4;cursor:default}
    .divider{height:1px;background:#ffffff16;margin:5px 4px}.hint{padding:6px 8px 3px;color:#b6b8bd;font-size:11px;overflow-wrap:anywhere}
    .error{color:#ffb9b9}.danger{color:#f0b1a9}
    @media(prefers-color-scheme:light){.trigger{background:#f6f4eff5;color:#272822}.panel{background:#fffefa;color:#252622;border-color:#bdb5a6}.item:hover{background:#0000000b}.divider{background:#00000016}.hint{color:#63645f}.danger,.error{color:#9f3028}}
  `);
  shadow.adoptedStyleSheets = [sheet];
  shadow.innerHTML = `<button class="trigger" aria-label="主题管理" aria-haspopup="menu" aria-expanded="false"><span class="dot"></span><span>主题</span><span aria-hidden="true">⌄</span></button>
    <div class="panel" role="menu" aria-label="主题管理" hidden>
      <button class="item" data-action="disable" role="menuitemradio"><span class="mark"></span>原生界面</button>
      <button class="item" data-action="enable" role="menuitemradio"><span class="mark"></span>桑多涅主题</button>
      <div class="divider"></div>
      <button class="item" data-action="replay" role="menuitem"><span class="mark">↻</span>重播开屏</button>
      <button class="item" data-action="opening" role="menuitemcheckbox"><span class="mark"></span>启动时播放开屏</button>
      <button class="item" data-action="auto-enter" role="menuitemcheckbox"><span class="mark"></span>就绪后自动进入</button>
      <div class="divider"></div>
      <button class="item danger" data-action="uninstall" role="menuitem"><span class="mark">−</span>卸载主题附加包…</button>
      <button class="item" data-action="cancel-uninstall" role="menuitem" hidden><span class="mark">↶</span>取消待执行的卸载</button>
      <div class="hint status" role="status" aria-live="polite"></div>
      <div class="hint error" role="alert" hidden></div>
    </div>`;
  const trigger = shadow.querySelector('.trigger');
  const panel = shadow.querySelector('.panel');
  const close = (focus = false) => {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  };
  const send = action => console.log(prefix + action);
  const items = () => [...panel.querySelectorAll('button')].filter(button => !button.hidden && !button.disabled);
  const open = (focus = false) => {
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    send('status');
    if (focus) items()[0]?.focus();
  };
  trigger.addEventListener('click', () => panel.hidden ? open() : close());
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); open(true); }
  });
  panel.addEventListener('keydown', event => {
    const buttons = items();
    const index = buttons.indexOf(shadow.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    if (next !== undefined) { event.preventDefault(); buttons[next]?.focus(); }
    if (event.key === 'Tab') close();
  });
  shadow.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
    if (!button.disabled) send(button.dataset.action);
    close(true);
  }));
  const outside = event => { if (!event.composedPath().includes(host)) close(); };
  const escape = event => {
    if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); close(true); }
  };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', escape, true);
  const place = () => {
    const bar = contract?.selectors?.titlebar ? document.querySelector(contract.selectors.titlebar)?.getBoundingClientRect() : null;
    const overlay = navigator.windowControlsOverlay;
    const area = overlay?.getTitlebarAreaRect?.();
    const nativeWidth = overlay?.visible && area?.width > 0 ? innerWidth - area.x - area.width : 138;
    const height = bar?.height >= 24 && bar.height <= 70 ? bar.height : 36;
    host.style.top = innerWidth < 660 || document.fullscreenElement ? '42px' : Math.max(2, (height - 26) / 2) + 'px';
    host.style.right = innerWidth < 660 || document.fullscreenElement ? '12px' : (Math.max(120, Math.min(240, nativeWidth)) + 122) + 'px';
  };
  const update = (next, nextPrefix) => {
    state = next;
    if (nextPrefix) prefix = nextPrefix;
    const pending = ['scheduled', 'removing', 'completed'].includes(next.uninstallStatus);
    shadow.querySelector('.dot').classList.toggle('on', next.enabled);
    for (const name of ['enable', 'disable']) {
      const checked = name === 'enable' ? next.enabled : !next.enabled;
      const button = shadow.querySelector(`[data-action="${name}"]`);
      button.setAttribute('aria-checked', String(checked));
      button.querySelector('.mark').textContent = checked ? '✓' : '';
    }
    shadow.querySelector('[data-action="enable"]').disabled = pending;
    shadow.querySelector('[data-action="replay"]').disabled = !next.enabled || pending;
    shadow.querySelector('[data-action="uninstall"]').disabled = pending;
    shadow.querySelector('[data-action="cancel-uninstall"]').hidden = next.uninstallStatus !== 'scheduled';
    const opening = shadow.querySelector('[data-action="opening"]');
    opening.setAttribute('aria-checked', String(next.openingOnLaunch));
    opening.querySelector('.mark').textContent = next.openingOnLaunch ? '✓' : '';
    const autoEnter = shadow.querySelector('[data-action="auto-enter"]');
    autoEnter.setAttribute('aria-checked', String(next.autoEnterOnReady !== false));
    autoEnter.querySelector('.mark').textContent = next.autoEnterOnReady !== false ? '✓' : '';
    shadow.querySelector('.status').textContent = next.uninstallStatus === 'scheduled'
      ? '退出所有 Codex 窗口及托盘进程后卸载；当前聊天继续保留。'
      : next.uninstallStatus === 'completed' ? '附加包已移除，下次启动不再加载。'
      : next.uninstallStatus === 'removing' ? '正在移除附加包。'
      : '选择自动保存。原生界面保留此管理入口。';
    const error = shadow.querySelector('.error');
    error.hidden = !(next.error || next.warning);
    error.textContent = next.error || next.warning || '';
    place();
  };
  window.sandroneReplayOpening = () => { if (state.enabled) send('replay'); };
  window.addEventListener('resize', place);
  navigator.windowControlsOverlay?.addEventListener('geometrychange', place);
  document.documentElement.append(host);
  window[key] = { update, dispose() {
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', escape, true);
    window.removeEventListener('resize', place);
    navigator.windowControlsOverlay?.removeEventListener('geometrychange', place);
    host.remove();
    delete window[key];
    delete window.sandroneReplayOpening;
  } };
  update(state);
  return true;
};
