import { watchProfileMenu } from './profileMenu';

let previous = '';
const profileMenu = watchProfileMenu();

function watchLocation(): void {
  if (location.href === previous) return;
  previous = location.href;
  profileMenu.update();
  void chrome.runtime.sendMessage({ type: 'contextChanged' }).catch(() => {
    // Reload the portal after an extension update invalidates this script.
    console.warn(
      'Entra Admin Helper: reload the portal to reconnect the extension.',
    );
  });
}

window.addEventListener('hashchange', watchLocation);
window.addEventListener('popstate', watchLocation);
setInterval(watchLocation, 1000);
watchLocation();
