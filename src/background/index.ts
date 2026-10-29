import { authStatus, getToken, signIn, signOut } from './auth';
import { errorMessage, type Request, type Response } from '../shared/messages';
import { parseUserProfile } from '../shared/context';
import { createGraphClient } from '../shared/graph';
import { loadUserAccessPackages } from './accessPackages';

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

function profileUser(sender: chrome.runtime.MessageSender): string | null {
  if (
    sender.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    sender.tab?.id === undefined ||
    !sender.url?.startsWith('https://entra.microsoft.com/')
  )
    return null;
  return parseUserProfile(sender.tab.url ?? sender.url);
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
    const contentRequest =
      message.type === 'getUserAccessPackages' ||
      message.type === 'openSidePanel';
    const userId = contentRequest ? profileUser(sender) : null;
    if (contentRequest ? !userId : !isTrustedPage(sender)) return;
    const action = message as Request;
    async function handle(): Promise<unknown> {
      switch (action.type) {
        case 'openSidePanel':
          // Call before awaiting anything to preserve the content-script gesture.
          if (sender.tab?.id === undefined)
            throw new Error('The Entra tab is unavailable.');
          await chrome.sidePanel.open({ tabId: sender.tab.id });
          return null;
        case 'getUserAccessPackages': {
          if (
            !userId ||
            typeof action.payload?.userId !== 'string' ||
            action.payload.userId.toLowerCase() !== userId
          )
            throw new Error('Invalid user access package request.');
          const auth = await authStatus();
          if (!auth.signedIn || !auth.sessionId)
            throw new Error(
              'Set your tenant and client IDs in Options, then sign in using the side panel.',
            );
          const data = await loadUserAccessPackages(
            userId,
            createGraphClient(getToken),
            auth.sessionId,
            new AbortController().signal,
          );
          const current = await authStatus();
          if (!current.signedIn || current.sessionId !== auth.sessionId)
            throw new Error('Sign-in state changed. Sign in again.');
          return data;
        }
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
