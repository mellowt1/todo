// A finger for the Playwright checks, in Chromium or WebKit.
// Chromium sends real touch through CDP. WebKit has no CDP, so there the finger is
// PointerEvents with pointerType 'touch', which is all the app listens to. Those go to the
// element first touched (touch has implicit capture), or to what is under the point once
// that element has left the page.
export async function touch(page, engine = 'chromium') {
  let send;
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    send = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  } else {
    const kind = { touchStart: 'pointerdown', touchMove: 'pointermove', touchEnd: 'pointerup' };
    send = (type, x, y) => page.evaluate(([type, x, y]) => {
      if (type === 'pointerdown') window.__finger = { el: document.elementFromPoint(x, y), x, y };
      const f = window.__finger;
      if (!f || !f.el) return;
      if (x === null) { x = f.x; y = f.y; } else { f.x = x; f.y = y; }
      const el = f.el.isConnected ? f.el : document.elementFromPoint(x, y);
      if (type === 'pointerup') window.__finger = null;
      if (!el) return;
      el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true, pointerId: 41, pointerType: 'touch', isPrimary: true,
        clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1,
        width: 20, height: 20, pressure: type === 'pointerup' ? 0 : 0.5,
      }));
    }, [kind[type], x ?? null, y ?? null]);
  }
  // A redraw (a sync reply, say) can swap the row out between finding it and measuring it,
  // and then boundingBox() is null. Ask again for the new row.
  const boxOf = async (el) => {
    for (let i = 0; i < 20; i++) {
      const b = await el.boundingBox();
      if (b) return b;
      await page.waitForTimeout(50);
    }
    throw new Error('no bounding box for ' + el);
  };
  let x0 = 0, y0 = 0, cur = 0;
  return {
    async drag(el, dx, { end = true, steps = 12 } = {}) {
      const b = await boxOf(el);
      x0 = b.x + b.width / 2; y0 = b.y + b.height / 2; cur = 0;
      await send('touchStart', x0, y0);
      await this.to(dx, steps);
      if (end) await send('touchEnd');
    },
    async to(dx, steps = 6) {
      const from = cur;
      for (let i = 1; i <= steps; i++) { cur = from + ((dx - from) * i) / steps; await send('touchMove', x0 + cur, y0); await page.waitForTimeout(12); }
    },
    async release() { await send('touchEnd'); },
    async longPress(el) {
      const b = await boxOf(el);
      await send('touchStart', b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(650);
      await send('touchEnd');
    },
    // Point by point, for holds and vertical drags.
    down: (x, y) => send('touchStart', x, y),
    move: (x, y) => send('touchMove', x, y),
    up: () => send('touchEnd'),
  };
}
