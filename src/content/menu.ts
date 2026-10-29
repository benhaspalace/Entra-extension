import {
  accessPackagesLabel,
  customSecurityAttributeLabels,
} from './menuLabels';

export const MENU_MARKER = '[data-entra-helper="access-packages"]';
const ITEM_SELECTOR =
  '[role="listitem"], [role="treeitem"], [role="menuitem"], li';

function* labelNodes(root: Node, labels: readonly string[]): Generator<Text> {
  const document = root.ownerDocument ?? globalThis.document;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (labels.includes(node.textContent?.trim() ?? '')) yield node as Text;
  }
}

export function findAnchorItem(
  root: ParentNode,
  labels: readonly string[] = customSecurityAttributeLabels,
): HTMLElement | null {
  let last: HTMLElement | null = null;
  let visible: HTMLElement | null = null;
  for (const node of labelNodes(root, labels)) {
    const element = node.parentElement;
    if (element?.closest('[data-entra-helper]')) continue;
    const item = element?.closest<HTMLElement>(ITEM_SELECTOR);
    if (!item) continue;
    last = item;
    if (item.getClientRects().length > 0) visible = item;
  }
  const document = root.ownerDocument ?? globalThis.document;
  // DOM-only test environments have no layout, including for the document root.
  return (
    visible ??
    (document.documentElement.getClientRects().length === 0 ? last : null)
  );
}

export function cloneMenuItem(anchor: HTMLElement): HTMLElement {
  const clone = anchor.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      'script, style, link, iframe, object, embed, img, input, select, textarea',
    )
    .forEach((node) => node.remove());
  for (const node of clone.querySelectorAll('a, button')) {
    const span = anchor.ownerDocument.createElement('span');
    for (const attribute of node.attributes)
      span.setAttribute(attribute.name, attribute.value);
    span.append(...node.childNodes);
    node.replaceWith(span);
  }
  for (const node of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...node.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        /^(id|href|xlink:href|src|srcset|target|style|tabindex|role|aria-.+|data-.+)$/i.test(
          attribute.name,
        )
      )
        node.removeAttribute(attribute.name);
    }
    for (const name of [...node.classList]) {
      if (/(selected|active|current|focused)/i.test(name))
        node.classList.remove(name);
    }
  }
  // Keep the portal's label wrapper/classes, not its navigation or icon.
  const label = [...labelNodes(clone, customSecurityAttributeLabels)].at(
    -1,
  )?.parentElement;
  const wrapper = label ?? clone;
  wrapper.textContent = accessPackagesLabel;
  const icons = [
    ...clone.querySelectorAll('svg, [class*="icon"], [class*="Icon"]'),
  ].filter((node) => node !== wrapper && !node.contains(wrapper));
  const svg = anchor.ownerDocument.createElementNS(
    'http://www.w3.org/2000/svg',
    'svg',
  );
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = anchor.ownerDocument.createElementNS(
    'http://www.w3.org/2000/svg',
    'path',
  );
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M3 5h7l2 2h9v13H3V5zm2 4v9h14V9H5zm2 3h10v2H7v-2z');
  svg.append(path);
  const icon = icons[0];
  if (icon?.tagName.toLowerCase() === 'svg') icon.replaceWith(svg);
  else if (icon) icon.replaceChildren(svg);
  else clone.prepend(svg);
  for (const extra of icons.slice(1)) {
    if (!icon?.contains(extra)) extra.remove();
  }
  clone.dataset.entraHelper = 'access-packages';
  clone.setAttribute('role', anchor.getAttribute('role') ?? 'menuitem');
  clone.setAttribute('tabindex', '0');
  clone.setAttribute('aria-label', accessPackagesLabel);
  return clone;
}
