import { parseUserProfile } from '../shared/context';
import { openDrawer, type Drawer } from './drawer';
import { cloneMenuItem, findAnchorItem, MENU_MARKER } from './menu';

export function watchProfileMenu(): { update(): void; dispose(): void } {
  let userId: string | null = null;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastInjection = 0;
  let drawer: Drawer | undefined;

  function removeItems(): void {
    document.querySelectorAll(MENU_MARKER).forEach((node) => node.remove());
  }
  function inject(): void {
    lastInjection = Date.now();
    if (!userId || parseUserProfile(location.href) !== userId) return;
    const anchor = findAnchorItem(document.body);
    if (!anchor?.parentElement) {
      removeItems();
      return;
    }
    const items = [...document.querySelectorAll<HTMLElement>(MENU_MARKER)];
    const current = items.find((item) => item.nextElementSibling === anchor);
    for (const item of items) if (item !== current) item.remove();
    if (current) return;
    const item = cloneMenuItem(anchor);
    function activate(event: Event): void {
      if (event.isTrusted === false) return;
      event.preventDefault();
      event.stopPropagation();
      if (!userId || parseUserProfile(location.href) !== userId) return;
      drawer?.close();
      drawer = openDrawer(userId, item);
    }
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
    anchor.before(item);
  }
  function stop(): void {
    observer?.disconnect();
    observer = undefined;
    clearTimeout(timer);
    timer = undefined;
    removeItems();
    drawer?.close();
    drawer = undefined;
  }
  function update(): void {
    const next = parseUserProfile(location.href);
    if (next === userId) return;
    stop();
    userId = next;
    if (!userId) return;
    observer = new MutationObserver(() => {
      if (timer !== undefined) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          inject();
        },
        Math.max(0, 250 - (Date.now() - lastInjection)),
      );
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    inject();
  }
  return {
    update,
    dispose: () => {
      stop();
      userId = null;
    },
  };
}
