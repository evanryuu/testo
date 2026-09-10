import { OverlayScrollbars } from 'overlayscrollbars';

// Use the existing viewport so React keeps ownership of the content and its layout.
export function attachOverlayScrollbars(element: HTMLElement | null, slot?: HTMLElement) {
  if (!element) return;
  const style = getComputedStyle(element);
  const instance = OverlayScrollbars({
    target: element,
    elements: { viewport: element },
    ...(slot ? { scrollbars: { slot } } : {}),
    cancel: { body: false },
  }, {
    overflow: {
      x: style.overflowX === 'hidden' ? 'hidden' : 'scroll',
      y: style.overflowY === 'hidden' ? 'hidden' : 'scroll',
    },
    scrollbars: {
      theme: 'os-theme-workspace',
      autoHide: 'leave',
      autoHideDelay: 150,
      autoHideSuspend: false,
      dragScroll: true,
      clickScroll: 'instant',
    },
  });
  return () => instance.destroy();
}
