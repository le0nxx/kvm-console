import RFB from './novnc/core/rfb.js';

const q = new URLSearchParams(location.search);
const url = q.get('url');
const password = q.get('password') || '';
const hint = document.getElementById('hint');
const loading = document.getElementById('loading');

const fail = (msg) => {
  hint.classList.remove('hidden');
  hint.textContent = msg;
  if (loading) {
    loading.classList.remove('hidden');
    const t = document.getElementById('loading-text');
    if (t) t.textContent = msg;
    const sp = loading.querySelector('.spinner');
    if (sp) sp.style.display = 'none';
  }
  document.title = 'VNC error';
  document.body.dataset.state = 'error';
  document.body.dataset.error = msg;
};

if (!url) {
  fail('缺少 VNC 地址');
} else {
  try {
    const rfb = new RFB(document.getElementById('screen'), url, {
      credentials: { password },
      wsProtocols: ['binary'],
    });
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = '#000';
    rfb.addEventListener('connect', () => {
      hint.classList.add('hidden');
      loading?.classList.add('hidden');
      document.title = 'VNC connected';
      document.body.dataset.state = 'connected';
    });
    rfb.addEventListener('disconnect', (e) => {
      if (e.detail && e.detail.clean) return;
      fail('VNC 连接已断开');
    });
    rfb.addEventListener('credentialsrequired', () => {
      try { rfb.sendCredentials({ password }); } catch (err) {}
    });
    window.__rfb = rfb;
  } catch (err) {
    fail('VNC 连接失败：' + (err && err.message ? err.message : err));
  }
}
