(() => {
  const mode = localStorage.getItem('kvm-lang') || 'auto';
  const lang = mode === 'zh' || mode === 'en' ? mode : ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
  const hint = document.getElementById('hint');
  if (!hint) return;
  hint.textContent = hint.getAttribute(lang === 'zh' ? 'data-zh' : 'data-en') || hint.textContent;
  const loading = document.getElementById('loading-text');
  if (loading) loading.textContent = loading.getAttribute(lang === 'zh' ? 'data-zh' : 'data-en') || loading.textContent;
  const style = document.createElement('style');
  style.textContent = '#hint{background:rgba(27,30,32,.92);color:#bdc3c7;border-bottom:1px solid #31363b;font-family:"Noto Sans","Noto Sans SC",system-ui,sans-serif}';
  document.head.appendChild(style);
})();
