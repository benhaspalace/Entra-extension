import { errorMessage, request } from '../shared/messages';
import { readSettings, validateSettings } from '../shared/settings';

function element<T extends HTMLElement>(id: string, type: { new (): T }): T {
  const node = document.getElementById(id);
  if (!(node instanceof type))
    throw new Error(`Missing options element: ${id}`);
  return node;
}

const tenant = element('tenant', HTMLInputElement);
const client = element('client', HTMLInputElement);
const audit = element('audit', HTMLInputElement);
const status = element('status', HTMLParagraphElement);
const form = element('settings', HTMLFormElement);
element('redirect', HTMLElement).textContent = chrome.identity.getRedirectURL();

function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('error', error);
}

async function save(): Promise<void> {
  const settings = validateSettings({
    tenantId: tenant.value,
    clientId: client.value,
    auditEnabled: audit.checked,
  });
  const stored = await chrome.storage.sync.get('settings');
  if (
    !stored.settings ||
    JSON.stringify(stored.settings) !== JSON.stringify(settings)
  ) {
    await request('signOut', undefined);
    await chrome.storage.sync.set({ settings });
  }
}

async function run(operation: () => Promise<void>): Promise<void> {
  const buttons = form.querySelectorAll('button');
  buttons.forEach((button) => (button.disabled = true));
  try {
    await operation();
  } catch (error) {
    setStatus(errorMessage(error), true);
  } finally {
    buttons.forEach((button) => (button.disabled = false));
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    await save();
    setStatus('Settings saved. Sign in from the panel or test sign-in here.');
  });
});
element('test', HTMLButtonElement).addEventListener('click', () => {
  void run(async () => {
    await save();
    setStatus('Complete sign-in in the Microsoft window...');
    await request('signIn', undefined);
    setStatus(
      'Sign-in succeeded. Open the panel on an Entra Members or Groups blade.',
    );
  });
});
element('signout', HTMLButtonElement).addEventListener('click', () => {
  void run(async () => {
    await request('signOut', undefined);
    setStatus(
      'Extension session cleared. Your Microsoft browser session is unchanged.',
    );
  });
});
void readSettings().then(
  (settings) => {
    tenant.value = settings.tenantId;
    client.value = settings.clientId;
    audit.checked = settings.auditEnabled;
  },
  (error: unknown) => setStatus(errorMessage(error)),
);
