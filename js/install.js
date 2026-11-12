// 安装到桌面：注册 Service Worker，并处理 Android/桌面 Chrome 的安装弹窗与 iOS 的手动引导。

let installPrompt = null;

export function initInstall({ showHelp, toast } = {}) {
  const button = document.querySelector('#btn-install');
  const note = document.querySelector('#settings-install-note');
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS =
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const secure = window.isSecureContext;

  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Service Worker 注册失败', error));
  }

  function sync() {
    if (!button) return;
    let text = '';
    if (isStandalone) {
      button.classList.add('hidden');
      text = '已在桌面模式下独立运行';
    } else if (installPrompt) {
      button.textContent = '安装到桌面';
      button.classList.remove('hidden');
      text = '点首页右上角「安装到桌面」即可像 App 一样打开';
    } else if (isIOS) {
      button.textContent = '添加到主屏幕';
      button.classList.remove('hidden');
      text = 'Safari：点分享 → 添加到主屏幕';
    } else {
      button.classList.add('hidden');
      text = secure
        ? '当前浏览器未提供安装入口，可用浏览器菜单里的「安装应用 / 创建快捷方式」'
        : '安装需要 HTTPS 或 localhost；局域网 http 地址只能当网页用';
    }
    if (note) note.textContent = text;
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    sync();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    toast && toast('已安装到桌面');
    sync();
  });

  if (button) {
    button.addEventListener('click', async () => {
      if (installPrompt) {
        installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') installPrompt = null;
        sync();
        return;
      }
      if (isIOS && showHelp) {
        showHelp({
          title: '添加到主屏幕',
          html: `
            <ol class="help-steps">
              <li>用 Safari 打开本页，点底部的「分享」按钮</li>
              <li>在列表里往下找「添加到主屏幕」</li>
              <li>确认名字后点「添加」，桌面就会出现拼豆图标</li>
            </ol>
            <p class="field-hint">从桌面图标打开时不显示地址栏，进度和图纸都还在。</p>`,
        });
      }
    });
  }

  // 从桌面模式启动时隐藏入口，返回时再刷新一次状态。
  window.matchMedia('(display-mode: standalone)').addEventListener?.('change', sync);
  sync();
}
