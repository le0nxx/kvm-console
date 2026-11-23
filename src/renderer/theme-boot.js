(() => {
  try {
    const saved = localStorage.getItem('kvm-theme') || 'auto';
    const light =
      saved === 'light' ||
      (saved === 'auto' && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
  } catch {
    document.documentElement.dataset.theme = 'dark';
  }
})();
