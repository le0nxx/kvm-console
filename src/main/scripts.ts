/**
 * Scripts injected into vendor BMC pages. They must stay dependency-free and
 * defensive: every vendor renders a different DOM and we never want an
 * exception to break the session.
 */

const HELPERS = `
const __vis = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
};
const __text = (el) => ((el.innerText || el.value || el.getAttribute('aria-label') || el.title || '') + '').trim();
const __sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const __setValue = (el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, v); else el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const __clickables = 'a,button,[role=button],[onclick],input[type=button],input[type=submit],li';
`;

/** click a cookie/privacy consent button, if the BMC shows one before login */
export function consentScript(): string {
  return `(() => {
    ${HELPERS}
    const RE = /^(继续|同意|接受|我已知晓|我知道了|继续访问|Continue|Accept|Agree|I Agree|Got it)$/i;
    const btns = [...document.querySelectorAll('button,a,[role=button],input[type=button]')]
      .filter(__vis)
      .filter((b) => RE.test(__text(b).trim()));
    if (btns.length) { btns[0].click(); return __text(btns[0]).trim(); }
    return null;
  })()`;
}

/** returns { hasForm: boolean, hasPassword: boolean, title, url } */
export function probeScript(): string {
  return `(() => {
    ${HELPERS}
    const pw = [...document.querySelectorAll('input[type=password]')].filter(__vis);
    const body = (document.body && document.body.innerText || '').slice(0, 4000);
    return {
      hasPassword: pw.length > 0,
      title: document.title,
      url: location.href,
      locked: /(锁定|已锁定|locked|too many|尝试次数)/i.test(body),
      forceChange: /(修改密码|密码已过期|初始密码|首次登录|change password|password expired|must change)/i.test(body),
      ready: document.readyState
    };
  })()`;
}

/** fill + submit the login form. returns { status } */
export function loginScript(user: string, pass: string): string {
  const U = JSON.stringify(user);
  const P = JSON.stringify(pass);
  return `(async () => {
    ${HELPERS}
    const U = ${U}, P = ${P};
    const pw = [...document.querySelectorAll('input[type=password]')].filter(__vis)[0];
    if (!pw) return { status: 'no-form' };

    const inputs = [...document.querySelectorAll('input')].filter(__vis);
    const idx = inputs.indexOf(pw);
    let userEl = null;
    for (let i = idx - 1; i >= 0; i--) {
      const t = (inputs[i].type || 'text').toLowerCase();
      if (t === 'text' || t === 'email' || t === 'tel' || t === '') { userEl = inputs[i]; break; }
    }
    if (!userEl) {
      userEl = inputs.find((el) => el !== pw && /user|name|account|登录名|用户名/i.test((el.name || '') + (el.id || '')));
    }
    if (userEl) __setValue(userEl, U);
    __setValue(pw, P);
    await __sleep(150);

    const btns = [...document.querySelectorAll('button,input[type=submit],input[type=button],a,[role=button],.el-button')]
      .filter(__vis)
      .filter((b) => /登录|登 录|登陆|sign\\s*in|log\\s*in|logon|submit|确定|ok/i.test(__text(b)));
    let submitted = false;
    if (btns.length) { btns[0].click(); submitted = true; }
    if (!submitted && pw.form) {
      try { pw.form.requestSubmit(); submitted = true; } catch (e) {}
    }
    if (!submitted) {
      pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      pw.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      submitted = true;
    }
    return { status: 'submitted', userField: !!userEl, button: btns.length ? __text(btns[0]).slice(0, 30) : 'enter' };
  })()`;
}

/**
 * Find and click the KVM entry. Tries a direct match first, then opens a
 * "remote control" menu and retries. Returns { ok, label }.
 */
export function launchKvmScript(): string {
  return `(async () => {
    ${HELPERS}
    const KVM = /(KVM|虚拟控制台|远程控制台|远程会话|虚拟终端|Virtual\\s*Console|Remote\\s*Console|iKVM|Console\\s*Redirection)/i;
    const MENU = /(远程控制|远程管理|远程运维|控制台|Remote\\s*Control|Remote\\s*Management|Console)/i;
    const pick = (re) => {
      const all = [...document.querySelectorAll(__clickables + ',[aria-label],[title]')]
        .filter((el) => __vis(el) && re.test(__text(el)) && __text(el).length < 48);
      all.sort((a, b) => {
        const score = (el) => (el.matches('a,button,[role=button],[onclick]') ? 0 : 2) + (el.children.length > 3 ? 1 : 0);
        return score(a) - score(b);
      });
      return all[0] || null;
    };

    let el = pick(/^start\s+(the\s+)?virtual\s+console$/i) || pick(KVM);
    let viaMenu = false;
    if (!el) {
      const menu = pick(MENU);
      if (menu) {
        menu.click();
        viaMenu = true;
        await __sleep(800);
        el = pick(KVM);
      }
    }
    if (!el) return { ok: false, reason: 'not-found', title: document.title };

    const label = __text(el).slice(0, 40);
    el.click();
    await __sleep(500);
    return { ok: true, label, viaMenu, url: location.href };
  })()`;
}

/** returns { ok, w, h } when a console surface is present */
export function frameProbeScript(): string {
  return `(() => {
    const canvases = [...document.querySelectorAll('canvas')].filter((c) => c.width >= 160 && c.height >= 120);
    if (canvases.length) {
      canvases.sort((a, b) => b.width * b.height - a.width * a.height);
      return { ok: true, kind: 'canvas', w: canvases[0].width, h: canvases[0].height };
    }
    const videos = [...document.querySelectorAll('video')].filter((v) => v.videoWidth > 0);
    if (videos.length) return { ok: true, kind: 'video', w: videos[0].videoWidth, h: videos[0].videoHeight };
    return { ok: false };
  })()`;
}

/** health probe: logged out? timeout dialog? console present? */
export function healthScript(): string {
  return `(() => {
    ${HELPERS}
    const pw = [...document.querySelectorAll('input[type=password]')].filter(__vis);
    const body = (document.body && document.body.innerText || '').slice(0, 6000);
    const timeout = /(会话.{0,6}(超时|过期|失效)|session.{0,12}(timeout|expired|invalid)|请重新登录|重新登录)/i.test(body);
    const canvases = [...document.querySelectorAll('canvas')].filter((c) => c.width >= 160 && c.height >= 120);
    return {
      hasPassword: pw.length > 0,
      timeout,
      hasCanvas: canvases.length > 0,
      title: document.title,
      url: location.href
    };
  })()`;
}

/** dismiss a "session expired" modal by clicking its confirm button */
export function dismissDialogScript(): string {
  return `(() => {
    ${HELPERS}
    const btns = [...document.querySelectorAll('button,a,[role=button],input[type=button]')]
      .filter(__vis)
      .filter((b) => /^(确定|确认|好的|OK|Ok|ok|知道了|重新登录)$/.test(__text(b)));
    if (btns.length) { btns[0].click(); return true; }
    return false;
  })()`;
}

/** click the virtual media entry so the technician can use the vendor dialog */
export function openMediaPanelScript(): string {
  return `(async () => {
    ${HELPERS}
    const RE = /(虚拟介质|虚拟光驱|Virtual\\s*Media|Virtual\\s*CD|镜像挂载)/i;
    const all = [...document.querySelectorAll(__clickables + ',[aria-label],[title]')]
      .filter((el) => __vis(el) && RE.test(__text(el)) && __text(el).length < 48);
    if (!all.length) return { ok: false };
    all[0].click();
    return { ok: true, label: __text(all[0]).slice(0, 40) };
  })()`;
}

/**
 * Put a local file into a vendor <input type="file"> without opening the OS
 * picker. Runs in the page, returns how many inputs were found.
 */
export function fileInputTargetsScript(): string {
  return `(() => {
    const inputs = [...document.querySelectorAll('input[type=file]')];
    return inputs.map((el, i) => ({ i, accept: el.accept || '', name: el.name || '', id: el.id || '' }));
  })()`;
}

/* ---------------- trusted-input login (iframe + framework safe) ---------------- */

const LOGIN_RESOLVER = `
const __area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
const __resolveLogin = () => {
  const pws = [...document.querySelectorAll('input[type=password]')]
    .filter(__vis)
    .sort((a, b) => __area(b) - __area(a));
  const pw = pws[0] || null;
  if (!pw) return { pw: null, user: null, btn: null };
  const inputs = [...document.querySelectorAll('input')].filter(__vis);
  const idx = inputs.indexOf(pw);
  let user = null;
  for (let i = idx - 1; i >= 0; i--) {
    const t = (inputs[i].type || 'text').toLowerCase();
    if (t === 'text' || t === 'email' || t === 'tel' || t === '') { user = inputs[i]; break; }
  }
  if (!user) {
    user = inputs.find((el) => el !== pw && /user|name|account|登录名|用户名/i.test((el.name || '') + (el.id || ''))) || null;
  }
  const btn = [...document.querySelectorAll('button,input[type=submit],input[type=button],a,[role=button],.el-button')]
    .filter(__vis)
    .filter((b) => /登录|登 录|登陆|sign\s*in|log\s*in|logon|submit/i.test(__text(b)))[0] || null;
  return { pw, user, btn };
};
`;

export function prepareLoginScript(): string {
  return `(() => {
    ${HELPERS}
    ${LOGIN_RESOLVER}
    const r = __resolveLogin();
    window.__kvmLogin = r;
    return { ok: !!r.pw, hasUser: !!r.user, hasBtn: !!r.btn };
  })()`;
}

export function focusFieldScript(which: 'user' | 'pw'): string {
  return `(() => {
    ${HELPERS}
    ${LOGIN_RESOLVER}
    const r = __resolveLogin();
    const el = r.${which};
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    el.focus();
    if (el.select) el.select();
    return document.activeElement === el;
  })()`;
}

export function filledStateScript(): string {
  return `(() => {
    ${HELPERS}
    ${LOGIN_RESOLVER}
    const r = __resolveLogin();
    return {
      user: r.user ? String(r.user.value || '').length > 0 : true,
      pw: r.pw ? String(r.pw.value || '').length > 0 : false
    };
  })()`;
}

/** fallback when trusted typing did not reach a framework-controlled field */
export function fallbackFillScript(user: string, pass: string): string {
  const U = JSON.stringify(user);
  const P = JSON.stringify(pass);
  return `(() => {
    ${HELPERS}
    ${LOGIN_RESOLVER}
    const r = __resolveLogin();
    if (!r.pw) return { user: false, pw: false };
    if (r.user) __setValue(r.user, ${U});
    __setValue(r.pw, ${P});
    return {
      user: r.user ? String(r.user.value || '').length > 0 : true,
      pw: String(r.pw.value || '').length > 0
    };
  })()`;
}

export function submitLoginScript(): string {
  return `(async () => {
    ${HELPERS}
    ${LOGIN_RESOLVER}
    const r = __resolveLogin();
    if (!r.pw) return 'none';
    if (r.btn && r.btn.disabled) {
      r.pw.dispatchEvent(new Event('input', { bubbles: true }));
      r.pw.dispatchEvent(new Event('change', { bubbles: true }));
      await __sleep(350);
    }
    const again = __resolveLogin();
    if (again.btn) {
      again.btn.click();
      return 'click';
    }
    // Some SPAs (iDRAC) only wire ng-click on the submit button; requestSubmit
    // would silently do nothing. Click the real submit control instead.
    const submitBtn = [...document.querySelectorAll('button[type=submit],input[type=submit]')]
      .filter(__vis)
      .find((b) => !b.disabled);
    if (submitBtn) {
      submitBtn.click();
      return 'click-submit';
    }
    try {
      if (again.pw.form && again.pw.form.requestSubmit) { again.pw.form.requestSubmit(); return 'submit'; }
    } catch (e) {}
    again.pw.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    again.pw.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return 'enter';
  })()`;
}

export function loginErrorTextScript(): string {
  return `(() => {
    const body = (document.body && document.body.innerText || '').slice(0, 3000);
    const m = body.match(/(The user name or password is empty|user name or password[^\\n]{0,40}|用户名或密码[^\\n]{0,20}|密码错误|account[^\\n]{0,20}locked)/i);
    return m ? m[0] : '';
  })()`;
}

/** iBMC/xFusion show a "your account has security risks" notice after login */
export function dismissPostLoginScript(): string {
  return `(() => {
    ${HELPERS}
    const wanted = [
      /^change\\s*later$/i,
      /^do not show (this )?again$/i,
      /^remind me later$/i,
      /^later$/i,
      /^稍后$/,
      /^以后再说$/,
      /^暂不(修改|处理)?$/,
      /^不再提示$/
    ];
    const els = [...document.querySelectorAll('button,a,[role=button],span,div')]
      .filter((el) => __vis(el))
      .map((el) => ({ el, text: __text(el) }))
      .filter((x) => x.text.length < 30 && wanted.some((re) => re.test(x.text)));
    if (!els.length) return null;
    const el = els[0];
    el.el.click();
    return el.text;
  })()`;
}

export function kvmLimitScript(): string {
  return `(() => {
    const t = (document.body && document.body.innerText) || '';
    return /reached the limit|forced to log out|达到.{0,4}上限|强制注销/i.test(t);
  })()`;
}

/** second stage for consoles that need "Virtual Console" -> "Launch" */
export function launchConsoleScript(): string {
  return `(() => {
    ${HELPERS}
    const RE = /^(Start( the)? Virtual Console|Launch Virtual Console|Launch Console|Start Console|Launch|Start|启动虚拟控制台|启动|打开控制台)$/i;
    const btns = [...document.querySelectorAll('button,a,[role=button],input[type=button]')]
      .filter(__vis)
      .filter((b) => RE.test(__text(b).trim()));
    if (!btns.length) return { ok: false };
    const label = __text(btns[0]).trim();
    btns[0].click();
    return { ok: true, label };
  })()`;
}

/** iDRAC refuses logins when all GUI sessions are occupied */
export function sessionLimitScript(): string {
  return `(() => {
    const text = (document.body && document.body.innerText) || '';
    return /maximum number of (user )?sessions|number of sessions[^\\n]{0,20}reached|会话数.{0,6}(上限|达到)/i.test(text);
  })()`;
}

/** click the dashboard's "Start the Virtual Console" style action, not the nav item */
export function startConsoleScript(): string {
  return `(() => {
    ${HELPERS}
    const RE = /^(start|launch|open)\\b[^\\n]{0,40}console|^(启动|打开)[^\\n]{0,12}(控制台|虚拟)/i;
    const els = [...document.querySelectorAll('button,a,[role=button],div,span')]
      .filter((el) => __vis(el))
      .map((el) => ({ el, t: __text(el).trim() }))
      .filter((x) => x.t.length > 0 && x.t.length < 60 && RE.test(x.t));
    if (!els.length) return { ok: false };
    els[0].el.click();
    return { ok: true, label: els[0].t };
  })()`;
}
