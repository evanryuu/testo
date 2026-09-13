import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react';

type Point = { x: number; y: number };
type Box = { left: number; top: number; width: number; height: number };
type Gesture = {
  pointerId: number; origin: Point; client: Point; initialClient: Point;
  original: Set<string>; additive: boolean; moved: boolean;
};

// Keep the anchor in list coordinates so scrolling does not change where the drag began.
export function useCaseMarquee(enabled: boolean, selection: Set<string>, onSelect: (ids: Set<string>) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const update = useCallback(() => {
    const current = gesture.current, list = ref.current;
    if (!current || !list) return;
    if (!current.moved && Math.hypot(current.client.x - current.initialClient.x, current.client.y - current.initialClient.y) < 4) return;
    current.moved = true;
    const bounds = list.getBoundingClientRect();
    const x = Math.max(0, Math.min(bounds.width, current.client.x - bounds.left));
    const y = Math.max(0, Math.min(bounds.height, current.client.y - bounds.top));
    const next = { left: Math.min(current.origin.x, x), top: Math.min(current.origin.y, y), width: Math.abs(current.origin.x - x), height: Math.abs(current.origin.y - y) };
    const ids = new Set(current.additive ? current.original : []);
    list.querySelectorAll<HTMLElement>('[data-case-id]').forEach(row => {
      const rect = row.getBoundingClientRect();
      if (rect.left - bounds.left < next.left + next.width && rect.right - bounds.left > next.left
        && rect.top - bounds.top < next.top + next.height && rect.bottom - bounds.top > next.top) ids.add(row.dataset.caseId!);
    });
    setBox(next);
    onSelect(ids);
  }, [onSelect]);
  const finish = useCallback((cancel: boolean) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    if (cancel) onSelect(current.original);
    else if (!current.moved && !current.additive) onSelect(new Set());
    setBox(null);
    if (ref.current?.hasPointerCapture(current.pointerId)) ref.current.releasePointerCapture(current.pointerId);
  }, [onSelect]);
  useEffect(() => {
    const cancel = () => finish(true);
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('blur', cancel);
    // Capturing also catches horizontal scrolling inside the list.
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('scroll', update, true);
      gesture.current = null;
    };
  }, [finish, update]);
  useEffect(() => { if (!enabled) finish(true); }, [enabled, finish]);
  return {
    ref, box,
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (!enabled || event.button !== 0 || event.pointerType !== 'mouse'
        || !(event.target instanceof Element) || event.target.closest('button, a, input, textarea, select, label, [role="checkbox"], [contenteditable], .os-scrollbar')) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      gesture.current = { pointerId: event.pointerId, origin: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        client: { x: event.clientX, y: event.clientY }, initialClient: { x: event.clientX, y: event.clientY }, original: new Set(selection), additive: event.metaKey || event.ctrlKey, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (gesture.current?.pointerId !== event.pointerId) return;
      gesture.current.client = { x: event.clientX, y: event.clientY };
      update();
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      if (gesture.current?.pointerId === event.pointerId) finish(false);
    },
    onPointerCancel() { finish(true); },
    onLostPointerCapture() { finish(true); },
    onDragStartCapture(event: DragEvent<HTMLDivElement>) {
      if (gesture.current) { event.preventDefault(); event.stopPropagation(); }
    },
  };
}
