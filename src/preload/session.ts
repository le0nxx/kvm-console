import { ipcRenderer } from 'electron';

// Remote BMC pages have their own keyboard handlers; capture configured app
// shortcuts before the page sees them, regardless of which console has focus.
window.addEventListener(
  'keydown',
  (event) => {
    if (event.defaultPrevented) return;
    if (!event.ctrlKey && !event.altKey && !event.metaKey) return;
    let handled = false;
    try {
      handled = ipcRenderer.sendSync('shortcut-key', {
        control: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        meta: event.metaKey,
        key: event.key,
        code: event.code,
      }) === true;
    } catch {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true,
);
