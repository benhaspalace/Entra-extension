import { authStatus, getToken, signIn, signOut } from './auth';
import { errorMessage, type Request, type Response } from '../shared/messages';

async function configurePanel(tabId: number, href: string): Promise<void> {
  await chrome.sidePanel.setOptions({
    tabId,
    path: 'sidepanel/index.html',
    enabled: href.startsWith('https://entra.microsoft.com/'),
  });
}

async function initialize(): Promise<void> {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.sidePanel.setOptions({ enabled: false });
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) =>
      tab.id !== undefined
        ? configurePanel(tab.id, tab.url ?? '')
        : Promise.resolve(),
    ),
  );
}

for (const event of [chrome.runtime.onInstalled, chrome.runtime.onStartup])
  event.addListener(() => {
    void initialize().catch((error: unknown) =>
      console.error(errorMessage(error)),
    );
  });

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url)
    void configurePanel(tabId, change.url).catch((error: unknown) =>
      console.error(errorMessage(error)),
    );
});

function isTrustedPage(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    (sender.url === chrome.runtime.getURL('sidepanel/index.html') ||
      sender.url === chrome.runtime.getURL('options/index.html'))
  );
}

chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    sender,
    sendResponse: (response: Response<unknown>) => void,
  ) => {
    if (
      !message ||
      typeof message !== 'object' ||
      !('type' in message) ||
      typeof message.type !== 'string'
    )
      return;
    if (message.type === 'contextChanged') {
      if (sender.tab?.id !== undefined && sender.url)
        void configurePanel(sender.tab.id, sender.url).catch((error: unknown) =>
          console.error(errorMessage(error)),
        );
      sendResponse({ ok: true, value: null });
      return;
    }
    if (!isTrustedPage(sender)) return;
    const action = message as Request;
    async function handle(): Promise<unknown> {
      switch (action.type) {
        case 'authStatus':
          return authStatus();
        case 'signIn':
          return signIn();
        case 'signOut':
          return signOut();
        case 'getToken':
          if (typeof action.payload?.refresh !== 'boolean')
            throw new Error('Invalid token request.');
          return getToken(action.payload.refresh);
        default:
          throw new Error('Unknown extension request.');
      }
    }
    void handle().then(
      (value) => sendResponse({ ok: true, value }),
      (error: unknown) =>
        sendResponse({ ok: false, error: errorMessage(error) }),
    );
    return true;
  },
);
